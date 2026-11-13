/** What a collector does when the server says its chain epoch is old (a restore from a backup). */
import type { ForkPoint } from "@rine-network/core";
import {
	AlertReason,
	type SeqRange,
	TailExit,
	type TailStop,
} from "./tail-alert.js";
import type { ChainPosition } from "./org-events-chain.js";
import type { TailText } from "./tail-text.js";

export type ForkOutcome =
	| { stop: TailStop }
	| { position: ChainPosition | undefined; after: number };

/** The range this collector holds that the restored server no longer has, or null. */
function heldBeyond(
	fork: ForkPoint,
	held: ChainPosition | undefined,
): SeqRange | null {
	if (held === undefined || held.seq <= fork.forkAfterSeq) return null;
	return { from: fork.forkAfterSeq + 1, to: held.seq };
}

/**
 * Without `acceptEpoch` the collector stops (or says it lost nothing, when it holds no event past the fork).
 * With the new epoch accepted it carries on after `fork_after_seq`, requiring the next event to
 * attach to `fork_after_hash`; a position that sits exactly on the fork point must carry that hash.
 */
export function resolveFork(
	fork: ForkPoint,
	held: ChainPosition | undefined,
	after: number,
	oldEpoch: number | undefined,
	acceptEpoch: number | undefined,
	text: TailText,
): ForkOutcome {
	const old = oldEpoch ?? fork.currentEpoch - 1;
	const range = heldBeyond(fork, held);
	if (acceptEpoch !== fork.currentEpoch) {
		const message = (range === null ? text.forkNothingHeld : text.fork)(
			old,
			fork.currentEpoch,
			fork.forkAfterSeq,
		);
		return {
			stop: {
				code: TailExit.Fork,
				reason: AlertReason.Fork,
				text: message,
				extra: {
					old_epoch: old,
					new_epoch: fork.currentEpoch,
					fork_after_seq: fork.forkAfterSeq,
					...(fork.forkAfterHash === undefined
						? {}
						: { fork_after_hash: fork.forkAfterHash }),
					range,
				},
			},
		};
	}
	const epoch = fork.currentEpoch;
	if (held === undefined)
		return { position: undefined, after: Math.min(after, fork.forkAfterSeq) };
	if (range !== null) {
		const position = {
			seq: fork.forkAfterSeq,
			hash: fork.forkAfterHash ?? "",
			chain_epoch: epoch,
		};
		return { position, after: position.seq };
	}
	if (
		held.seq === fork.forkAfterSeq &&
		fork.forkAfterHash !== undefined &&
		held.hash !== fork.forkAfterHash
	)
		return {
			stop: {
				code: TailExit.Chain,
				reason: AlertReason.ChainGap,
				text: text.gap(fork.forkAfterSeq + 1),
			},
		};
	return { position: { ...held, chain_epoch: epoch }, after: held.seq };
}
