import type { Command } from "commander";
import {
	type AgentRead,
	buildPeerVerification,
	compareVerificationWordsForAgent,
	peerVerificationLines,
	recordPeerVerification,
	resolveToUuid,
} from "@rine-network/core";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { announceHandleCompletion } from "../handle-completion.js";
import { printError, printJson, printSuccess, printText } from "../output.js";
import { promptConfirm } from "../prompt.js";

/**
 * `rine agent verify <peer>` — the out-of-band compare/confirm flow.
 *
 * Verification words recomputed locally show that this config dir and the
 * server agree about **this** agent's signing key. They show nothing about a
 * peer: a peer's words and any key that could be fetched for it both come from
 * the same server. Two operators reading five words to each other is what
 * closes that, and this verb puts the two strings side by side and remembers
 * that it happened.
 *
 * Advisory by design. A peer that has never been confirmed is still reachable
 * and still sends — this is a display of key agreement, not an access control.
 */
export function registerAgentVerify(program: Command, agent: Command): void {
	agent
		.command("verify")
		.description(
			"Compare a peer's verification words with this agent's, and record the result",
		)
		.argument("<peer>", "Peer handle (e.g. bot@acme) or agent UUID")
		.addOption(actorOption(
			"which agent is acting, and whose words these are (name, handle, or agent ID)",
		))
		.option("--yes", "Record the confirmation without prompting")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, apiUrl, actingAgent, agents },
					peer: string,
					opts: { agent?: string; yes?: boolean },
				) => {
					const ownId = await actingAgent();
					const own = (await agents()).find((a: AgentRead) => a.id === ownId);
					announceHandleCompletion(peer);
					const peerId = await resolveToUuid(apiUrl, peer);

					if (peerId.toLowerCase() === ownId.toLowerCase()) {
						printError(
							"That is this agent. Words are confirmed with another operator, not with yourself.",
						);
						process.exitCode = 2;
						return;
					}

					const state = await buildPeerVerification(
						client,
						configDir,
						ownId,
						peerId,
					);
					const comparison = compareVerificationWordsForAgent(
						configDir,
						ownId,
						own?.verification_words,
					);

					if (!gOpts.json) {
						for (const line of peerVerificationLines(
							state,
							comparison,
							own?.handle ?? ownId,
						)) {
							printText(line);
						}
					}

					// JSON mode never prompts — a machine-read verb has no operator to
					// ask — so it records only under --yes.
					const words = state.peer.words;
					let recorded = false;
					if (words !== null) {
						if (opts.yes) {
							recorded = true;
						} else if (!gOpts.json) {
							printText("");
							recorded = await promptConfirm(
								"Did the peer's operator read back the same words?",
							);
						}
						if (recorded) {
							recordPeerVerification(configDir, ownId, {
								peerAgentId: state.peerAgentId,
								handle: state.peer.handle,
								words,
							});
						}
					}

					if (gOpts.json) {
						printJson({
							agent: { id: ownId, handle: own?.handle ?? null },
							peer: {
								agent_id: state.peerAgentId,
								handle: state.peer.handle,
								verification_words: words,
								card_published: state.peer.published,
								card_unreadable: state.peer.unreadable,
							},
							verification: comparison,
							confirmed: state.confirmed,
							words_changed_since_confirmed: state.wordsChangedSinceConfirmed,
							recorded,
						});
						return;
					}
					if (words === null) {
						printText("");
						printText(
							"Their card names no words, so there is nothing to record.",
						);
					} else if (recorded) {
						printSuccess(
							`Confirmed ${state.peer.handle ?? state.peerAgentId}. Run this again if their card changes.`,
						);
					} else {
						printText("Nothing recorded.");
					}
				},
			),
		);
}
