/**
 * The message reader: a fixed header block drawn from row metadata, a ruled separator, then the body behind a gutter.
 *
 * The header never contains body text, and every body line starts with the gutter, so no line of a message can sit in
 * the header area or imitate the verdict row. Every string arrives already scrubbed and composed by
 * the view-model and `copy.ts`; this file only places it.
 */
import { clipToWidth, displayWidth } from "@rine-network/core";
import { dotJoint, glyph } from "../glyphs.js";
import type { Rect } from "../layout.js";
import type { Screen } from "../screen.js";
import { PLAIN, Role, type Style } from "../style.js";
import { type ReaderParties, readerPartiesRuns } from "./parties.js";
import { putRuns } from "./runs.js";
import { drawScrollbar } from "./scrollbar.js";
import { bodyLines } from "./wrap.js";

/** What the reader draws for one message. */
export interface ReaderItem {
	/** Both parties, names bold and short agent ids dim, for example `sales 3f9a1c07  →  billing@acme 8b20e4d1`; a group is the tail. */
	parties: ReaderParties;
	/** The full timestamp. */
	when: string;
	/** The conversation kind, for example `1:1`. */
	kind: string;
	/** The verification glyph, already chosen for the terminal's alphabet, and the label that follows it. */
	glyph: string;
	glyphRole: Role;
	verdict: string;
	/** Shown under the verdict when two different copies of the message were seen. */
	equivocation: { glyph: string; sentence: string } | null;
	/** `{n} hidden characters removed`, or null when nothing was removed. */
	hidden: string | null;
	/** The title set into the dashed rule: the message, or the gap. */
	ruleTitle: string;
	/** Present for a gap row: the fixed sentence, then one line on what it means. The body is not shown. */
	gap: { sentence: string; meaning: string } | null;
	/** The scrubbed, clipped body; null when the text is not shown. */
	body: string | null;
}

export interface ReaderView {
	/** Index of the first body line on screen. */
	scroll: number;
	/** Wrap long lines; off, they are cut at the edge. */
	wrap: boolean;
	unicode: boolean;
}

/** What the reducer needs back to bound the scroll position. */
export interface ReaderMetrics {
	/** Body lines after wrapping. */
	lines: number;
	/** Body lines that fit on screen. */
	viewport: number;
	/** The scroll position actually drawn, clamped into range. */
	scroll: number;
	/** Where the body text is drawn, behind the gutter. */
	body: Rect;
	/** A body line is cut at the edge because wrapping is off. */
	clipped: boolean;
}

const GUTTER_WIDTH = 2;
/** The scrollbar column. */
const TRAILER = 1;

function itemBody(item: ReaderItem, width: number, wrap: boolean): { text: string; style: Style }[] {
	const style = (s: Style) => (text: string) => ({ text, style: s });
	if (item.gap) {
		return [
			...bodyLines(item.gap.sentence, width, true).map(style({ fg: Role.Warn })),
			{ text: "", style: PLAIN },
			...bodyLines(item.gap.meaning, width, true).map(style({ fg: Role.Dim })),
		];
	}
	return item.body === null ? [] : bodyLines(item.body, width, wrap).map(style(PLAIN));
}

const NO_METRICS: ReaderMetrics = {
	lines: 0,
	viewport: 0,
	scroll: 0,
	body: { x: 0, y: 0, w: 0, h: 0 },
	clipped: false,
};

function clipped(text: string, width: number, ellipsis: string): string {
	if (displayWidth(text) <= width) return text;
	return clipToWidth(text, Math.max(0, width - displayWidth(ellipsis))) + ellipsis;
}

