/** Hands a batch to the sink, waiting out a receiver that refuses it. */
import { sleepWithSignal } from "@rine-network/core";
import { AlertReason, TailExit, type TailStop } from "./tail-alert.js";
import type { TailProgress } from "./tail-head.js";
import type { Outgoing } from "./tail-outgoing.js";
import { type Sink, SinkRefusal } from "./tail-transport.js";
import type { TailText } from "./tail-text.js";

export const Delivery = { Sent: "sent", Aborted: "aborted" } as const;
export type Delivery = (typeof Delivery)[keyof typeof Delivery];

const MAX_BACKOFF_S = 60;

export interface DeliverEnv {
	sink: Sink;
	text: TailText;
	/** How long a receiver may refuse before the collector gives up. */
	giveUpMs: number;
	signal: AbortSignal;
	log: (message: string) => void;
	progress: TailProgress;
}

/**
 * Sends `batch`, retrying with a doubling wait until it is accepted, the collector is
 * stopped, or the receiver has refused for `giveUpMs`. A refusal marks the progress so the head
 * watch does not read the pause as withheld events; it is never a head failure.
 */
export async function deliver(
	env: DeliverEnv,
	batch: Outgoing[],
): Promise<Delivery | TailStop> {
	const startedAt = Date.now();
	let backoffS = 0;
	for (;;) {
		try {
			await env.sink.send(batch);
			env.progress.sinkBlocked = false;
			return Delivery.Sent;
		} catch (err) {
			if (!(err instanceof SinkRefusal)) throw err;
			env.progress.sinkBlocked = true;
			const waitedMs = Date.now() - startedAt;
			if (waitedMs >= env.giveUpMs)
				return {
					code: TailExit.SinkDown,
					reason: AlertReason.SinkDown,
					text: env.text.sinkDown(env.sink.name, Math.floor(waitedMs / 1000)),
				};
			backoffS = Math.min(Math.max(backoffS * 2, 1), MAX_BACKOFF_S);
			env.log(env.text.sinkRefused(env.sink.name, err.status, backoffS));
			await sleepWithSignal(backoffS * 1000, env.signal);
			if (env.signal.aborted) return Delivery.Aborted;
		}
	}
}
