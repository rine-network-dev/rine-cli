/**
 * The virtualised message list: one line per row, a selection, gap rows and a glyph column.
 *
 * Rows are fetched through `rowAt` for the visible window only, so the cost of a frame follows the
 * window height and never the number of loaded rows. The verification glyph sits in the last column
 * before the scrollbar and is drawn with an absolute cursor move.
 */
import { clipWithEllipsis, displayWidth } from "@rine-network/core";
import type { Screen } from "../screen.js";
import { glyph } from "../glyphs.js";
import type { Rect } from "../layout.js";
import { PLAIN, Role, type Style } from "../style.js";
import { type ListParties, partiesRuns } from "./parties.js";
import { putRuns } from "./runs.js";
import { drawScrollbar } from "./scrollbar.js";

/**
 * What the list draws for one message; the view-model produces it with every string already
 * scrubbed.
 */
export interface ListItem {
	/** Who talked to whom: two labels and the joint between them, fitted to the column at draw time. */
	parties: ListParties;
	/** The snippet, or the gap sentence when it is a gap. */
	text: string;
	/** How the snippet reads: plain text, a gap's warning, a withheld text's reason. */
	textStyle: Style;
	/** The date in the column at the right, for example `14:02` or `Mon`. */
	date: string;
	/** The verification glyph, already chosen for the terminal's alphabet. */
	glyph: string;
	glyphRole: Role;
}

export interface ListView {
	/** Rows loaded. */
	total: number;
	/** Index of the first row on screen. */
	top: number;
	/** Index of the selected row. */
	selected: number;
	/** Whether the list has focus; an unfocused selection is dimmer. */
	focused: boolean;
	unicode: boolean;
}

const GAP = 2;
const PARTIES_MIN = 8;
const PARTIES_MAX = 28;
const DATE_WIDTH = 9;
/** The selection bar column. */
const LEAD = 1;
/** The glyph, then the scrollbar column. */
const TRAILER = 2;

/** The first row to show so that `selected` is on screen, moving as little as possible. */
export function scrollIntoView(
	top: number,
	selected: number,
	height: number,
	total: number,
): number {
	const last = Math.max(0, total - height);
	if (selected < top) return Math.min(selected, last);
	if (selected >= top + height) return Math.min(selected - height + 1, last);
	return Math.min(Math.max(top, 0), last);
}

export function fit(text: string, width: number, ellipsis: string): string {
	if (width <= 0) return "";
	const clipped = clipWithEllipsis(text, width, ellipsis);
	return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

function partiesWidth(width: number): number {
	return Math.min(PARTIES_MAX, Math.max(PARTIES_MIN, Math.floor(width * 0.3)));
}

function drawRow(
	screen: Screen,
	rect: Rect,
	y: number,
	item: ListItem,
	selected: boolean,
	view: ListView,
): void {
	const ellipsis = glyph("ellipsis", view.unicode);
	const body = rect.w - LEAD - TRAILER;
	const dateAt = Math.max(0, body - DATE_WIDTH - 1);
	const parties = Math.min(partiesWidth(rect.w), Math.max(0, dateAt - GAP));
	const snippet = Math.max(0, dateAt - GAP - parties - (parties > 0 ? GAP : 0));
	const base: Style = selected ? { reverse: true, bold: view.focused } : PLAIN;
	const dim: Style = { ...base, fg: Role.Dim };
	screen.put(rect.x, y, " ".repeat(rect.w - 1), base);
	if (selected) {
		const bar: Style = { fg: view.focused ? Role.Accent : Role.Dim, bold: true };
		screen.put(rect.x, y, glyph("selectionBar", view.unicode), bar);
	}
	let x = rect.x + LEAD;
	if (parties > 0) {
		x = putRuns(screen, x, y, partiesRuns(item.parties, parties, ellipsis), base) + GAP;
	}
	screen.put(x, y, fit(item.text, snippet, ellipsis), { ...base, ...item.textStyle });
	const pad = Math.max(0, DATE_WIDTH - displayWidth(item.date));
	screen.put(rect.x + LEAD + dateAt, y, " ".repeat(pad) + item.date, dim);
	screen.putAnchored(rect.x + rect.w - TRAILER, y, item.glyph, { ...base, fg: item.glyphRole });
}

/**
 * Draw the visible window of the list into `rect` and its scrollbar into the last column. `rowAt`
 * is called only for indices on screen.
 */
export function drawList(
	screen: Screen,
	rect: Rect,
	view: ListView,
	rowAt: (index: number) => ListItem | undefined,
): void {
	if (rect.w <= TRAILER || rect.h <= 0) return;
	const end = Math.min(view.total, view.top + rect.h);
	for (let index = view.top; index < end; index++) {
		const item = rowAt(index);
		if (item) {
			drawRow(screen, rect, rect.y + index - view.top, item, index === view.selected, view);
		}
	}
	drawScrollbar(
		screen,
		rect.x + rect.w - 1,
		rect.y,
		rect.h,
		{ total: view.total, visible: rect.h, offset: view.top },
		{ unicode: view.unicode, trackStyle: { fg: Role.Dim } },
	);
}