/** Draw the header block from `rect.y`; returns the next free row. */
function drawHeader(screen: Screen, rect: Rect, item: ReaderItem, view: ReaderView): number {
	const ellipsis = glyph("ellipsis", view.unicode);
	const bottom = rect.y + rect.h;
	let y = rect.y;
	const line = (text: string, style: Style): void => {
		if (y < bottom) screen.put(rect.x, y++, clipped(text, rect.w, ellipsis), style);
	};
	if (y < bottom) putRuns(screen, rect.x, y++, readerPartiesRuns(item.parties, rect.w, ellipsis));
	if (y < bottom) {
		const lead = clipped(`${item.when}${dotJoint(view.unicode)}${item.kind}${dotJoint(view.unicode)}`, rect.w, ellipsis);
		const x = screen.put(rect.x, y, lead, PLAIN);
		screen.putAnchored(x, y, item.glyph, { fg: item.glyphRole });
		screen.put(x + 1, y, clipToWidth(` ${item.verdict}`, Math.max(0, rect.x + rect.w - x - 1)), PLAIN);
		y++;
	}
	if (item.equivocation) line(`${item.equivocation.glyph} ${item.equivocation.sentence}`, { fg: Role.Info });
	if (item.hidden) line(item.hidden, { fg: Role.Dim });
	return y;
}

/** Cells of the rule's tail that fade out, `╌╌┄┄`. */
const FADE = ["fadeMid", "fadeMid", "fadeEnd", "fadeEnd"] as const;

/** `━━ message ` in accent and bold, then a dim line whose last four cells fade away. */
function drawRule(screen: Screen, rect: Rect, y: number, title: string, unicode: boolean): void {
	const label = clipToWidth(title, Math.max(0, rect.w - 4));
	const lead = glyph("heavy", unicode).repeat(2);
	const fill = Math.max(0, rect.w - displayWidth(label) - 4);
	const fade = Math.min(FADE.length, fill);
	const tail =
		glyph("lineH", unicode).repeat(fill - fade) +
		FADE.slice(FADE.length - fade).map((name) => glyph(name, unicode)).join("");
	putRuns(screen, rect.x, y, [
		{ text: lead, style: { fg: Role.Accent } },
		{ text: " " },
		{ text: label, style: { bold: true } },
		{ text: " " },
		{ text: tail, style: { fg: Role.Dim } },
	]);
}

/**
 * Draw the reader into `rect` and return the numbers the reducer needs to bound scrolling. The body is drawn only
 * below the rule, each line behind the gutter, with a scrollbar in the last column.
 */
export function drawReader(screen: Screen, rect: Rect, item: ReaderItem, view: ReaderView): ReaderMetrics {
	if (rect.w <= GUTTER_WIDTH + TRAILER || rect.h <= 0) return NO_METRICS;
	const ruleY = drawHeader(screen, rect, item, view);
	if (ruleY >= rect.y + rect.h) return NO_METRICS;
	drawRule(screen, rect, ruleY, item.ruleTitle, view.unicode);
	const bodyRect: Rect = { x: rect.x, y: ruleY + 1, w: rect.w, h: rect.y + rect.h - ruleY - 1 };
	const lines = itemBody(item, rect.w - GUTTER_WIDTH - TRAILER, view.wrap);
	const scroll = Math.min(Math.max(view.scroll, 0), Math.max(0, lines.length - bodyRect.h));
	const gutter = glyph("gutter", view.unicode);
	for (let row = 0; row < bodyRect.h && scroll + row < lines.length; row++) {
		const { text, style } = lines[scroll + row] as { text: string; style: Style };
		screen.put(bodyRect.x, bodyRect.y + row, gutter, { fg: Role.Dim });
		screen.put(bodyRect.x + GUTTER_WIDTH, bodyRect.y + row, text, style);
	}
	drawScrollbar(
		screen,
		rect.x + rect.w - TRAILER,
		bodyRect.y,
		bodyRect.h,
		{ total: lines.length, visible: bodyRect.h, offset: scroll },
		{ unicode: view.unicode, trackStyle: { fg: Role.Dim } },
	);
	const text: Rect = { ...bodyRect, x: bodyRect.x + GUTTER_WIDTH, w: bodyRect.w - GUTTER_WIDTH - TRAILER };
	const cut = !view.wrap && (item.body ?? "").split("\n").some((line) => displayWidth(line) > text.w);
	return { lines: lines.length, viewport: bodyRect.h, scroll, body: text, clipped: cut };
}
