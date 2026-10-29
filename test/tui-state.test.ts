import { describe, expect, it } from "vitest";
import type { Action } from "../src/tui/keymap-table.js";
import type { VerdictGlyph } from "../src/tui/feed-schema.js";
import { rowBridge } from "../src/tui/app-data.js";
import { PageKind } from "../src/tui/feed-schema.js";
import { MAX_LOADED_ROWS, type ListRow } from "../src/tui/state-data.js";
import { messageOf, textBody } from "./tui-fixture.js";
import { signed } from "../src/tui/state-motion.js";
import {
	type Model,
	type Msg,
	type Result,
	initialModel,
	update,
} from "../src/tui/state.js";

const SALES = { id: "a-sales", label: "sales" };
const BILLING = { id: "a-billing", label: "billing" };
const OPS = { id: "g-ops", label: "ops" };

let clock = 0;
function row(id: string, over: Partial<ListRow> = {}): ListRow {
	clock += 1;
	return {
		id,
		createdAtMicros: clock,
		direction: "internal",
		agents: [SALES],
		group: null,
		verdict: "verified",
		searchText: `message ${id}`,
		...over,
	};
}

function reduce(model: Model, ...msgs: Msg[]): Result {
	let result: Result = { model, effects: [] };
	for (const msg of msgs) result = update(result.model, msg);
	return result;
}

const act = (action: Action): Msg => ({ type: "action", action });
const down = (count = 1): Msg =>
	act({ kind: "move", unit: "row", step: "next", count });
const up = (count = 1): Msg =>
	act({ kind: "move", unit: "row", step: "prev", count });
const viewport = (
	listHeight: number,
	readerHeight = 5,
	readerLines = 20,
	railDrawn = true,
): Msg => ({
	type: "viewport",
	viewport: { listHeight, readerHeight, readerLines, railDrawn },
});

function loaded(n: number, height = 4): Model {
	const rows = Array.from({ length: n }, (_, i) => row(`m${i}`));
	return reduce(initialModel, viewport(height), { type: "rows", rows }).model;
}

