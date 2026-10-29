/** `rine reply` — answer one message, sealed for its sender. */

import {
	type MessageRead,
	RineApiError,
	agentKeysExist,
	controlFrameReplyRefusal,
	isControlFrameType,
	sealForAgent,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printError } from "../output.js";
import { resolvePayload } from "./messages-payload.js";
import { printSent } from "./messages-rows.js";

/** Register `reply` on the `message` command group. */
export function addReplyCommand(parent: Command, program: Command): void {
	parent
		.command("reply")
		.description("Reply to a message (encrypted)")
		.argument("<message-id>", "Message ID to reply to")
		.addOption(actorOption("which agent is acting, and replies"))
		.option("--type <type>", "Message type (defaults to original message type)")
		.option("--payload <json>", "Reply payload as JSON string")
		.option(
			"--payload-file <path>",
			"Read payload JSON from file (use - for stdin)",
		)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, actingAgent },
					messageId: string,
					opts: { type?: string; payload?: string; payloadFile?: string },
				) => {
					const result = resolvePayload(opts.payload, opts.payloadFile);
					if ("error" in result) {
						printError(result.error);
						process.exitCode = 2;
						return;
					}
					const parsedPayload = result.parsed;

					// Resolved BEFORE the fetch (see `ActorLadder.actingAgent`) —
					// answering a message is also how it gets marked read.
					const senderAgentId = await actingAgent();

					// Fetch the original message to get the sender (our reply recipient)
					const original = (await client.get(
						`/messages/${messageId}`,
					)) as MessageRead;

					// A reply mirrors the original's type, so an answer to a control
					// frame would travel labelled as one; the server accepts it, so
					// the refusal is here, whatever `--type` says.
					if (isControlFrameType(original.type)) {
						printError(controlFrameReplyRefusal(original.type));
						process.exitCode = 1;
						return;
					}

					if (original.from_agent_id === senderAgentId) {
						printError(
							"Cannot reply to your own message. Use 'rine send' to follow up in this conversation.",
						);
						process.exitCode = 1;
						return;
					}

					const recipientAgentId = original.from_agent_id;

					const resolvedType = opts.type ?? original.type;

					try {
						const body: Record<string, unknown> = { type: resolvedType };

						if (
							!recipientAgentId ||
							!agentKeysExist(configDir, senderAgentId)
						) {
							throw new Error(
								"Cannot reply: encryption keys unavailable. " +
									"Run 'rine org recover' to restore this agent's keys.",
							);
						}
						Object.assign(
							body,
							await sealForAgent(
								client,
								configDir,
								{ senderAgentId, recipientAgentId },
								parsedPayload,
							),
						);

						const data = (await client.post(
							`/messages/${messageId}/reply`,
							body,
						)) as MessageRead;

						printSent(data, gOpts.json);
					} catch (err) {
						if (err instanceof RineApiError && err.status === 409) {
							printError("Conversation is closed");
						} else {
							throw err;
						}
						process.exitCode = 1;
					}
				},
			),
		);
}
