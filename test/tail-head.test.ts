import { type HeadKey, RineApiError } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TailExit, type TailStop } from "../src/commands/tail-alert.js";
import {
	type HeadWatch,
	type TailProgress,
	watchHead,
} from "../src/commands/tail-head.js";
import { runTail } from "../src/commands/tail-run.js";
import {
	chain,
	harness,
	keyPair,
	page,
	signedHead,
	text,
} from "./tail-fixtures.js";
import type { EventHead } from "@rine-network/core";

const k1 = keyPair("k1");
const k2 = keyPair("k2");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

interface Probe {
	stop: () => TailStop | undefined;
	progress: TailProgress;
	keyCalls: () => number;
	nonces: string[];
	end: () => Promise<TailStop | undefined>;
}

/** Starts a watch and lets the test move the clock. `head` answers each check. */
function probe(
	head: (nonce: string, call: number) => Promise<EventHead> | EventHead,
	over: {
		keys?: (call: number) => HeadKey[];
		progress?: Partial<TailProgress>;
	} = {},
): Probe {
	const nonces: string[] = [];
	let keyCalls = 0;
	const cfg: HeadWatch = {
		fetchHead: async (nonce) => {
			nonces.push(nonce);
			return head(nonce, nonces.length - 1);
		},
		fetchKeys: async () => ({
			keys: (over.keys ?? (() => [k1.key]))(keyCalls++),
		}),
		thresholds: { silencedS: 300, withheldS: 120, stalledS: 300 },
		intervalMs: 60_000,
		keyRetryMs: 420_000,
	};
	const progress: TailProgress = {
		lastSeq: 0,
		chainEpoch: 1,
		caughtUp: true,
		sinkBlocked: false,
		...over.progress,
	};
	const ctl = new AbortController();
	let result: TailStop | undefined;
	let settled = false;
	const work = watchHead(cfg, progress, ctl.signal, text).then((r) => {
		result = r;
		settled = true;
		return r;
	});
	return {
		stop: () => (settled ? result : undefined),
		progress,
		keyCalls: () => keyCalls,
		nonces,
		end: () => {
			ctl.abort();
			return work;
		},
	};
}

const good =
	(over: Partial<EventHead> = {}) =>
	(nonce: string) =>
		signedHead("k1", k1.privateKey, nonce, over);
const advance = (s: number) => vi.advanceTimersByTimeAsync(s * 1000);

