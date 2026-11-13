import { createEventSource } from "eventsource-client";
import type { StreamEvent } from "./stream-message.js";

export type DisconnectReason = "heartbeat_timeout" | "server_close" | "signal";

export interface StreamConnectionArgs {
	url: string;
	headers: Record<string, string>;
	heartbeatTimeoutMs: number;
	onMessage: (event: StreamEvent) => void;
}

/**
 * The server answered the stream request with a status other than 2xx (a hold's 403, a dead
 * token's 401). `eventsource-client` reads such a body as a stream that ended cleanly and
 * reconnects at once, so the connection turns it into an error the caller backs off from.
 */
export class StreamHttpError extends Error {
	constructor(readonly status: number) {
		super(`The stream was refused with HTTP ${status}`);
	}
}

export interface StreamConnection {
	/** Settles once, with whichever ending came first; rejects with `StreamHttpError` on a refusal. */
	readonly closed: Promise<DisconnectReason>;
	/** Close the connection on a signal. */
	stop(): void;
}

/**
 * One SSE connection, watched by a heartbeat timer: silence for
 * `heartbeatTimeoutMs` closes it, as do a server close and a stop request. A non-2xx
 * response rejects `closed` and ends the connection.
 */
export function openStreamConnection({
	url,
	headers,
	heartbeatTimeoutMs,
	onMessage,
}: StreamConnectionArgs): StreamConnection {
	let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
	let settle: (reason: DisconnectReason) => void = () => {};
	let refuse: (error: StreamHttpError) => void = () => {};
	const closed = new Promise<DisconnectReason>((resolve, reject) => {
		settle = resolve;
		refuse = reject;
	});

	const end = (reason: DisconnectReason, closeSource: boolean): void => {
		if (heartbeatTimer) clearTimeout(heartbeatTimer);
		if (closeSource) es.close();
		settle(reason);
	};
	const refusingFetch: typeof fetch = async (input, init) => {
		const response = await fetch(input, init);
		if (response.ok) return response;
		const error = new StreamHttpError(response.status);
		if (heartbeatTimer) clearTimeout(heartbeatTimer);
		es.close();
		refuse(error);
		throw error;
	};
	const resetHeartbeatTimer = (): void => {
		if (heartbeatTimer) clearTimeout(heartbeatTimer);
		heartbeatTimer = setTimeout(
			() => end("heartbeat_timeout", true),
			heartbeatTimeoutMs,
		);
	};

	const es = createEventSource({
		url,
		headers,
		fetch: refusingFetch,
		onMessage: (event) => {
			resetHeartbeatTimer();
			onMessage(event);
		},
		onDisconnect: () => end("server_close", false),
		onScheduleReconnect: () => end("server_close", true),
	});
	resetHeartbeatTimer();

	return { closed, stop: () => end("signal", true) };
}
