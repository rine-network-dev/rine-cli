import * as fs from "node:fs";
import {
	type GroupRead,
	type HttpClient,
	type ListResponse,
	type MessageRead,
	type PaginatedResponse,
	RineApiError,
	type ThreadRow,
	type ThreadRowEntry,
	agentKeysExist,
	decryptGroupMessage,
	decryptMessage,
	decryptThreadRow,
	encryptGroupMessage,
	encryptMessage,
	encryptMlsGroupMessage,
	fetchAgents,
	fetchRecipientKeys,
	ingestSenderKeyDistribution,
	normalizeHandle,
	processMlsWelcomes,
	resolveAgent,
	resolveToUuid,
	syncMlsGroup,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printError, printJson, printTable, printText } from "../output.js";
import { x402SendExtras } from "../x402.js";
import {
	fetchAndIngestPendingSKDistributions,
	getOrCreateSenderKey,
} from "./sender-key-ops.js";

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
		Status: (m.status ?? "new").toUpperCase(),
		Created: m.created_at,
	};
}

/** One thread turn rendered as a role-tagged row (`[sent]` you / `[received]`). */
function threadRow(e: ThreadRowEntry): Record<string, unknown> {
	const who = e.direction === "sent" ? "you" : (e.sender_handle ?? "unknown");
	return {
		Direction: `[${e.direction}]`,
		From: who,
		Type: e.type,
		Verified:
			e.verification_status === "verified"
				? "✓"
				: e.verification_status === "invalid"
					? "✗ INVALID"
					: "?",
		Text: e.text,
		Created: e.created_at,
	};
}

