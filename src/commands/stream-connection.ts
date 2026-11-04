import { createEventSource } from "eventsource-client";
import type { StreamEvent } from "./stream-message.js";

export type DisconnectReason = "heartbeat_timeout" | "server_close" | "signal";

export interface StreamConnectionArgs {
	url: string;
	headers: Record<string, string>;
	heartbeatTimeoutMs: number;
	onMessage: (event: StreamEvent) => void;
}

export interface StreamConnection {
	/** Settles once, with whichever ending came first. */
	readonly closed: Promise<DisconnectReason>;
	/** Close the connection on a signal. */
	stop(): void;
}

/**
 * One SSE connection, watched by a heartbeat timer: silence for
 * `heartbeatTimeoutMs` closes it, as do a server close and a stop request.
 */
export function openStreamConnection({
	url,
	headers,
	heartbeatTimeoutMs,
	onMessage,
}: StreamConnectionArgs): StreamConnection {
	let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
	let settle: (reason: DisconnectReason) => void = () => {};
	const closed = new Promise<DisconnectReason>((resolve) => {
		settle = resolve;
	});

	const end = (reason: DisconnectReason, closeSource: boolean): void => {
		if (heartbeatTimer) clearTimeout(heartbeatTimer);
		if (closeSource) es.close();
		settle(reason);
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
