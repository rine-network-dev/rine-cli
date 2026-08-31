import * as fs from "node:fs";
import {
	type HttpClient,
	type MessageRead,
	ACTING_AGENT_HEADER,
	MlsInitInFlightError,
	type PaginatedResponse,
	RineApiError,
	agentKeysExist,
	assertNoMlsDowngrade,
	decryptThreadRows,
	encryptGroupMessage,
	encryptMessage,
	encryptMlsGroupMessage,
	fetchRecipientKeys,
	groupAcceptsMlsSendOnly,
	isNoMlsStateError,
	normalizeHandle,
	processMlsWelcomes,
	readThreadPage,
	resolveGroupByHandle,
	resolveThreadRef,
	resolveToUuid,
	syncMlsGroup,
	THREAD_REF_SURFACES,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorAliasOption, actorOption } from "../actor.js";
import { announceHandleCompletion } from "../handle-completion.js";
import { printError, printJson, printTable, printText } from "../output.js";
import { x402SendExtras } from "../x402.js";
import {
	GROUP_REFERENCE_HELP,
	withEvictionPointerIfHeld,
} from "./group-target.js";
import { addReadCommand } from "./messages-read.js";
import { inboxRow, sendRow, threadRow } from "./messages-rows.js";
import { getOrCreateSenderKey } from "./sender-key-ops.js";

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
	const hdrs = { [ACTING_AGENT_HEADER]: senderAgentId };
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
		// The predicate rine-core owns, not a copy of its message text.
		if (isNoMlsStateError(err)) {
			// Scoped, because unlike the pre-sync above this call is UNCAUGHT: left
			// unscoped it raises whichever refusal arrived first in the pass, so a
			// substituted Welcome for some other group would abort this send with
			// that group's text. `forGroup` narrows only which refusal is the answer
			// to THIS caller's question — every Welcome in the batch still installs.
			// The Python twin reaches the same scoping via `install_mls_state`.
			await processMlsWelcomes(configDir, senderAgentId, client, {
				forGroup: groupId,
			});
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
	addReadCommand(parent, program);

	parent
		.command("send")
		.description("Send an encrypted message")
		.requiredOption(
			"--to <address>",
			// 🔴 It advertises no BARE name, and that ring-fence is narrower than it
			// once was. `#logistics` — the sigil, no `@` — already resolves here:
			// the sigil is what files a send as a group (below), and
			// `resolveGroupByHandle`'s fallback retries a handle's local part
			// against the org's own groups. The help advertises that shipped
			// spelling; it widens no behaviour.
			//
			// 🔴 The bare-name rule is untouched by that, and this sentence must keep
			// saying so: a bare `logistics`, no sigil, is an AGENT on this surface and
			// is sent as `to_agent_id`. So the ring-fence now reads
			// narrower and still holds — the CLI advertises and resolves
			// `#logistics`, and advertises and resolves NEITHER a bare `logistics`
			// as a group. A later migration will be tempted to erase the second
			// half; it is a decision nobody has taken, not an omission.
			"Recipient: an agent handle (kofi@acme.rine.network), an agent ID, or a group — by handle (#logistics@acme.rine.network) or by sigiled name (#logistics)",
		)
		.option("--type <type>", "Message type (default: rine.v1.dm)")
		.option("--payload <json>", "Message payload as JSON string")
		.option(
			"--payload-file <path>",
			"Read payload JSON from file (use - for stdin)",
		)
		.addOption(actorOption("which agent is acting, and sends"))
		.addOption(
			actorAliasOption(
				"--from <address>",
				"which agent is acting — the retired spelling of --agent (handle or agent ID)",
			),
		)
		.option("--idempotency-key <key>", "Idempotency key header")
		.option(
			"--no-marker",
			"For x402 message types: omit the cleartext status marker",
		)
		.action(
			withClient(
				program,
				async (
					ctx,
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
					const { client, gOpts, configDir, apiUrl, actingAgent } = ctx;
					const result = resolvePayload(opts.payload, opts.payloadFile);
					if ("error" in result) {
						printError(result.error);
						process.exitCode = 2;
						return;
					}
					const parsedPayload = result.parsed;

					const to = normalizeHandle(opts.to);
					const from = opts.from ? normalizeHandle(opts.from) : opts.from;

					// One ladder, whichever spelling named the sender: `--agent`,
					// the retired `--from`, the program's `--as`, `RINE_AGENT`, or
					// the org's only agent. `withClient` pinned `X-Rine-Agent`
					// while resolving, so nothing here has to carry it per call.
					const senderAgentId = await actingAgent();

					const extraHeaders: Record<string, string> = {};
					if (opts.idempotencyKey) {
						extraHeaders["Idempotency-Key"] = opts.idempotencyKey;
					}

					// 🔴 The sigil decides this, not the `@`. A group is named
					// `#logistics@acme.rine.network` OR `#logistics` — the second
					// spelling has no `@`, and reading only the `@` filed it as an
					// agent id: `#logistics` became `recipientAgentId` and, below,
					// `to_agent_id`, while the group branch also set `to_handle`.
					// `MessageCreate.check_exactly_one_destination` refuses both
					// (`schemas.py`: "Provide exactly one of to_agent_id or
					// to_handle, not both") — after the message has been sealed.
					// The bare-name rule is untouched: a BARE `logistics`, no sigil, is still an
					// agent on this surface and still resolves as one.
					const isGroupSend = to.startsWith("#");

					// Resolve recipient ID for key fetch. A group has no recipient
					// agent — its key comes from the group, not from an agent row.
					let recipientAgentId: string | undefined;
					if (isGroupSend) {
						recipientAgentId = undefined;
					} else if (!to.includes("@")) {
						recipientAgentId = to;
					} else {
						// 🔴 Item 18. `rine send` is the call site where a silent
						// completion costs most: the message goes to whoever the
						// completed handle names, and the caller is told nothing.
						//
						// 🔴 `opts.to`, NOT `to`. This surface is the one that
						// normalises ahead of the branch — line 190 — so `to` is
						// already the completed spelling and comparing it against its
						// own normalisation can never differ. Handed `to`, the notice
						// is dead code that reads exactly like a working one.
						announceHandleCompletion(opts.to);
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

					// The group arm sets `to_handle` from the RESOLVED row below and
					// must not set a destination here — setting one makes the body
					// carry two, which the server refuses outright.
					if (!isGroupSend) {
						if (to.includes("@")) {
							body.to_handle = to;
						} else {
							body.to_agent_id = to;
						}
					}

					if (from?.includes("@")) {
						body.from_handle = from;
					}

					if (isGroupSend) {
						// Resolve the group once: the server's account of its encryption
						// is the only one a client gets, and both the guard and the
						// branch read it.
						//
						// 🔴 The refusal is widened the same way the twelve member-ladder
						// verbs widen theirs. `send` does not climb that
						// ladder — it resolves the handle here — so without this an
						// evicted agent gets the pointer from `rine group get` and a bare
						// roster refusal from `rine send`, on the same spelling of the
						// same group. The acting agent is already resolved above, so the
						// gate costs no round trip here at all.
						const group = await resolveGroupByHandle(client, to).catch(
							async (err): Promise<never> => {
								throw await withEvictionPointerIfHeld(ctx, err);
							},
						);
						// 🔴 The wire carries the group the SERVER holds, never the
						// spelling that was typed. `POST /messages` looks `to_handle`
						// up by exact equality, and the handle fallback exists precisely
						// because the two can differ — it resolves a handle whose ORG
						// half is wrong, which is what a shortened or half-remembered
						// handle is. Posting `to` sends that spelling: the message is
						// sealed for the right group and then refused with a bare
						// `Group not found`. The resolve alone was never the whole fix.
						body.to_handle = group.handle;
						// The SEND question, not the render question;
						// `groupAcceptsMlsSendOnly` documents why `mls_group_id` alone
						// walks into a server 409 during the init window.
						const mlsOnly = groupAcceptsMlsSendOnly(group);

						// The guard goes HERE, between the resolve and the branch,
						// because reaching the sender-key branch has already leaked the
						// key (`assertNoMlsDowngrade`). No fallback, no sender-key retry.
						assertNoMlsDowngrade(configDir, senderAgentId, group.id, mlsOnly);

						if (mlsOnly) {
							if (group.mls_group_id == null)
								throw new MlsInitInFlightError(to);
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
								group.handle,
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
					} else if (recipientAgentId) {
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
			"Show the both-sided, decrypted transcript of a conversation or a group (role-tagged)",
		)
		// Optional, and still first: every existing `rine thread <id>` call is
		// unchanged. A group is named the way every other group verb takes it.
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
					// concurrently exactly as before, and owns the one decision this
					// map could not — a transcript of unopenable group messages says
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
