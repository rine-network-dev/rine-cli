import { type ReadFinding, ReadGapReason } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { rowBridge } from "../src/tui/app-data.js";
import { gapSentence } from "../src/tui/copy.js";
import { computeLayout } from "../src/tui/layout.js";
import type { DataEvent } from "../src/tui/data-types.js";
import type { Action } from "../src/tui/keymap-table.js";
import { render } from "../src/tui/render.js";
import { RESTING } from "../src/tui/motion.js";
import { PLAIN } from "../src/tui/style.js";
import { Screen } from "../src/tui/screen.js";
import { centred, drawOverlayBox } from "../src/tui/widgets/overlay.js";
import {
	MAX_LOADED_ROWS,
	groupHandle,
	railEntries,
} from "../src/tui/state-data.js";
import {
	type Model,
	type Msg,
	initialModel,
	update,
} from "../src/tui/state.js";
import { messageOf, textBody } from "./tui-fixture.js";
import { type RowView, rowView } from "../src/tui/view-model.js";

const finding = (groupId: string, epoch: number): ReadFinding => ({
	groupId,
	gap: { reason: ReadGapReason.NoEscrow, epoch },
});
const act = (action: Action): Msg => ({ type: "action", action });
const reduce = (model: Model, ...msgs: Msg[]): Model =>
	msgs.reduce((acc, msg) => update(acc, msg).model, model);
const told = (...found: ReadFinding[]): Msg[] =>
	found.map((one) => ({ type: "finding", finding: one }));

function frame(model: Model, cols = 80, rows = 24): string[] {
	const screen = new Screen(cols, rows);
	const views = new Map<string, RowView>();
	for (const row of model.rows) {
		const view = rowView(
			messageOf(
				row.id,
				{ text: textBody("hi") },
				{ groupId: "g1", groupHandle: "#ops" },
			),
		);
		views.set(row.id, view);
	}
	render(screen, model, {
		caps: { unicode: true },
		motion: RESTING,
		now: 0,
		viewOf: (row) => views.get(row.id),
	});
	return Array.from({ length: rows }, (_, y) =>
		Array.from({ length: cols }, (_, x) => screen.cell(x, y).text).join(""),
	);
}

describe("findings in the reducer", () => {
	it("keeps the newest finding first and one per group and gap", () => {
		const model = reduce(
			initialModel,
			...told(
				finding("g1", 1),
				finding("g2", 1),
				finding("g1", 1),
				finding("g1", 2),
			),
		);
		expect(model.findings.map((f) => [f.groupId, f.gap.epoch])).toEqual([
			["g1", 2],
			["g2", 1],
			["g1", 1],
		]);
	});

	it("forgets the oldest findings past the cap", () => {
		const flood = Array.from({ length: MAX_LOADED_ROWS + 2 }, (_, i) =>
			finding(`g${i}`, i),
		);
		const model = reduce(initialModel, ...told(...flood));
		expect(model.findings).toHaveLength(MAX_LOADED_ROWS);
		expect(model.findings[0]?.gap.epoch).toBe(MAX_LOADED_ROWS + 1);
	});

	it("opens and closes the overlay with f, Esc and q, and ignores f when there are none", () => {
		const f = act({ kind: "findings" });
		expect(reduce(initialModel, f).overlay).toBe("none");
		const withOne = reduce(initialModel, ...told(finding("g1", 1)));
		const open = reduce(withOne, f);
		expect(open.overlay).toBe("findings");
		expect(reduce(open, f).overlay).toBe("none");
		expect(reduce(open, act({ kind: "close" })).overlay).toBe("none");
		expect(reduce(open, act({ kind: "closeOrQuit" })).overlay).toBe("none");
	});

	it("clears the findings and closes the overlay on a reload, and the next read tells them again", () => {
		const open = reduce(
			initialModel,
			...told(finding("g1", 1)),
			act({ kind: "findings" }),
		);
		const reloaded = update(open, act({ kind: "refresh" }));
		expect(reloaded.model.findings).toEqual([]);
		expect(reloaded.model.overlay).toBe("none");
		expect(reloaded.effects).toEqual([{ type: "reread" }]);
		expect(
			reduce(reloaded.model, ...told(finding("g1", 1))).findings,
		).toHaveLength(1);
	});

	it("scrolls the overlay with the motion keys and keeps the list still", () => {
		const open = reduce(
			initialModel,
			...told(finding("g1", 1), finding("g1", 2), finding("g1", 3)),
			act({ kind: "findings" }),
		);
		const down = act({ kind: "move", unit: "row", step: "next", count: 1 });
		expect(reduce(open, down).findingsTop).toBe(1);
		expect(reduce(open, down, down, down, down).findingsTop).toBe(2);
		expect(
			reduce(
				open,
				act({ kind: "jump", to: "last" }),
				act({ kind: "jump", to: "first" }),
			).findingsTop,
		).toBe(0);
	});
});

