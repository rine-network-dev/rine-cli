import type { Command } from "commander";
import { withErrorHandler } from "../action.js";
import { HttpClient, resolveApiUrl, resolveToUuid } from "@rine-network/core";
import { announceHandleCompletion } from "../handle-completion.js";
import { printJson, printTable, printText } from "../output.js";
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
	const apiUrl = resolveApiUrl();
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

	const data = await HttpClient.publicGet(apiUrl, "/directory/agents", params);
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
				const apiUrl = resolveApiUrl();
				const data = await HttpClient.publicGet(apiUrl, "/directory/categories");
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
				const apiUrl = resolveApiUrl();
				// 🔴 The refusal this used to compose here printed
				// `kofi@acme.rine.network`, a placeholder domain in a REFUSAL —
				// which a model was measured copying verbatim, local part
				// moved, domain not. `resolveToUuid` is the shared recipient /
				// invitee / target resolver and already answers this exact question
				// with a placeholder-free sentence (`invalidAgentIdentifierRefusal`
				// names the three PARTS of a handle instead of printing one), gated
				// against its Python twin. Rung 1 — naming a real handle — is
				// unreachable here: the directory lookup is the thing that failed,
				// so there is nothing resolved to echo alongside the caller's own
				// spelling, which the sentence does carry.
				//
				// Same two arms as the block it replaces, plus `normalizeHandle`, so
				// `kofi@acme` now reaches WebFinger as `kofi@acme.rine.network`
				// instead of being refused. Throws rather than printing:
				// `withErrorHandler` prints and sets the same exit code 1.
				//
				// 🔴 Item 18: that completion is announced, never silent. A caller
				// who typed `kofi@acme` is looked up as something they did not
				// write, and being told which agent was actually inspected is the
				// difference between a helpful default and a wrong answer nobody
				// can see. The notice is `announceHandleCompletion`'s and is not
				// restated here — every `resolveToUuid` call site carries the same
				// one, so there is one sentence and one gate over all of them.
				announceHandleCompletion(agentIdArg);
				const resolvedId = await resolveToUuid(apiUrl, agentIdArg);
				const data = await HttpClient.publicGet(
					apiUrl,
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
