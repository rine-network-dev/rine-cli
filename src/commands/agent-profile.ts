import type { Command } from "commander";
import { withClient } from "../action.js";
import { printError, printJson, printSuccess, printTable } from "../output.js";

const READ_ONLY_KEYS = [
	"id",
	"agent_id",
	"created_at",
	"updated_at",
	"signatures",
];
const VALID_PRICING = ["free", "per_request", "subscription", "negotiated"];

type AgentCard = Record<string, unknown>;

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
					const result = await updateCard(client, agentId, (card) => {
						card.description = opts.description;
					});
					if (gOpts.json) {
						printJson(result);
					} else {
						printSuccess("Description updated");
					}
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
					const result = await updateCard(client, agentId, (card) => {
						const skill: Record<string, unknown> = {
							id: opts.skillId,
							name: opts.skillName,
							description: opts.skillDescription ?? "",
							tags: opts.tags
								? opts.tags.split(",").map((t) => t.trim())
								: [],
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
					if (gOpts.json) {
						printJson(result);
					} else {
						printSuccess("Skill added");
					}
				},
			),
		);

	agent
		.command("set-categories")
		.description("Set agent categories")
		.argument("<agent-id>", "Agent ID")
		.requiredOption("--categories <cats>", "Comma-separated category names")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: { categories: string },
				) => {
					const cats = opts.categories.split(",").map((c) => c.trim());
					const result = await updateCard(client, agentId, (card) =>
						setRineField(card, "categories", cats),
					);
					if (gOpts.json) {
						printJson(result);
					} else {
						printSuccess("Categories updated");
					}
				},
			),
		);

	agent
		.command("set-languages")
		.description("Set agent supported languages")
		.argument("<agent-id>", "Agent ID")
		.requiredOption("--languages <langs>", "Comma-separated language codes")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: { languages: string },
				) => {
					const langs = opts.languages.split(",").map((l) => l.trim());
					const result = await updateCard(client, agentId, (card) =>
						setRineField(card, "languages", langs),
					);
					if (gOpts.json) {
						printJson(result);
					} else {
						printSuccess("Languages updated");
					}
				},
			),
		);

	agent
		.command("set-pricing")
		.description("Set agent pricing model")
		.argument("<agent-id>", "Agent ID")
		.requiredOption(
			"--model <model>",
			`Pricing model (${VALID_PRICING.join("|")})`,
		)
		.action(
			withClient(
				program,
				async ({ client, gOpts }, agentId: string, opts: { model: string }) => {
					if (!VALID_PRICING.includes(opts.model)) {
						printError(
							`Invalid pricing model '${opts.model}'. Valid: ${VALID_PRICING.join(", ")}`,
						);
						process.exitCode = 2;
						return;
					}
					const result = await updateCard(client, agentId, (card) =>
						setRineField(card, "pricing_model", opts.model),
					);
					if (gOpts.json) {
						printJson(result);
					} else {
						printSuccess("Pricing updated");
					}
				},
			),
		);

	agent
		.command("accept-types")
		.description("Set accepted message types")
		.argument("<agent-id>", "Agent ID")
		.requiredOption("--types <types>", "Comma-separated message types")
		.action(
			withClient(
				program,
				async ({ client, gOpts }, agentId: string, opts: { types: string }) => {
					const types = opts.types.split(",").map((t) => t.trim());
					const result = await updateCard(client, agentId, (card) =>
						setRineField(card, "message_types_accepted", types),
					);
					if (gOpts.json) {
						printJson(result);
					} else {
						printSuccess("Accept types updated");
					}
				},
			),
		);
}
