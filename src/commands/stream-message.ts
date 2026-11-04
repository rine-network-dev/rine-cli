/**
 * What `rine stream` does with one SSE event once it has arrived: print it in
 * the chosen mode, and acknowledge the row when it settled.
 *
 * The stream connects with the peek header, so the server marks nothing
 * delivered at yield. A row is acknowledged here, through the batcher, only
 * after it was opened (or was refused, or was never ciphertext); a row this
 * agent cannot open yet stays new for the next reader.
 */

import {
	type AckBatcher,
	type HttpClient,
	type SenderKeyExplainer,
	ackFailureNotice,
	createAckBatcher,
	markDeliveredAs,
	raceDeadline,
} from "@rine-network/core";
import { printError } from "../output.js";
import { messageEventLine } from "./stream-cleartext.js";
import { renderOpened } from "./stream-format.js";
import { isSettledMessage, openStreamMessage } from "./stream-open.js";

export interface StreamEvent {
	event?: string;
	data: string;
	id?: string;
}

export interface StreamEnv {
	json: boolean;
	monitor?: boolean;
	verbose?: boolean;
	agentId: string;
	configDir: string;
	client: HttpClient;
	explain: SenderKeyExplainer;
	acks: AckBatcher;
	/** Rows still being opened. Each one may yet queue an ack. */
	inFlight: Set<Promise<void>>;
}

/** The environment of one stream, with a batcher that acknowledges through its client. */
export function createStreamEnv(
	base: Omit<StreamEnv, "acks" | "inFlight">,
): StreamEnv {
	// A lost batch only means its rows are shown again.
	const acks = createAckBatcher({
		ack: (ids) => markDeliveredAs(base.client, base.agentId, ids),
		onError: (count, err) =>
			process.stderr.write(`${ackFailureNotice(count, err)}\n`),
	});
	return { ...base, acks, inFlight: new Set() };
}

/** How long a stop waits for rows still being opened before it sends the last batch. */
const IN_FLIGHT_WAIT_MS = 2000;

/**
 * Let the rows still being opened queue their acks, then send the last batch.
 * Without the wait, a row that settles after the stop would re-arm a timer the
 * exiting process never runs. The wait is bounded: a decrypt that stalls on the
 * network must not hold a stop, and its row simply stays new.
 */
export async function closeStreamEnv(
	env: StreamEnv,
	inFlightWaitMs = IN_FLIGHT_WAIT_MS,
): Promise<void> {
	try {
		await raceDeadline(Promise.allSettled([...env.inFlight]), inFlightWaitMs);
	} catch {
		/* rows still opening are left new */
	}
	await env.acks.close();
}

/** Open the row, queue its ack when it settled, and print it in human mode. */
async function settleAndPrint(env: StreamEnv, dataStr: string): Promise<void> {
	let line: string;
	try {
		const opened = await openStreamMessage(
			dataStr,
			env.agentId,
			env.configDir,
			env.client,
		);
		const row = opened.data;
		if (row.id && isSettledMessage(opened)) env.acks.add(row.id);
		if (env.json) return;
		const rendered = renderOpened(opened, env.explain);
		if (rendered.notice !== null) printError(rendered.notice);
		line = rendered.line;
	} catch {
		// A frame that does not parse has no verdict: it is not acknowledged.
		if (env.json) return;
		line = `[message] ${dataStr.slice(0, 80)}`;
	}
	console.log(line);
}

export function handleStreamEvent(
	env: StreamEnv,
	{ event, data, id }: StreamEvent,
): void {
	if (event === "heartbeat") void env.acks.flush();
	if (env.json) {
		if (!env.monitor || event === "message") {
			console.log(messageEventLine(event, id, data));
		}
	} else if (event === "heartbeat" && env.verbose) {
		process.stderr.write(`[heartbeat] ${data}\n`);
	}
	if (event === "message") {
		const settling = settleAndPrint(env, data);
		env.inFlight.add(settling);
		void settling.finally(() => env.inFlight.delete(settling));
	}
}
