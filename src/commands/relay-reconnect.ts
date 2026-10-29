/** How the relay loop reads a dropped or refused tunnel, and how it waits to retry. */

import {
	type TunnelClose,
	jitteredDelayMs,
	nextReconnectBackoffSeconds,
	sleep,
} from "@rine-network/core";
import { emitLifecycle } from "./relay-lifecycle.js";

export function isRevoked(err: unknown): boolean {
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
 * before the reconnect branch).
 */
export function waitForClose(
	tunnel: {
		onClose(cb: (close: TunnelClose) => void): void;
		close(): void;
	},
	isStopped: () => boolean,
	setStop: (stop: () => void) => void,
): Promise<TunnelClose | undefined> {
	return new Promise<TunnelClose | undefined>((resolve) => {
		if (isStopped()) return resolve(undefined);
		tunnel.onClose((close) => resolve(close));
		setStop(() => {
			tunnel.close();
			resolve(undefined);
		});
	});
}
