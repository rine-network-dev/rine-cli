import {
	type CounterpartyView,
	fetchCounterparties,
	orgWords,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { printJson, printText } from "../output.js";
import { registerCounterpartyWrites } from "./org-counterparties-write.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;

const header = (n: number, k: number) =>
	`${n} organisations, ${k} new this week`;
const checkCode = (words: string) =>
	`Check this code with a contact at that organisation: ${words}. Names and slugs are chosen by whoever registers them.`;

async function listAll(ctx: ActionContext): Promise<CounterpartyView[]> {
	const all: CounterpartyView[] = [];
	let cursor: string | undefined;
	do {
		const page = await fetchCounterparties(ctx.client, cursor, PAGE_SIZE);
		all.push(...page.counterparties);
		cursor = page.next_cursor ?? undefined;
	} while (cursor !== undefined);
	return all;
}

export function registerOrgCounterparties(
	org: Command,
	program: Command,
): void {
	const counterparties = org
		.command("counterparties")
		.description(
			"Organisations your agents exchanged messages with, counted from message envelopes, never from content",
		)
		.action(
			withClient(program, async (ctx) => {
				const all = await listAll(ctx);
				const since = Date.now() - WEEK_MS;
				const fresh = all.filter((c) => Date.parse(c.first_seen) >= since);
				const words = (c: CounterpartyView) => orgWords(c.counterparty_org_id);
				if (ctx.gOpts.json) {
					printJson({
						organisations: all.length,
						new_this_week: fresh.length,
						counterparties: all.map((c) => ({ ...c, org_words: words(c) })),
					});
					return;
				}
				printText(header(all.length, fresh.length));
				for (const c of all)
					printText(`${c.counterparty_org_id}  ${checkCode(words(c))}`);
			}),
		);

	registerCounterpartyWrites(counterparties, program);
}
