/** The page loop: fetch, check the chain, hand to the sink, save the position once it is accepted. */
import {
	type RetentionFloor,
	forkPointOf,
	formatError,
	sleepWithSignal,
} from "@rine-network/core";
import {
	ChainBreak,
	ChainFault,
	type ChainPosition,
	type ChainStep,
} from "./org-events-chain.js";
import {
	AlertReason,
	TailExit,
	type TailStop,
	alertRecord,
} from "./tail-alert.js";
import { Delivery, deliver } from "./tail-deliver.js";
import { isAuthRefusal, isTransient } from "./tail-errors.js";
import { resolveFork } from "./tail-fork.js";
import type { HeadWatch, TailProgress } from "./tail-head.js";
import { type Outgoing, alertOutgoing } from "./tail-outgoing.js";
import { BATCH_SIZE, type Sink } from "./tail-transport.js";
import type { TailText } from "./tail-text.js";

export interface Page<T> {
	items: T[];
	epoch: number;
	floor?: RetentionFloor | null;
}

/** What differs between the event log and the metadata stream. */
export interface Source<T> {
	fetchPage(after: number, chainEpoch: number | undefined): Promise<Page<T>>;
	step(
		item: T,
		previous: ChainPosition | undefined,
		after: number,
		floor: RetentionFloor | null | undefined,
	): ChainStep;
	outgoing(item: T): Outgoing;
}

export interface TailRun<T> {
	source: Source<T>;
	text: TailText;
	sink: Sink;
	orgId: string | undefined;
	afterSeq: number;
	/** Loaded from the state file; wins over `afterSeq`. */
	position?: ChainPosition;
	acceptEpoch?: number;
	intervalMs: number;
	/** How long the sink may refuse before exit 9. */
	giveUpMs: number;
	signal: AbortSignal;
	/** Absent for the metadata stream, which has no head. */
	head?: HeadWatch;
	save: (position: ChainPosition) => void;
	log: (message: string) => void;
}

const MAX_BACKOFF_S = 60;

function chainStop(err: ChainBreak, text: TailText): TailStop {
	const hash = err.fault === ChainFault.Hash;
	return {
		code: TailExit.Chain,
		reason: hash ? AlertReason.ChainHash : AlertReason.ChainGap,
		text: hash ? text.hash(err.seq) : text.gap(err.seq),
	};
}

/** Pages until stopped (undefined) or something ends the collector. */
export async function runPages<T>(
	run: TailRun<T>,
	progress: TailProgress,
	signal: AbortSignal,
): Promise<TailStop | undefined> {
	const { source, text } = run;
	const env = { ...run, signal, progress };
	let position = run.position;
	let after = position?.seq ?? run.afterSeq;
	let epoch = position?.chain_epoch;
	let backoffS = 0;
	progress.chainEpoch = epoch;
	while (!signal.aborted) {
		let page: Page<T>;
		try {
			page = await source.fetchPage(after, epoch);
		} catch (err) {
			const fork = forkPointOf(err);
			if (fork !== undefined) {
				const out = resolveFork(
					fork,
					position,
					after,
					epoch,
					run.acceptEpoch,
					text,
				);
				if ("stop" in out) return out.stop;
				position = out.position;
				after = out.after;
				epoch = fork.currentEpoch;
				progress.chainEpoch = epoch;
				progress.lastSeq = after;
				continue;
			}
			if (isAuthRefusal(err))
				return {
					code: TailExit.Auth,
					reason: AlertReason.AuthRefused,
					text: text.auth,
				};
			if (!isTransient(err)) throw err;
			backoffS = Math.min(Math.max(backoffS * 2, 1), MAX_BACKOFF_S);
			run.log(text.retry(formatError(err), backoffS));
			await sleepWithSignal(backoffS * 1000, signal);
			continue;
		}
		backoffS = 0;
		epoch = page.epoch;
		progress.chainEpoch = epoch;
		const fresh = position === undefined;
		let batch: Outgoing[] = [];
		const flush = async (): Promise<TailStop | undefined> => {
			if (batch.length === 0 || position === undefined) return undefined;
			const sent = await deliver(env, batch);
			if (sent === Delivery.Aborted) return undefined;
			if (sent !== Delivery.Sent) return sent;
			run.save(position);
			progress.lastSeq = position.seq;
			batch = [];
			return undefined;
		};
		let broke: TailStop | undefined;
		for (const item of page.items) {
			let step: ChainStep;
			try {
				step = source.step(item, position, after, page.floor);
			} catch (err) {
				if (!(err instanceof ChainBreak)) throw err;
				broke = chainStop(err, text);
				break;
			}
			if (step.pruned !== undefined) {
				const flushed = await flush();
				if (flushed !== undefined) return flushed;
				if (fresh) run.log(text.pruned(step.pruned.to));
				else {
					const { from, to } = step.pruned;
					const message = text.prunedUnread(from, to);
					run.log(message);
					const alert = alertRecord(
						{
							code: null,
							reason: AlertReason.PrunedUnread,
							text: message,
							extra: { range: { from, to } },
						},
						run.orgId,
					);
					const sent = await deliver(env, [alertOutgoing(alert)]);
					if (sent !== Delivery.Sent && sent !== Delivery.Aborted) return sent;
				}
			}
			position = { ...step.position, chain_epoch: page.epoch };
			after = position.seq;
			batch.push(source.outgoing(item));
			if (batch.length >= BATCH_SIZE) {
				const flushed = await flush();
				if (flushed !== undefined) return flushed;
			}
		}
		const flushed = await flush();
		if (flushed !== undefined) return flushed;
		if (broke !== undefined) return broke;
		progress.caughtUp = page.items.length === 0;
		if (page.items.length === 0) await sleepWithSignal(run.intervalMs, signal);
	}
	return undefined;
}
