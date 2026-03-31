import type { Command } from "commander";
import { withClient } from "../action.js";
import type { MessageRead, PaginatedResponse } from "../api-types.js";
import { ingestSenderKeyDistribution } from "../crypto/ingest.js";
import { agentKeysExist } from "../crypto/keys.js";
import {
	decryptGroupMessage,
	decryptMessage,
	encryptGroupMessage,
	encryptMessage,
	fetchRecipientEncryptionKey,
} from "../crypto/message.js";
import { RineApiError } from "../errors.js";
import { printError, printJson, printTable, printText } from "../output.js";
import { resolveAgent, resolveToUuid } from "../resolve-agent.js";
import { getOrCreateSenderKey } from "./sender-key-ops.js";

function msgFrom(m: MessageRead): string {
	return m.sender_handle ?? m.from_agent_id ?? "";
}

function msgTo(m: MessageRead): string {
	return m.recipient_handle ?? m.to_agent_id ?? "";
}

function msgGroup(m: MessageRead): string {
	return m.group_handle ?? "";
}

function sendRow(m: MessageRead): Record<string, unknown> {
	return {
		ID: m.id,
		"Conversation ID": m.conversation_id,
		From: msgFrom(m),
		To: msgTo(m),
		Group: msgGroup(m),
		Type: m.type,
		Created: m.created_at,
	};
}

function inboxRow(m: MessageRead): Record<string, unknown> {
	return {
		ID: m.id,
		From: msgFrom(m),
		Group: msgGroup(m),
		Type: m.type,
		Encryption: m.encryption_version,
		Created: m.created_at,
	};
}

