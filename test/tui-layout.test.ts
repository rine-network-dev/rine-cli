import { describe, expect, it } from "vitest";
import {
	type Rect,
	computeLayout,
	fill,
	length,
	percent,
	split,
} from "../src/tui/layout.js";

const area: Rect = { x: 2, y: 3, w: 100, h: 30 };

describe("split", () => {
	it("tiles the area exactly for lengths, percentages and fills", () => {
		const parts = split(area, "horizontal", [length(20), percent(25), fill()]);
		expect(parts.map((p) => p.w)).toEqual([20, 25, 55]);
		expect(parts.map((p) => p.x)).toEqual([2, 22, 47]);
		expect(parts.every((p) => p.y === 3 && p.h === 30)).toBe(true);
	});

	it("splits vertically and gives the rounding remainder to the last fill", () => {
		const parts = split({ x: 0, y: 0, w: 10, h: 10 }, "vertical", [
			fill(1),
			fill(1),
			fill(1),
		]);
		expect(parts.map((p) => p.h)).toEqual([3, 3, 4]);
		expect(parts.map((p) => p.y)).toEqual([0, 3, 6]);
	});

	it("shares fills by weight", () => {
		const parts = split({ x: 0, y: 0, w: 90, h: 1 }, "horizontal", [
			fill(1),
			fill(2),
		]);
		expect(parts.map((p) => p.w)).toEqual([30, 60]);
	});

	it("shrinks from the end when the fixed parts overflow", () => {
		const parts = split({ x: 0, y: 0, w: 30, h: 1 }, "horizontal", [
			length(20),
			length(20),
			fill(),
		]);
		expect(parts.map((p) => p.w)).toEqual([20, 10, 0]);
	});
});

const sum = (rects: Rect[], key: "w" | "h") =>
	rects.reduce((n, r) => n + r[key], 0);

describe("computeLayout", () => {
	it("is tooSmall below 40 columns or 10 rows", () => {
		expect(computeLayout(39, 40).tier).toBe("tooSmall");
		expect(computeLayout(120, 9).tier).toBe("tooSmall");
		expect(computeLayout(40, 10).tier).toBe("narrow");
	});

	it("is a single pane below 60 columns", () => {
		const l = computeLayout(59, 20);
		expect(l.tier).toBe("narrow");
		if (l.tier === "narrow")
			expect(l.pane).toEqual({ x: 1, y: 1, w: 57, h: 18 });
	});

	it("collapses the rail into a chip from 60 to 99 columns", () => {
		for (const cols of [60, 99]) {
			const l = computeLayout(cols, 40);
			expect(l.tier).toBe("medium");
			if (l.tier !== "medium") continue;
			expect(l.chip.h).toBe(1);
			expect(l.list.w).toBe(cols - 2);
			expect(sum([l.chip, l.list, l.listRule, l.reader], "h")).toBe(38);
		}
	});

	it("shows the 20 column rail from 100 columns, list over reader 55/45", () => {
		const l = computeLayout(120, 40);
		expect(l.tier).toBe("wide");
		if (l.tier !== "wide") return;
		expect(l.rail.w).toBe(20);
		expect(sum([l.rail, l.railRule, l.list], "w")).toBe(
			118 - (l.reader.w - l.list.w),
		);
		expect(l.list.x).toBe(22);
		expect(l.list.h).toBe(Math.floor((38 * 55) / 100));
		expect(sum([l.list, l.listRule, l.reader], "h")).toBe(38);
		expect(computeLayout(100, 40).tier).toBe("wide");
	});
});
