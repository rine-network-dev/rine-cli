/**
 * The head watch: every interval a signed head is asked for with a fresh nonce and checked, so a
 * log that is silenced, replayed, stalled, truncated or withheld stops the collector even when
 * nothing is being written. It runs beside the page loop and never waits on the sink.
 */
import { randomBytes } from "node:crypto";
import {
	type EventHead,
	HeadFault,
	type HeadKey,
	type HeadKeyList,
	RineApiError,
	sleepWithSignal,
	verifyHead,
} from "@rine-network/core";
import { AlertReason, TailExit, type TailStop } from "./tail-alert.js";
import { isAuthRefusal } from "./tail-errors.js";
import type { TailText } from "./tail-text.js";

/** The seconds each threshold is by default, and the lowest a flag may set one to. */
export const HeadDefaults = {
	intervalS: 60,
	silencedS: 300,
	withheldS: 120,
	stalledS: 300,
	/** Past the edge cache's 300 s `ttl` and 60 s `stale`. */
	keyRetryS: 420,
	minThresholdS: 30,
} as const;

export interface HeadThresholds {
	silencedS: number;
	withheldS: number;
	stalledS: number;
}

export interface HeadWatch {
	fetchHead: (nonce: string) => Promise<EventHead>;
	fetchKeys: () => Promise<HeadKeyList>;
	thresholds: HeadThresholds;
	intervalMs: number;
	keyRetryMs: number;
}

/** What the page loop has seen, for the head watch to compare the server's claims against. */
export interface TailProgress {
	/** Highest sequence number received and verified. */
	lastSeq: number;
	chainEpoch: number | undefined;
	/** The last page came back empty: the collector has everything the server returns. */
	caughtUp: boolean;
	/** The sink is refusing a batch, so the page loop is not fetching. */
	sinkBlocked: boolean;
}

const seconds = (since: number) => Math.floor((Date.now() - since) / 1000);

/** Runs head checks until stopped (undefined) or one of them ends the collector. */
export async function watchHead(
	cfg: HeadWatch,
	progress: TailProgress,
	signal: AbortSignal,
	text: TailText,
): Promise<TailStop | undefined> {
	const startedAt = Date.now();
	let lastAnswerAt = startedAt;
	let answered = false;
	let keys: HeadKey[] | undefined;
	let unknownSince: number | undefined;
	let aheadSince: number | undefined;
	let previous: { epoch: number; seq: number } | undefined;
	const stop = (
		code: TailStop["code"],
		reason: TailStop["reason"],
		message: string,
		extra?: Record<string, unknown>,
	): TailStop => ({ code, reason, text: message, extra });
	const silenced = () => {
		const s = seconds(lastAnswerAt);
		return s >= cfg.thresholds.silencedS
			? stop(TailExit.Silenced, AlertReason.Silenced, text.silenced(s), {
					silent_seconds: s,
				})
			: undefined;
	};

	async function check(): Promise<TailStop | undefined> {
		const seen = progress.lastSeq;
		const seenEpoch = progress.chainEpoch;
		const nonce = randomBytes(32).toString("base64url");
		let head: EventHead;
		try {
			head = await cfg.fetchHead(nonce);
		} catch (err) {
			if (isAuthRefusal(err))
				return stop(TailExit.Auth, AlertReason.AuthRefused, text.auth);
			if (err instanceof RineApiError && err.status === 404 && !answered)
				return stop(TailExit.Silenced, AlertReason.NoHeadRoute, text.noHead);
			return silenced();
		}
		lastAnswerAt = Date.now();
		answered = true;
		try {
			keys ??= (await cfg.fetchKeys()).keys;
			let verdict = verifyHead(head, nonce, keys);
			if (!verdict.ok && verdict.fault === HeadFault.UnknownKid) {
				const due =
					unknownSince === undefined ||
					Date.now() - unknownSince >= cfg.keyRetryMs;
				if (!due) return undefined;
				keys = (await cfg.fetchKeys()).keys;
				verdict = verifyHead(head, nonce, keys);
				if (!verdict.ok && unknownSince === undefined) {
					unknownSince = Date.now();
					return undefined;
				}
			}
			if (!verdict.ok)
				return stop(
					TailExit.Silenced,
					AlertReason.HeadInvalid,
					text.headInvalid,
					{
						fault: verdict.fault,
					},
				);
		} catch {
			return silenced();
		}
		unknownSince = undefined;
		return judge(head, seen, seenEpoch);
	}

	function judge(
		head: EventHead,
		seen: number,
		seenEpoch: number | undefined,
	): TailStop | undefined {
		const sameEpoch = seenEpoch === undefined || head.chain_epoch === seenEpoch;
		const floor = Math.max(
			sameEpoch ? seen : 0,
			previous !== undefined && previous.epoch === head.chain_epoch
				? previous.seq
				: 0,
		);
		previous = { epoch: head.chain_epoch, seq: head.seq };
		if (head.seq < floor)
			return stop(
				TailExit.Truncated,
				AlertReason.Truncated,
				text.truncated(head.seq, floor),
				{ head_seq: head.seq, last_seq: floor },
			);
		const ahead =
			sameEpoch &&
			head.seq > seen &&
			progress.caughtUp &&
			!progress.sinkBlocked;
		aheadSince = ahead ? (aheadSince ?? Date.now()) : undefined;
		if (
			aheadSince !== undefined &&
			seconds(aheadSince) >= cfg.thresholds.withheldS
		)
			return stop(
				TailExit.Silenced,
				AlertReason.Withheld,
				text.withheld(head.seq, seconds(aheadSince)),
				{ head_seq: head.seq, last_seq: seen },
			);
		if (head.unsequenced_oldest_seconds >= cfg.thresholds.stalledS)
			return stop(
				TailExit.Stalled,
				AlertReason.Stalled,
				text.stalled(head.unsequenced_oldest_seconds),
				{ unsequenced_oldest_seconds: head.unsequenced_oldest_seconds },
			);
		return undefined;
	}

	while (!signal.aborted) {
		const ended = await check();
		if (ended !== undefined) return ended;
		await sleepWithSignal(cfg.intervalMs, signal);
	}
	return undefined;
}