function addMessageCommands(parent: Command, program: Command): void {
	parent
		.command("send")
		.description("Send an encrypted message")
		.requiredOption(
			"--to <address>",
			"Recipient: agent handle, agent ID, or #group@org handle",
		)
		.requiredOption("--type <type>", "Message type (e.g. rine.v1.task_request)")
		.requiredOption("--payload <json>", "Message payload as JSON string")
		.option("--from <address>", "Sender address (agent ID or handle with @)")
		.option("--idempotency-key <key>", "Idempotency key header")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					opts: {
						to: string;
						type: string;
						payload: string;
						from?: string;
						idempotencyKey?: string;
					},
				) => {
					let parsedPayload: unknown;
					try {
						parsedPayload = JSON.parse(opts.payload);
					} catch {
						printError("--payload must be valid JSON");
						process.exitCode = 2;
						return;
					}

					const extraHeaders: Record<string, string> = {};
					let senderAgentId: string | undefined;

					if (opts.from !== undefined) {
						senderAgentId = await resolveToUuid(opts.from);
						extraHeaders["X-Rine-Agent"] = senderAgentId;
					} else if (!gOpts.as) {
						senderAgentId = await resolveAgent(client, undefined, undefined);
						extraHeaders["X-Rine-Agent"] = senderAgentId;
					} else {
						senderAgentId = await resolveToUuid(gOpts.as);
					}

					if (opts.idempotencyKey) {
						extraHeaders["Idempotency-Key"] = opts.idempotencyKey;
					}

					// Resolve recipient ID for key fetch
					let recipientAgentId: string | undefined;
					if (!opts.to.includes("@")) {
						recipientAgentId = opts.to;
					} else if (!opts.to.startsWith("#")) {
						recipientAgentId = await resolveToUuid(opts.to);
					}

					// Build body with encryption
					const body: Record<string, unknown> = { type: opts.type };

					if (opts.to.includes("@")) {
						body.to_handle = opts.to;
					} else {
						body.to_agent_id = opts.to;
					}

					if (opts.from?.includes("@")) {
						body.from_handle = opts.from;
					}

					const isGroupSend = opts.to.startsWith("#");

					if (isGroupSend && senderAgentId) {
						// Group send: use sender-key encryption
						const { state, groupId } = await getOrCreateSenderKey(
							client,
							senderAgentId,
							opts.to,
							Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
						);
						const { result } = await encryptGroupMessage(
							senderAgentId,
							groupId,
							state,
							parsedPayload,
						);
						Object.assign(body, result);
					} else if (senderAgentId && recipientAgentId) {
						// Direct send: use HPKE encryption
						const recipientPk = await fetchRecipientEncryptionKey(
							client,
							recipientAgentId,
						);
						const encrypted = await encryptMessage(
							senderAgentId,
							recipientPk,
							parsedPayload,
						);
						Object.assign(body, encrypted);
					} else {
						throw new Error(
							"Cannot encrypt: unable to resolve sender or recipient. " +
							"Use UUIDs or ensure WebFinger is available.",
						);
					}

					const data = (await client.post(
						"/messages",
						body,
						Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
					)) as MessageRead;

					if (gOpts.json) {
						printJson(data);
					} else {
						printTable([sendRow(data)]);
					}
				},
			),
		);

	parent
		.command("read")
		.description("Read and decrypt a message by ID")
		.argument("<message-id>", "Message ID")
		.option("--agent <id>", "Agent ID (for decryption key)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					messageId: string,
					opts: { agent?: string },
				) => {
					const data = (await client.get(
						`/messages/${messageId}`,
					)) as MessageRead;

					const agentId = await resolveAgent(client, opts.agent, gOpts.as);

					const canDecrypt =
						(data.encryption_version === "hpke-v1" ||
							data.encryption_version === "sender-key-v1") &&
						agentKeysExist(agentId);

					if (canDecrypt) {
						try {
							let result: Awaited<ReturnType<typeof decryptMessage>>;
							if (
								data.encryption_version === "sender-key-v1" &&
								data.group_id
							) {
								result = await decryptGroupMessage(
									agentId,
									data.group_id,
									data.encrypted_payload,
									client,
								);
							} else {
								result = await decryptMessage(
									agentId,
									data.encrypted_payload,
									client,
								);
							}

							// Auto-ingest sender key distributions (only from verified senders)
							if (ingestSenderKeyDistribution(agentId, data.type, result)) {
								printText("Sender key ingested");
							}

							if (gOpts.json) {
								printJson({
									...data,
									decrypted_payload: JSON.parse(result.plaintext),
									signature_verified: result.verified,
									verification_status: result.verificationStatus,
									sender_kid: result.senderKid,
								});
							} else {
								printTable([
									{
										ID: data.id,
										"Conversation ID": data.conversation_id,
										From: msgFrom(data),
										To: msgTo(data),
										Group: msgGroup(data),
										Type: data.type,
										Verified: result.verificationStatus === "verified" ? "\u2713" : result.verificationStatus === "invalid" ? "\u2717 INVALID" : "?",
										Payload: result.plaintext.slice(0, 200),
										Created: data.created_at,
									},
								]);
							}
							return;
						} catch (err) {
							if (!gOpts.json) {
								printError(
									`Decryption failed: ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						}
					}

					// Fallback: show raw encrypted data
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable([
							{
								ID: data.id,
								"Conversation ID": data.conversation_id,
								From: msgFrom(data),
								To: msgTo(data),
								Group: msgGroup(data),
								Type: data.type,
								Encryption: data.encryption_version,
								"Encrypted Payload": `${data.encrypted_payload.slice(0, 40)}...`,
								Created: data.created_at,
							},
						]);
					}
				},
			),
		);

	parent
		.command("inbox")
		.description("List inbox messages")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.option("--limit <n>", "Maximum number of messages to return")
		.option("--cursor <cursor>", "Pagination cursor")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					opts: { agent?: string; limit?: string; cursor?: string },
				) => {
					const agentId = await resolveAgent(client, opts.agent, gOpts.as);

					const params: Record<string, string | number | boolean> = {};
					if (opts.limit) params.limit = opts.limit;
					if (opts.cursor) params.cursor = opts.cursor;

					const data = (await client.get(
						`/agents/${agentId}/messages`,
						params,
					)) as PaginatedResponse<MessageRead>;

					if (gOpts.json) {
						printJson(data);
					} else {
						printTable(data.items.map(inboxRow));
						if (data.next_cursor) {
							printText(`Next cursor: ${data.next_cursor}`);
						}
					}
				},
			),
		);

	parent
		.command("reply")
		.description("Reply to a message (encrypted)")
		.argument("<message-id>", "Message ID to reply to")
		.requiredOption("--type <type>", "Message type")
		.requiredOption("--payload <json>", "Reply payload as JSON string")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					messageId: string,
					opts: { type: string; payload: string },
				) => {
					let parsedPayload: unknown;
					try {
						parsedPayload = JSON.parse(opts.payload);
					} catch {
						printError("--payload must be valid JSON");
						process.exitCode = 2;
						return;
					}

					// Fetch the original message to get the sender (our reply recipient)
					const original = (await client.get(
						`/messages/${messageId}`,
					)) as MessageRead;

					const senderAgentId = await resolveAgent(client, undefined, gOpts.as);
					const recipientAgentId = original.from_agent_id;

					try {
						const body: Record<string, unknown> = { type: opts.type };

						if (!recipientAgentId || !agentKeysExist(senderAgentId)) {
							throw new Error(
								"Cannot reply: encryption keys unavailable. " +
								"Run 'rine keys generate' first.",
							);
						}
						const recipientPk = await fetchRecipientEncryptionKey(
							client,
							recipientAgentId,
						);
						const encrypted = await encryptMessage(
							senderAgentId,
							recipientPk,
							parsedPayload,
						);
						Object.assign(body, encrypted);

						const data = (await client.post(
							`/messages/${messageId}/reply`,
							body,
						)) as MessageRead;

						if (gOpts.json) {
							printJson(data);
						} else {
							printTable([sendRow(data)]);
						}
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

export function registerMessages(program: Command): void {
	addMessageCommands(program, program);

	const message = program
		.command("message")
		.description("Message operations (aliases: send/read/inbox/reply)");
	addMessageCommands(message, program);
}
