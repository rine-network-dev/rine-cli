import { describe, expect, it, vi } from "vitest";
import { createMotion } from "../src/tui/app-motion.js";
import type { Caps } from "../src/tui/caps.js";
import { NOISE, SHADES } from "../src/tui/glyphs.js";
import {
	DECODE_MS,
	REVEAL_MS,
	SCAN_PASS_MS,
	SHIMMER_MS,
	TICK_MS,
	cascadeStage,
	decodeCells,
	drawScan,
	noiseGlyph,
	scanStart,
	shimmerRow,
	wordmark,
} from "../src/tui/motion-effects.js";
import {
	RESTING,
	arrive,
	motionEnabled,
	motionFrame,
	nextMotionMs,
	observe,
	startClock,
} from "../src/tui/motion.js";
import { Screen } from "../src/tui/screen.js";
import { initialModel } from "../src/tui/state.js";
import type { Connection, Model } from "../src/tui/state-model.js";
import { Role } from "../src/tui/style.js";

const CAPS: Caps = { color: "truecolor", unicode: true };
const withConnection = (connection: Connection): Model => ({ ...initialModel, connection });
const LIVE = withConnection({ kind: "live", pollS: 5 });

const rowOf = (screen: Screen, y = 0): string =>
	Array.from({ length: screen.cols }, (_, x) => screen.cell(x, y).text).join("");

function textScreen(text: string): Screen {
	const screen = new Screen(text.length, 1);
	screen.put(0, 0, text);
	return screen;
}

describe("kill switches", () => {
	const on = (caps: Caps, env: NodeJS.ProcessEnv = {}, tty = true) => motionEnabled(caps, env, tty);

	it("runs on a coloured unicode terminal", () => {
		expect(on(CAPS)).toBe(true);
		expect(on({ color: "16", unicode: true })).toBe(true);
	});

	it.each([
		["NO_COLOR", { color: "none", unicode: true } as Caps, {}, true],
		["--ascii", { color: "truecolor", unicode: false } as Caps, {}, true],
		["not a tty", CAPS, {}, false],
		["RINE_REDUCED_MOTION", CAPS, { RINE_REDUCED_MOTION: "1" }, true],
	])("test_motionEnabled_%s_isOff", (_, caps, env, tty) => {
		expect(on(caps, env, tty)).toBe(false);
	});

	it("treats an empty RINE_REDUCED_MOTION as unset", () => {
		expect(on(CAPS, { RINE_REDUCED_MOTION: "" })).toBe(true);
	});

	it("never schedules a frame and always draws the resting one when off", () => {
		const off = arrive(startClock(false, 0), ["a"], 0);
		for (const kind of ["loading", "live", "paused", "network", "failing", "blocked"] as const) {
			const connection = {
				loading: { kind: "loading" },
				live: { kind: "live", pollS: 5 },
				paused: { kind: "paused", seconds: 3 },
				network: { kind: "network", host: "h", retryS: 3 },
				failing: { kind: "failing", code: "server", retryS: 3 },
				blocked: { kind: "blocked", code: "needs_org_key" },
			}[kind] as Connection;
			expect(nextMotionMs(off, withConnection(connection), 100)).toBeNull();
			expect(motionFrame(off, withConnection(connection), 100)).toBe(RESTING);
		}
	});
});

describe("nextMotionMs", () => {
	const settled = REVEAL_MS + 1;
	const clock = startClock(true, 0);

	it("ticks quickly while the wordmark reveals and slowly once it is done", () => {
		expect(nextMotionMs(clock, LIVE, 10)).toBe(TICK_MS);
		expect(nextMotionMs(clock, LIVE, settled)).toBe(350);
	});

	it("is null at rest: a blocked view with nothing arriving draws no more frames", () => {
		const blocked = withConnection({ kind: "blocked", code: "needs_org_key" });
		expect(nextMotionMs(clock, blocked, settled)).toBeNull();
	});

	it("spins at 120 ms while loading and scans at the fast tick while the feed is down", () => {
		expect(nextMotionMs(clock, withConnection({ kind: "loading" }), settled)).toBe(120);
		for (const connection of [
			{ kind: "paused", seconds: 3 },
			{ kind: "network", host: "h", retryS: 3 },
			{ kind: "failing", code: "server", retryS: 3 },
		] as const) {
			expect(nextMotionMs(clock, withConnection(connection), settled)).toBe(TICK_MS);
		}
	});

	it("ticks fast while an arrival shimmers, then falls back", () => {
		const arrived = arrive(clock, ["m1"], settled);
		expect(nextMotionMs(arrived, LIVE, settled + 10)).toBe(TICK_MS);
		expect(nextMotionMs(arrived, LIVE, settled + SHIMMER_MS + 1)).toBe(350);
	});
});

