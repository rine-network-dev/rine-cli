import { describe, expect, it } from "vitest";
import {
	type Key,
	type KeyState,
	flushEscape,
	initialKeyState,
	parseKeys,
} from "../src/tui/keys.js";

function feed(...chunks: string[]): { keys: Key[]; state: KeyState } {
	let state = initialKeyState;
	const keys: Key[] = [];
	for (const chunk of chunks) {
		const out = parseKeys(chunk, state);
		keys.push(...out.keys);
		state = out.state;
	}
	return { keys, state };
}

const char = (c: string, ctrl = false, alt = false): Key => ({
	kind: "char",
	char: c,
	ctrl,
	alt,
});
const named = (
	name: string,
	mods: Partial<Record<"ctrl" | "shift" | "alt", boolean>> = {},
) => ({
	kind: "named",
	name,
	ctrl: false,
	shift: false,
	alt: false,
	...mods,
});

describe("parseKeys", () => {
	it("reads plain characters, including multi-unit ones", () => {
		expect(feed("jk$é😀").keys).toEqual([
			char("j"),
			char("k"),
			char("$"),
			char("é"),
			char("😀"),
		]);
	});

	it("reads ctrl letters, enter, tab and backspace", () => {
		expect(feed("\x04\x1a\x0c\r\n\t\x7f\x08").keys).toEqual([
			char("d", true),
			char("z", true),
			char("l", true),
			named("enter"),
			named("enter"),
			named("tab"),
			named("backspace"),
			named("backspace"),
		]);
	});

	it("reads CSI and SS3 arrows, home, end and paging", () => {
		expect(
			feed(
				"\x1b[A\x1b[B\x1b[C\x1b[D\x1bOA\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[3~\x1b[1~\x1b[4~",
			).keys,
		).toEqual([
			named("up"),
			named("down"),
			named("right"),
			named("left"),
			named("up"),
			named("home"),
			named("end"),
			named("pageUp"),
			named("pageDown"),
			named("delete"),
			named("home"),
			named("end"),
		]);
	});

	it("reads modifiers and shift-tab", () => {
		expect(feed("\x1b[1;2A\x1b[1;5C\x1b[1;3D\x1b[Z").keys).toEqual([
			named("up", { shift: true }),
			named("right", { ctrl: true }),
			named("left", { alt: true }),
			named("backtab", { shift: true }),
		]);
	});

	it("reads alt plus a character", () => {
		expect(feed("\x1bx").keys).toEqual([char("x", false, true)]);
	});

	it("joins a CSI sequence split across chunks", () => {
		const first = feed("\x1b");
		expect(first.keys).toEqual([]);
		expect(first.state.pending).toBe("\x1b");
		expect(feed("\x1b", "[", "1;5", "A").keys).toEqual([
			named("up", { ctrl: true }),
		]);
		expect(feed("a\x1b[", "5~b").keys).toEqual([
			char("a"),
			named("pageUp"),
			char("b"),
		]);
	});

	it("keeps a lone ESC pending until flushEscape resolves it", () => {
		const { keys, state } = feed("\x1b");
		expect(keys).toEqual([]);
		const flushed = flushEscape(state);
		expect(flushed.keys).toEqual([named("escape")]);
		expect(flushed.state).toEqual(initialKeyState);
	});

	it("turns ESC followed by another sequence into Escape plus that key", () => {
		expect(feed("\x1b\x1b[A").keys).toEqual([named("escape"), named("up")]);
	});

	it("drops an unfinished sequence on flush and ignores unknown ones", () => {
		const { state } = feed("\x1b[1;");
		expect(flushEscape(state).keys).toEqual([]);
		expect(feed("\x1b[99~\x1b[?25ha").keys).toEqual([char("a")]);
	});

	it("ignores NUL, 8-bit controls and DEL-class bytes", () => {
		expect(feed("\x00\x1c\x9ba").keys).toEqual([char("a")]);
	});

	it("delivers a bracketed paste as one event with its text", () => {
		expect(feed("\x1b[200~line one\nline two\x1b[201~q").keys).toEqual([
			{ kind: "paste", text: "line one\nline two" },
			char("q"),
		]);
	});

	it("joins a paste split across chunks, including a split end marker", () => {
		expect(feed("\x1b[20", "0~ab", "c\x1b[2", "01~").keys).toEqual([
			{ kind: "paste", text: "abc" },
		]);
	});

	it("treats keys inside a paste as text, and does not turn a paste ESC into Escape", () => {
		const mid = feed("\x1b[200~a\x1b[A");
		expect(mid.keys).toEqual([]);
		expect(flushEscape({ ...mid.state, pending: "\x1b" }).keys).toEqual([]);
		expect(feed("\x1b[200~a\x1b[Ab\x1b[201~").keys).toEqual([
			{ kind: "paste", text: "a\x1b[Ab" },
		]);
	});
});
