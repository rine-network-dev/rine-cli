import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import {
	type EventHead,
	HEAD_DOMAIN,
	type HeadKey,
	type OrgEvent,
	RineApiError,
	headMessage,
} from "@rine-network/core";
import {
	type ChainPosition,
	GENESIS_HASH,
	eventHash,
	verifyEvent,
} from "../src/commands/org-events-chain.js";
import { eventOutgoing } from "../src/commands/tail-outgoing.js";
import type { Outgoing } from "../src/commands/tail-outgoing.js";
import type { Page, TailRun } from "../src/commands/tail-loop.js";
import { EVENTS_TAIL, tailText } from "../src/commands/tail-text.js";
import {
	type Sink,
	SinkName,
	SinkRefusal,
} from "../src/commands/tail-transport.js";

export const ORG = "22222222-2222-4222-8222-222222222222";
export const text = tailText(EVENTS_TAIL);

export function event(
	seq: number,
	prev: string,
	extra: Record<string, unknown> = {},
): OrgEvent {
	const body = {
		schema: "rine.org_event.v1",
		org_id: ORG,
		seq,
		prev_hash: prev,
		chain_epoch: 1,
		occurred_at: "2026-11-09T10:00:00.000000Z",
		kind: "agent.created",
		detail: { n: seq, name: "café" },
		...extra,
	};
	return {
		...body,
		hash: eventHash({ ...body, hash: "" } as OrgEvent),
	} as OrgEvent;
}

export function chain(n: number, from = 1, prev = GENESIS_HASH): OrgEvent[] {
	const out: OrgEvent[] = [];
	for (let i = from; i < from + n; i++)
		out.push(event(i, out.at(-1)?.hash ?? prev));
	return out;
}

export const page = (
	items: OrgEvent[],
	floor?: Page<OrgEvent>["floor"],
	epoch = 1,
): Page<OrgEvent> => ({ items, epoch, floor });

export const forkError = (
	current: number,
	forkSeq: number,
	forkHash?: string,
) =>
	new RineApiError(409, "restored", undefined, "chain_epoch_changed", {
		error: "chain_epoch_changed",
		detail: "restored",
		current_epoch: current,
		fork_after_seq: forkSeq,
		...(forkHash === undefined ? {} : { fork_after_hash: forkHash }),
	});

/** A sink that keeps what it accepted and refuses the calls `refuse` names. */
export function memorySink(
	refuse: (call: number) => string | undefined = () => undefined,
) {
	const accepted: Outgoing[][] = [];
	const order: string[] = [];
	let calls = 0;
	const sink: Sink = {
		name: SinkName.Hec,
		async send(batch) {
			const why = refuse(calls++);
			if (why !== undefined) throw new SinkRefusal(why);
			accepted.push(batch);
			order.push(`send:${batch.length}`);
		},
	};
	return { sink, accepted, order, calls: () => calls };
}

export interface Harness {
	run: TailRun<OrgEvent>;
	saved: ChainPosition[];
	logs: string[];
	asked: { after: number; epoch: number | undefined }[];
	accepted: Outgoing[][];
	order: string[];
	/** Every body the sink accepted, flattened. */
	bodies: () => Record<string, unknown>[];
}

/** Serves `pages` in order, then stops the tail when the last one is asked for. */
export function harness(
	pages: (Page<OrgEvent> | Error)[],
	over: Partial<TailRun<OrgEvent>> = {},
	refuse?: (call: number) => string | undefined,
): Harness {
	const stop = new AbortController();
	const mem = memorySink(refuse);
	const h: Harness = {
		saved: [],
		logs: [],
		asked: [],
		accepted: mem.accepted,
		order: mem.order,
		bodies: () => mem.accepted.flat().map((o) => o.body),
		run: undefined as never,
	};
	let i = 0;
	h.run = {
		source: {
			fetchPage: async (after, epoch) => {
				h.asked.push({ after, epoch });
				const next = pages[i++];
				if (i >= pages.length) queueMicrotask(() => stop.abort());
				if (next === undefined || next instanceof Error)
					throw next ?? new Error("no page");
				return next;
			},
			step: verifyEvent,
			outgoing: eventOutgoing,
		},
		text,
		sink: mem.sink,
		orgId: ORG,
		afterSeq: 0,
		intervalMs: 1,
		giveUpMs: 900_000,
		signal: stop.signal,
		save: (p) => {
			h.saved.push(p);
			mem.order.push(`save:${p.seq}`);
		},
		log: (m) => h.logs.push(m),
		...over,
	};
	return h;
}

export function keyPair(kid: string): { key: HeadKey; privateKey: KeyObject } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privateKey,
		key: {
			kid,
			alg: "Ed25519",
			public_key: publicKey.export({ format: "jwk" }).x as string,
			created_at: "2026-11-01T00:00:00Z",
			retired_at: null,
		},
	};
}

export function signedHead(
	kid: string,
	privateKey: KeyObject,
	nonce: string,
	over: Partial<EventHead> = {},
): EventHead {
	const head: EventHead = {
		domain: HEAD_DOMAIN,
		org_id: ORG,
		chain_epoch: 1,
		seq: 0,
		hash: GENESIS_HASH,
		server_time: "2026-11-09T10:00:00Z",
		nonce,
		unsequenced_oldest_seconds: 0,
		retention_floor_seq: 0,
		kid: "",
		sig: "",
		...over,
	};
	const sig = sign(null, headMessage(head), privateKey).toString("base64url");
	return { ...head, kid, sig };
}