describe("head watch", () => {
	it("test_head_when_the_server_answers_signed_heads_then_checks_each_minute_with_a_fresh_43_character_nonce_and_never_stops", async () => {
		const p = probe(good());
		await advance(190);
		expect(await p.end()).toBeUndefined();
		expect(p.nonces).toHaveLength(4);
		expect(new Set(p.nonces).size).toBe(4);
		for (const n of p.nonces) expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("test_head_when_an_old_head_is_replayed_then_head_invalid_exit_6", async () => {
		const old = signedHead("k1", k1.privateKey, "O".repeat(43));
		const p = probe(() => old);
		await advance(1);
		expect(p.stop()).toMatchObject({
			code: TailExit.Silenced,
			reason: "head_invalid",
			text: text.headInvalid,
			extra: { fault: "wrong_nonce" },
		});
	});

	it("test_head_when_the_signature_is_forged_then_head_invalid_exit_6", async () => {
		const p = probe((nonce) => signedHead("k1", k2.privateKey, nonce));
		await advance(1);
		expect(p.stop()).toMatchObject({
			code: 6,
			reason: "head_invalid",
			extra: { fault: "bad_signature" },
		});
	});

	it("test_head_when_the_kid_stays_unknown_then_one_refetch_at_once_and_a_second_at_420_s_before_head_invalid", async () => {
		const p = probe((nonce) => signedHead("k2", k2.privateKey, nonce));
		await advance(400);
		expect(p.stop()).toBeUndefined();
		expect(p.keyCalls()).toBe(2);
		await advance(30);
		expect(p.stop()).toMatchObject({ reason: "head_invalid", code: 6 });
		expect(p.keyCalls()).toBe(3);
	});

	it("test_head_when_a_key_was_rotated_behind_the_cache_then_the_second_refetch_accepts_it", async () => {
		const p = probe((nonce) => signedHead("k2", k2.privateKey, nonce), {
			keys: (call) => (call < 2 ? [k1.key] : [k1.key, k2.key]),
		});
		await advance(600);
		expect(await p.end()).toBeUndefined();
		expect(p.keyCalls()).toBe(3);
	});

	it("test_head_when_the_server_does_not_answer_for_300_s_then_silenced_exit_6_and_not_before", async () => {
		const p = probe(() => {
			throw new TypeError("fetch failed");
		});
		await advance(290);
		expect(p.stop()).toBeUndefined();
		await advance(20);
		expect(p.stop()).toMatchObject({
			code: TailExit.Silenced,
			reason: "silenced",
			text: text.silenced(300),
		});
	});

	it("test_head_when_the_route_is_missing_at_start_then_no_head_route_exit_6", async () => {
		const p = probe(() => {
			throw new RineApiError(404, "not found");
		});
		await advance(1);
		expect(p.stop()).toMatchObject({
			code: 6,
			reason: "no_head_route",
			text: text.noHead,
		});
	});

	it("test_head_when_the_credential_is_refused_then_exit_3", async () => {
		const p = probe(() => {
			throw new RineApiError(401, "no", undefined, "invalid_token");
		});
		await advance(1);
		expect(p.stop()).toMatchObject({ code: TailExit.Auth, text: text.auth });
	});

	it("test_head_when_events_wait_300_s_to_enter_the_log_then_stalled_exit_7", async () => {
		const quiet = probe(good({ unsequenced_oldest_seconds: 299 }));
		await advance(1);
		expect(quiet.stop()).toBeUndefined();
		await quiet.end();
		const p = probe(good({ unsequenced_oldest_seconds: 300 }));
		await advance(1);
		expect(p.stop()).toMatchObject({
			code: TailExit.Stalled,
			reason: "stalled",
			text: text.stalled(300),
		});
	});

	it("test_head_when_the_head_is_behind_what_was_received_then_truncated_exit_8", async () => {
		const p = probe(good({ seq: 8 }), { progress: { lastSeq: 10 } });
		await advance(1);
		expect(p.stop()).toMatchObject({
			code: TailExit.Truncated,
			text: text.truncated(8, 10),
		});
	});

	it("test_head_when_the_seq_drops_between_two_heads_then_truncated_and_a_new_epoch_is_not", async () => {
		const seqs = [5, 3];
		const p = probe((nonce, i) =>
			signedHead("k1", k1.privateKey, nonce, { seq: seqs[i] ?? 3 }),
		);
		await advance(61);
		expect(p.stop()).toMatchObject({ code: 8, text: text.truncated(3, 5) });

		const fresh = probe(good({ seq: 3, chain_epoch: 2 }), {
			progress: { lastSeq: 10 },
		});
		await advance(1);
		expect(fresh.stop()).toBeUndefined();
		await fresh.end();
	});

	it("test_head_when_the_head_is_ahead_for_120_s_while_caught_up_then_withheld_exit_6", async () => {
		const p = probe(good({ seq: 9 }), { progress: { lastSeq: 5 } });
		await advance(119);
		expect(p.stop()).toBeUndefined();
		await advance(2);
		expect(p.stop()).toMatchObject({
			code: TailExit.Silenced,
			reason: "withheld",
			text: text.withheld(9, 120),
		});
	});

	it("test_head_when_the_sink_is_blocked_or_pages_are_still_coming_then_an_ahead_head_is_not_withheld", async () => {
		const blocked = probe(good({ seq: 9 }), {
			progress: { lastSeq: 5, sinkBlocked: true },
		});
		const busy = probe(good({ seq: 9 }), {
			progress: { lastSeq: 5, caughtUp: false },
		});
		await advance(400);
		expect(blocked.stop()).toBeUndefined();
		expect(busy.stop()).toBeUndefined();
		await blocked.end();
		await busy.end();
	});
});

describe("tail with a head watch", () => {
	const idle = (h: ReturnType<typeof harness>) => {
		h.run.source = { ...h.run.source, fetchPage: async () => page([]) };
	};
	const withHead = (
		fetchHead: HeadWatch["fetchHead"],
		over: Partial<HeadWatch> = {},
	): HeadWatch => ({
		fetchHead,
		fetchKeys: async () => ({ keys: [k1.key] }),
		thresholds: { silencedS: 300, withheldS: 120, stalledS: 300 },
		intervalMs: 60_000,
		keyRetryMs: 420_000,
		...over,
	});

	it("test_tail_when_the_head_stops_answering_then_exit_6_the_text_on_stderr_and_one_alert_record_to_the_sink", async () => {
		const h = harness([]);
		idle(h);
		h.run.head = withHead(async () => {
			throw new TypeError("fetch failed");
		});
		h.run.intervalMs = 1000;
		const done = runTail(h.run);
		await advance(400);
		expect(await done).toBe(TailExit.Silenced);
		expect(h.logs.at(-1)).toMatch(
			/has not answered a signed head check for 3\d\d s/,
		);
		expect(h.bodies()).toHaveLength(1);
		expect(h.bodies()[0]).toMatchObject({
			schema: "rine.collector_alert.v1",
			reason: "silenced",
			exit_code: 6,
		});
	});

	it("test_tail_when_the_receiver_refuses_for_900_s_and_the_head_is_healthy_then_exit_9_with_no_alert_to_the_sink_and_never_6", async () => {
		const h = harness([page(chain(2)), page([])], {}, () => "HTTP 503");
		h.run.head = withHead(async (nonce) =>
			signedHead("k1", k1.privateKey, nonce, { seq: 2 }),
		);
		const done = runTail(h.run);
		await advance(1200);
		expect(await done).toBe(TailExit.SinkDown);
		expect(h.logs.at(-1)).toMatch(
			/^rine org events tail: the HEC receiver has refused every batch for 9\d\d s\. The server is answering;/,
		);
		expect(h.accepted).toEqual([]);
		expect(h.saved).toEqual([]);
	});
});
