/** Borders with a title and a right-aligned badge, drawn into the cell buffer. */
import { clipToWidth, displayWidth } from "@rine-network/core";
import { type GlyphName, glyph } from "../glyphs.js";
import type { Rect } from "../layout.js";
import type { Screen } from "../screen.js";
import { PLAIN, type Style } from "../style.js";
import { type Run, clipRuns, putRuns, runsWidth } from "./runs.js";

export interface BoxOptions {
	unicode: boolean;
	/** Set into the top edge after one space of border; each run over `titleStyle`. */
	title?: readonly Run[];
	/** Set into the top edge, ending one space before the corner. */
	badge?: string;
	style?: Style;
	titleStyle?: Style;
	badgeStyle?: Style;
}

/**
 * `runs` between spaces on the border row, clipped to `room` columns; returns the columns it took,
 * spaces included.
 */
function label(
	screen: Screen,
	x: number,
	y: number,
	room: number,
	runs: readonly Run[],
	style: Style,
): number {
	const clipped = clipRuns(runs, Math.max(0, room - 2));
	if (clipped.length === 0) return 0;
	const width = runsWidth(clipped);
	screen.put(x, y, " ", style);
	putRuns(screen, x + 1, y, clipped, style);
	screen.put(x + 1 + width, y, " ", style);
	return width + 2;
}

/** The area inside a box of this size; empty when the box is too small to have an inside. */
export function innerRect(rect: Rect): Rect {
	return { x: rect.x + 1, y: rect.y + 1, w: Math.max(0, rect.w - 2), h: Math.max(0, rect.h - 2) };
}

/**
 * Draw the border and return the inside. The right border is anchored, so a terminal that measures
 * a cluster in the row differently cannot push it out of its column.
 */
export function drawBox(screen: Screen, rect: Rect, options: BoxOptions): Rect {
	const { x, y, w, h } = rect;
	if (w < 2 || h < 2) return innerRect(rect);
	const mark = (name: GlyphName): string => glyph(name, options.unicode);
	const style = options.style ?? PLAIN;
	const top = w - 2;
	const edge = mark("lineH").repeat(top);
	screen.put(x, y, mark("boxTopLeft") + edge + mark("boxTopRight"), style);
	screen.put(x, y + h - 1, mark("boxBottomLeft") + edge + mark("boxBottomRight"), style);
	for (let row = y + 1; row < y + h - 1; row++) {
		screen.put(x, row, mark("lineV"), style);
		screen.putAnchored(x + w - 1, row, mark("lineV"), style);
	}
	let used = 0;
	if (options.title) {
		used = label(screen, x + 1, y, top, options.title, options.titleStyle ?? style);
	}
	if (options.badge) {
		const room = top - used;
		const badge = clipToWidth(options.badge, Math.max(0, room - 2));
		if (badge) {
			const width = displayWidth(badge) + 2;
			screen.put(x + w - 1 - width, y, ` ${badge} `, options.badgeStyle ?? style);
		}
	}
	return innerRect(rect);
}
