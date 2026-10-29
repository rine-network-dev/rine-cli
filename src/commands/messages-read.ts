/**
 * `rine message read` — fetch one message and open it: the decrypt-and-render
 * pipeline, which has nothing to do with sending. Registered by `messages.ts`
 * alongside its siblings.
 */

import {
	A2A_CLEARTEXT_NOTICE,
	a2aCleartextPlaintext,
	type MessageRead,
	MLS_EVICTED_BY_COMMIT,
	THREAD_UNAVAILABLE,
	agentKeysExist,
	ingestSenderKeyDistribution,
	isA2aCleartext,
	isDecryptableVersion,
	withPeekHeader,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printError, printJson, printTable, printText } from "../output.js";
import { type DecryptRefusal, openMessage } from "./messages-read-decrypt.js";
import { jsonRow, msgFrom, msgGroup, msgTo, verifiedMark } from "./messages-rows.js";

/**
 * What `read` itself takes, beside the actor flag every verb here declares.
 *
 * A single plain boolean with no `--no-peek` counterpart, deliberately: the
 * default IS today's behaviour, so the negation would only spell out an absence,
 * and a negation pair on a subcommand registered both top-level and nested is
 * the one shape this CLI has already been bitten by — `discover agents
 * --no-verified` is still broken for exactly that reason.
 */
interface ReadOpts {
	/**
	 * Read the message WITHOUT consuming it.
	 *
	 * A read marks the message delivered whether or not it decrypts, and there
	 * is no route that un-marks one — so a message this agent's keys cannot open
	 * disappears from `--new`, `/poll` and the stream's catch-up after a single
	 * look, while staying fetchable only by an id the caller has to have kept.
	 * `--peek` is how a caller declines that: `X-Rine-Peek` suppresses the
	 * delivery mark and nothing else — same authorisation, same body, same
	 * refusals — so the row stays `new` and a later poll is still offered it.
	 */
	peek?: boolean;
}

