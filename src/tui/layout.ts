/** Rect splitting with ratatui-style constraints, and the width breakpoints of the org view. */

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type Constraint =
	| { kind: "length"; n: number }
	| { kind: "percent"; n: number }
	| { kind: "fill"; weight: number };

export const length = (n: number): Constraint => ({ kind: "length", n });
export const percent = (n: number): Constraint => ({ kind: "percent", n });
export const fill = (weight = 1): Constraint => ({ kind: "fill", weight });

export type Direction = "horizontal" | "vertical";

/**
 * Split `area` along `dir` (horizontal = side by side). Lengths and percentages are taken first, in
 * order, and shrink from the end when they overflow; `fill` parts share what is left by weight, the
 * last taking the rounding remainder. The parts always tile the area exactly.
 */
export function split(
	area: Rect,
	dir: Direction,
	constraints: readonly Constraint[],
): Rect[] {
	const total = dir === "horizontal" ? area.w : area.h;
	const sizes = constraints.map((c) => {
		if (c.kind === "length") return Math.max(0, c.n);
		if (c.kind === "percent") return Math.floor((total * c.n) / 100);
		return 0;
	});
	let rest = total;
	for (let i = 0; i < sizes.length; i++) {
		sizes[i] = Math.min(sizes[i] as number, rest);
		rest -= sizes[i] as number;
	}
	const fills = constraints.flatMap((c, i) =>
		c.kind === "fill" ? [{ i, weight: Math.max(0, c.weight) }] : [],
	);
	const weights = fills.reduce((sum, f) => sum + f.weight, 0);
	let given = 0;
	fills.forEach((f, k) => {
		const share =
			k === fills.length - 1
				? rest - given
				: Math.floor((rest * f.weight) / (weights || 1));
		sizes[f.i] = share;
		given += share;
	});
	if (fills.length === 0 && rest > 0) {
		sizes[sizes.length - 1] = (sizes[sizes.length - 1] ?? 0) + rest;
	}
	let at = dir === "horizontal" ? area.x : area.y;
	return sizes.map((size) => {
		const rect =
			dir === "horizontal"
				? { x: at, y: area.y, w: size, h: area.h }
				: { x: area.x, y: at, w: area.w, h: size };
		at += size;
		return rect;
	});
}

export const MIN_COLS = 40;
export const MIN_ROWS = 10;
export const WIDE_COLS = 100;
export const MEDIUM_COLS = 60;
export const RAIL_COLS = 20;
/** Share of the right-hand column, in percent, that the list takes above the reader. */
export const LIST_SHARE = 55;

/**
 * The regions of the org view. `body` is inside the outer frame (one cell of border on each side);
 * the one-cell `*Rule` rects are the separators between regions.
 */
export type Layout =
	| { tier: "tooSmall" }
	| {
			tier: "wide";
			body: Rect;
			rail: Rect;
			railRule: Rect;
			list: Rect;
			listRule: Rect;
			reader: Rect;
	  }
	| {
			tier: "medium";
			body: Rect;
			chip: Rect;
			list: Rect;
			listRule: Rect;
			reader: Rect;
	  }
	| { tier: "narrow"; body: Rect; pane: Rect };

/** Rows the findings bar takes under the panes; the bar is drawn in the last of them. */
export const FINDINGS_BAR_ROWS = 1;

/** `reserved` rows under the panes are left to the caller, for example the findings bar. */
export function computeLayout(cols: number, rows: number, reserved = 0): Layout {
	if (cols < MIN_COLS || rows < MIN_ROWS) return { tier: "tooSmall" };
	const body = { x: 1, y: 1, w: cols - 2, h: rows - 2 - reserved };
	if (cols >= WIDE_COLS) {
		const [rail, railRule, right] = split(body, "horizontal", [
			length(RAIL_COLS),
			length(1),
			fill(),
		]) as [Rect, Rect, Rect];
		const [list, listRule, reader] = split(right, "vertical", [
			percent(LIST_SHARE),
			length(1),
			fill(),
		]) as [Rect, Rect, Rect];
		return { tier: "wide", body, rail, railRule, list, listRule, reader };
	}
	if (cols >= MEDIUM_COLS) {
		const [chip, list, listRule, reader] = split(body, "vertical", [
			length(1),
			percent(LIST_SHARE),
			length(1),
			fill(),
		]) as [Rect, Rect, Rect, Rect];
		return { tier: "medium", body, chip, list, listRule, reader };
	}
	return { tier: "narrow", body, pane: body };
}
