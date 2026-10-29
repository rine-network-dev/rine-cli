import { describe, expect, it } from "vitest";
import {
	type Action,
	BINDINGS,
	type KeymapState,
	type Mode,
	initialKeymapState,
	interpret,
} from "../src/tui/keymap.js";
import { type Key, parseKeys } from "../src/tui/keys.js";

/** Feed raw terminal bytes through the real key parser, then the keymap. */
function run(bytes: string, mode: Mode = "normal"): Action[] {
	let state: KeymapState = initialKeymapState;
	const actions: Action[] = [];
	// A doubled ESC is the Escape key; each "|" starts a new read so ESC is not glued to the next byte.
	for (const key of bytes.split("|").flatMap((c) => parseKeys(c).keys)) {
		const out = interpret(state, key, mode);
		state = out.state;
		if (out.action) actions.push(out.action);
	}
	return actions;
}

const ctrl = (c: string) => String.fromCharCode(c.charCodeAt(0) - 0x60);
const move = (unit: string, step: string, count = 1) => ({
	kind: "move",
	unit,
	step,
	count,
});

describe("binding table", () => {
	it("equals the standalone keymap column", () => {
		expect(BINDINGS.map((r) => [r.label, r.display])).toEqual([
			["next / previous row (or line in the reader)", "j/k, ↓/↑"],
			["first / last loaded row", "gg / G"],
			["half page / page", "ctrl-d/ctrl-u, ctrl-f/ctrl-b, PgDn/PgUp"],
			["top / middle / bottom of screen; centre", "H M L; zz"],
			["move focus rail / list / reader", "h/l, ←/→, Tab/shift-Tab"],
			["open in the reader / choose a rail entry", "Enter, o"],
			["close the reader or overlay", "q, Esc"],
			["quit", "q from the list, ctrl-c"],
			[
				"search loaded rows; next / previous match",
				"/ (Enter runs, Esc cancels); n / N",
			],
			["next / previous gap or unverified row", "] / ["],
			["cycle direction all, sent, received, internal", "D"],
			["follow on/off", "F"],
			["re-read from the newest page", "R"],
			["wrap long lines", "w"],
			["list findings", "f"],
			["help", "?"],
			["redraw", "ctrl-l"],
			["suspend", "ctrl-z"],
		]);
	});

	it("resolves every bound input to its action through the real key parser", () => {
		const bytes: Record<string, string> = {
			down: "\x1b[B",
			up: "\x1b[A",
			left: "\x1b[D",
			right: "\x1b[C",
			pageDown: "\x1b[6~",
			pageUp: "\x1b[5~",
			tab: "\t",
			"shift-tab": "\x1b[Z",
			enter: "\r",
			esc: "\x1b\x1b",
		};
		for (const [inputs, action] of BINDINGS.flatMap((r) => r.binds)) {
			for (const input of inputs.split("|")) {
				const raw = input
					.split(" ")
					.map(
						(t) => bytes[t] ?? (t.startsWith("ctrl-") ? ctrl(t.slice(5)) : t),
					)
					.join("");
				const got = run(raw);
				expect(got.at(-1), input).toEqual(action);
			}
		}
	});
});

describe("interpret", () => {
	it("moves one row by default and by the typed count", () => {
		expect(run("j")).toEqual([move("row", "next")]);
		expect(run("5j")).toEqual([move("row", "next", 5)]);
		expect(run("12k")).toEqual([move("row", "prev", 12)]);
		expect(run("10\x04")).toEqual([move("halfPage", "next", 10)]);
	});

	it("treats 0 as a count digit only after another digit", () => {
		expect(run("0j")).toEqual([move("row", "next")]);
		expect(run("20j")).toEqual([move("row", "next", 20)]);
	});

	it("caps the count", () => {
		expect(run("999999j")).toEqual([move("row", "next", 9999)]);
	});

	it("uses the count once and resets afterwards", () => {
		expect(run("3jj")).toEqual([move("row", "next", 3), move("row", "next")]);
	});

	it("reads gg as first and zz as centre, and a lone g waits", () => {
		expect(run("gg")).toEqual([{ kind: "jump", to: "first" }]);
		expect(run("zz")).toEqual([{ kind: "jump", to: "centre" }]);
		expect(run("g")).toEqual([]);
		expect(run("G")).toEqual([{ kind: "jump", to: "last" }]);
	});

	it("drops a broken sequence and a count with it", () => {
		expect(run("gj")).toEqual([]);
		expect(run("gjj")).toEqual([move("row", "next")]);
		expect(run("5gj")).toEqual([]);
		expect(run("5xj")).toEqual([move("row", "next")]);
	});

	it("keeps a count across the first key of a sequence", () => {
		expect(run("3gg")).toEqual([{ kind: "jump", to: "first" }]);
	});

	it("reads the gap pair and the match pair", () => {
		expect(run("][")).toEqual([
			{ kind: "gap", step: "next" },
			{ kind: "gap", step: "prev" },
		]);
		expect(run("nN")).toEqual([
			{ kind: "searchStep", step: "next" },
			{ kind: "searchStep", step: "prev" },
		]);
	});

	it("ignores an unknown key, an alt chord and a paste", () => {
		expect(run("x")).toEqual([]);
		expect(run("\x1bj")).toEqual([]);
		expect(run("\x1b[200~j\x1b[201~")).toEqual([]);
	});

	it("clears a pending count or prefix on Esc, which does nothing else", () => {
		expect(run("5\x1b\x1b|j")).toEqual([move("row", "next")]);
		expect(run("g\x1b\x1b|g")).toEqual([]);
		expect(run("\x1b\x1b")).toEqual([{ kind: "close" }]);
	});

	it("separates q (close or quit) from ctrl-c (quit now), also mid-sequence", () => {
		expect(run("q")).toEqual([{ kind: "closeOrQuit" }]);
		expect(run("\x03")).toEqual([{ kind: "quit" }]);
		expect(run("5g\x03")).toEqual([{ kind: "quit" }]);
	});

	it("types search text verbatim until Enter or Esc", () => {
		expect(run("/")).toEqual([{ kind: "searchStart" }]);
		const keys = (b: string): Key[] => parseKeys(b).keys;
		const types = keys("jq5\x7f\r\x1b\x1b").map(
			(k) => interpret(initialKeymapState, k, "search").action,
		);
		expect(types).toEqual([
			{ kind: "searchInput", text: "j" },
			{ kind: "searchInput", text: "q" },
			{ kind: "searchInput", text: "5" },
			{ kind: "searchBackspace" },
			{ kind: "searchRun" },
			{ kind: "searchCancel" },
		]);
		expect(run("\x1b[200~a b\x1b[201~", "search")).toEqual([
			{ kind: "searchInput", text: "a b" },
		]);
		expect(run("\x03", "search")).toEqual([{ kind: "quit" }]);
	});
});
