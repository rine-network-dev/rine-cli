import { displayWidth } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { Screen } from "../src/tui/screen.js";
import { Role } from "../src/tui/style.js";
import {
	type ReaderItem,
	type ReaderView,
	drawReader,
} from "../src/tui/widgets/reader.js";
import type { ReaderParties } from "../src/tui/widgets/parties.js";
import { bodyLines } from "../src/tui/widgets/wrap.js";

function rowText(s: Screen, y: number): string {
	let line = "";
	for (let x = 0; x < s.cols; x++) line += s.cell(x, y).text;
	return line;
}

const rows = (s: Screen): string[] =>
	Array.from({ length: s.rows }, (_, y) => rowText(s, y));

const parties = (from: string, to: string, tailId = true): ReaderParties => ({
	lead: { text: from, style: { bold: true } },
	leadId: { text: " 3f9a1c07", style: { fg: Role.Dim } },
	joint: { text: "  →  ", style: { fg: Role.Dim } },
	tail: { text: to, style: { bold: true } },
	tailId: tailId ? { text: " 8b20e4d1", style: { fg: Role.Dim } } : null,
});

const message = (over: Partial<ReaderItem> = {}): ReaderItem => ({
	parties: parties("sales", "billing@acme"),
	when: "2026-10-24 14:02",
	kind: "1:1",
	glyph: "✓",
	glyphRole: Role.Ok,
	verdict: "verified",
	equivocation: null,
	hidden: null,
	ruleTitle: "message",
	gap: null,
	body: "alpha\nbeta",
	...over,
});

const readerView = (over: Partial<ReaderView> = {}): ReaderView => ({
	scroll: 0,
	wrap: true,
	unicode: true,
	...over,
});

