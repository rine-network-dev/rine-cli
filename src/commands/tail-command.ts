/** The options and start-up `rine org events tail` and `rine org metadata tail` share. */
import { fetchHeadKeys, fetchOrgEventHead } from "@rine-network/core";
import type { Command } from "commander";
import type { ActionContext } from "../action.js";
import { loadPosition, savePosition } from "./org-events-chain.js";
import { HeadDefaults, type HeadWatch } from "./tail-head.js";
import { type Source, type TailRun } from "./tail-loop.js";
import { runTail } from "./tail-run.js";
import { chooseSink } from "./tail-sinks.js";
import { type TailText } from "./tail-text.js";

/** How long a receiver may refuse every batch before the collector exits 9. */
const SINK_GIVE_UP_S = 900;
const DEFAULT_POLL_S = 5;

export interface TailOpts {
	afterSeq?: string;
	state?: string;
	interval?: string;
	hec?: string;
	otlp?: string;
	acceptEpoch?: string;
	silencedAfter?: string;
	withheldAfter?: string;
	stalledAfter?: string;
}

export function parseCount(
	value: string | undefined,
	flag: string,
	min: number,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n < min)
		throw new Error(`${flag} must be an integer of at least ${min}`);
	return n;
}

/** Adds the shared options; the head thresholds only where there is a head to watch. */
export function addTailOptions(cmd: Command, withHead: boolean): Command {
	cmd
		.option(
			"--after-seq <n>",
			"Start after this sequence number (ignored when --state holds a position)",
		)
		.option(
			"--state <file>",
			"Remember the last delivered position here and resume from it",
		)
		.option(
			"--interval <seconds>",
			`Seconds between polls when caught up (default ${DEFAULT_POLL_S})`,
		)
		.option(
			"--hec <url>",
			"Send to a Splunk HEC receiver (token in RINE_HEC_TOKEN)",
		)
		.option(
			"--otlp <url>",
			"Send to an OTLP/HTTP logs receiver (headers in RINE_OTLP_HEADERS, as k=v,k=v)",
		)
		.option(
			"--accept-epoch <n>",
			"Carry on after the server was restored from a backup and moved to chain epoch n",
		);
	if (withHead)
		cmd
			.option(
				"--silenced-after <seconds>",
				`Seconds without a valid signed head before exit 6 (default ${HeadDefaults.silencedS}, at least ${HeadDefaults.minThresholdS})`,
			)
			.option(
				"--withheld-after <seconds>",
				`Seconds a reported event may stay unreturned before exit 6 (default ${HeadDefaults.withheldS}, at least ${HeadDefaults.minThresholdS})`,
			)
			.option(
				"--stalled-after <seconds>",
				`Seconds an event may wait to enter the log before exit 7 (default ${HeadDefaults.stalledS}, at least ${HeadDefaults.minThresholdS})`,
			);
	return cmd;
}

export interface TailLaunch<T> {
	text: TailText;
	source: Source<T>;
	withHead: boolean;
}

function headWatch(ctx: ActionContext, opts: TailOpts): HeadWatch {
	const min = HeadDefaults.minThresholdS;
	const thresholds = {
		silencedS: parseCount(
			opts.silencedAfter,
			"--silenced-after",
			min,
			HeadDefaults.silencedS,
		),
		withheldS: parseCount(
			opts.withheldAfter,
			"--withheld-after",
			min,
			HeadDefaults.withheldS,
		),
		stalledS: parseCount(
			opts.stalledAfter,
			"--stalled-after",
			min,
			HeadDefaults.stalledS,
		),
	};
	return {
		fetchHead: (nonce) => fetchOrgEventHead(ctx.client, nonce),
		fetchKeys: () => fetchHeadKeys(ctx.apiUrl),
		thresholds,
		intervalMs:
			Math.min(HeadDefaults.intervalS, ...Object.values(thresholds)) * 1000,
		keyRetryMs: HeadDefaults.keyRetryS * 1000,
	};
}

/** Builds the run from the options and drives it until it ends; sets the process exit code. */
export async function launchTail<T>(
	ctx: ActionContext,
	opts: TailOpts,
	launch: TailLaunch<T>,
): Promise<void> {
	const state = opts.state;
	const run: TailRun<T> = {
		source: launch.source,
		text: launch.text,
		sink: chooseSink({
			hec: opts.hec,
			otlp: opts.otlp,
			env: process.env,
			text: launch.text,
		}),
		orgId: ctx.auth?.orgId,
		afterSeq: parseCount(opts.afterSeq, "--after-seq", 0, 0),
		position: state === undefined ? undefined : loadPosition(state),
		acceptEpoch:
			opts.acceptEpoch === undefined
				? undefined
				: parseCount(opts.acceptEpoch, "--accept-epoch", 1, 1),
		intervalMs:
			parseCount(opts.interval, "--interval", 1, DEFAULT_POLL_S) * 1000,
		giveUpMs: SINK_GIVE_UP_S * 1000,
		signal: undefined as never,
		head: launch.withHead ? headWatch(ctx, opts) : undefined,
		save: (position) => {
			if (state !== undefined) savePosition(state, position);
		},
		log: (message) => console.error(message),
	};
	const stop = new AbortController();
	run.signal = stop.signal;
	const onSignal = () => stop.abort();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		process.exitCode = await runTail(run);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}
