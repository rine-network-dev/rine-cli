/** How the relay loop reads a dropped or refused tunnel, and how it waits to retry. */

import {
	BindNakReason,
	CLOSE_SUSPENDED,
	RineApiError,
	TunnelBindError,
	type TunnelClose,
	holdOf,
	isRefusalStatus,
	jitteredDelayMs,
	nextReconnectBackoffSeconds,
	sleep,
} from "@rine-network/core";
import {
	PAUSED_MESSAGE,
	PAUSED_RETRY_MS,
	emitLifecycle,
} from "./relay-lifecycle.js";

/**
 * End the relay on a revoked binding. It does NOT revoke or wipe the per-agent wildcard: that is
 * SHARED across every other live hook of the agent, so wiping it would kill all of them. The kill
 * switch is server-side DNS+route teardown; the relay just exits.
 */
export function exitRevoked(
	cert: { stop(): void },
	json: boolean | undefined,
): void {
	cert.stop();
	emitLifecycle(json, { state: "tunnel_revoked" });
	process.exitCode = 1;
}

function isRevoked(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { revoked?: boolean }).revoked === true
	);
}

/** Emit an error reconnect, wait its jittered delay, and return the next backoff. */
export async function reconnectAfterError(
	json: boolean | undefined,
	attempt: number,
	backoff: number,
	afterEmit?: () => void,
): Promise<number> {
	const delay = jitteredDelayMs(backoff);
	emitLifecycle(json, {
		state: "tunnel_reconnecting",
		attempt: attempt + 1,
		backoff_ms: delay,
		reason: "error",
	});
	afterEmit?.();
	await sleep(delay);
	return nextReconnectBackoffSeconds(backoff);
}

/**
 * Resolve when the tunnel WS closes (carrying the classified close so the caller
 * can pick clean-vs-error reconnect) OR the stop handed to `setStop` runs on
 * SIGINT (resolves `undefined`; the caller's `stopped` flag short-circuits
 * before the reconnect branch). A 4423 close (the agent is held) rejects.
 */
export function waitForClose(
	tunnel: {
		onClose(cb: (close: TunnelClose) => void): void;
		close(): void;
	},
	isStopped: () => boolean,
	setStop: (stop: () => void) => void,
): Promise<TunnelClose | undefined> {
	return new Promise<TunnelClose | undefined>((resolve, reject) => {
		if (isStopped()) return resolve(undefined);
		tunnel.onClose((close) =>
			// A 4423 close is the same failure as a `suspended` NAK: the loop pauses on it.
			close.code === CLOSE_SUSPENDED
				? reject(new TunnelBindError(BindNakReason.Suspended))
				: resolve(close),
		);
		setStop(() => {
			tunnel.close();
			resolve(undefined);
		});
	});
}

function isHoldRefusal(err: unknown): boolean {
	return (
		err instanceof RineApiError && holdOf(err.status, err.body) !== undefined
	);
}

/** What the relay does after a failed bind or a dropped tunnel. */
export const RelayFailure = {
	/** The agent is held: the relay has paused and retries with a fresh token. */
	Paused: "paused",
	/** The binding is gone: the relay exits. */
	Revoked: "revoked",
	/** Nothing definitive: the relay reconnects with the backoff. */
	Retry: "retry",
} as const;
export type RelayFailure = (typeof RelayFailure)[keyof typeof RelayFailure];

/**
 * Confirm a revocation NAK once with a freshly minted token, because an older broker or server
 * reports a held agent as revoked. A mint refused with a hold code means held. A mint that
 * succeeds, or one the server refuses outright (a 4xx other than a throttle), leaves the NAK
 * standing. A network fault, a 429 or a 5xx says nothing about the binding, so the relay retries.
 */
async function confirmRevoked(
	mint: (opts: { force: boolean }) => Promise<unknown>,
): Promise<RelayFailure> {
	try {
		await mint({ force: true });
	} catch (mintErr) {
		if (isHoldRefusal(mintErr)) return RelayFailure.Paused;
		return mintErr instanceof RineApiError && isRefusalStatus(mintErr.status)
			? RelayFailure.Revoked
			: RelayFailure.Retry;
	}
	return RelayFailure.Revoked;
}

/** Sort a failure: a `suspended` NAK and a hold-coded refusal say held directly. */
async function classifyFailure(
	err: unknown,
	mint: (opts: { force: boolean }) => Promise<unknown>,
): Promise<RelayFailure> {
	if (isRevoked(err)) return confirmRevoked(mint);
	const held =
		(err instanceof TunnelBindError &&
			err.reason === BindNakReason.Suspended) ||
		isHoldRefusal(err);
	return held ? RelayFailure.Paused : RelayFailure.Retry;
}

/**
 * Announce the pause and wait [`PAUSED_RETRY_MS`] before the next attempt, or until the
 * stop handed to `setStop` runs on SIGINT.
 */
async function pauseTunnel(
	json: boolean | undefined,
	setStop: (stop: (() => void) | undefined) => void,
): Promise<void> {
	emitLifecycle(json, { state: "tunnel_paused", message: PAUSED_MESSAGE });
	if (!json) process.stderr.write(`${PAUSED_MESSAGE}\n`);
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, PAUSED_RETRY_MS);
		setStop(() => {
			clearTimeout(timer);
			resolve();
		});
	});
	setStop(undefined);
}

/** Classify `err`, and run the pause when it says the agent is held. */
export async function settleFailure(
	err: unknown,
	mint: (opts: { force: boolean }) => Promise<unknown>,
	json: boolean | undefined,
	setStop: (stop: (() => void) | undefined) => void,
): Promise<RelayFailure> {
	const failure = await classifyFailure(err, mint);
	if (failure === RelayFailure.Paused) await pauseTunnel(json, setStop);
	return failure;
}