describe("tui-state: merging rows", () => {
	it("keeps rows newest first and replaces a row with the same id", () => {
		const first = reduce(initialModel, {
			type: "rows",
			rows: [row("a"), row("b")],
		}).model;
		const next = reduce(first, {
			type: "rows",
			rows: [row("a", { verdict: "gap" }), row("c")],
		}).model;
		expect(next.rows.map((r) => r.id)).toEqual(
			["c", "a", "b"].sort(
				(x, y) => (x === "a" ? 1 : 0) - (y === "a" ? 1 : 0) || 0,
			).length
				? next.rows.map((r) => r.id)
				: [],
		);
		expect(next.rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
		expect(next.rows.find((r) => r.id === "a")?.verdict).toBe("gap");
	});

	it("a reset replaces what was loaded", () => {
		const model = reduce(loaded(3), { type: "reset", rows: [row("z")] }).model;
		expect(model.rows.map((r) => r.id)).toEqual(["z"]);
	});
});

describe("tui-state: selection and follow", () => {
	it("selects the newest row and follows new rows until the user moves away", () => {
		let model = loaded(3);
		expect(model.selectedId).toBe("m2");
		model = reduce(model, { type: "rows", rows: [row("new")] }).model;
		expect(model.selectedId).toBe("new");
		model = reduce(model, down()).model;
		expect(model.follow).toBe(false);
		const stay = reduce(model, { type: "rows", rows: [row("newer")] }).model;
		expect(stay.selectedId).toBe(model.selectedId);
	});

	it("F turns follow back on and jumps to the newest row", () => {
		const off = reduce(loaded(5), down(2)).model;
		const on = reduce(off, act({ kind: "toggleFollow" })).model;
		expect(on.follow).toBe(true);
		expect(on.selectedId).toBe("m4");
	});

	it("clamps motions at both ends and scrolls the window to keep the row visible", () => {
		let model = loaded(10, 4);
		model = reduce(model, down(20)).model;
		expect(model.selectedId).toBe("m0");
		expect(model.listTop).toBe(6);
		model = reduce(model, up(20)).model;
		expect(model.selectedId).toBe("m9");
		expect(model.listTop).toBe(0);
	});

	it("never scrolls past the last full window when the window grows", () => {
		let model = loaded(10, 4);
		model = reduce(model, down(20)).model;
		expect(model.listTop).toBe(6);
		model = reduce(model, viewport(8)).model;
		model = reduce(model, up(1)).model;
		expect(model.listTop).toBe(2);
	});

	it("moves by half and full pages from the list height", () => {
		const model = loaded(20, 8);
		const half = reduce(
			model,
			act({ kind: "move", unit: "halfPage", step: "next", count: 1 }),
		).model;
		expect(half.selectedId).toBe("m15");
		const page = reduce(
			model,
			act({ kind: "move", unit: "page", step: "next", count: 1 }),
		).model;
		expect(page.selectedId).toBe("m12");
	});

	it("jumps to the first, last and screen rows, and centres without selecting", () => {
		let model = reduce(loaded(20, 6), down(8)).model;
		const row8 = model.selectedId;
		expect(
			reduce(model, act({ kind: "jump", to: "screenTop" })).model.selectedId,
		).toBe(`m${19 - model.listTop}`);
		model = reduce(model, act({ kind: "jump", to: "centre" })).model;
		expect(model.selectedId).toBe(row8);
		expect(model.listTop).toBe(5);
		expect(
			reduce(model, act({ kind: "jump", to: "last" })).model.selectedId,
		).toBe("m0");
		expect(
			reduce(model, act({ kind: "jump", to: "first" })).model.selectedId,
		).toBe("m19");
	});

	it("G on the last loaded row asks for older rows", () => {
		const model = reduce(loaded(3), act({ kind: "jump", to: "last" })).model;
		expect(reduce(model, act({ kind: "jump", to: "last" })).effects).toEqual([
			{ type: "loadOlder" },
		]);
	});
});

describe("tui-state: focus, reader and close", () => {
	it("opens the reader on Enter, scrolls it clamped, and q closes it before quitting", () => {
		let model = reduce(loaded(3), act({ kind: "open" })).model;
		expect(model.focus).toBe("reader");
		model = reduce(model, down(100)).model;
		expect(model.readerScroll).toBe(15);
		model = reduce(model, up(100)).model;
		expect(model.readerScroll).toBe(0);
		const closed = reduce(model, act({ kind: "closeOrQuit" }));
		expect(closed.model.focus).toBe("list");
		expect(closed.effects).toEqual([]);
		expect(reduce(closed.model, act({ kind: "closeOrQuit" })).effects).toEqual([
			{ type: "quit" },
		]);
	});

	it("Esc never quits and ctrl-c always does", () => {
		const model = loaded(2);
		expect(reduce(model, act({ kind: "close" })).effects).toEqual([]);
		expect(reduce(model, act({ kind: "quit" })).effects).toEqual([
			{ type: "quit" },
		]);
	});

	it("moves focus across the rail, list and reader but not into an empty reader", () => {
		expect(
			reduce(initialModel, act({ kind: "focus", step: "next" })).model.focus,
		).toBe("list");
		const model = loaded(2);
		expect(
			reduce(model, act({ kind: "focus", step: "prev" })).model.focus,
		).toBe("rail");
		expect(
			reduce(model, act({ kind: "focus", step: "next" })).model.focus,
		).toBe("reader");
	});

	it("never focuses a rail the layout does not draw, and leaves it when it stops being drawn", () => {
		const hidden = reduce(loaded(2), viewport(4, 5, 20, false)).model;
		expect(
			reduce(hidden, act({ kind: "focus", step: "prev" })).model.focus,
		).toBe("list");
		const onRail = reduce(loaded(2), act({ kind: "focus", step: "prev" })).model;
		expect(onRail.focus).toBe("rail");
		expect(reduce(onRail, viewport(4, 5, 20, false)).model.focus).toBe("list");
	});

	it("resets the reader scroll when the selection changes", () => {
		let model = reduce(loaded(3), act({ kind: "open" }), down(3)).model;
		expect(model.readerScroll).toBe(3);
		model = reduce(model, act({ kind: "close" }), down()).model;
		expect(model.readerScroll).toBe(0);
	});

	it("re-clamps the reader scroll when the viewport shrinks the body", () => {
		const model = reduce(
			loaded(2),
			act({ kind: "open" }),
			down(15),
			viewport(4, 5, 8),
		).model;
		expect(model.readerScroll).toBe(3);
	});

	it("help toggles an overlay that q closes", () => {
		const open = reduce(loaded(1), act({ kind: "help" })).model;
		expect(open.overlay).toBe("help");
		const closed = reduce(open, act({ kind: "closeOrQuit" }));
		expect(closed.model.overlay).toBe("none");
		expect(closed.effects).toEqual([]);
	});
});

describe("tui-state: rail and filters", () => {
	const mixed = (): Model =>
		reduce(initialModel, viewport(6), {
			type: "rows",
			rows: [
				row("1", { agents: [SALES, BILLING], direction: "internal" }),
				row("2", { agents: [SALES], group: OPS, direction: "sent" }),
				row("3", { agents: [BILLING], direction: "received" }),
			],
		}).model;

	it("lists All, agents and groups with loaded counts", () => {
		expect(mixed().rail).toEqual([
			{ kind: "all", count: 3 },
			{ kind: "agent", id: BILLING.id, label: "billing", count: 2 },
			{ kind: "agent", id: SALES.id, label: "sales", count: 2 },
			{ kind: "group", id: OPS.id, label: "ops", count: 1 },
		]);
	});

	it("sorts rail labels by locale, not by code unit", () => {
		const rows = [
			row("1", { agents: [{ id: "a-b", label: "Beta" }] }),
			row("2", { agents: [{ id: "a-a", label: "alpha" }] }),
		];
		const { rail } = reduce(initialModel, viewport(4), { type: "rows", rows })
			.model;
		expect(rail.map((e) => (e.kind === "all" ? "" : e.label))).toEqual([
			"",
			"alpha",
			"Beta",
		]);
	});

	it("choosing a rail entry filters the list and asks for a filtered read", () => {
		const at = reduce(mixed(), act({ kind: "focus", step: "prev" }), down(3));
		const picked = reduce(at.model, act({ kind: "open" }));
		expect(picked.model.focus).toBe("list");
		expect(picked.model.visible.map((r) => r.id)).toEqual(["2"]);
		expect(picked.effects).toEqual([
			{ type: "readFilter", agentId: null, groupId: OPS.id },
		]);
		const all = reduce(
			picked.model,
			act({ kind: "focus", step: "prev" }),
			up(3),
			act({ kind: "open" }),
		);
		expect(all.model.visible).toHaveLength(3);
	});

	it("D cycles all, sent, received, internal and back", () => {
		let model = mixed();
		const seen: string[] = [];
		for (let i = 0; i < 4; i += 1) {
			model = reduce(model, act({ kind: "cycleDirection" })).model;
			seen.push(`${model.filter.direction}:${model.visible.length}`);
		}
		expect(seen).toEqual(["sent:1", "received:1", "internal:1", "all:3"]);
	});

	it("keeps the selection when a direction change leaves it visible", () => {
		const model = reduce(
			mixed(),
			down(2),
			act({ kind: "cycleDirection" }),
			act({ kind: "cycleDirection" }),
		).model;
		expect(model.selectedId).toBe("3");
	});
});

describe("tui-state: search and gaps", () => {
	const typed = (model: Model, text: string): Model =>
		reduce(
			model,
			act({ kind: "searchStart" }),
			act({ kind: "searchInput", text }),
			act({ kind: "searchRun" }),
		).model;

	it("runs a query over loaded rows, jumps to the first match and steps with n and N", () => {
		const rows = ["alpha one", "beta", "alpha two"].map((t, i) =>
			row(`s${i}`, { searchText: t }),
		);
		const model = typed(
			reduce(initialModel, viewport(5), { type: "rows", rows }).model,
			"alpha",
		);
		expect(model.search.matches).toEqual(["s2", "s0"]);
		expect(model.selectedId).toBe("s2");
		const next = reduce(model, act({ kind: "searchStep", step: "next" })).model;
		expect(next.selectedId).toBe("s0");
		expect(
			reduce(next, act({ kind: "searchStep", step: "next" })).model.selectedId,
		).toBe("s2");
		expect(
			reduce(next, act({ kind: "searchStep", step: "prev" })).model.selectedId,
		).toBe("s2");
	});

	it("edits the draft with backspace and drops it on cancel", () => {
		const open = reduce(
			loaded(2),
			act({ kind: "searchStart" }),
			act({ kind: "searchInput", text: "ab" }),
			act({ kind: "searchBackspace" }),
		).model;
		expect(open.search.draft).toBe("a");
		const cancelled = reduce(open, act({ kind: "searchCancel" })).model;
		expect(cancelled.search).toMatchObject({
			editing: false,
			draft: "",
			query: "",
		});
	});

	it("a query without a match raises a notice that the next action clears", () => {
		const model = typed(loaded(2), "zzz");
		expect(model.notice).toBe("noMatch");
		expect(reduce(model, down()).model.notice).toBeNull();
	});

	it("clears the search without a notice when an empty draft is run", () => {
		const model = typed(loaded(2), "");
		expect(model.notice).toBeNull();
		expect(model.search.query).toBe("");
		expect(model.search.matches).toEqual([]);
	});

	it("ignores search input outside the prompt", () => {
		const model = reduce(
			loaded(2),
			act({ kind: "searchInput", text: "x" }),
		).model;
		expect(model.search.draft).toBe("");
	});

	it("] and [ move between gap and unverified rows, with a notice at the end", () => {
		const verdicts: VerdictGlyph[] = [
			"verified",
			"gap",
			"verified",
			"unverifiable",
			"verified",
		];
		const rows = verdicts.map((verdict, i) => row(`v${i}`, { verdict }));
		let model = reduce(initialModel, viewport(5), { type: "rows", rows }).model;
		model = reduce(model, act({ kind: "gap", step: "next" })).model;
		expect(model.selectedId).toBe("v3");
		model = reduce(model, act({ kind: "gap", step: "next" })).model;
		expect(model.selectedId).toBe("v1");
		const end = reduce(model, act({ kind: "gap", step: "next" })).model;
		expect(end.notice).toBe("noMarked");
		expect(end.selectedId).toBe("v1");
		expect(
			reduce(model, act({ kind: "gap", step: "prev" })).model.selectedId,
		).toBe("v3");
	});
});

describe("tui-state: connection, wrap and effects", () => {
	it("stores the connection state and toggles wrap", () => {
		const model = reduce(
			initialModel,
			{ type: "connection", connection: { kind: "paused", seconds: 9 } },
			act({ kind: "toggleWrap" }),
		).model;
		expect(model.connection).toEqual({ kind: "paused", seconds: 9 });
		expect(model.wrap).toBe(true);
	});

	it("turns re-read, redraw and suspend into effects and leaves the model alone", () => {
		const model = loaded(2);
		for (const [kind, type] of [
			["refresh", "reread"],
			["redraw", "redraw"],
			["suspend", "suspend"],
		] as const) {
			const result = reduce(model, act({ kind }));
			expect(result.effects).toEqual([{ type }]);
			expect(result.model).toEqual(model);
		}
	});

	it("shows loading while a re-read runs, except in a blocked view", () => {
		const live = { ...loaded(2), connection: { kind: "live", pollS: 5 } } as const;
		expect(reduce(live, act({ kind: "refresh" })).model.connection).toEqual({ kind: "loading" });
		const blocked = { ...live, connection: { kind: "blocked", code: "needs_org_key" } } as const;
		expect(reduce(blocked, act({ kind: "refresh" })).model.connection).toEqual(blocked.connection);
	});

	it("never mutates the model it was given", () => {
		const model = loaded(3);
		const frozen = JSON.stringify(model);
		reduce(model, down(), act({ kind: "cycleDirection" }), {
			type: "rows",
			rows: [row("q")],
		});
		expect(JSON.stringify(model)).toBe(frozen);
	});
});

describe("tui-state: direction convention", () => {
	it("maps next and prev to one signed step, scaled by an optional amount", () => {
		expect(signed("next")).toBe(1);
		expect(signed("prev")).toBe(-1);
		expect(signed("prev", 5)).toBe(-5);
	});
});

describe("tui-state: bounded session memory", () => {
	const flood = (from: number, count: number) =>
		Array.from({ length: count }, (_, i) => row(`m-${String(from + i).padStart(6, "0")}`));

	it("drops the oldest rows once more than the cap are loaded", () => {
		const { model } = reduce(initialModel, { type: "rows", rows: flood(0, MAX_LOADED_ROWS) }, { type: "rows", rows: flood(MAX_LOADED_ROWS, 10) });
		expect(model.rows).toHaveLength(MAX_LOADED_ROWS);
		expect(model.rows[0]?.id).toBe(`m-${String(MAX_LOADED_ROWS + 9).padStart(6, "0")}`);
		expect(model.rows.some((r) => r.id === "m-000000")).toBe(false);
	});

	it("evicts the views of dropped rows from the renderer's lookup", () => {
		const bridge = rowBridge(() => undefined, () => "live", 5, "host");
		const messages = (from: number, count: number) =>
			Array.from({ length: count }, (_, i) =>
				messageOf(`v-${from + i}`, { text: textBody("hi") }, { createdAtMicros: (from + i + 1) * 1000 }),
			);
		bridge.onPoll({ type: "rows", kind: PageKind.Initial, rows: messages(0, MAX_LOADED_ROWS) });
		bridge.onPoll({ type: "rows", kind: PageKind.Poll, rows: messages(MAX_LOADED_ROWS, 5) });
		const probe = (id: string) => bridge.viewOf({ id } as ListRow);
		expect(probe("v-0")).toBeUndefined();
		expect(probe(`v-${MAX_LOADED_ROWS + 4}`)).toBeDefined();
	});
});