describe("motionFrame", () => {
	it("steps the pulse every 350 ms and the spinner every 120 ms", () => {
		const clock = startClock(true, 0);
		expect(motionFrame(clock, LIVE, 349).pulse).toBe(0);
		expect(motionFrame(clock, LIVE, 350).pulse).toBe(1);
		expect(motionFrame(clock, LIVE, 1400).pulse).toBe(4);
		expect(motionFrame(clock, LIVE, 119).spin).toBe(0);
		expect(motionFrame(clock, LIVE, 120).spin).toBe(1);
	});

	it("reveals the wordmark for 600 ms from the start, then never again", () => {
		const clock = startClock(true, 1000);
		expect(motionFrame(clock, LIVE, 1000).revealMs).toBe(0);
		expect(motionFrame(clock, LIVE, 1000 + REVEAL_MS - 1).revealMs).toBe(REVEAL_MS - 1);
		expect(motionFrame(clock, LIVE, 1000 + REVEAL_MS).revealMs).toBeNull();
	});

	it("holds an arrival's shimmer until its cascade is over", () => {
		const clock = arrive(startClock(true, 0), ["a", "b"], 2000);
		expect([...motionFrame(clock, LIVE, 2100).shimmer]).toEqual([["a", 100], ["b", 100]]);
		expect(motionFrame(clock, LIVE, 2000 + SHIMMER_MS).shimmer.size).toBe(0);
	});

	it("forgets arrivals whose cascade is over when new ones come", () => {
		const first = arrive(startClock(true, 0), ["a"], 0);
		const next = arrive(first, ["b"], SHIMMER_MS + 5);
		expect([...next.arrivals.keys()]).toEqual(["b"]);
	});

	it("scans the top border only while the feed is down, one pass in 1.5 s", () => {
		const clock = startClock(true, 0);
		const down = withConnection({ kind: "network", host: "h", retryS: 3 });
		expect(motionFrame(clock, LIVE, 100).scan).toBeNull();
		expect(motionFrame(clock, down, 0).scan).toBe(0);
		expect(motionFrame(clock, down, SCAN_PASS_MS / 2).scan).toBe(0.5);
		expect(motionFrame(clock, down, SCAN_PASS_MS).scan).toBe(0);
	});

	it("decodes the reader for 350 ms after it opens on the message, not on staying open", () => {
		const list: Model = { ...LIVE, focus: "list", selectedId: "m1" };
		const reader: Model = { ...list, focus: "reader" };
		const opened = observe(startClock(true, 0), list, reader, 5000);
		expect(motionFrame(opened, reader, 5100).decodeMs).toBe(100);
		expect(motionFrame(opened, reader, 5000 + DECODE_MS).decodeMs).toBeNull();
		expect(motionFrame(opened, { ...reader, selectedId: "m2" }, 5100).decodeMs).toBeNull();
		expect(motionFrame(opened, list, 5100).decodeMs).toBeNull();
		expect(observe(opened, reader, reader, 9000)).toBe(opened);
		expect(observe(startClock(false, 0), list, reader, 5000).opened).toBeNull();
	});
});

describe("cascadeStage", () => {
	it("starts the first cell at once and the last after the cascade, and settles every cell", () => {
		expect(cascadeStage(0, 10, 0)).toBe(1);
		expect(cascadeStage(9, 10, 0)).toBe(0);
		for (let i = 0; i < 10; i++) expect(cascadeStage(i, 10, SHIMMER_MS)).toBe(4);
	});

	it("never goes backwards in time and never runs ahead of a cell to its left", () => {
		for (let t = 0; t < SHIMMER_MS; t += 20) {
			for (let i = 1; i < 12; i++) {
				expect(cascadeStage(i, 12, t)).toBeLessThanOrEqual(cascadeStage(i - 1, 12, t));
				expect(cascadeStage(i, 12, t + 20)).toBeGreaterThanOrEqual(cascadeStage(i, 12, t));
			}
		}
	});

	it("handles a one-cell span", () => {
		expect(cascadeStage(0, 1, 0)).toBe(1);
	});
});

