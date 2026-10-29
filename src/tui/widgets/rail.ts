/**
 * The agents and groups rail: All messages, then the org's agents, then its groups, each with the
 * count of rows loaded for it. The entries are built by the caller from loaded rows only, with
 * labels already scrubbed. Below 100 columns the rail collapses into a one-line filter chip.
 */
import { clipToWidth, displayWidth } from "@rine-network/core";
import { glyph } from "../glyphs.js";
import type { Rect } from "../layout.js";
import type { Screen } from "../screen.js";
import { PLAIN, Role, type Style } from "../style.js";

export const RailKind = { All: "all", Agent: "agent", Group: "group" } as const;
export type RailKind = (typeof RailKind)[keyof typeof RailKind];

export interface RailEntry {
	kind: RailKind;
	label: string;
	/** Rows loaded for this entry. */
	count: number;
}

export interface RailView {
	entries: readonly RailEntry[];
	/** Index into `entries` of the chosen entry. */
	selected: number;
	/** The rail holds the keyboard focus: the selection shows in reverse video. */
	focused: boolean;
	unicode: boolean;
}

const HEADINGS: Record<RailKind, string> = {
	all: "Messages",
	agent: "Agents",
	group: "Groups",
};

type Line = { heading: string } | { entry: number };

/** Headings and entries in display order: a heading above the first entry of each kind. */
function lineList(entries: readonly RailEntry[]): Line[] {
	const lines: Line[] = [];
	let kind: RailKind | undefined;
	entries.forEach((entry, entryIndex) => {
		if (entry.kind !== kind) {
			kind = entry.kind;
			lines.push({ heading: HEADINGS[kind] });
		}
		lines.push({ entry: entryIndex });
	});
	return lines;
}

function ellipsize(text: string, columns: number, unicode: boolean): string {
	if (displayWidth(text) <= columns) return text;
	const mark = glyph("ellipsis", unicode);
	return columns <= displayWidth(mark)
		? clipToWidth(text, columns)
		: clipToWidth(text, columns - displayWidth(mark)) + mark;
}

function drawEntry(
	screen: Screen,
	rect: Rect,
	y: number,
	entry: RailEntry,
	chosen: boolean,
	view: RailView,
): void {
	const style: Style = chosen
		? view.focused
			? { reverse: true }
			: { bold: true, fg: Role.Accent }
		: PLAIN;
	const right = rect.x + rect.w;
	screen.put(rect.x, y, " ".repeat(rect.w), style);
	screen.put(rect.x + 1, y, chosen ? glyph("railMarker", view.unicode) : " ", style);
	const count = String(entry.count);
	screen.put(
		right - 1 - count.length,
		y,
		count,
		chosen ? style : { fg: Role.Dim },
	);
	const room = rect.w - 3 - count.length - 2;
	screen.put(
		rect.x + 3,
		y,
		ellipsize(entry.label, Math.max(room, 0), view.unicode),
		style,
	);
}

/** Draw the full rail into `rect`, scrolling so the chosen entry stays visible. */
export function drawRail(screen: Screen, rect: Rect, view: RailView): void {
	const lines = lineList(view.entries);
	const chosenLine = lines.findIndex(
		(l) => "entry" in l && l.entry === view.selected,
	);
	const top = Math.min(
		Math.max(chosenLine - rect.h + 1, 0),
		Math.max(lines.length - rect.h, 0),
	);
	for (let row = 0; row < rect.h; row++) {
		const y = rect.y + row;
		const line = lines[top + row];
		if (line === undefined) {
			screen.put(rect.x, y, " ".repeat(rect.w));
		} else if ("heading" in line) {
			screen.put(rect.x, y, " ".repeat(rect.w));
			screen.put(
				rect.x + 1,
				y,
				ellipsize(line.heading, rect.w - 2, view.unicode),
				{ bold: true, fg: Role.Dim },
			);
		} else {
			drawEntry(
				screen,
				rect,
				y,
				view.entries[line.entry] as RailEntry,
				line.entry === view.selected,
				view,
			);
		}
	}
}

/**
 * The one-line filter chip for 60-99 columns: `[ sales 91 ]`, or the same in ASCII brackets for
 * All.
 */
export function drawRailChip(screen: Screen, rect: Rect, view: RailView): void {
	const entry = view.entries[view.selected];
	screen.put(rect.x, rect.y, " ".repeat(rect.w));
	if (entry === undefined) return;
	const kindLabel =
		entry.kind === RailKind.All
			? ""
			: `${HEADINGS[entry.kind].slice(0, -1).toLowerCase()} `;
	const inner = ellipsize(
		`${kindLabel}${entry.label} ${entry.count}`,
		Math.max(rect.w - 6, 0),
		view.unicode,
	);
	const style: Style = view.focused ? { reverse: true } : { fg: Role.Accent };
	screen.put(rect.x + 1, rect.y, `[ ${inner} ]`, style);
}
