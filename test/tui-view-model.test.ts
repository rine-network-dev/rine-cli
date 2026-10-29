import { ReadGapReason, type ReadMessage } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { Glyph } from "../src/tui/feed-schema.js";
import { searchMatches } from "../src/tui/state-data.js";
import { Role } from "../src/tui/style.js";
import { BODY_MAX_CHARS, SNIPPET_MAX_CHARS, SnippetKind, formatPayload, glyphMark, noteHandles, rowView } from "../src/tui/view-model.js";

const SALES = { agentId: "3f9a1c07-0000-4000-8000-000000000001", handle: "sales@acme", orgId: "o", own: true };
const BILLING = { agentId: "8b20e4d1-0000-4000-8000-000000000002", handle: "billing@acme", orgId: "o", own: true };
const MICROS = Date.UTC(2026, 9, 24, 14, 2, 11) * 1000;

function message(over: Partial<ReadMessage> = {}, row: Partial<ReadMessage["row"]> = {}): ReadMessage {
	return {
		row: {
			id: "m1",
			createdAt: "2026-10-24T14:02:11Z",
			createdAtMicros: MICROS,
			offsetMinutes: 0,
			type: "rine.v1.text",
			direction: "internal",
			sender: SALES,
			recipient: BILLING,
			groupId: null,
			groupHandle: null,
			conversationId: "c",
			encryptionVersion: "hpke-hybrid-v2",
			ciphertext: new Uint8Array(),
			selfCiphertext: null,
			keyGen: null,
			...row,
		},
		text: JSON.stringify({ text: "Invoice 4471 is ready" }),
		verification: null,
		equivocation: false,
		epoch: null,
		gap: null,
		slot: null,
		envelope: null,
		...over,
	};
}

describe("formatPayload", () => {
	it("shows the text field of a JSON object", () => {
		expect(formatPayload('{"text":"hello"}')).toBe("hello");
	});
	it("shows other JSON exactly as sent, so no number or field changes", () => {
		const big = '{"amount": 9007199254740993, "to": "x"}';
		expect(formatPayload(big)).toBe(big);
	});
	it("shows the whole payload when text sits beside other fields", () => {
		const both = '{"text":"hi","payee":"evil"}';
		expect(formatPayload(both)).toBe(both);
	});
	it("survives deeply nested JSON without expanding it", () => {
		const deep = "[".repeat(6000) + "]".repeat(6000);
		expect(formatPayload(deep)).toBe(deep);
	});
	it("shows a payload that is not JSON as it is", () => {
		expect(formatPayload("plain words")).toBe("plain words");
	});
	it("does not leak the input through an error", () => {
		expect(() => formatPayload("{SENTINEL")).not.toThrow();
	});
});