describe("shimmerRow", () => {
	it("turns inked cells into shades from the left and leaves blanks alone", () => {
		const screen = textScreen("ab cdefgh");
		shimmerRow(screen, 0, 0, 9, 0);
		const row = rowOf(screen);
		expect(row[0]).toBe("░");
		expect(row[2]).toBe(" ");
		expect(row.slice(4)).toBe("     ");
	});

	it("draws only shades or the original text, and settles to the original", () => {
		const text = "new message arrives here";
		for (let t = 0; t <= SHIMMER_MS; t += 40) {
			const screen = textScreen(text);
			shimmerRow(screen, 0, 0, text.length, t);
			Array.from(rowOf(screen)).forEach((ch, i) => {
				expect([text[i], " ", ...SHADES]).toContain(ch);
			});
		}
		const done = textScreen(text);
		shimmerRow(done, 0, 0, text.length, SHIMMER_MS);
		expect(rowOf(done)).toBe(text);
	});

	it("keeps a selected row's reverse video", () => {
		const screen = new Screen(4, 1);
		screen.put(0, 0, "abcd", { reverse: true });
		shimmerRow(screen, 0, 0, 4, 0);
		expect(screen.cell(0, 0).style.reverse).toBe(true);
	});

	it("blanks the tail of a wide glyph it replaces", () => {
		const screen = new Screen(4, 1);
		screen.put(0, 0, "中文");
		shimmerRow(screen, 0, 0, 4, 0);
		expect(rowOf(screen)).not.toContain("中");
		expect(Array.from(rowOf(screen)).every((ch) => [" ", ...SHADES].includes(ch))).toBe(true);
	});
});

describe("noiseGlyph", () => {
	it("is a pure function of the cell and the step", () => {
		expect(noiseGlyph(7, 3)).toBe(noiseGlyph(7, 3));
	});

	it("never leaves the fixed glyph set, and does vary", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 400; index++)
			for (let step = 0; step < 8; step++) {
				const glyph = noiseGlyph(index, step);
				expect(NOISE).toContain(glyph);
				seen.add(glyph);
			}
		expect(seen.size).toBe(NOISE.length);
	});

	it("does not touch Math.random", () => {
		const random = vi.spyOn(Math, "random");
		noiseGlyph(1, 1);
		decodeCells(textScreen("abcdef"), { x: 0, y: 0, w: 6, h: 1 }, 100);
		expect(random).not.toHaveBeenCalled();
		random.mockRestore();
	});
});

describe("decodeCells", () => {
	const rect = (w: number) => ({ x: 0, y: 0, w, h: 1 });

	it("shows noise ahead of the front and the real text behind it", () => {
		const text = "the quick brown fox jumps over the lazy dog";
		const screen = textScreen(text);
		decodeCells(screen, rect(text.length), DECODE_MS / 2);
		const row = Array.from(rowOf(screen));
		const resolved = row.filter((ch, i) => ch === text[i] && ch !== " ").length;
		const noisy = row.filter((ch) => NOISE.includes(ch)).length;
		expect(resolved).toBeGreaterThan(0);
		expect(noisy).toBeGreaterThan(0);
		expect(row.every((ch, i) => ch === text[i] || NOISE.includes(ch))).toBe(true);
		expect(row[3]).toBe(" ");
	});

	it("starts all noise and crosses any length in the same time", () => {
		for (const length of [10, 400, 3000]) {
			const text = "x".repeat(length);
			const start = textScreen(text);
			decodeCells(start, rect(length), 0);
			expect(Array.from(rowOf(start)).every((ch) => NOISE.includes(ch))).toBe(true);
			const mid = textScreen(text);
			decodeCells(mid, rect(length), DECODE_MS / 2);
			const resolved = Array.from(rowOf(mid)).filter((ch) => ch === "x").length;
			expect(resolved / length).toBeGreaterThan(0.45);
			expect(resolved / length).toBeLessThan(0.55);
		}
	});

	it("glows just behind the front in the bright step", () => {
		const screen = textScreen("x".repeat(100));
		decodeCells(screen, rect(100), DECODE_MS / 2);
		expect(screen.cell(48, 0).style.fg).toBe(Role.AccentHi);
		expect(screen.cell(10, 0).style.fg).toBeUndefined();
	});

	it("leaves text outside the rect alone", () => {
		const screen = textScreen("keep this");
		decodeCells(screen, { x: 5, y: 0, w: 4, h: 1 }, 0);
		expect(rowOf(screen).slice(0, 5)).toBe("keep ");
	});
});

