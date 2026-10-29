import { describe, expect, it } from "vitest";
import { GLYPHS, type GlyphName, SPINNER, PULSE, frameAt, glyph } from "../src/tui/glyphs.js";
import { headerTitle } from "../src/tui/header.js";
import { Screen } from "../src/tui/screen.js";
import { Role } from "../src/tui/style.js";
import { clipRuns, fitRuns, putRuns, runsWidth } from "../src/tui/widgets/runs.js";

const names = Object.keys(GLYPHS) as GlyphName[];

describe("glyph table", () => {
	it("gives every glyph a printable single-cell ASCII stand-in", () => {
		for (const name of names) {
			expect(GLYPHS[name].ascii).toMatch(/^[\x20-\x7e]+$/);
			expect(GLYPHS[name].ascii.length).toBe(GLYPHS[name].unicode.length);
		}
	});

	it("answers by terminal capability", () => {
		expect(glyph("brand", true)).toBe("◆");
		expect(glyph("brand", false)).toBe("*");
		expect(glyph("selectionBar", false)).toBe(">");
	});

	it("keeps the animated marks drawable in ASCII and wraps by step", () => {
		for (const frames of [SPINNER, PULSE]) {
			for (const frame of frames.ascii) expect(frame).toMatch(/^[\x20-\x7e]$/);
		}
		expect(frameAt(SPINNER, true, 0)).toBe(frameAt(SPINNER, true, SPINNER.unicode.length));
		expect(frameAt(SPINNER, false, 5)).toBe(SPINNER.ascii[1]);
	});
});

describe("runs", () => {
	const runs = [{ text: "ab" }, { text: "cd", style: { bold: true } }];

	it("measures the total display width", () => {
		expect(runsWidth(runs)).toBe(4);
		expect(runsWidth([{ text: "中" }])).toBe(2);
	});

	it("clips across run boundaries and drops what is left", () => {
		expect(clipRuns(runs, 3)).toEqual([{ text: "ab" }, { text: "c", style: { bold: true } }]);
		expect(clipRuns(runs, 0)).toEqual([]);
		expect(clipRuns(runs, 9)).toEqual(runs);
	});

	it("does not split a wide glyph at the cut", () => {
		expect(clipRuns([{ text: "a中" }], 2)).toEqual([{ text: "a" }]);
	});

	it("fits to exactly the width: pads short lines and ellipsises long ones in the last kept style", () => {
		expect(runsWidth(fitRuns(runs, 8, "…"))).toBe(8);
		const cut = fitRuns(runs, 3, "…");
		expect(runsWidth(cut)).toBe(3);
		expect(cut.map((run) => run.text).join("")).toBe("ab…");
		expect(fitRuns([{ text: "中中中" }], 4, "…").map((run) => run.text).join("")).toBe("中… ");
		expect(runsWidth(fitRuns([{ text: "中中中" }], 4, "…"))).toBe(4);
		expect(fitRuns(runs, 0, "…")).toEqual([]);
	});

	it("draws each run over the base style and returns the next column", () => {
		const screen = new Screen(6, 1);
		const next = putRuns(screen, 1, 0, runs, { fg: Role.Dim });
		expect(next).toBe(5);
		expect(screen.cell(1, 0).style).toEqual({ fg: Role.Dim });
		expect(screen.cell(3, 0).style).toEqual({ fg: Role.Dim, bold: true });
	});
});

describe("headerTitle", () => {
	const text = (title: ReturnType<typeof headerTitle>) => title.map((run) => run.text).join("");

	it("reads brand mark, wordmark, then the org name", () => {
		expect(text(headerTitle({ name: "Acme", slug: "acme" }, true, null))).toBe("◆ rine · Acme");
		expect(text(headerTitle({ name: "Acme", slug: "acme" }, false, null))).toBe("* rine - Acme");
	});

	it("falls back to a plain word until the org is known", () => {
		expect(text(headerTitle(null, true, null))).toBe("◆ rine · org");
	});

	it("clips a long name to 24 cells with an ellipsis", () => {
		const long = { name: "A".repeat(40), slug: "acme" };
		const shown = text(headerTitle(long, true, null)).split(" · ")[1] as string;
		expect(runsWidth([{ text: shown }])).toBe(24);
		expect(shown.endsWith("…")).toBe(true);
		expect(text(headerTitle(long, false, null)).endsWith("~")).toBe(true);
	});

	it("shows the wordmark mid-reveal as shades, not the word", () => {
		expect(text(headerTitle(null, true, 0))).toContain("▓▓▓▓");
	});
});
