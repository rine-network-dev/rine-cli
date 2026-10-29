import {
	ACTING_AGENT_HEADER,
	decryptThreadRows,
	readThreadPage,
	resolveThreadRef,
	THREAD_REF_SURFACES,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printJson, printTable } from "../output.js";
import { GROUP_REFERENCE_HELP } from "./group-target.js";
import { addInboxCommand } from "./messages-inbox.js";
import { addReadCommand } from "./messages-read.js";
import { addReplyCommand } from "./messages-reply.js";
import { threadRow } from "./messages-rows.js";
import { registerSend } from "./messages-send.js";

function addMessageCommands(parent: Command, program: Command): void {
	addReadCommand(parent, program);
	registerSend(parent, program);
	addInboxCommand(parent, program);
	addReplyCommand(parent, program);

	parent
		.command("thread")
		.description(
			"Show the both-sided, decrypted transcript of a conversation or a group (role-tagged)",
		)
		// The conversation id is optional and positional; a group is named with
		// `--group`, the way every other group verb takes it.
		.argument("[conversation-id]", "Conversation ID")
		.option("--group <ref>", GROUP_REFERENCE_HELP)
		.addOption(actorOption())
		.option("--limit <n>", "Max turns to return (most-recent window)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, actingAgent },
					conversationId: string | undefined,
					opts: { group?: string; agent?: string; limit?: string },
				) => {
					// Both refusals — naming both references or neither, and a
					// conversation id the wire would not read as a UUID — are decided
					// in rine-core before a request is spent, and spell the parameters
					// the way this surface takes them. 🔴 Ordered BEFORE `actingAgent()`,
					// which fetches this org's agents: a refusal advertised as costing
					// nothing must actually cost nothing. `rine-mcp` orders it the same
					// way (`src/tools/messaging-thread.ts`) and says so there too.
					const ref = resolveThreadRef(
						{ group: opts.group, conversationId },
						THREAD_REF_SURFACES.cli,
					);
					const agentId = await actingAgent();
					const data = await readThreadPage(client, ref, {
						...(opts.limit ? { limit: opts.limit } : {}),
						extraHeaders: { [ACTING_AGENT_HEADER]: agentId },
					});

					// The plural call is the render boundary: it decrypts the rows
					// concurrently, and owns the one decision this map could not — a transcript of unopenable group messages says
					// why once, then marks, instead of repeating a paragraph per row.
					const entries = await decryptThreadRows(
						configDir,
						agentId,
						data.messages ?? [],
						client,
					);

					if (gOpts.json) {
						printJson(entries);
					} else {
						printTable(entries.map(threadRow));
					}
				},
			),
		);
}

export function registerMessages(program: Command): void {
	addMessageCommands(program, program);

	const message = program
		.command("message")
		.description("Message operations (aliases: send/read/inbox/reply)");
	addMessageCommands(message, program);
}