describe("drawReader", () => {
	it("starts every body line with the gutter and keeps body text out of the header", () => {
		const s = new Screen(40, 10);
		const body = Array.from({ length: 5 }, (_, i) => `line-${i}`).join("\n");
		const m = drawReader(
			s,
			{ x: 0, y: 0, w: 40, h: 10 },
			message({ body }),
			readerView(),
		);
		const out = rows(s);
		const ruleRow = out.findIndex((r) => r.startsWith("━━ message"));
		expect(ruleRow).toBe(2);
		for (const header of out.slice(0, ruleRow + 1))
			expect(header).not.toContain("line-");
		for (let i = 0; i < 5; i++)
			expect(out[ruleRow + 1 + i]?.startsWith("┃ line-")).toBe(true);
		expect(m.lines).toBe(5);
	});

	it("uses ASCII gutter and rule when unicode is off", () => {
		const s = new Screen(30, 6);
		drawReader(
			s,
			{ x: 0, y: 0, w: 30, h: 6 },
			message(),
			readerView({ unicode: false }),
		);
		expect(rowText(s, 2)).toBe(`== message ${"-".repeat(19)}`);
		expect(rowText(s, 3).startsWith("| alpha")).toBe(true);
	});

	it("sets the rule as a heavy accent lead, a bold label and a dim line fading out", () => {
		const s = new Screen(30, 6);
		drawReader(s, { x: 0, y: 0, w: 30, h: 6 }, message(), readerView());
		expect(rowText(s, 2)).toBe(`━━ message ${"─".repeat(15)}╌╌┄┄`);
		expect(s.cell(0, 2).style.fg).toBe(Role.Accent);
		expect(s.cell(3, 2).style.bold).toBe(true);
		expect(s.cell(14, 2).style.fg).toBe(Role.Dim);
	});

	it("shows the parties with bold names and dim agent ids", () => {
		const s = new Screen(60, 6);
		drawReader(s, { x: 0, y: 0, w: 60, h: 6 }, message(), readerView());
		expect(rowText(s, 0).trimEnd()).toBe("sales 3f9a1c07  →  billing@acme 8b20e4d1");
		expect(s.cell(0, 0).style.bold).toBe(true);
		expect(s.cell(6, 0).style.fg).toBe(Role.Dim);
		expect(s.cell(6, 0).style.bold).toBeFalsy();
		expect(s.cell(19, 0).style.bold).toBe(true);
	});

	it("reports where the body is drawn and whether a line is cut at the edge", () => {
		const s = new Screen(20, 8);
		const long = message({ body: "x".repeat(40) });
		const cut = drawReader(s, { x: 0, y: 0, w: 20, h: 8 }, long, readerView({ wrap: false }));
		expect(cut.clipped).toBe(true);
		expect(cut.body).toEqual({ x: 2, y: 3, w: 17, h: 5 });
		const wrapped = drawReader(new Screen(20, 8), { x: 0, y: 0, w: 20, h: 8 }, long, readerView());
		expect(wrapped.clipped).toBe(false);
	});

	it("keeps a body line that looks like a verdict row behind the gutter", () => {
		const s = new Screen(40, 8);
		drawReader(
			s,
			{ x: 0, y: 0, w: 40, h: 8 },
			message({ body: "2026-10-24 14:02 · 1:1 · ✓ verified" }),
			readerView(),
		);
		expect(rowText(s, 3).startsWith("┃ 2026-10-24")).toBe(true);
		expect(rowText(s, 1)).toContain("verified");
	});

	it("clamps the scroll into range and reports the drawn position", () => {
		const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
		const s = new Screen(30, 8);
		const m = drawReader(
			s,
			{ x: 0, y: 0, w: 30, h: 8 },
			message({ body }),
			readerView({ scroll: 999 }),
		);
		expect(m).toMatchObject({ lines: 20, viewport: 5, scroll: 15 });
		expect(rowText(s, 7)).toContain("line-19");
		const low = drawReader(
			new Screen(30, 8),
			{ x: 0, y: 0, w: 30, h: 8 },
			message({ body }),
			readerView({ scroll: -4 }),
		);
		expect(low.scroll).toBe(0);
	});

	it("clips a long header line to the width instead of spilling", () => {
		const s = new Screen(20, 8);
		drawReader(
			s,
			{ x: 0, y: 0, w: 20, h: 8 },
			message({ parties: parties("x".repeat(60), "y") }),
			readerView(),
		);
		expect(rowText(s, 0).trimEnd().endsWith("…")).toBe(true);
		expect(displayWidth(rowText(s, 0))).toBeLessThanOrEqual(20);
	});

	it.each([60, 80])("keeps the @ of a long remote group and sender at %i columns", (w) => {
		const s = new Screen(w, 8);
		drawReader(
			s,
			{ x: 0, y: 0, w, h: 8 },
			message({
				parties: parties(
					"mx-cli-longname@mx-cli-874177.rine.network",
					"#mx-orgread-closed-123456@mx-ts-sdk-874177.rine.network",
					false,
				),
			}),
			readerView(),
		);
		const head = rowText(s, 0);
		expect(head.match(/@/g)?.length).toBe(2);
		expect(head).toContain("3f9a1c07");
		expect(displayWidth(head)).toBeLessThanOrEqual(w);
	});

	it("draws a gap as sentence then meaning and never the body", () => {
		const s = new Screen(40, 10);
		drawReader(
			s,
			{ x: 0, y: 0, w: 40, h: 10 },
			message({
				body: "secret body",
				gap: { sentence: "Message missing.", meaning: "It was not seen." },
			}),
			readerView(),
		);
		const text = rows(s).join("\n");
		expect(text).toContain("┃ Message missing.");
		expect(text).toContain("┃ It was not seen.");
		expect(text).not.toContain("secret body");
	});

	it("draws nothing when the rect cannot hold a gutter and scrollbar", () => {
		const s = new Screen(10, 5);
		expect(
			drawReader(s, { x: 0, y: 0, w: 3, h: 5 }, message(), readerView()),
		).toMatchObject({ lines: 0, viewport: 0, scroll: 0 });
		expect(rows(s).join("").trim()).toBe("");
	});
});

describe("bodyLines", () => {
	it("wraps at the last space within the width", () => {
		expect(bodyLines("aaa bbb ccc", 7, true)).toEqual(["aaa bbb", "ccc"]);
	});

	it("never lets a wide cluster overflow the width", () => {
		const lines = bodyLines("日本語のテキスト👨‍👩‍👧‍👦です", 7, true);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(7);
		expect(lines.join("")).toBe("日本語のテキスト👨‍👩‍👧‍👦です");
	});

	it("counts display columns, not characters, when deciding to wrap", () => {
		expect(
			bodyLines("日本語", 5, true)
				.map(displayWidth)
				.every((w) => w <= 5),
		).toBe(true);
		expect(bodyLines("日本語", 5, true).length).toBeGreaterThan(1);
	});

	it("cuts at the edge with wrap off and keeps empty lines", () => {
		expect(bodyLines("abcdefghij\n\nxy", 4, false)).toEqual(["abcd", "", "xy"]);
	});
});
