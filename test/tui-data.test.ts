import {
	type ActivityQuery,
	MalformedPageError,
	type ReadFinding,
	ReadGapReason,
	type ReadMessage,
	type ReadPage,
	ReaderNetworkError,
	RineApiError,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionFor } from "../src/tui/app-data.js";
import { Poller } from "../src/tui/data.js";
import type { DataEvent } from "../src/tui/data-types.js";
import { FeedErrorCode, PageKind } from "../src/tui/feed-schema.js";
import { messageOf, textBody } from "./tui-fixture.js";

const NOW = Date.UTC(2026, 9, 24, 14, 0, 0);
function message(id: string, ageS: number, over: Partial<ReadMessage> = {}, bytes = [1]): ReadMessage {
	return messageOf(
		id,
		{ text: textBody("hi"), ...over },
		{ createdAtMicros: (NOW - ageS * 1000) * 1000, ciphertext: new Uint8Array(bytes) },
	);
}

const gapped = (id: string, ageS: number, reason: ReadGapReason): ReadMessage =>
	message(id, ageS, { text: null, gap: { reason } });
const page = (items: ReadMessage[], nextCursor: string | null = null, findings: ReadFinding[] = []): ReadPage => ({
	items,
	nextCursor,
	findings,
});

function setup(results: (ReadPage | Error)[], extra: { bucket?: { msUntilToken(): number }; pollS?: number } = {}) {
	const queries: ActivityQuery[] = [];
	const events: DataEvent[] = [];
	const queue = [...results];
	const reader = {
		async read(query: ActivityQuery): Promise<ReadPage> {
			queries.push(query);
			const next = queue.shift();
			if (next === undefined) return page([]);
			if (next instanceof Error) throw next;
			return next;
		},
	};
	const poller = new Poller({ reader, emit: (e) => events.push(e), now: () => NOW, ...extra });
	const rows = () => events.flatMap((e) => (e.type === "rows" ? e.rows : []));
	const errors = () => events.filter((e) => e.type === "error");
	return { poller, queries, events, rows, errors };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Poller", () => {
	it("reads the newest page of 100 first, with its older cursor", async () => {
		const t = setup([page([message("m1", 10)], "older-1")]);
		await t.poller.start();
		expect(t.queries[0]).toEqual({ limit: 100 });
		expect(t.events).toContainEqual({ type: "page", kind: PageKind.Initial, count: 1, olderCursor: "older-1" });
		await t.poller.stop();
	});

	it("polls 30 seconds behind the newest row and emits a row once", async () => {
		const t = setup([page([message("m1", 10)]), page([message("m1", 10), message("m2", 1)])]);
		await t.poller.start();
		await t.poller.poll();
		expect(t.queries[1]?.since).toBe(new Date(NOW - 10_000 - 30_000).toISOString());
		expect(t.rows().map((m) => m.row.id)).toEqual(["m1", "m2"]);
		await t.poller.stop();
	});

	it("clamps a far-future row so the window cannot pass real rows", async () => {
		const t = setup([page([message("m1", -86_400)]), page([])]);
		await t.poller.start();
		await t.poller.poll();
		expect(t.queries[1]?.since).toBe(new Date(NOW + 60_000 - 30_000).toISOString());
		await t.poller.stop();
	});

	it("replaces a gap with the text once the row opens", async () => {
		const t = setup([page([gapped("m1", 5, ReadGapReason.NoEscrow)]), page([message("m1", 5)])]);
		await t.poller.start();
		await t.poller.poll();
		expect(t.rows().map((m) => m.gap)).toEqual([{ reason: ReadGapReason.NoEscrow }, null]);
		await t.poller.stop();
	});

	it("keeps the first text of a verified row and flags a re-sent different ciphertext once", async () => {
		const first = message("m1", 5, { text: '{"text":"first"}' });
		const resent = message("m1", 5, { text: '{"text":"second"}' }, [2]);
		const t = setup([page([first]), page([resent]), page([resent])]);
		await t.poller.start();
		await t.poller.poll();
		await t.poller.poll();
		expect(t.rows()).toHaveLength(2);
		expect(t.rows()[1]).toMatchObject({ text: '{"text":"first"}', equivocation: true });
		await t.poller.stop();
	});

	it("replaces an unverifiable row once its sender verifies", async () => {
		const t = setup([
			page([message("m1", 5, { verification: "unverifiable" })]),
			page([message("m1", 5, { verification: "verified" })]),
		]);
		await t.poller.start();
		await t.poller.poll();
		expect(t.rows().map((m) => m.verification)).toEqual(["unverifiable", "verified"]);
		await t.poller.stop();
	});

	it("re-opens a row whose keys were unavailable, however old it is", async () => {
		const t = setup([
			page([gapped("old", 3600, ReadGapReason.KeysUnavailable), message("new", 1)]),
			page([message("old", 3600)]),
		]);
		await t.poller.start();
		await t.poller.poll();
		expect(t.queries[1]?.since).toBe(new Date(NOW - 3_600_000).toISOString());
		expect(t.rows().at(-1)).toMatchObject({ gap: null, row: { id: "old" } });
		await t.poller.stop();
	});

	it("tells each finding once", async () => {
		const finding: ReadFinding = { groupId: "g1", gap: { reason: ReadGapReason.NoEscrow, epoch: 4 } };
		const t = setup([page([], null, [finding]), page([], null, [finding])]);
		await t.poller.start();
		await t.poller.poll();
		expect(t.events.filter((e) => e.type === "finding")).toEqual([{ type: "finding", finding }]);
		await t.poller.stop();
	});

	it("follows at most 3 pages per poll and resumes the rest on the next", async () => {
		const t = setup([
			page([message("m0", 100)]),
			page([message("a", 5)], "c1"),
			page([message("b", 4)], "c2"),
			page([message("c", 3)], "c3"),
			page([message("d", 2)]),
		]);
		await t.poller.start();
		await t.poller.poll();
		expect(t.queries.slice(1).map((q) => q.cursor ?? null)).toEqual([null, "c1", "c2"]);
		await t.poller.poll();
		expect(t.queries[4]?.cursor).toBe("c3");
		expect(t.rows().map((m) => m.row.id)).toEqual(["m0", "a", "b", "c", "d"]);
		await t.poller.stop();
	});

	it("defers a poll while the bucket is empty, then reads when a token is back", async () => {
		let wait = 4000;
		const t = setup([page([])], { bucket: { msUntilToken: () => wait } });
		await t.poller.start();
		await t.poller.poll();
		expect(t.queries).toHaveLength(1);
		wait = 0;
		await vi.advanceTimersByTimeAsync(4000);
		expect(t.queries).toHaveLength(2);
		await t.poller.stop();
	});

	it("polls again on the cadence while following, and not once paused", async () => {
		const t = setup([page([])], { pollS: 5 });
		await t.poller.start();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.queries).toHaveLength(2);
		t.poller.setFollow(false);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(t.queries).toHaveLength(2);
		await t.poller.stop();
	});

	it("honours Retry-After on a 429, then doubles up to two minutes", async () => {
		const limited = (secs?: string) =>
			new RineApiError(429, "slow down", secs === undefined ? undefined : new Response(null, { headers: { "retry-after": secs } }));
		const t = setup([limited("45"), limited(), limited(), limited()]);
		await t.poller.start();
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(120_000);
		expect(t.errors().map((e) => e.retryS)).toEqual([45, 90, 120, 120]);
		await t.poller.stop();
	});

	it("waits 30 seconds on a 429 without Retry-After", async () => {
		const t = setup([new RineApiError(429, "slow down")]);
		await t.poller.start();
		expect(t.errors()).toEqual([{ type: "error", code: FeedErrorCode.RateLimited, retryS: 30 }]);
		await t.poller.stop();
	});

	it("names each failure and stops for good on a refusal", async () => {
		const t = setup([
			new ReaderNetworkError("down"),
			new RineApiError(503, "busy"),
			new MalformedPageError(),
			new RineApiError(401, "no"),
		]);
		await t.poller.start();
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.errors().map((e) => [e.code, e.retryS])).toEqual([
			[FeedErrorCode.Network, 5],
			[FeedErrorCode.Server, 5],
			[FeedErrorCode.MalformedPage, 5],
			[FeedErrorCode.AuthRefused, null],
		]);
		expect(t.queries).toHaveLength(4);
	});

	it("reads older pages and a filter from the newest page of its slice", async () => {
		const t = setup([page([message("m1", 10)], "o1"), page([message("m0", 90)], "o2"), page([message("f1", 8)])]);
		await t.poller.start();
		await t.poller.older("o1");
		expect(t.queries[1]).toEqual({ cursor: "o1", limit: 100 });
		expect(t.events).toContainEqual({ type: "page", kind: PageKind.Older, count: 1, olderCursor: "o2" });
		await t.poller.setFilter({ agentId: "a1", groupId: "g1" });
		expect(t.queries[2]).toEqual({ limit: 100, agent: "a1", groupId: "g1" });
		expect(t.events.at(-1)).toMatchObject({ type: "rows", kind: PageKind.Initial });
		await t.poller.stop();
	});

	it("emits the rows of a page before the next page is read, so a failed poll loses none", async () => {
		const t = setup([page([message("m0", 100)]), page([message("a", 5)], "c1"), new RineApiError(503, "busy"), page([message("b", 4)])]);
		await t.poller.start();
		await t.poller.poll();
		expect(t.rows().map((m) => m.row.id)).toEqual(["m0", "a"]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.queries[3]?.cursor).toBe("c1");
		expect(t.rows().map((m) => m.row.id)).toEqual(["m0", "a", "b"]);
		await t.poller.stop();
	});

	it("retries a failed initial read as an initial read and keeps what was loaded until it lands", async () => {
		const t = setup([page([message("m1", 10)], "o1"), new RineApiError(503, "busy"), page([message("f1", 8)])]);
		await t.poller.start();
		await t.poller.setFilter({ agentId: "a1", groupId: null });
		expect(t.rows().map((m) => m.row.id)).toEqual(["m1"]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.queries[2]).toEqual({ limit: 100, agent: "a1" });
		expect(t.events.at(-2)).toMatchObject({ type: "page", kind: PageKind.Initial, count: 1 });
		expect(t.rows().map((m) => m.row.id)).toEqual(["m1", "f1"]);
		await t.poller.stop();
	});

	it("reads nothing more once a refusal has stopped it", async () => {
		const t = setup([page([message("m1", 10)]), new RineApiError(401, "no")]);
		await t.poller.start();
		await t.poller.poll();
		await vi.advanceTimersByTimeAsync(60_000);
		await t.poller.poll();
		expect(t.queries).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("lets a defect propagate", async () => {
		const t = setup([new TypeError("bug")]);
		await expect(t.poller.start()).rejects.toThrow("bug");
		await t.poller.stop();
	});
});

describe("connectionFor", () => {
	it("carries the feed code of every state that blocks the view", () => {
		for (const code of [
			FeedErrorCode.AuthRefused,
			FeedErrorCode.NeedsOrgKey,
			FeedErrorCode.NoIdentity,
		]) {
			expect(connectionFor(code, null, "api.test")).toEqual({ kind: "blocked", code });
		}
	});
});