describe("wordmark", () => {
	const letters = (elapsed: number | null) => wordmark("rine", elapsed).map((run) => run.text).join("");

	it("is the plain word once settled or when motion is off", () => {
		expect(letters(null)).toBe("rine");
		expect(letters(REVEAL_MS)).toBe("rine");
		expect(wordmark("rine", null).every((run) => run.style?.bold === true && run.style.fg === Role.AccentHi)).toBe(true);
	});

	it("starts as dense shade and resolves one letter after another", () => {
		expect(letters(0)).toBe("▓▓▓▓");
		const seen = [0, 100, 200, 300, 400, 500, REVEAL_MS - 1].map(letters);
		for (const step of seen) expect(Array.from(step).every((ch) => [..."rine", ...SHADES].includes(ch))).toBe(true);
		const resolvedCount = seen.map((step) => Array.from(step).filter((ch, i) => ch === "rine"[i]).length);
		expect(resolvedCount).toEqual([...resolvedCount].sort((a, b) => a - b));
		expect(letters(REVEAL_MS - 1)).toBe("rin░");
	});
});

describe("scan", () => {
	it("moves a four-cell segment across the border from off the left edge to off the right", () => {
		expect(scanStart(0, 80)).toBe(-4);
		expect(scanStart(0.5, 80)).toBe(38);
		expect(scanStart(0.999, 80)).toBeLessThan(80);
		expect(scanStart(0.999, 80)).toBeGreaterThan(76);
	});

	it("lights only plain border cells, so a title in the border stays whole", () => {
		const screen = new Screen(18, 1);
		screen.put(0, 0, `╭ ◆ rine ${"─".repeat(8)}╮`);
		drawScan(screen, 6);
		expect(rowOf(screen)).toBe(`╭ ◆ rine ━${"─".repeat(7)}╮`);
	});

	it("clips at both edges and keeps the corners", () => {
		const screen = new Screen(10, 1);
		screen.put(0, 0, `╭${"─".repeat(8)}╮`);
		drawScan(screen, -2);
		expect(rowOf(screen)).toBe(`╭━${"─".repeat(7)}╮`);
		const right = new Screen(10, 1);
		right.put(0, 0, `╭${"─".repeat(8)}╮`);
		drawScan(right, 8);
		expect(rowOf(right)).toBe(`╭${"─".repeat(7)}━╮`);
	});

	it("draws the segment bold in the bright accent", () => {
		const screen = new Screen(10, 1);
		screen.put(0, 0, `╭${"─".repeat(8)}╮`);
		drawScan(screen, 3);
		expect(screen.cell(3, 0).style).toEqual({ fg: Role.AccentHi, bold: true });
	});
});

describe("createMotion", () => {
	it("arms one timer after a draw and re-arms it from the next state", () => {
		vi.useFakeTimers();
		try {
			let now = 0;
			const redraw = vi.fn();
			const motion = createMotion({ enabled: true, now: () => now, redraw });
			motion.arm(LIVE);
			motion.arm(LIVE);
			vi.advanceTimersByTime(TICK_MS);
			expect(redraw).toHaveBeenCalledTimes(1);
			now = REVEAL_MS + 1;
			motion.arm(LIVE);
			vi.advanceTimersByTime(349);
			expect(redraw).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);
			expect(redraw).toHaveBeenCalledTimes(2);
			motion.stop();
			vi.advanceTimersByTime(10_000);
			expect(redraw).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("arms nothing when motion is off", () => {
		vi.useFakeTimers();
		try {
			const redraw = vi.fn();
			createMotion({ enabled: false, now: () => 0, redraw }).arm(LIVE);
			vi.advanceTimersByTime(10_000);
			expect(redraw).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("turns arrivals and the reader opening into frames", () => {
		let now = 1000;
		const motion = createMotion({ enabled: true, now: () => now, redraw: () => undefined });
		motion.arrive(["m1"]);
		now = 1100;
		expect(motion.frame(LIVE).shimmer.get("m1")).toBe(100);
		const list: Model = { ...LIVE, selectedId: "m1" };
		motion.observe(list, { ...list, focus: "reader" });
		now = 1150;
		expect(motion.frame({ ...list, focus: "reader" }).decodeMs).toBe(50);
	});
});
