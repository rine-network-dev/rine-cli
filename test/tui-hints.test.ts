import { describe, expect, it } from "vitest";
import { HINTS, type HintContext, HintScope, hintContext, hintRuns } from "../src/tui/hints.js";
import type { Key } from "../src/tui/keys.js";
import { initialKeymapState, interpret } from "../src/tui/keymap.js";
import { initialModel } from "../src/tui/state.js";
import type { Model } from "../src/tui/state-model.js";
import { Role } from "../src/tui/style.js";

const keyOf = (name: string): Key => {
	if (name === "enter") return { kind: "named", name: "enter", ctrl: false, shift: false, alt: false };
	if (name === "esc") return { kind: "named", name: "escape", ctrl: false, shift: false, alt: false };
	return { kind: "char", char: name, ctrl: false, alt: false };
};

const context = (over: Partial<HintContext> = {}): HintContext => ({
	scope: HintScope.List,
	searchActive: false,
	findings: false,
	directionFiltered: false,
	followOff: false,
	wrapMatters: false,
	...over,
});

const text = (c: HintContext, width = 200): string =>
	hintRuns(c, width, true)
		.map((run) => run.text)
		.join("");

describe("hint table", () => {
	it.each(HINTS.flatMap((hint) => hint.keys.map((key) => ({ scope: hint.scope, label: hint.label, key }))))(
		"test_hint_$scope_$label_$key_isBoundToAnAction",
		({ scope, key }) => {
			const mode = scope === HintScope.Search ? "search" : "normal";
			const out = interpret(initialKeymapState, keyOf(key), mode);
			expect(out.action, `${scope} hint key ${key} does nothing`).not.toBeNull();
			if (mode === "search") expect(out.action?.kind).not.toBe("searchInput");
		},
	);

	it("names the action each hint key does", () => {
		const kind = (key: string) => interpret(initialKeymapState, keyOf(key)).action?.kind;
		expect([kind("j"), kind("enter"), kind("/"), kind("q"), kind("?"), kind("f"), kind("w"), kind("l")]).toEqual([
			"move",
			"open",
			"searchStart",
			"closeOrQuit",
			"help",
			"findings",
			"toggleWrap",
			"focus",
		]);
	});

	it("lists each scope's hints once, and priorities are unique within a scope", () => {
		for (const scope of Object.values(HintScope)) {
			const mine = HINTS.filter((hint) => hint.scope === scope);
			expect(mine.length).toBeGreaterThan(0);
			expect(new Set(mine.map((hint) => hint.priority)).size).toBe(mine.length);
		}
	});
});

describe("hintContext", () => {
	const model = (over: Partial<Model>): Model => ({ ...initialModel, ...over });

	it("follows the focus when nothing covers the screen", () => {
		expect(hintContext(model({ focus: "reader" }), false).scope).toBe(HintScope.Reader);
		expect(hintContext(model({ focus: "rail" }), false).scope).toBe(HintScope.Rail);
		expect(hintContext(model({}), false).scope).toBe(HintScope.List);
	});

	it("lets an overlay or a search draft take over", () => {
		expect(hintContext(model({ overlay: "help" }), false).scope).toBe(HintScope.Help);
		expect(hintContext(model({ overlay: "findings" }), false).scope).toBe(HintScope.Findings);
		const editing = { ...initialModel.search, editing: true };
		expect(hintContext(model({ search: editing, overlay: "help" }), false).scope).toBe(HintScope.Search);
	});

	it("reads the state the optional hints depend on", () => {
		const filter = { ...initialModel.filter, direction: "sent" as const };
		const c = hintContext(model({ follow: false, filter }), true);
		expect([c.followOff, c.directionFiltered, c.wrapMatters, c.findings, c.searchActive]).toEqual([
			true,
			true,
			true,
			false,
			false,
		]);
	});
});

describe("hintRuns", () => {
	it("opens the list and reader lines with the strings the e2e rig reads", () => {
		expect(text(context())).toMatch(/^j\/k move · enter open/);
		expect(text(context({ scope: HintScope.Reader }))).toMatch(/^j\/k scroll · q back/);
	});

	it("shows an optional hint only when its context holds", () => {
		expect(text(context())).not.toContain("findings");
		expect(text(context({ findings: true }))).toContain("f findings");
		expect(text(context({ searchActive: true }))).toContain("n/N next match");
		expect(text(context({ directionFiltered: true }))).toContain("D direction");
		expect(text(context({ followOff: true }))).toContain("F follow");
		expect(text(context({ scope: HintScope.Reader }))).not.toContain("wrap");
		expect(text(context({ scope: HintScope.Reader, wrapMatters: true }))).toContain("w wrap");
	});

	it("keeps the most important hints when the row is narrow, in display order", () => {
		const all = context({ findings: true, searchActive: true, directionFiltered: true, followOff: true });
		expect(text(all, 200)).toBe(
			"j/k move · enter open · / search · n/N next match · f findings · D direction · F follow · ? help",
		);
		expect(text(all, 30)).toBe("j/k move · enter open · ? help");
		expect(text(all, 12)).toBe("j/k move");
		expect(text(all, 3)).toBe("");
	});

	it("draws the keys bold in accent, the labels and separators dim", () => {
		const runs = hintRuns(context(), 200, true);
		expect(runs[0]).toEqual({ text: "j/k", style: { fg: Role.Accent, bold: true } });
		expect(runs[1]).toEqual({ text: " move", style: { fg: Role.Dim } });
		expect(runs[2]).toEqual({ text: " · ", style: { fg: Role.Dim } });
	});

	it("gives the search draft and the overlays their own hints", () => {
		expect(text(context({ scope: HintScope.Search }))).toBe("enter find · esc cancel");
		expect(text(context({ scope: HintScope.Help }))).toBe("? close");
		expect(text(context({ scope: HintScope.Findings }))).toBe("j/k scroll · f close");
		expect(text(context({ scope: HintScope.Rail }))).toBe("j/k move · enter choose · l list · ? help");
	});
});