/** Register `read` on the `message` command group. */
export function addReadCommand(parent: Command, program: Command): void {
	parent
		.command("read")
		.description("Read and decrypt a message by ID")
		.argument("<message-id>", "Message ID")
		.addOption(actorOption(
			"which agent is acting, and whose key decrypts (name, handle, or agent ID)",
		))
		.option(
			"--peek",
			"Read without marking the message delivered (it stays new)",
		)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, actingAgent },
					messageId: string,
					opts: ReadOpts,
				) => {
					// Resolved BEFORE the fetch (see `ActorLadder.actingAgent`) —
					// this command's whole job is the read, so a bare GET here
					// would show the message and mark nothing.
					//
					// 🔴 Resolved on a peek too. Peek changes what the read DOES,
					// never who it is AS: the header still has to name the agent
					// whose key decrypts, and dropping it to avoid the mark would
					// buy that by changing which delivery row is resolved and
					// which authorization path runs.
					const agentId = await actingAgent();

					// 🔴 A FRESH object, never `ctx.extraHeaders`. That one is the
					// client's default headers, held by reference and spread into
					// every later request of this invocation — a peek written
					// there would silently ride the resolves this command makes
					// after the read. Absent, not `"0"`: the server parses both as
					// false, and absent is the untouched-behaviour case.
					const data = (await client.get(
						`/messages/${messageId}`,
						undefined,
						withPeekHeader(undefined, opts.peek),
					)) as MessageRead;

					// The envelope's claim of authorship is checked against the sender the
					// server authenticated. Without one the message is shown as it
					// arrived — encrypted — rather than opened on trust.
					const fromAgentId = data.from_agent_id;
					const canDecrypt =
						fromAgentId !== undefined &&
						isDecryptableVersion(data.encryption_version) &&
						agentKeysExist(configDir, agentId);

					let refusal: DecryptRefusal | null = null;
					if (canDecrypt) {
						const opened = await openMessage({
							client,
							configDir,
							agentId,
							data,
							// Narrowed by `canDecrypt` above.
							fromAgentId: fromAgentId as string,
						});
						const decResult = opened.result;
						refusal = opened.refusal;
						// Prose to stderr for a human, ahead of whatever renders below. A
						// `--json` caller is told the same thing as a field instead, on the
						// envelope at the end — never both, and never neither.
						if (refusal !== null && !gOpts.json) printError(refusal.message);

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
									// Withheld, not empty: an authenticity failure yields the
									// verdict and no content, so there is nothing to parse.
									decrypted_payload:
										decResult.plaintext === undefined
											? null
											: JSON.parse(decResult.plaintext),
									signature_verified: decResult.verified,
									verification_status: decResult.verificationStatus,
									sender_kid: decResult.senderKid,
									// What reading this row did to a closed group's local MLS
									// state — the commits it applied and where they left it.
									// Present whenever this read ran a sync, `processed: 0`
									// included; absent means no sync ran, which is not the
									// claim that this agent is current.
									...(decResult.catchUp
										? { catch_up: decResult.catchUp }
										: {}),
								});
							} else {
								// An eviction applied by THIS read is the one thing a reader
								// cannot afford to learn later: the row opens normally, and it
								// is the next send that is refused. Said in the recovery
								// verbs' own words, from their own constant.
								if (decResult.catchUp?.evicted) {
									printError(MLS_EVICTED_BY_COMMIT);
								}
								printTable([
									openedRow(
										data,
										verifiedMark(decResult.verificationStatus),
										// A row that opened and withheld its content — an
										// authenticity refusal, which has no remedy to name and keeps
										// the sentinel every surface renders for it. A missing sender
										// key never reaches this cell: it leaves no result at all and
										// falls through to the refused table below.
										decResult.plaintext?.slice(0, 200) ?? THREAD_UNAVAILABLE,
									),
								]);
							}
							return;
						}
					}

					if (gOpts.json) {
						// Why it stayed closed is a fact about this read, and a `--json`
						// caller could not learn it at all before — the reason went to stderr
						// as prose, or nowhere. `decrypt_error_code` is the same field, under
						// the same name, that both SDKs carry. The envelope carries
						// `encrypted_payload` in full, so a program loses nothing the
						// human rendering below stopped printing.
						printJson({
							...jsonRow(data),
							...(refusal !== null
								? {
										decrypt_error: refusal.message,
										decrypt_error_code: refusal.code,
									}
								: {}),
						});
					} else if (refusal !== null) {
						// A read that was attempted and refused, rendered in `thread`'s
						// vocabulary rather than as a ciphertext dump: the sentinel every
						// surface prints for content it could not show, and `?` for a
						// signature nothing ever got as far as checking. The reason itself
						// went to stderr above, so the row does not repeat it — and 40
						// characters of base64 was never something a reader could act on.
						printTable([
							openedRow(data, verifiedMark("unverifiable"), THREAD_UNAVAILABLE),
						]);
					} else {
						// No decrypt was attempted at all — no keys, no authenticated
						// sender, or an encryption this build does not open. Nothing is
						// withheld, so the row is what arrived.
						printTable([
							{
								...readRow(data),
								Encryption: data.encryption_version,
								...(isA2aCleartext(data)
									? {
											Notice: A2A_CLEARTEXT_NOTICE,
											Payload: a2aCleartextPlaintext(data).slice(0, 200),
										}
									: {}),
								"Encrypted Payload": `${data.encrypted_payload.slice(0, 40)}...`,
								Created: data.created_at,
							},
						]);
					}
				},
			),
		);
}

/** The columns every rendering of one read shares, in one order. */
function readRow(data: MessageRead): Record<string, unknown> {
	return {
		ID: data.id,
		"Conversation ID": data.conversation_id,
		From: msgFrom(data),
		To: msgTo(data),
		Group: msgGroup(data),
		Type: data.type,
	};
}

/**
 * One row for a message this read tried to open — whether it opened, withheld
 * its content or would not open at all. One shape for all three, so a refused
 * read and a successful one are read off the same columns.
 */
function openedRow(
	data: MessageRead,
	verified: string,
	payload: string,
): Record<string, unknown> {
	return {
		...readRow(data),
		Verified: verified,
		Payload: payload,
		Created: data.created_at,
	};
}
