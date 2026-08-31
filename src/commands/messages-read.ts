/**
 * `rine message read` — fetch one message and open it.
 *
 * Split out of `messages.ts` because the decrypt-and-render pipeline is the
 * longest handler there by a wide margin and has nothing to do with sending.
 * The command is registered by `messages.ts` alongside its siblings, so the
 * CLI surface is unchanged.
 */

import {
	type MessageRead,
	MLS_EVICTED_BY_COMMIT,
	THREAD_UNAVAILABLE,
	agentKeysExist,
	ingestSenderKeyDistribution,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printError, printJson, printTable, printText } from "../output.js";
import { type DecryptRefusal, openMessage } from "./messages-read-decrypt.js";
import { msgFrom, msgGroup, msgTo, verifiedMark } from "./messages-rows.js";

/** Register `read` on the `message` command group. */
export function addReadCommand(parent: Command, program: Command): void {
	parent
		.command("read")
		.description("Read and decrypt a message by ID")
		.argument("<message-id>", "Message ID")
		.addOption(actorOption(
			"which agent is acting, and whose key decrypts (name, handle, or agent ID)",
		))
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, actingAgent },
					messageId: string,
					
				) => {
					// Resolved BEFORE the fetch (see `ActorLadder.actingAgent`) —
					// this command's whole job is the read, so a bare GET here
					// would show the message and mark nothing.
					const agentId = await actingAgent();

					const data = (await client.get(
						`/messages/${messageId}`,
					)) as MessageRead;

					// The envelope's claim of authorship is checked against the sender the
					// server authenticated. Without one the message is shown as it
					// arrived — encrypted — rather than opened on trust.
					const fromAgentId = data.from_agent_id;
					const canDecrypt =
						fromAgentId !== undefined &&
						(data.encryption_version === "hpke-v1" ||
							data.encryption_version === "hpke-hybrid-v1" ||
							data.encryption_version === "sender-key-v1" ||
							data.encryption_version === "mls-v1") &&
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
						// envelope at the end — never both, and no longer neither.
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
									{
										ID: data.id,
										"Conversation ID": data.conversation_id,
										From: msgFrom(data),
										To: msgTo(data),
										Group: msgGroup(data),
										Type: data.type,
										Verified: verifiedMark(decResult.verificationStatus),
										// A row that opened and withheld its content — an
										// authenticity refusal, which has no remedy to name and keeps
										// the sentinel every surface renders for it. A missing sender
										// key never reaches this cell: it leaves no result at all and
										// falls through to the raw table below.
										Payload:
											decResult.plaintext?.slice(0, 200) ?? THREAD_UNAVAILABLE,
										Created: data.created_at,
									},
								]);
							}
							return;
						}
					}

					// Fallback: show raw encrypted data
					if (gOpts.json) {
						// Why it stayed closed is a fact about this read, and a `--json`
						// caller could not learn it at all before — the reason went to stderr
						// as prose, or nowhere. `decrypt_error_code` is the same field, under
						// the same name, that both SDKs carry.
						printJson({
							...data,
							...(refusal !== null
								? {
										decrypt_error: refusal.message,
										decrypt_error_code: refusal.code,
									}
								: {}),
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
								Encryption: data.encryption_version,
								"Encrypted Payload": `${data.encrypted_payload.slice(0, 40)}...`,
								Created: data.created_at,
							},
						]);
					}
				},
			),
		);
}
