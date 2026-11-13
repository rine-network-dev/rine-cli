import {
	jitteredDelayMs,
	nextReconnectBackoffSeconds,
	sleepWithSignal,
} from "@rine-network/core";
import type { GlobalOpts } from "../types.js";
import type { DisconnectReason } from "./stream-connection.js";
import { emitLifecycle } from "./stream-lifecycle.js";

/** What the reconnect messages say and how long to wait: one connection attempt's context. */
export interface ReconnectContext {
	gOpts: GlobalOpts;
	monitor?: boolean;
	verbose?: boolean;
	/** The attempt that just ended. */
	attempt: number;
	/** Backoff, in seconds, before this attempt's jitter. */
	backoff: number;
	/** When the attempt began (ms since the epoch): a long-lived connection earns a fresh backoff. */
	startedAt: number;
	/** Fires when the stream is told to stop, which cuts the backoff short. */
	stopping: AbortSignal;
}

/** A connection that lasted this long was healthy: its ending starts the backoff over. */
export const HEALTHY_CONNECTION_MS = 30_000;

function backoffAfter({ backoff, startedAt }: ReconnectContext): number {
	return Date.now() - startedAt >= HEALTHY_CONNECTION_MS ? 1 : backoff;
}

/**
 * Say why a connection ended and wait out the backoff. Returns the backoff for
 * the next attempt, or null when the stream was stopped.
 */
export async function afterDisconnect(
	reason: DisconnectReason,
	ctx: ReconnectContext,
): Promise<number | null> {
	const { gOpts, monitor, attempt, stopping } = ctx;
	const backoff = backoffAfter(ctx);
	if (reason === "signal") {
		emitLifecycle(gOpts, monitor, { state: "stopped", reason: "signal" });
		return null;
	}
	if (reason === "heartbeat_timeout") {
		const jittered = jitteredDelayMs(backoff);
		emitLifecycle(gOpts, monitor, {
			state: "reconnecting",
			reason: "heartbeat_timeout",
			attempt: attempt + 1,
			backoff_ms: jittered,
		});
		if (!gOpts.json) {
			process.stderr.write(
				`Reconnecting (attempt ${attempt + 1}, heartbeat timeout)...\n`,
			);
		}
		await sleepWithSignal(jittered, stopping);
		return nextReconnectBackoffSeconds(backoff);
	}
	// Server-initiated close (heartbeat limit or clean close): a 200 stream that closes at once
	// backs off like any other failure, so it cannot spin.
	const jittered = jitteredDelayMs(backoff);
	emitLifecycle(gOpts, monitor, {
		state: "reconnecting",
		reason: "server_close",
		attempt: attempt + 1,
		backoff_ms: jittered,
	});
	if (!gOpts.json) {
		process.stderr.write(
			`Reconnecting (attempt ${attempt + 1}, server close)...\n`,
		);
	}
	await sleepWithSignal(jittered, stopping);
	return nextReconnectBackoffSeconds(backoff);
}

/**
 * Say that an attempt failed and wait out the backoff. Returns the backoff for
 * the next attempt, or null when the failure was the stop itself.
 */
export async function afterError(
	err: unknown,
	stopped: boolean,
	ctx: ReconnectContext,
): Promise<number | null> {
	const { gOpts, monitor, verbose, attempt, stopping } = ctx;
	const backoff = backoffAfter(ctx);
	if (stopped) {
		emitLifecycle(gOpts, monitor, { state: "stopped", reason: "signal" });
		return null;
	}
	const errorMsg = err instanceof Error ? err.message : String(err);
	const jittered = jitteredDelayMs(backoff);
	emitLifecycle(gOpts, monitor, {
		state: "reconnecting",
		reason: "error",
		attempt: attempt + 1,
		backoff_ms: jittered,
		error: errorMsg,
	});
	if (verbose) {
		process.stderr.write(
			`Reconnecting in ${Math.round(jittered / 1000)}s (attempt ${attempt + 1}, error: ${errorMsg})...\n`,
		);
	} else {
		process.stderr.write(`Reconnecting (attempt ${attempt + 1}, error)...\n`);
	}
	await sleepWithSignal(jittered, stopping);
	return nextReconnectBackoffSeconds(backoff);
}