describe("findings from the poller", () => {
	it("reach the reducer as a finding message", () => {
		const sent: Msg[] = [];
		const bridge = rowBridge(
			(msg) => sent.push(msg),
			() => "live",
			5,
			"host",
		);
		const event: DataEvent = { type: "finding", finding: finding("g1", 1) };
		bridge.onPoll(event);
		expect(sent).toEqual([{ type: "finding", finding: event.finding }]);
	});
});

describe("findings on screen", () => {
	const rows = [
		{
			id: "m1",
			createdAtMicros: 1,
			direction: "internal" as const,
			agents: [],
			group: { id: "g1", label: "#ops" },
			verdict: "verified" as const,
			searchText: "hi",
		},
	];
	const base = reduce(initialModel, { type: "reset", rows });

	it("draws nothing and takes no row while there are none", () => {
		const lines = frame(base);
		expect(lines.join("\n")).not.toContain("finding");
		expect(frame({ ...base, findings: [] })).toEqual(lines);
	});

	it("draws the bar on the row directly under the panes at every height", () => {
		for (const rowsHigh of [24, 30]) {
			const model = reduce(base, ...told(finding("g1", 41)));
			const layout = computeLayout(80, rowsHigh, 1);
			if (layout.tier === "tooSmall") throw new Error("layout too small");
			const lines = frame(model, 80, rowsHigh);
			expect(lines[layout.body.y + layout.body.h]).toContain("1 finding");
		}
	});

	it("names the group by its handle when a loaded row knows it", () => {
		const bar = frame(reduce(base, ...told(finding("g1", 41)))).at(-2) ?? "";
		expect(bar).toContain("1 finding · f lists them · In #ops: ");
		expect(bar).toContain(gapSentence(finding("g1", 41).gap).slice(0, 30));
	});

	it("shows a handle that already starts with # with exactly one #", () => {
		const bar = frame(reduce(base, ...told(finding("g1", 41)))).at(-2) ?? "";
		expect(bar).toContain("In #ops:");
		expect(bar).not.toContain("##");
	});

	it("names the group by a short id when no loaded row knows it", () => {
		const id = "9c2e51f0-0000-4000-8000-000000000009";
		const bar = frame(reduce(base, ...told(finding(id, 7)))).at(-2) ?? "";
		expect(bar).toContain("In 9c2e51f0:");
		expect(bar).not.toContain(id);
	});

	it("counts every finding and says the latest", () => {
		const bar =
			frame(reduce(base, ...told(finding("g1", 1), finding("g1", 2)))).at(-2) ??
			"";
		expect(bar).toContain("2 findings · f lists them");
		expect(bar).toContain("epoch 2");
	});

	it("lists every finding in the overlay", () => {
		const model = reduce(
			base,
			...told(finding("g1", 1), finding("g1", 2)),
			act({ kind: "findings" }),
		);
		const text = frame(model).join("\n");
		expect(text).toContain("Findings");
		expect(text).toContain("epoch 1");
		expect(text).toContain("epoch 2");
	});

	it("formats only the newest finding while the overlay is closed", () => {
		const untouched = {
			get groupId(): string {
				throw new Error("formatted a finding the bar does not show");
			},
			gap: finding("g1", 1).gap,
		};
		const model = {
			...reduce(base, ...told(finding("g1", 2))),
			findings: [finding("g1", 2), untouched],
		};
		expect(frame(model).at(-2)).toContain("2 findings");
	});

	it("reads a group handle from the rail, null when only the id is known", () => {
		const rail = railEntries(rows);
		expect(groupHandle(rail, "g1")).toBe("#ops");
		expect(groupHandle(rail, "g2")).toBeNull();
		expect(
			groupHandle(
				railEntries([{ ...rows[0]!, group: { id: "g3", label: "g3" } }]),
				"g3",
			),
		).toBeNull();
	});

	it("scrubs a group id with control characters", () => {
		const bar =
			frame(reduce(base, ...told(finding("\u001b[31mevil\u001b[0m", 1)))).at(
				-2,
			) ?? "";
		expect(bar).not.toContain("\u001b");
	});
});

describe("drawOverlayBox", () => {
	const rowText = (screen: Screen, y: number, cols: number): string =>
		Array.from({ length: cols }, (_, x) => screen.cell(x, y).text).join("");

	it("centres the box, blanks it, and returns the rows between the border and the footer", () => {
		const screen = new Screen(40, 12);
		screen.put(0, 5, "x".repeat(40), PLAIN);
		const rect = centred({ x: 0, y: 0, w: 40, h: 12 }, 30, 8);
		expect(rect).toEqual({ x: 5, y: 2, w: 30, h: 8 });
		const body = drawOverlayBox(screen, rect, {
			title: "T",
			footer: "close",
			unicode: true,
		});
		expect(body).toEqual({ x: 7, y: 4, w: 26, h: 4 });
		expect(rowText(screen, 5, 40).slice(6, 34).trim()).toBe("");
		expect(rowText(screen, 8, 40)).toContain("close");
	});

	it("returns nothing when the box has no room for text", () => {
		const screen = new Screen(10, 10);
		expect(
			drawOverlayBox(
				screen,
				{ x: 0, y: 0, w: 3, h: 5 },
				{ title: "T", footer: "f", unicode: true },
			),
		).toBeUndefined();
	});
});
