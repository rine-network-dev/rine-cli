import {
	type ReadFinding,
	type ReadGap,
	ReadGapReason,
	type ReadMessage,
	type ReadPage,
} from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { OVERLAP_MS, RowBook } from "../src/tui/data-book.js";
import { MAX_LOADED_ROWS } from "../src/tui/state-data.js";
import { messageOf, textBody } from "./tui-fixture.js";

const NOW = Date.UTC(2026, 9, 24, 14, 0, 0);
const message = (id: string, ageMs: number): ReadMessage =>
	messageOf(
		id,
		{ text: textBody("hi") },
		{ createdAtMicros: (NOW - ageMs) * 1000, ciphertext: new Uint8Array([1]) },
	);
const pageOf = (
	items: ReadMessage[],
	findings: ReadFinding[] = [],
): ReadPage => ({ items, nextCursor: null, findings });
const found = (groupId: string, gap: ReadGap): ReadFinding => ({ groupId, gap });

describe("RowBook findings", () => {
	it("tells equal gaps once whatever their field order", () => {
		const book = new RowBook();
		const first: ReadGap = { reason: ReadGapReason.NoEscrow, epoch: 4, index: 1 };
		const reordered: ReadGap = { index: 1, epoch: 4, reason: ReadGapReason.NoEscrow };
		expect(book.absorb(pageOf([], [found("g1", first)]), NOW).findings).toHaveLength(1);
		expect(book.absorb(pageOf([], [found("g1", reordered)]), NOW).findings).toHaveLength(0);
	});

	it("tells an equal gap again when another group found it", () => {
		const book = new RowBook();
		const gap: ReadGap = { reason: ReadGapReason.NoEscrow, epoch: 4 };
		expect(book.absorb(pageOf([], [found("g1", gap)]), NOW).findings).toHaveLength(1);
		expect(book.absorb(pageOf([], [found("g2", gap)]), NOW).findings).toHaveLength(1);
		expect(book.absorb(pageOf([], [found("g2", gap)]), NOW).findings).toHaveLength(0);
	});

	it("tells a finding again after the book is cleared for a new read", () => {
		const book = new RowBook();
		const seen = found("g1", { reason: ReadGapReason.NoEscrow, epoch: 4 });
		book.absorb(pageOf([], [seen]), NOW);
		book.clear();
		expect(book.absorb(pageOf([], [seen]), NOW).findings).toEqual([seen]);
	});
});

describe("RowBook bounds", () => {
	it("forgets the oldest rows once past the cap", () => {
		const book = new RowBook();
		const flood = Array.from({ length: MAX_LOADED_ROWS + 3 }, (_, i) =>
			message(`m${i}`, 1000),
		);
		book.absorb(pageOf(flood), NOW);
		const again = book.absorb(pageOf([flood[0], flood.at(-1)] as ReadMessage[]), NOW);
		expect(again.changed.map((m) => m.row.id)).toEqual(["m0"]);
	});

	it("forgets the oldest findings once past the cap", () => {
		const book = new RowBook();
		const flood = Array.from({ length: MAX_LOADED_ROWS + 1 }, (_, i) =>
			found("g1", { reason: ReadGapReason.NoEscrow, epoch: i }),
		);
		book.absorb(pageOf([], flood), NOW);
		expect(book.absorb(pageOf([], [flood[0] as ReadFinding]), NOW).findings).toHaveLength(1);
		expect(book.absorb(pageOf([], [flood.at(-1) as ReadFinding]), NOW).findings).toHaveLength(0);
	});
});

describe("RowBook since", () => {
	const gapped = (id: string, ageMs: number, reason: ReadGap["reason"]) =>
		messageOf(
			id,
			{ gap: { reason } },
			{ createdAtMicros: (NOW - ageMs) * 1000 },
		);

	it("reaches back to a row still waiting on keys", () => {
		const book = new RowBook();
		book.absorb(pageOf([gapped("a", 600_000, ReadGapReason.KeysUnavailable), message("b", 0)]), NOW);
		expect(book.since()).toBe(new Date(NOW - 600_000).toISOString());
	});

	it("keeps the overlap window for a gap that a retry cannot change", () => {
		const book = new RowBook();
		book.absorb(pageOf([gapped("a", 600_000, ReadGapReason.NoDistribution), message("b", 0)]), NOW);
		expect(book.since()).toBe(new Date(NOW - OVERLAP_MS).toISOString());
	});
});
