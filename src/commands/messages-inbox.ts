/** `rine inbox` — one page of the acting agent's received messages. */

import type { MessageRead, PaginatedResponse } from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printJson, printTable, printText } from "../output.js";
import { inboxRow, jsonRow, tableColumns } from "./messages-rows.js";

/** Register `inbox` on the `message` command group. */
export function addInboxCommand(parent: Command, program: Command): void {
	parent
		.command("inbox")
		.description("List inbox messages")
		.addOption(actorOption())
		.option("--new", "Show only new (undelivered) messages")
		.option("--delivered", "Show only delivered messages")
		.option("--read", "Show only read messages")
		.option("--limit <n>", "Maximum number of messages to return")
		.option("--cursor <cursor>", "Pagination cursor")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, actingAgent },
					opts: {
						agent?: string;
						new?: boolean;
						delivered?: boolean;
						read?: boolean;
						limit?: string;
						cursor?: string;
					},
				) => {
					const flags = [opts.new, opts.delivered, opts.read].filter(Boolean);
					if (flags.length > 1) {
						throw new Error(
							"Only one of --new, --delivered, --read can be specified",
						);
					}

					const agentId = await actingAgent();

					const params: Record<string, string | number | boolean> = {};
					if (opts.new) params.status = "new";
					else if (opts.delivered) params.status = "delivered";
					else if (opts.read) params.status = "read";
					if (opts.limit) params.limit = opts.limit;
					if (opts.cursor) params.cursor = opts.cursor;

					const data = (await client.get(
						`/agents/${agentId}/messages`,
						params,
					)) as PaginatedResponse<MessageRead>;

					if (gOpts.json) {
						printJson({ ...data, items: data.items.map(jsonRow) });
					} else {
						const rows = data.items.map(inboxRow);
						printTable(rows, tableColumns(rows));
						if (data.next_cursor) {
							printText(`Next cursor: ${data.next_cursor}`);
						}
					}
				},
			),
		);
}
