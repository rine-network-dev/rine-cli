import fs from "node:fs";
import { clusterWidth, graphemes } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { SYNC_BEGIN, SYNC_END } from "../src/tui/caps.js";
import { diffScreens } from "../src/tui/diff.js";
import { Screen } from "../src/tui/screen.js";
import { PLAIN, Role, sgr, type Style, styleEquals } from "../src/tui/style.js";

const ESC = "\x1b";

/** The visible text of each row, wide clusters once, as the screen holds it. */
function rowsOf(screen: Screen): string[] {
	return Array.from({ length: screen.rows }, (_, y) => {
		let line = "";
		for (let x = 0; x < screen.cols; x++) line += screen.cell(x, y).text;
		return line;
	});
}

/** A minimal terminal: applies CUP, CUF, SGR, ED 2 and DEC 2026 to a grid, wide clusters taking two columns. */
function replay(grid: string[][], output: string): void {
	const cols = grid[0]?.length ?? 0;
	let x = 0;
	let y = 0;
	const pattern = /\x1b\[([?\d;]*)([A-Za-z])|([^\x1b]+)/gu;
	for (const m of output.matchAll(pattern)) {
		if (m[3] !== undefined) {
			for (const cluster of graphemes(m[3])) {
				const width = clusterWidth(cluster);
				(grid[y] as string[])[x] = cluster;
				if (width === 2) (grid[y] as string[])[x + 1] = "";
				x += width;
			}
			continue;
		}
		const params = (m[1] ?? "").split(";").map(Number);
		if (m[2] === "H") {
			y = (params[0] ?? 1) - 1;
			x = (params[1] ?? 1) - 1;
		} else if (m[2] === "C") x += params[0] || 1;
		else if (m[2] === "J") for (const row of grid) row.fill(" ");
	}
	expect(x).toBeLessThanOrEqual(cols);
}

function replica(screen: Screen): string[][] {
	return Array.from({ length: screen.rows }, () => Array<string>(screen.cols).fill(" "));
}

function frame(cols: number, rows: number, draw: (s: Screen) => void): Screen {
	const s = new Screen(cols, rows);
	draw(s);
	return s;
}

describe("style", () => {
	const style: Style = { fg: Role.Accent, bold: true };

	it("encodes a role per colour depth, always from a reset", () => {
		expect(sgr(style, "truecolor")).toBe(`${ESC}[0;1;38;2;0;224;200m`);
		expect(sgr(style, "256")).toBe(`${ESC}[0;1;38;5;44m`);
		expect(sgr(style, "16")).toBe(`${ESC}[0;1;96m`);
		expect(sgr({ bg: Role.Warn }, "16")).toBe(`${ESC}[0;43m`);
	});

	it("gives the brand ramp its own step at every depth", () => {
		expect(sgr({ fg: Role.AccentHi }, "truecolor")).toBe(`${ESC}[0;38;2;51;245;221m`);
		expect(sgr({ fg: Role.AccentDeep }, "truecolor")).toBe(`${ESC}[0;38;2;0;187;168m`);
		expect(sgr({ fg: Role.AccentHi }, "256")).toBe(`${ESC}[0;38;5;51m`);
		expect(sgr({ fg: Role.AccentDeep }, "256")).toBe(`${ESC}[0;38;5;37m`);
		expect(sgr({ fg: Role.AccentDeep }, "16")).toBe(`${ESC}[0;36m`);
		expect(sgr({ fg: Role.Warn }, "truecolor")).toBe(`${ESC}[0;38;2;255;184;20m`);
		expect(sgr({ fg: Role.Ok }, "truecolor")).toBe(`${ESC}[0;38;2;138;217;188m`);
	});

	it("keeps attributes and drops colour when colour is off", () => {
		expect(sgr({ fg: Role.Bad, reverse: true }, "none")).toBe(`${ESC}[0;7m`);
		expect(sgr(PLAIN, "truecolor")).toBe(`${ESC}[0m`);
	});

	it("compares styles field by field", () => {
		expect(styleEquals({ fg: Role.Ok }, { fg: Role.Ok, bold: false })).toBe(true);
		expect(styleEquals({ fg: Role.Ok }, { fg: Role.Bad })).toBe(false);
	});
});

describe("Screen.put", () => {
	it("draws ASCII and returns the column after it", () => {
		const s = new Screen(10, 1);
		expect(s.put(2, 0, "abc")).toBe(5);
		expect(rowsOf(s)[0]).toBe("  abc     ");
	});

	it("gives a wide cluster two columns and a continuation cell", () => {
		const s = frame(6, 1, (f) => f.put(1, 0, "日a"));
		expect(s.cell(1, 0)).toMatchObject({ text: "日", width: 2 });
		expect(s.cell(2, 0)).toMatchObject({ text: "", width: 0 });
		expect(s.cell(3, 0).text).toBe("a");
	});

	it("keeps a combining mark in its base cell", () => {
		const s = frame(4, 1, (f) => f.put(0, 0, "éx"));
		expect(s.cell(0, 0).text).toBe("é");
		expect(s.cell(1, 0).text).toBe("x");
	});

	it("drops a wide cluster that would straddle the right edge", () => {
		const s = frame(4, 1, (f) => f.put(2, 0, "a日b"));
		expect(rowsOf(s)[0]).toBe("  a ");
	});

	it("blanks the visible half of a wide cluster cut by the left edge", () => {
		const s = frame(4, 1, (f) => f.put(-1, 0, "日b"));
		expect(rowsOf(s)[0]).toBe(" b  ");
	});

	it("ignores rows outside the screen", () => {
		const s = new Screen(4, 2);
		s.put(0, 5, "x");
		s.put(0, -1, "x");
		expect(rowsOf(s)).toEqual(["    ", "    "]);
	});

	it("blanks the other half when one half of a wide cluster is overwritten", () => {
		const lead = frame(4, 1, (f) => {
			f.put(0, 0, "日");
			f.put(0, 0, "a");
		});
		expect(rowsOf(lead)[0]).toBe("a   ");
		const tail = frame(4, 1, (f) => {
			f.put(0, 0, "日");
			f.put(1, 0, "b");
		});
		expect(rowsOf(tail)[0]).toBe(" b  ");
	});

	it("refuses controls: C0, ESC, DEL and 8-bit controls become U+FFFD and are counted", () => {
		const s = new Screen(20, 1);
		s.put(0, 0, "a\x1b[31mb\nc\x7fd\u009be\r");
		const text = rowsOf(s)[0] as string;
		expect(text).not.toMatch(/\p{Cc}/u);
		expect(text.startsWith("a�[31mb�c�d�e�")).toBe(true);
		expect(s.controlsRefused).toBe(5);
	});

	it("never stores a bidi override as a cell", () => {
		const s = frame(6, 1, (f) => f.put(0, 0, "a\u202eb"));
		expect(rowsOf(s)[0]).not.toContain("\u202e");
		expect(rowsOf(s)[0]?.trim()).toBe("ab");
	});
});

describe("diffScreens", () => {
	it("is empty when nothing changed", () => {
		const a = frame(8, 2, (f) => f.put(0, 0, "same"));
		const b = frame(8, 2, (f) => f.put(0, 0, "same"));
		expect(diffScreens(a, b, "truecolor")).toBe("");
	});

	it("sends one changed cell as one move and one character", () => {
		const a = frame(8, 3, (f) => f.put(0, 1, "hello"));
		const b = frame(8, 3, (f) => f.put(0, 1, "hellp"));
		expect(diffScreens(a, b, "truecolor")).toBe(`${SYNC_BEGIN}${ESC}[2;5Hp${SYNC_END}`);
	});

	it("sends adjacent changes as a single run", () => {
		const a = frame(10, 1, (f) => f.put(0, 0, "abcdef"));
		const b = frame(10, 1, (f) => f.put(0, 0, "aXYZef"));
		expect(diffScreens(a, b, "truecolor")).toBe(`${SYNC_BEGIN}${ESC}[1;2HXYZ${SYNC_END}`);
	});

	it("crosses an unchanged gap on one row with a relative move", () => {
		const a = frame(10, 1, (f) => f.put(0, 0, "abcdef"));
		const b = frame(10, 1, (f) => f.put(0, 0, "Xbcdeg"));
		expect(diffScreens(a, b, "truecolor")).toBe(`${SYNC_BEGIN}${ESC}[1;1HX${ESC}[4Cg${SYNC_END}`);
		const c = frame(10, 1, (f) => f.put(0, 0, "aXcdef"));
		const d = frame(10, 1, (f) => f.put(0, 0, "aXcXef"));
		expect(diffScreens(c, d, "truecolor")).toBe(`${SYNC_BEGIN}${ESC}[1;4HX${SYNC_END}`);
		const e = frame(10, 1, (f) => f.put(0, 0, "abcdef"));
		const g = frame(10, 1, (f) => f.put(0, 0, "XbXdef"));
		expect(diffScreens(e, g, "truecolor")).toBe(`${SYNC_BEGIN}${ESC}[1;1HX${ESC}[CX${SYNC_END}`);
	});

	it("switches style only where it changes and resets at the end", () => {
		const a = new Screen(6, 1);
		const b = frame(6, 1, (f) => {
			f.put(0, 0, "ab", { fg: Role.Ok });
			f.put(2, 0, "cd");
			f.put(4, 0, "e", { bold: true });
		});
		const out = diffScreens(a, b, "16");
		expect(out).toBe(
			`${SYNC_BEGIN}${ESC}[1;1H${ESC}[0;92mab${ESC}[0mcd${ESC}[0;1me${ESC}[0m${SYNC_END}`,
		);
	});

	it("clears and repaints in full without a previous frame or at a new size", () => {
		const b = frame(6, 2, (f) => f.put(1, 1, "hi"));
		const out = diffScreens(null, b, "truecolor");
		expect(out).toBe(`${SYNC_BEGIN}${ESC}[0m${ESC}[2J${ESC}[2;2Hhi${SYNC_END}`);
		expect(diffScreens(new Screen(5, 2), b, "truecolor")).toBe(out);
	});

	it("repaints the space under a wide cluster that was replaced by narrow text", () => {
		const a = frame(6, 1, (f) => f.put(0, 0, "日"));
		const b = frame(6, 1, (f) => f.put(0, 0, "ab"));
		expect(diffScreens(a, b, "truecolor")).toBe(`${SYNC_BEGIN}${ESC}[1;1Hab${SYNC_END}`);
		const grid = replica(a);
		replay(grid, diffScreens(null, a, "truecolor"));
		replay(grid, diffScreens(a, b, "truecolor"));
		expect(grid[0]?.join("")).toBe("ab    ");
	});

	it("re-positions with an absolute move after a non-ASCII cluster", () => {
		const a = new Screen(20, 1);
		const b = frame(20, 1, (f) => {
			f.put(2, 0, "é");
			f.put(10, 0, "x");
		});
		expect(diffScreens(a, b, "truecolor")).toBe(`${SYNC_BEGIN}${ESC}[1;3Hé${ESC}[1;11Hx${SYNC_END}`);
	});

	it("keeps relative moves on rows that are ASCII only", () => {
		const a = new Screen(20, 1);
		const b = frame(20, 1, (f) => {
			f.put(2, 0, "e");
			f.put(10, 0, "x");
		});
		expect(diffScreens(a, b, "truecolor")).toContain(`${ESC}[7C`);
	});

	it("always places an anchored cell with an absolute move, even when adjacent", () => {
		const a = new Screen(6, 1);
		const b = frame(6, 1, (f) => {
			f.put(0, 0, "ab");
			f.putAnchored(2, 0, "!");
		});
		expect(diffScreens(a, b, "truecolor")).toBe(`${SYNC_BEGIN}${ESC}[1;1Hab${ESC}[1;3H!${SYNC_END}`);
	});

	it("redraws an unchanged anchored cell on a row where a non-ASCII cluster was drawn", () => {
		const draw = (text: string) => (f: Screen) => {
			f.put(0, 0, text);
			f.putAnchored(5, 0, "|");
			f.put(0, 1, text);
			f.putAnchored(5, 1, "|");
		};
		const a = frame(6, 2, draw("ab"));
		const b = frame(6, 2, (f) => {
			draw("ab")(f);
			f.put(0, 0, "é");
		});
		const out = diffScreens(a, b, "truecolor");
		expect(out).toBe(`${SYNC_BEGIN}${ESC}[1;1Hé${ESC}[1;6H|${SYNC_END}`);
	});

	it("replays to the same screen across a sequence of frames, wide and combining clusters included", () => {
		const frames = [
			frame(12, 3, (f) => {
				f.put(0, 0, "日本語 ok");
				f.put(0, 1, "plain");
				f.putAnchored(11, 1, "|", { fg: Role.Dim });
			}),
			frame(12, 3, (f) => {
				f.put(0, 0, "日x語 ok", { bold: true });
				f.put(0, 1, "é plain");
				f.putAnchored(11, 1, "|", { fg: Role.Dim });
				f.put(10, 2, "end");
			}),
			frame(12, 3, (f) => {
				f.put(1, 0, "日本語 o");
				f.put(0, 2, "ab");
			}),
		];
		const grid = replica(frames[0] as Screen);
		let prev: Screen | null = null;
		for (const next of frames) {
			replay(grid, diffScreens(prev, next, "truecolor"));
			expect(grid.map((r) => r.join(""))).toEqual(rowsOf(next));
			prev = next;
		}
	});
});

describe("synchronized-output sequence", () => {
	it("is defined in exactly one tui module", () => {
		const dir = new URL("../src/tui/", import.meta.url);
		const definers = fs
			.readdirSync(dir, { recursive: true, encoding: "utf8" })
			.filter((f) => f.endsWith(".ts"))
			.filter((f) => fs.readFileSync(new URL(f, dir), "utf8").includes("?2026"));
		expect(definers).toEqual(["caps.ts"]);
	});
});
