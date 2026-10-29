import { describe, expect, it } from "vitest";
import { HintScope } from "../src/tui/hints.js";
import { Screen } from "../src/tui/screen.js";
import { Role } from "../src/tui/style.js";
import { drawHelp, helpRect } from "../src/tui/widgets/help.js";
import {
	type RailEntry,
	RailKind,
	type RailView,
	drawRail,
	drawRailChip,
} from "../src/tui/widgets/rail.js";
import { FeedState, drawStatus } from "../src/tui/widgets/status.js";

function rowText(s: Screen, y: number): string {
	let line = "";
	for (let x = 0; x < s.cols; x++) line += s.cell(x, y).text;
	return line;
}

const rows = (s: Screen): string[] =>
	Array.from({ length: s.rows }, (_, y) => rowText(s, y));

const entries: RailEntry[] = [
	{ kind: RailKind.All, label: "All messages", count: 99 },
	...Array.from({ length: 6 }, (_, i) => ({
		kind: RailKind.Agent,
		label: `agent-${i}`,
		count: i,
	})),
	{ kind: RailKind.Group, label: "ops", count: 7 },
];
const railView = (over: Partial<RailView> = {}): RailView => ({
	entries,
	selected: 0,
	focused: true,
	unicode: true,
	...over,
});

describe("drawRail", () => {
	it("groups entries under headings and marks the chosen one", () => {
		const s = new Screen(24, 12);
		drawRail(s, { x: 0, y: 0, w: 24, h: 12 }, railView({ selected: 2 }));
		const out = rows(s);
		expect(out[0]).toContain("Messages");
		expect(out[2]).toContain("Agents");
		expect(out.find((r) => r.includes("▸"))).toContain("agent-1");
		expect(out[9]).toContain("Groups");
		expect(out[10]).toContain("ops");
	});

	it("scrolls so the chosen entry stays on screen", () => {
		const s = new Screen(24, 4);
		drawRail(s, { x: 0, y: 0, w: 24, h: 4 }, railView({ selected: 7 }));
		const out = rows(s);
		expect(out.join("\n")).toContain("ops");
		expect(out.filter((r) => r.includes("▸"))).toHaveLength(1);
		expect(out[3]).toContain("ops");
	});

	it("truncates a long label so the count keeps its column", () => {
		const s = new Screen(16, 3);
		drawRail(
			s,
			{ x: 0, y: 0, w: 16, h: 3 },
			railView({
				entries: [{ kind: RailKind.All, label: "x".repeat(40), count: 12 }],
			}),
		);
		expect(rowText(s, 1).trimEnd().endsWith("12")).toBe(true);
		expect(rowText(s, 1)).toContain("…");
	});
});

describe("drawRailChip", () => {
	it("shows the chosen entry in brackets with its kind", () => {
		const s = new Screen(30, 1);
		drawRailChip(s, { x: 0, y: 0, w: 30, h: 1 }, railView({ selected: 1 }));
		expect(rowText(s, 0).trim()).toBe("[ agent agent-0 0 ]");
	});

	it("omits the kind for All", () => {
		const s = new Screen(30, 1);
		drawRailChip(s, { x: 0, y: 0, w: 30, h: 1 }, railView());
		expect(rowText(s, 0).trim()).toBe("[ All messages 99 ]");
	});
});

describe("drawHelp", () => {
	const help = { title: "Keys", footer: "Esc closes", unicode: true };
	const bindings = Array.from({ length: 4 }, (_, i) => ({
		display: `k${i}`,
		label: `does thing ${i}`,
	}));

	it("lists every binding with the footer on the last inner row", () => {
		const s = new Screen(60, 20);
		const area = { x: 0, y: 0, w: 60, h: 20 };
		drawHelp(s, area, bindings, help);
		const box = helpRect(area, bindings, help);
		const out = rows(s);
		bindings.forEach((b, i) =>
			expect(out[box.y + 2 + i]).toContain(`${b.display}  ${b.label}`),
		);
		expect(out[box.y + box.h - 2]).toContain("Esc closes");
	});

	it("cuts rows that do not fit and never overwrites the footer", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			display: `k${i}`,
			label: `row ${i}`,
		}));
		const s = new Screen(60, 10);
		const area = { x: 0, y: 0, w: 60, h: 10 };
		drawHelp(s, area, many, help);
		const box = helpRect(area, many, help);
		expect(box.h).toBe(10);
		const out = rows(s);
		expect(out[box.y + box.h - 2]).toContain("Esc closes");
		expect(out.join("\n")).not.toContain("row 8");
		expect(out[box.y + box.h - 1]?.trim()).toMatch(/^╰─+╯$/);
	});
});

describe("drawStatus", () => {
	const status = {
		hints: {
			scope: HintScope.List,
			searchActive: false,
			findings: false,
			directionFiltered: false,
			followOff: false,
			wrapMatters: false,
		},
		transient: null,
		state: FeedState.Live,
		stateText: "live",
		counts: "5 loaded",
		spin: 0,
		pulse: 0,
		unicode: true,
	};

	it("puts hints left and state with counts right", () => {
		const s = new Screen(50, 1);
		drawStatus(s, { x: 0, y: 0, w: 50, h: 1 }, status);
		expect(rowText(s, 0).startsWith("j/k move · enter open")).toBe(true);
		expect(rowText(s, 0).trimEnd().endsWith("● live · 5 loaded")).toBe(true);
	});

	it("draws the keys bold in accent and the labels dim", () => {
		const s = new Screen(50, 1);
		drawStatus(s, { x: 0, y: 0, w: 50, h: 1 }, status);
		expect(s.cell(0, 0).style).toMatchObject({ fg: Role.Accent, bold: true });
		expect(s.cell(4, 0).style.fg).toBe(Role.Dim);
		expect(s.cell(9, 0).style.fg).toBe(Role.Dim);
	});

	it("pulses the live mark through the phases and spins the loading mark", () => {
		const mark = (view: object) => {
			const s = new Screen(50, 1);
			drawStatus(s, { x: 0, y: 0, w: 50, h: 1 }, { ...status, ...view });
			return rowText(s, 0).trimEnd().slice(-17, -16);
		};
		expect([0, 1, 2, 3, 4].map((pulse) => mark({ pulse }))).toEqual(["●", "◉", "○", "◉", "●"]);
		const spin = (n: number) => mark({ state: FeedState.Loading, spin: n });
		expect(spin(0)).toBe("⠋");
		expect(spin(1)).toBe("⠙");
		expect(spin(10)).toBe("⠋");
	});

	it("keeps the live mark steady in ASCII", () => {
		const s = new Screen(50, 1);
		drawStatus(s, { x: 0, y: 0, w: 50, h: 1 }, { ...status, pulse: 1, unicode: false });
		expect(rowText(s, 0)).toContain("* live");
	});

	it("shows the search draft and its enter and esc hints together on the row", () => {
		const s = new Screen(50, 1);
		drawStatus(
			s,
			{ x: 0, y: 0, w: 50, h: 1 },
			{
				...status,
				hints: { ...status.hints, scope: HintScope.Search },
				transient: "/ab_",
			},
		);
		expect(rowText(s, 0).startsWith("/ab_  enter find · esc cancel")).toBe(true);
	});

	it("lets a transient message replace the hints and drops the right side when narrow", () => {
		const s = new Screen(20, 1);
		drawStatus(
			s,
			{ x: 0, y: 0, w: 20, h: 1 },
			{ ...status, transient: "copied" },
		);
		expect(rowText(s, 0).trimEnd()).toBe("copied");
	});
});