function resolvePayload(
	payload?: string,
	payloadFile?: string,
): { parsed: unknown } | { error: string } {
	if (payload !== undefined && payloadFile !== undefined) {
		return { error: "--payload and --payload-file are mutually exclusive" };
	}
	if (payload === undefined && payloadFile === undefined) {
		return { error: "Provide --payload or --payload-file" };
	}

	let raw: string;
	if (payloadFile !== undefined) {
		try {
			raw =
				payloadFile === "-"
					? fs.readFileSync(0, "utf-8")
					: fs.readFileSync(payloadFile, "utf-8");
		} catch (err) {
			return {
				error: `Cannot read payload file: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	} else {
		raw = payload!;
	}

	try {
		return { parsed: JSON.parse(raw) };
	} catch {
		return { error: "Payload must be valid JSON" };
	}
}

async function resolveGroup(
	client: HttpClient,
	handle: string,
): Promise<GroupRead> {
	const list = (await client.get("/groups", {
		handle,
	})) as ListResponse<GroupRead>;
	const group = list.items?.[0];
	if (!group) throw new Error(`Group not found: ${handle}`);
	return group;
}

// MLS group send: always sync to the latest epoch before encrypting so that
// newer members (who joined via external commit) can decrypt.  If no local
// state exists yet, install pending welcomes + sync, then encrypt.
async function encryptMlsWithRecovery(
	client: HttpClient,
	configDir: string,
	senderAgentId: string,
	groupId: string,
	payload: unknown,
): Promise<ReturnType<typeof encryptMlsGroupMessage>> {
	const hdrs = { "X-Rine-Agent": senderAgentId };
	// Pre-sync: advance local epoch so we encrypt at the group's current state.
	// Failures are non-fatal — the "No MLS state" recovery below handles them.
	await processMlsWelcomes(configDir, senderAgentId, client).catch(() => {});
	await syncMlsGroup(configDir, senderAgentId, groupId, client, hdrs).catch(
		() => {},
	);

	try {
		return await encryptMlsGroupMessage(
			configDir,
			senderAgentId,
			groupId,
			payload,
		);
	} catch (err) {
		if (
			err instanceof Error &&
			err.message.startsWith("No MLS state for group")
		) {
			await processMlsWelcomes(configDir, senderAgentId, client);
			await syncMlsGroup(configDir, senderAgentId, groupId, client, hdrs);
			return await encryptMlsGroupMessage(
				configDir,
				senderAgentId,
				groupId,
				payload,
			);
		}
		throw err;
	}
}

function addMessageCommands(parent: Command, program: Command): void {
	parent
		.command("send")
		.description("Send an encrypted message")
		.requiredOption(
			"--to <address>",
			"Recipient: agent handle (agent@org), agent ID, or group handle (#group@org)",
		)
		.option("--type <type>", "Message type (default: rine.v1.dm)")
		.option("--payload <json>", "Message payload as JSON string")
		.option(
			"--payload-file <path>",
			"Read payload JSON from file (use - for stdin)",
		)
		.option("--from <address>", "Sender: agent handle (agent@org) or agent ID")
		.option("--idempotency-key <key>", "Idempotency key header")
		.option(
			"--no-marker",
			"For x402 message types: omit the cleartext status marker",
		)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, apiUrl },
					opts: {
						to: string;
						type?: string;
						payload?: string;
						payloadFile?: string;
						from?: string;
						idempotencyKey?: string;
						marker?: boolean;
					},
				) => {
					const result = resolvePayload(opts.payload, opts.payloadFile);
					if ("error" in result) {
						printError(result.error);
						process.exitCode = 2;
						return;
					}
					const parsedPayload = result.parsed;

					const to = normalizeHandle(opts.to);
					const from = opts.from ? normalizeHandle(opts.from) : opts.from;

					const extraHeaders: Record<string, string> = {};
					let senderAgentId: string | undefined;

					if (from !== undefined) {
						senderAgentId = await resolveToUuid(apiUrl, from);
						extraHeaders["X-Rine-Agent"] = senderAgentId;
					} else if (!gOpts.as) {
						const agents = await fetchAgents(client);
						senderAgentId = await resolveAgent(
							apiUrl,
							agents,
							undefined,
							undefined,
						);
						extraHeaders["X-Rine-Agent"] = senderAgentId;
					} else {
						const agents = await fetchAgents(client);
						senderAgentId = await resolveAgent(
							apiUrl,
							agents,
							undefined,
							gOpts.as,
						);
					}

					if (opts.idempotencyKey) {
						extraHeaders["Idempotency-Key"] = opts.idempotencyKey;
					}

					// Resolve recipient ID for key fetch
					let recipientAgentId: string | undefined;
					if (!to.includes("@")) {
						recipientAgentId = to;
					} else if (!to.startsWith("#")) {
						recipientAgentId = await resolveToUuid(apiUrl, to);
					}

					// Build body with encryption
					const resolvedType = opts.type ?? "rine.v1.dm";
					const body: Record<string, unknown> = { type: resolvedType };

					// x402 types (quote/payment/receipt) carry cleartext extras: the
					// content_type/payload_schema descriptors and the optional coarse
					// status marker. rine-core validates the verbatim payload + builds
					// these; a non-x402 type returns null and sends unchanged.
					const x402 = x402SendExtras(
						resolvedType,
						parsedPayload,
						opts.marker !== false,
					);
					if (x402) {
						body.content_type = x402.content_type;
						body.payload_schema = x402.payload_schema;
						if (x402.metadata) body.metadata = x402.metadata;
					}

					if (to.includes("@")) {
						body.to_handle = to;
					} else {
						body.to_agent_id = to;
					}

					if (from?.includes("@")) {
						body.from_handle = from;
					}

					const isGroupSend = to.startsWith("#");

					if (isGroupSend && senderAgentId) {
						const group = await resolveGroup(client, to);
						if (group.mls_group_id) {
							// MLS-active group: use MLS encryption (keyed by rine group UUID)
							const encResult = await encryptMlsWithRecovery(
								client,
								configDir,
								senderAgentId,
								group.id,
								parsedPayload,
							);
							Object.assign(body, encResult);
						} else {
							// Sender-key group: use sender-key encryption
							const { state, groupId } = await getOrCreateSenderKey(
								client,
								configDir,
								senderAgentId,
								to,
								Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
							);
							const { result: encResult } = await encryptGroupMessage(
								configDir,
								senderAgentId,
								groupId,
								state,
								parsedPayload,
							);
							Object.assign(body, encResult);
						}
					} else if (senderAgentId && recipientAgentId) {
						// Direct send: use HPKE encryption (hybrid PQ when available)
						const recipientKeys = await fetchRecipientKeys(
							client,
							recipientAgentId,
						);
						const encrypted = await encryptMessage(
							configDir,
							senderAgentId,
							recipientKeys.encryption,
							parsedPayload,
							recipientKeys.pqEncryption,
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
					{ client, gOpts, configDir, apiUrl },
					messageId: string,
					opts: { agent?: string },
				) => {
					const data = (await client.get(
						`/messages/${messageId}`,
					)) as MessageRead;

					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);

					const canDecrypt =
						(data.encryption_version === "hpke-v1" ||
							data.encryption_version === "hpke-hybrid-v1" ||
							data.encryption_version === "sender-key-v1" ||
							data.encryption_version === "mls-v1") &&
						agentKeysExist(configDir, agentId);

					if (canDecrypt) {
						let decResult:
							| Awaited<ReturnType<typeof decryptMessage>>
							| undefined;

						if (
							(data.encryption_version === "sender-key-v1" ||
								data.encryption_version === "mls-v1") &&
							data.group_id
						) {
							try {
								decResult = await decryptGroupMessage(
									configDir,
									agentId,
									data.group_id,
									data.encrypted_payload,
									client,
								);
							} catch (err) {
								// Auto-recover: fetch missing sender keys and retry once
								const match =
									err instanceof Error &&
									err.message.match(/^unknown sender key id: (.+)$/);
								if (match) {
									const ingested = await fetchAndIngestPendingSKDistributions(
										client,
										configDir,
										agentId,
										match[1],
									);
									if (ingested > 0) {
										try {
											decResult = await decryptGroupMessage(
												configDir,
												agentId,
												data.group_id,
												data.encrypted_payload,
												client,
											);
										} catch (retryErr) {
											if (!gOpts.json) {
												printError(
													`Decryption failed after auto-ingest: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
												);
											}
										}
									} else if (!gOpts.json) {
										printError(`Decryption failed: ${err.message}`);
									}
								} else if (!gOpts.json) {
									printError(
										`Decryption failed: ${err instanceof Error ? err.message : String(err)}`,
									);
								}
							}
						} else {
							try {
								decResult = await decryptMessage(
									configDir,
									agentId,
									data.encrypted_payload,
									client,
								);
							} catch (err) {
								if (!gOpts.json) {
									printError(
										`Decryption failed: ${err instanceof Error ? err.message : String(err)}`,
									);
								}
							}
						}

						if (decResult) {
							if (
								ingestSenderKeyDistribution(
									configDir,
									agentId,
									data.type,
									decResult,
								)
							) {
								printText("Sender key ingested");
							}

							if (gOpts.json) {
								printJson({
									...data,
									decrypted_payload: JSON.parse(decResult.plaintext),
									signature_verified: decResult.verified,
									verification_status: decResult.verificationStatus,
									sender_kid: decResult.senderKid,
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
										Verified:
											decResult.verificationStatus === "verified"
												? "\u2713"
												: decResult.verificationStatus === "invalid"
													? "\u2717 INVALID"
													: "?",
										Payload: decResult.plaintext.slice(0, 200),
										Created: data.created_at,
									},
								]);
							}
							return;
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
		.option("--new", "Show only new (undelivered) messages")
		.option("--delivered", "Show only delivered messages")
		.option("--read", "Show only read messages")
		.option("--limit <n>", "Maximum number of messages to return")
		.option("--cursor <cursor>", "Pagination cursor")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, apiUrl },
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

					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);

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
					{ client, gOpts, configDir, apiUrl },
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

					// Fetch the original message to get the sender (our reply recipient)
					const original = (await client.get(
						`/messages/${messageId}`,
					)) as MessageRead;

					const agents = await fetchAgents(client);
					const senderAgentId = await resolveAgent(
						apiUrl,
						agents,
						undefined,
						gOpts.as,
					);

					if (original.from_agent_id === senderAgentId) {
						console.error(
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
									"Run 'rine keys generate' first.",
							);
						}
						const recipientKeys = await fetchRecipientKeys(
							client,
							recipientAgentId,
						);
						const encrypted = await encryptMessage(
							configDir,
							senderAgentId,
							recipientKeys.encryption,
							parsedPayload,
							recipientKeys.pqEncryption,
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

	parent
		.command("thread")
		.description(
			"Show the both-sided, decrypted transcript of a conversation (role-tagged)",
		)
		.argument("<conversation-id>", "Conversation ID")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.option("--limit <n>", "Max turns to return (most-recent window)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, apiUrl },
					conversationId: string,
					opts: { agent?: string; limit?: string },
				) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);

					const params: Record<string, string | number> = {};
					if (opts.limit) params.limit = opts.limit;
					const data = (await client.get(
						`/conversations/${conversationId}/messages`,
						params,
						{ "X-Rine-Agent": agentId },
					)) as { messages: ThreadRow[]; truncated?: boolean };

					const entries = await Promise.all(
						(data.messages ?? []).map((row) =>
							decryptThreadRow(configDir, agentId, row, client),
						),
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