describe("rowView body", () => {
	it("scrubs after parsing, so escapes that decode to controls are removed", () => {
		const text = JSON.stringify({ text: "a\u001b[31mred‮b" });
		expect(text).toContain("\\u001b");
		const view = rowView(message({ text }));
		expect(view.body).toBe("aredb");
		expect(view.hiddenChars).toBeGreaterThan(0);
	});

	it("scrubs a payload that is not JSON as raw text", () => {
		const view = rowView(message({ text: "x\u001b]0;title\u0007y" }));
		expect(view.body).toBe("xy");
		expect(view.hiddenChars).toBeGreaterThan(0);
	});

	it("clips the body and counts what was dropped", () => {
		const view = rowView(message({ text: "z".repeat(BODY_MAX_CHARS + 100) }));
		expect(Array.from(view.body ?? "").length).toBeLessThanOrEqual(BODY_MAX_CHARS);
		expect(view.textTruncated).toBeGreaterThan(0);
	});

	it("keeps the snippet to one short line", () => {
		const view = rowView(message({ text: `line one\n\n${"w ".repeat(500)}` }));
		expect(view.snippet).not.toContain("\n");
		expect(Array.from(view.snippet).length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
		expect(view.snippet.startsWith("line one w")).toBe(true);
	});

	it("shows no body when the text is withheld", () => {
		const view = rowView(message({ text: null, verification: "invalid" }));
		expect(view.body).toBeNull();
		expect(view.verdict).toBe(Glyph.Invalid);
		expect(view.snippet).toBe("signature does not match, so the text is not shown");
	});
});

describe("rowView verdict and parties", () => {
	it.each([
		["invalid", Glyph.Invalid],
		["sender-mismatch", Glyph.SenderMismatch],
		["unverifiable", Glyph.Unverifiable],
	] as const)("maps %s", (verification, glyph) => {
		expect(rowView(message({ text: null, verification })).verdict).toBe(glyph);
	});

	it("a row with no verdict is verified only when its text was read", () => {
		expect(rowView(message({ verification: null })).verdict).toBe(Glyph.Verified);
		expect(rowView(message({ text: null, verification: null })).verdict).toBe(Glyph.Unverifiable);
	});

	it("carries the direction the row has", () => {
		for (const direction of ["sent", "received", "internal"] as const) {
			expect(rowView(message({}, { direction })).direction).toBe(direction);
		}
	});

	it("a gap row shows its sentence and no body", () => {
		const view = rowView(message({ text: null, gap: { reason: ReadGapReason.NoEscrow, epoch: 41 } }));
		expect(view.verdict).toBe(Glyph.Gap);
		expect(view.snippet).toBe(view.gapSentence);
		expect(view.verdictLabel).toBe(view.gapSentence);
		expect(view.snippet).toContain("epoch 41");
		expect(view.body).toBeNull();
	});

	it("a gap row names the key copy's uploader by the handle a loaded row knows", () => {
		const gap = { reason: ReadGapReason.EscrowInvalid, epoch: 3, uploader: "u1" };
		const named = rowView(message({ text: null, gap }), new Map([["u1", "atlas@acme"]]));
		expect(named.gapSentence).toContain("atlas@acme");
		expect(rowView(message({ text: null, gap })).gapSentence).toContain("u1");
	});

	it("shows short agent ids beside both parties of a 1:1 row", () => {
		const view = rowView(message());
		expect(view.kind).toBe("1:1");
		expect(view.fromShort).toBe("3f9a1c07");
		expect(view.toShort).toBe("8b20e4d1");
		expect([view.from, view.to, view.groupLabel]).toEqual(["sales@acme", "billing@acme", null]);
		expect(view.agents.map((a) => a.id)).toEqual([SALES.agentId, BILLING.agentId]);
	});

	it("reads a group row as #group · sender, listing only the org's own agents", () => {
		const outsider = { ...SALES, handle: "x@other", own: false };
		const view = rowView(message({}, { groupId: "g1", groupHandle: "#ops", sender: outsider, recipient: null }));
		expect(view.kind).toBe("group");
		expect([view.from, view.to, view.groupLabel]).toEqual(["x@other", null, "#ops"]);
		expect(view.group).toEqual({ id: "g1", label: "#ops" });
		expect(view.agents).toEqual([]);
	});

	it("scrubs handles and ids from the server", () => {
		const hostile = { ...SALES, handle: "ev\u001b[2Jil", agentId: "\u001b[31m3f9a1c07zz" };
		const view = rowView(message({}, { sender: hostile }));
		expect([view.from, view.to]).toEqual(["evil", "billing@acme"]);
		expect(view.fromShort).toBe("3f9a1c07");
	});

	it("shows the org's own agents bare and other orgs short, against the slug it is given", () => {
		const own = { ...SALES, handle: "sales@acme.rine.network" };
		const buyer = { ...BILLING, handle: "buyer@fjord21735.rine.network", own: false };
		const view = rowView(message({}, { sender: own, recipient: buyer }), undefined, "acme");
		expect([view.from, view.to]).toEqual(["sales", "buyer@fjord21735"]);
		expect(view.searchText).toContain("buyer@fjord21735");
		expect(view.agents[0]?.label).toBe("sales");
		const inbound = rowView(message({}, { sender: buyer, recipient: own }), undefined, "acme");
		expect([inbound.from, inbound.to]).toEqual(["buyer@fjord21735", "sales"]);
	});

	it("shows a group in the org bare, another org's group short, and a lookalike in full", () => {
		const group = (groupHandle: string, slug: string | null = "acme") =>
			rowView(message({}, { groupId: "g1", groupHandle, recipient: null }), undefined, slug).groupLabel;
		expect(group("#ops@acme.rine.network")).toBe("#ops");
		expect(group("#ops@fjord21735.rine.network")).toBe("#ops@fjord21735");
		expect(group("#ops@acme.rine.network.evil.io")).toBe("#ops@acme.rine.network.evil.io");
	});

	it("names an agent in a gap sentence the way the rows do", () => {
		const own = { ...SALES, handle: "sales@acme.rine.network" };
		const handles = new Map<string, string>();
		noteHandles(handles, message({}, { sender: own }), "acme");
		expect(handles.get(SALES.agentId)).toBe("sales");
	});

	it("tells the list what the snippet is", () => {
		expect(rowView(message()).snippetKind).toBe(SnippetKind.Text);
		const gap = { reason: ReadGapReason.NoEscrow, epoch: 41 };
		expect(rowView(message({ text: null, gap })).snippetKind).toBe(SnippetKind.Gap);
		expect(rowView(message({ text: null, verification: "invalid" })).snippetKind).toBe(SnippetKind.Verdict);
	});

	it("carries the send time as ISO for the list's date column", () => {
		expect(rowView(message()).sentAt).toBe("2026-10-24T14:02:11.000Z");
	});

	it("flags equivocation with its sentence", () => {
		const view = rowView(message({ equivocation: true }));
		expect(view.equivocation).toBe(true);
		expect(view.equivocationSentence).toContain("two different copies");
		expect(rowView(message()).equivocationSentence).toBeNull();
	});

	it("finds a row by a pasted full handle as well as by the short label", () => {
		const own = { ...SALES, handle: "sales@acme.rine.network" };
		const buyer = { ...BILLING, handle: "buyer@fjord21735.rine.network", own: false };
		const direct = rowView(message({}, { sender: own, recipient: buyer }), undefined, "acme");
		const grouped = rowView(
			message({}, { sender: own, recipient: null, groupId: "g1", groupHandle: "#ops@fjord21735.rine.network" }),
			undefined,
			"acme",
		);
		for (const [view, queries] of [
			[direct, ["sales", "buyer@fjord21735", "sales@acme.rine.network", "buyer@fjord21735.rine.network"]],
			[grouped, ["#ops@fjord21735", "#ops@fjord21735.rine.network"]],
		] as const)
			for (const query of queries) expect(searchMatches([view], query)).toEqual([view.id]);
		expect(searchMatches([direct], "fjord21735.evil")).toEqual([]);
	});

	it("makes the search text from handles, group and snippet", () => {
		expect(rowView(message()).searchText).toContain("invoice 4471");
		expect(rowView(message()).searchText).toContain("billing@acme");
	});
});

describe("glyphMark", () => {
	it("picks the alphabet", () => {
		expect(glyphMark(Glyph.Verified, true)).toEqual({ text: "✓", role: Role.Ok });
		expect(glyphMark(Glyph.Verified, false)).toEqual({ text: "+", role: Role.Ok });
		expect(glyphMark(Glyph.Equivocation, false)).toEqual({ text: "#", role: Role.Info });
	});
});
