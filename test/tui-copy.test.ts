import { ReadGapReason, type ReadGap } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import {
	DUMB_TERMINAL,
	GAP_MEANING,
	NEEDS_TERMINAL,
	VERIFICATION_LABEL,
	errorSentence,
	gapSentence,
	hiddenCharsSentence,
} from "../src/tui/copy.js";
import { FeedErrorCode, Glyph } from "../src/tui/feed-schema.js";

const FULL: ReadGap = { reason: ReadGapReason.NoEscrow, epoch: 41, uploader: "up", sender: "sam", index: 3 };

describe("gapSentence", () => {
	it.each(Object.values(ReadGapReason))("has a sentence for %s", (reason) => {
		const sentence = gapSentence({ ...FULL, reason });
		expect(sentence.length).toBeGreaterThan(10);
		expect(sentence).not.toMatch(/undefined|\{|\}/);
	});

	it("stays whole when the reason's fields are missing", () => {
		for (const reason of Object.values(ReadGapReason)) {
			expect(gapSentence({ reason })).not.toMatch(/undefined|\{|\}/);
		}
	});

	it("says the keys could not be fetched just now, naming nobody", () => {
		expect(gapSentence({ reason: ReadGapReason.KeysUnavailable, epoch: 7 })).toBe(
			"The keys needed to check this message could not be fetched just now, so it is checked again on the next read.",
		);
	});

	it("names the epoch, the uploader and the sender from the gap", () => {
		expect(gapSentence({ reason: ReadGapReason.EscrowForged, epoch: 41 })).toContain("epoch 41");
		expect(gapSentence({ reason: ReadGapReason.EscrowInvalid, uploader: "up" })).toContain("up uploaded");
		expect(gapSentence({ reason: ReadGapReason.NoDistribution, sender: "sam" })).toMatch(/^sam's sender key/);
	});

	it("tells two key-copy findings of one uploader apart by epoch", () => {
		const at = (epoch: number) => gapSentence({ reason: ReadGapReason.EscrowInvalid, epoch, uploader: "up" });
		expect(at(3)).toContain("uploaded for epoch 3 ");
		expect(at(3)).not.toBe(at(4));
	});

	it("names the uploader by handle when one is known, else by id", () => {
		const gap = { reason: ReadGapReason.EscrowInvalid, epoch: 2, uploader: "3f9c" };
		expect(gapSentence(gap, new Map([["3f9c", "ada"]]))).toContain("The key copy ada uploaded");
		expect(gapSentence(gap, new Map())).toContain("The key copy 3f9c uploaded");
	});

	it("scrubs a server string before it enters a sentence", () => {
		const sentence = gapSentence({ reason: ReadGapReason.NoDistribution, sender: "\u001b[31mred‮" });
		expect(sentence).toMatch(/^red's sender key/);
	});
});

describe("labels and states", () => {
	it("labels every verdict glyph", () => {
		for (const glyph of [Glyph.Verified, Glyph.Invalid, Glyph.SenderMismatch, Glyph.Unverifiable, Glyph.Gap] as const) {
			expect(VERIFICATION_LABEL[glyph]).toBeTruthy();
		}
		expect(GAP_MEANING).toBeTruthy();
	});

	it("has a sentence for every feed error code", () => {
		for (const code of Object.values(FeedErrorCode)) {
			expect(errorSentence(code, { host: "rine.network", retryS: 5 })).not.toMatch(/undefined|\{|\}/);
		}
	});

	it("says the org key is needed, in the vocabulary of keys", () => {
		const sentence = errorSentence(FeedErrorCode.NeedsOrgKey);
		expect(sentence).toContain("needs the org key");
		expect(sentence).toContain("rine inbox");
	});

	it("carries the retry delay and the host", () => {
		expect(errorSentence(FeedErrorCode.Network, { host: "api.example", retryS: 12 })).toBe(
			"Cannot reach api.example. Trying again in 12 s.",
		);
		expect(errorSentence(FeedErrorCode.RateLimited, { retryS: 30 })).toBe(
			"Paused for 30 s: your org's read limit was reached.",
		);
	});

	it("counts hidden characters", () => {
		expect(hiddenCharsSentence(3)).toBe("3 hidden characters removed");
	});
});

describe("terminal refusals", () => {
	it("point to the line commands, not to the feed", () => {
		const lines = "To read messages as lines, use rine inbox or rine stream.";
		expect(NEEDS_TERMINAL).toBe(`rine tui needs a terminal. ${lines}`);
		expect(DUMB_TERMINAL).toBe(`rine tui cannot draw on a terminal of type dumb. ${lines}`);
	});
});
