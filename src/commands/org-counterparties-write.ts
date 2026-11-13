import {
	type AllowWrite,
	Decision,
	type GroupRead,
	RineApiError,
	RuleDirection,
	UUID_RE,
	deleteAllow,
	fetchAllAllow,
	getPolicy,
	lookupCounterparty,
	orgWords,
	putAllow,
	resolveHandleViaWebFinger,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { printJson, printMutationOk, printTable, printText } from "../output.js";
import { promptConfirm } from "../prompt.js";
import { resolveAgent } from "./agent-suspend.js";
import { groupsAllowLine } from "./org-rules-words.js";
import { warnInAgentRuntime } from "./runtime-warning.js";

interface DecideOpts {
	outbound?: boolean;
	inbound?: boolean;
	both?: boolean;
	groups?: boolean;
	agent?: string;
	theirAgent?: string;
	reason: string;
	yes?: boolean;
}

function directionsOf(opts: DecideOpts): RuleDirection[] {
	const chosen = [opts.outbound, opts.inbound, opts.both].filter(Boolean);
	if (chosen.length > 1)
		throw new Error("Give one of --outbound, --inbound or --both.");
	if (opts.outbound) return [RuleDirection.Outbound];
	if (opts.inbound) return [RuleDirection.Inbound];
	return [RuleDirection.Outbound, RuleDirection.Inbound];
}

/** Our open groups, for the `--groups` check; `undefined` when the org principal cannot list them. */
async function openGroups(ctx: ActionContext): Promise<number | undefined> {
	try {
		const page = (await ctx.client.get("/groups")) as { items: GroupRead[] };
		return page.items.filter((g) => g.enrollment_policy === "open").length;
	} catch (err) {
		if (err instanceof RineApiError) return undefined;
		throw err;
	}
}

/** The counterparty write, plus the group check with `--groups`. */
async function describe(
	ctx: ActionContext,
	ref: string,
	groups: boolean,
): Promise<string> {
	const c = await lookupCounterparty(ctx.client, ref);
	const domains =
		c.proven_domains.length > 0
			? `Proven domain: ${c.proven_domains.join(", ")}.`
			: "No proven domain. Names and slugs are chosen by whoever registers them.";
	const lines = [
		`${c.name}  org ${c.org_id.slice(0, 8)}…  tier ${c.tier}`,
		domains,
		`Check this code with a contact at ${c.name}:`,
		`  ${orgWords(c.org_id)}`,
	];
	if (groups) {
		const covered = (await getPolicy(ctx.client)).groups_covered;
		lines.push(groupsAllowLine(await openGroups(ctx), covered));
	}
	if (!ctx.gOpts.json) for (const l of lines) printText(l);
	return c.org_id;
}

async function theirAgentId(
	ctx: ActionContext,
	ref: string,
): Promise<string> {
	const id = UUID_RE.test(ref)
		? ref
		: await resolveHandleViaWebFinger(ctx.apiUrl, ref);
	if (!UUID_RE.test(id)) throw new Error(`No agent matches '${ref}'.`);
	return id.toLowerCase();
}

function decide(program: Command, parent: Command, decision: Decision): void {
	const verb = decision === Decision.Allow ? "Allow" : "Block";
	const cmd = parent
		.command(decision)
		.description(`${verb} an organisation, or one of its agents, in the message rules`)
		.argument("<ref>", "Organisation id, an agent handle, or the slug of an organisation you have dealt with")
		.option("--outbound", "Our agents sending to it")
		.option("--inbound", "Its agents sending to ours")
		.option("--both", "Both directions (the default)")
		.option("--agent <ours>", "Only for one of our agents")
		.option("--their-agent <handle>", "Only for one of its agents")
		.requiredOption("--reason <text>", "Why; kept with the entry")
		.option("--yes", "Skip confirmation prompt");
	if (decision === Decision.Allow)
		cmd.option("--groups", "Also let it join your open groups once the group rule is on");
	cmd.action(
		withClient(program, async (ctx, ref: string, opts: DecideOpts) => {
			const directions = directionsOf(opts);
			warnInAgentRuntime();
			const orgId = await describe(ctx, ref, opts.groups === true);
			if (!opts.yes && !ctx.gOpts.json) {
				const sure = await promptConfirm(`${verb} ${directions.join(" and ")}?`);
				if (!sure) return;
			}
			const ours = opts.agent && (await resolveAgent(ctx, opts.agent));
			const theirs = opts.theirAgent && (await theirAgentId(ctx, opts.theirAgent));
			const entries = [];
			for (const direction of directions) {
				const entry: AllowWrite = {
					direction,
					counterparty_org_id: orgId,
					decision,
					groups: opts.groups === true,
					reason: opts.reason,
					...(ours ? { agent_id: ours } : {}),
					...(theirs ? { counterparty_agent_id: theirs } : {}),
				};
				entries.push(await putAllow(ctx.client, entry));
			}
			if (ctx.gOpts.json) return printJson(entries);
			printMutationOk(`${verb} entry written (${directions.join(", ")}).`);
		}),
	);
}

export function registerCounterpartyWrites(
	counterparties: Command,
	program: Command,
): void {
	decide(program, counterparties, Decision.Allow);
	decide(program, counterparties, Decision.Block);

	counterparties
		.command("remove <id>")
		.description("Remove an allow or block entry (an id from `counterparties entries`)")
		.requiredOption("--reason <text>", "Why")
		.action(
			withClient(program, async ({ client, gOpts }, id: string, opts: { reason: string }) => {
				warnInAgentRuntime();
				await deleteAllow(client, id, opts.reason);
				printMutationOk("Entry removed", gOpts.json);
			}),
		);

	counterparties
		.command("entries")
		.description("List every allow and block entry (--json is the export)")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const entries = await fetchAllAllow(client);
				if (gOpts.json) return printJson(entries);
				printTable(
					entries.map((e) => ({
						ID: e.id,
						Direction: e.direction,
						Decision: e.decision,
						Org: e.counterparty_org_id,
						Scope: e.scope_agent_id ?? "org",
						Groups: e.groups ? "yes" : "no",
						Reason: e.reason,
					})),
				);
			}),
		);
}
