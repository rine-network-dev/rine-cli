import * as fs from "node:fs";
import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	printError,
	printJson,
	printMutationOk,
	printSuccess,
	printTable,
} from "../output.js";

const READ_ONLY_KEYS = [
	"id",
	"agent_id",
	"created_at",
	"updated_at",
	"signatures",
];
const VALID_PRICING = ["free", "per_request", "subscription", "negotiated"];

type AgentCard = Record<string, unknown>;

/**
 * Read the x402 card terms from a JSON string or a file (`-` = stdin). The
 * authoritative field shape (rail/schemes/networks/assets/mode/...) is validated
 * server-side on PUT; here we only enforce it is a JSON array so a malformed
 * value fails client-side before a needless round-trip.
 */
function readTerms(
	inline?: string,
	file?: string,
): { value: unknown[] } | { error: string } {
	if (inline !== undefined && file !== undefined) {
		return {
			error: "--x402-terms and --x402-terms-file are mutually exclusive",
		};
	}
	let raw: string;
	if (file !== undefined) {
		try {
			raw =
				file === "-"
					? fs.readFileSync(0, "utf-8")
					: fs.readFileSync(file, "utf-8");
		} catch (err) {
			return {
				error: `Cannot read terms file: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	} else {
		raw = inline as string;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: "x402 terms must be valid JSON" };
	}
	if (!Array.isArray(parsed)) {
		return { error: "x402 terms must be a JSON array (rail-keyed entries)" };
	}
	return { value: parsed };
}

function stripReadOnly(card: AgentCard): AgentCard {
	const result = { ...card };
	for (const key of READ_ONLY_KEYS) {
		delete result[key];
	}
	return result;
}

function setRineField(card: AgentCard, key: string, value: unknown): AgentCard {
	const rine = { ...(card.rine as Record<string, unknown> | undefined) };
	rine[key] = value;
	return { ...card, rine };
}

function toRow(card: AgentCard): Record<string, string> {
	const rine = (card.rine as Record<string, unknown> | undefined) ?? {};
	const skillCount = Array.isArray(card.skills) ? card.skills.length : 0;
	const join = (v: unknown): string =>
		Array.isArray(v) ? (v as string[]).join(", ") : "—";
	return {
		ID: String(card.id ?? "—"),
		"Agent ID": String(card.agent_id ?? "—"),
		Name: String(card.name ?? "—"),
		Description: card.description ? String(card.description).slice(0, 60) : "—",
		Version: String(card.version ?? "—"),
		Public: String(card.is_public ?? "—"),
		Skills: String(skillCount),
		Categories: join(rine.categories) || "—",
		Languages: join(rine.languages) || "—",
		Pricing: String(rine.pricing_model ?? "—"),
		"Accept Types": join(rine.message_types_accepted) || "—",
		Updated: String(card.updated_at ?? "—"),
	};
}

async function updateCard(
	client: {
		get: (path: string) => Promise<unknown>;
		put: (path: string, body?: unknown) => Promise<unknown>;
	},
	agentId: string,
	modify: (card: AgentCard) => AgentCard | void,
): Promise<AgentCard> {
	const card = (await client.get(`/agents/${agentId}/card`)) as AgentCard;
	const updated = modify(card) ?? card;
	const result = (await client.put(
		`/agents/${agentId}/card`,
		stripReadOnly(updated),
	)) as AgentCard;
	return result;
}

function getAgentCmd(program: Command): Command {
	const cmd = program.commands.find((c) => c.name() === "agent");
	if (!cmd)
		throw new Error("registerAgent must be called before registerAgentProfile");
	return cmd;
}

const CSV_FIELD_CMDS = [
	{
		name: "set-categories",
		desc: "Set agent categories",
		flag: "--categories <cats>",
		flagDesc: "Comma-separated category names",
		field: "categories",
		msg: "Categories updated",
	},
	{
		name: "set-languages",
		desc: "Set agent supported languages",
		flag: "--languages <langs>",
		flagDesc: "Comma-separated language codes",
		field: "languages",
		msg: "Languages updated",
	},
	{
		name: "accept-types",
		desc: "Set accepted message types",
		flag: "--types <types>",
		flagDesc: "Comma-separated message types",
		field: "message_types_accepted",
		msg: "Accept types updated",
	},
] as const;

export function registerAgentProfile(program: Command): void {
	const agent = getAgentCmd(program);

	agent
		.command("profile")
		.description("Get agent card")
		.argument("<agent-id>", "Agent ID")
		.action(
			withClient(program, async ({ client, gOpts }, agentId: string) => {
				const card = (await client.get(`/agents/${agentId}/card`)) as AgentCard;
				if (gOpts.json) {
					printJson(card);
				} else {
					printTable([toRow(card)]);
				}
			}),
		);

	agent
		.command("describe")
		.description("Update agent description")
		.argument("<agent-id>", "Agent ID")
		.requiredOption("--description <desc>", "Agent description")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: { description: string },
				) => {
					await updateCard(client, agentId, (card) => {
						card.description = opts.description;
					});
					printMutationOk("Description updated", gOpts.json);
				},
			),
		);

	agent
		.command("add-skill")
		.description("Add a skill to the agent card")
		.argument("<agent-id>", "Agent ID")
		.requiredOption("--skill-id <id>", "Skill ID")
		.requiredOption("--skill-name <name>", "Skill name")
		.option("--skill-description <desc>", "Skill description")
		.option("--tags <tags>", "Comma-separated tags")
		.option("--examples <examples>", "Comma-separated examples")
		.option("--input-modes <modes>", "Comma-separated input modes")
		.option("--output-modes <modes>", "Comma-separated output modes")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: {
						skillId: string;
						skillName: string;
						skillDescription?: string;
						tags?: string;
						examples?: string;
						inputModes?: string;
						outputModes?: string;
					},
				) => {
					await updateCard(client, agentId, (card) => {
						const skill: Record<string, unknown> = {
							id: opts.skillId,
							name: opts.skillName,
							description: opts.skillDescription ?? "",
							tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [],
						};
						if (opts.examples)
							skill.examples = opts.examples.split(",").map((e) => e.trim());
						if (opts.inputModes)
							skill.inputModes = opts.inputModes
								.split(",")
								.map((m) => m.trim());
						if (opts.outputModes)
							skill.outputModes = opts.outputModes
								.split(",")
								.map((m) => m.trim());
						card.skills = [
							...(Array.isArray(card.skills)
								? (card.skills as Record<string, unknown>[])
								: []),
							skill,
						];
					});
					printMutationOk("Skill added", gOpts.json);
				},
			),
		);

	agent
		.command("set-pricing")
		.description(
			"Set agent pricing model and/or x402 payment terms (rine.x402.terms)",
		)
		.argument("<agent-id>", "Agent ID")
		.option("--model <model>", `Pricing model (${VALID_PRICING.join("|")})`)
		.option(
			"--x402-terms <json>",
			"x402 card terms as a JSON array; advisory only",
		)
		.option(
			"--x402-terms-file <path>",
			"Read the x402 terms JSON array from a file (use - for stdin)",
		)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: {
						model?: string;
						x402Terms?: string;
						x402TermsFile?: string;
					},
				) => {
					if (
						opts.model === undefined &&
						opts.x402Terms === undefined &&
						opts.x402TermsFile === undefined
					) {
						printError(
							"Nothing to set. Provide --model and/or --x402-terms/--x402-terms-file.",
						);
						process.exitCode = 2;
						return;
					}
					if (opts.model !== undefined && !VALID_PRICING.includes(opts.model)) {
						printError(
							`Invalid pricing model '${opts.model}'. Valid: ${VALID_PRICING.join(", ")}`,
						);
						process.exitCode = 2;
						return;
					}

					let terms: unknown;
					if (
						opts.x402Terms !== undefined ||
						opts.x402TermsFile !== undefined
					) {
						const parsed = readTerms(opts.x402Terms, opts.x402TermsFile);
						if ("error" in parsed) {
							printError(parsed.error);
							process.exitCode = 2;
							return;
						}
						terms = parsed.value;
					}

					await updateCard(client, agentId, (card) => {
						let next = card;
						if (opts.model !== undefined) {
							next = setRineField(next, "pricing_model", opts.model);
						}
						if (terms !== undefined) {
							// The card sub-object is `rine.x402 = { terms: [...] }`
							// (server schema X402CardConfig). The pricing_model enum is
							// left untouched — the two coexist as coarse + fine signals.
							next = setRineField(next, "x402", { terms });
						}
						return next;
					});
					printMutationOk("Pricing updated", gOpts.json);
				},
			),
		);

	for (const def of CSV_FIELD_CMDS) {
		agent
			.command(def.name)
			.description(def.desc)
			.argument("<agent-id>", "Agent ID")
			.requiredOption(def.flag, def.flagDesc)
			.action(
				withClient(
					program,
					async (
						{ client, gOpts },
						agentId: string,
						opts: Record<string, string>,
					) => {
						const raw = Object.values(opts)[0]!;
						await updateCard(client, agentId, (card) =>
							setRineField(
								card,
								def.field,
								raw.split(",").map((s) => s.trim()),
							),
						);
						printMutationOk(def.msg, gOpts.json);
					},
				),
			);
	}

	agent
		.command("enable-a2a")
		.description("Enable A2A protocol bridge for this agent")
		.argument("<agent-id>", "Agent ID")
		.action(
			withClient(program, async ({ client, gOpts }, agentId: string) => {
				const result = await updateCard(client, agentId, (card) =>
					setRineField(card, "a2a_enabled", true),
				);
				if (gOpts.json) {
					printJson(result);
					return;
				}
				const rine = (result.rine as Record<string, unknown> | undefined) ?? {};
				const endpoint = rine.a2a_endpoint;
				if (endpoint) {
					printSuccess(`A2A enabled. Endpoint: ${endpoint}`);
				} else {
					printSuccess("A2A enabled (endpoint not yet set by server)");
				}
			}),
		);

	agent
		.command("disable-a2a")
		.description("Disable A2A protocol bridge for this agent")
		.argument("<agent-id>", "Agent ID")
		.action(
			withClient(program, async ({ client, gOpts }, agentId: string) => {
				await updateCard(client, agentId, (card) =>
					setRineField(card, "a2a_enabled", false),
				);
				printMutationOk("A2A disabled", gOpts.json);
			}),
		);
}
