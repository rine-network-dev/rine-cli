import type { Command } from "commander";
import { withErrorHandler } from "../action.js";
import { HttpClient } from "../http.js";
import { printError, printJson, printTable, printText } from "../output.js";
import { resolveHandleViaWebFinger } from "../resolve-handle.js";
import { registerDiscoverGroups } from "./discover-groups.js";

function trunc(s: unknown, len: number): string {
	const str = String(s ?? "");
	return str.length > len ? `${str.slice(0, len - 1)}\u2026` : str;
}

function fmtList(v: unknown): string {
	return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

interface AgentSummary {
	name?: unknown;
	handle?: unknown;
	description?: unknown;
	categories?: unknown;
	tags?: unknown;
	pricing_model?: unknown;
	rine?: { categories?: unknown; tags?: unknown; pricing_model?: unknown };
}

type SearchOpts = {
	query?: string;
	category: string[];
	tag: string[];
	jurisdiction?: string;
	language: string[];
	verified?: boolean;
	pricingModel?: string;
	limit?: string;
	cursor?: string;
	sort?: string;
};

async function doAgentSearch(
	opts: SearchOpts,
	gOpts: { json?: boolean },
): Promise<void> {
	const params = new URLSearchParams();
	if (opts.query) params.append("q", opts.query);
	for (const c of opts.category) params.append("category", c);
	for (const t of opts.tag) params.append("tag", t);
	if (opts.jurisdiction) params.append("jurisdiction", opts.jurisdiction);
	for (const l of opts.language) params.append("language", l);
	if (opts.verified !== undefined)
		params.append("verified", String(opts.verified));
	if (opts.pricingModel) params.append("pricing_model", opts.pricingModel);
	if (opts.limit) params.append("limit", opts.limit);
	if (opts.cursor) params.append("cursor", opts.cursor);
	if (opts.sort) params.append("sort", opts.sort);

	const data = await HttpClient.publicGet("/directory/agents", params);
	if (gOpts.json) {
		printJson(data);
		return;
	}
	const result = data as {
		items?: AgentSummary[];
		next_cursor?: string;
	};
	const items = result.items ?? [];
	printTable(
		items.map((a) => ({
			Name: trunc(a.name, 40),
			Categories: trunc(fmtList(a.rine?.categories ?? a.categories), 40),
			Tags: trunc(fmtList(a.rine?.tags ?? a.tags), 40),
			Pricing: trunc(a.rine?.pricing_model ?? a.pricing_model, 40),
			Handle: trunc(a.handle, 40),
		})),
	);
	if (result.next_cursor) printText(`Next cursor: ${result.next_cursor}`);
}

const collect = (v: string, prev: string[]): string[] => [...prev, v];

function addAgentSearchCommand(
	parent: Command,
	name: string,
	description: string,
	program: Command,
	requireQuery: boolean,
): void {
	const cmd = parent.command(name).description(description);
	if (requireQuery) {
		cmd.requiredOption("-q, --query <query>", "Search query");
	} else {
		cmd.option("-q, --query <query>", "Search query");
	}
	cmd
		.option(
			"--category <cat>",
			"Category filter (repeatable)",
			collect,
			[] as string[],
		)
		.option("--tag <tag>", "Tag filter (repeatable)", collect, [] as string[])
		.option("--jurisdiction <j>", "Jurisdiction filter")
		.option(
			"--language <lang>",
			"Language filter (repeatable)",
			collect,
			[] as string[],
		)
		.option("--verified", "Only verified agents")
		.option("--no-verified", "Only unverified agents")
		.option("--pricing-model <model>", "Pricing model filter")
		.option("--limit <n>", "Max results")
		.option("--cursor <cursor>", "Pagination cursor")
		.option("--sort <sort>", "Sort order (relevance|name|created_at)")
		.action(
			withErrorHandler(program, async (gOpts, opts: SearchOpts) => {
				await doAgentSearch(opts, gOpts);
			}),
		);
}

export function registerDiscover(program: Command): void {
	const discover = program
		.command("discover")
		.description("Discover agents and groups in the directory");

	addAgentSearchCommand(
		discover,
		"agents",
		"List agents in the directory",
		program,
		false,
	);
	addAgentSearchCommand(
		discover,
		"search",
		"Search agents (--query required)",
		program,
		true,
	);

	discover
		.command("categories")
		.description("List directory categories with counts")
		.action(
			withErrorHandler(program, async (gOpts) => {
				const data = await HttpClient.publicGet("/directory/categories");
				if (gOpts.json) {
					printJson(data);
					return;
				}
				const result = data as {
					items?: { name: string; count: number }[];
				};
				const items = (result.items ?? []).sort((a, b) =>
					a.name.localeCompare(b.name),
				);
				printTable(items.map((c) => ({ Category: c.name, Count: c.count })));
			}),
		);

	discover
		.command("inspect")
		.description("Inspect a specific agent in the directory")
		.argument("<agent-id>", "Agent UUID or handle")
		.action(
			withErrorHandler(program, async (gOpts, agentIdArg: string) => {
				const UUID_RE =
					/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
				let resolvedId = agentIdArg;
				if (agentIdArg.includes("@")) {
					resolvedId = await resolveHandleViaWebFinger(agentIdArg);
				}
				if (!UUID_RE.test(resolvedId)) {
					printError(
						`Could not resolve '${agentIdArg}' to an agent UUID. ` +
							"Provide a UUID or a valid handle (e.g. agent@org.rine.network).",
					);
					process.exitCode = 1;
					return;
				}
				const data = await HttpClient.publicGet(
					`/directory/agents/${resolvedId}`,
				);
				if (gOpts.json) {
					printJson(data);
					return;
				}
				const result = data as {
					card?: AgentSummary & { description?: unknown };
					directory_metadata?: {
						registered_at?: unknown;
						messages_processed_30d?: unknown;
						avg_response_time_ms?: unknown;
					};
				};
				const card = result.card ?? (data as AgentSummary);
				const meta = result.directory_metadata ?? {};
				printTable([
					{
						Name: String(card.name ?? ""),
						Description: trunc(card.description, 120),
						Categories: fmtList(card.rine?.categories ?? card.categories),
						Tags: fmtList(card.rine?.tags ?? card.tags),
						Pricing: String(
							card.rine?.pricing_model ?? card.pricing_model ?? "",
						),
						"Registered At": String(meta.registered_at ?? ""),
						"Messages (30d)": String(meta.messages_processed_30d ?? ""),
						"Avg Response (ms)": String(meta.avg_response_time_ms ?? ""),
					},
				]);
			}),
		);

	registerDiscoverGroups(discover, program);
}
