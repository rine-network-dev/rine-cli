/** The panes under the frame: rail, list and reader, laid out by tier, and the effects drawn on them. */
import type { Caps } from "./caps.js";
import { EMPTY_FILTER, EMPTY_ORG, LOADING } from "./copy.js";
import type { Layout, Rect } from "./layout.js";
import type { MotionFrame } from "./motion.js";
import { decodeCells, shimmerRow } from "./motion-effects.js";
import { railView } from "./render-items.js";
import { junctions, rule } from "./render-frame.js";
import { listItem, readerItem } from "./render-rows.js";
import type { Screen } from "./screen.js";
import type { ListRow } from "./state-data.js";
import type { Model, Viewport } from "./state-model.js";
import { Role } from "./style.js";
import type { RowView } from "./view-model.js";
import { drawList } from "./widgets/list.js";
import { drawRail, drawRailChip } from "./widgets/rail.js";
import { drawReader } from "./widgets/reader.js";
import { bodyLines } from "./widgets/wrap.js";

export interface RenderOptions {
	caps: Pick<Caps, "unicode">;
	/** What is in motion; `RESTING` when nothing is. */
	motion: MotionFrame;
	/** The time dates are measured from. */
	now: number;
	/** The row view behind a model row; the model keeps only what the reducer needs. */
	viewOf: (row: ListRow) => RowView | undefined;
}

export interface PanesDrawn {
	viewport: Viewport;
	/** A line of the open message is cut at the edge. */
	clipped: boolean;
}

/** A wrapped sentence from the top-left of `rect`. */
export function say(
	screen: Screen,
	rect: Rect,
	text: string,
	role: Role = Role.Dim,
): void {
	bodyLines(text, rect.w, true)
		.slice(0, rect.h)
		.forEach((line, i) => screen.put(rect.x, rect.y + i, line, { fg: role }));
}

function emptyText(model: Model): string {
	if (model.rows.length > 0) return EMPTY_FILTER;
	return model.connection.kind === "loading" ? LOADING : EMPTY_ORG;
}

export function drawPanes(
	screen: Screen,
	model: Model,
	layout: Exclude<Layout, { tier: "tooSmall" }>,
	options: RenderOptions,
): PanesDrawn {
	const { unicode } = options.caps;
	const { motion } = options;
	const items = model.visible.flatMap((row) => options.viewOf(row) ?? []);
	const selected = items.findIndex((row) => row.id === model.selectedId);
	const rowAt = (index: number) => {
		const row = items[index];
		return row && listItem(row, unicode, options.now);
	};
	let clipped = false;
	const paneList = (rect: Rect): void => {
		if (items.length === 0) {
			say(screen, rect, emptyText(model));
			return;
		}
		const view = {
			total: items.length,
			top: model.listTop,
			selected,
			focused: model.focus === "list",
			unicode,
		};
		drawList(screen, rect, view, rowAt);
		items.slice(view.top, view.top + rect.h).forEach((row, i) => {
			const elapsed = motion.shimmer.get(row.id);
			if (elapsed !== undefined)
				shimmerRow(screen, rect.x + 1, rect.y + i, rect.w - 3, elapsed);
		});
	};
	const paneReader = (rect: Rect): Viewport["readerLines"] => {
		const row = items[selected];
		if (row === undefined) return 0;
		const drawn = drawReader(screen, rect, readerItem(row, unicode), {
			scroll: model.readerScroll,
			wrap: model.wrap,
			unicode,
		});
		clipped = drawn.clipped;
		if (motion.decodeMs !== null)
			decodeCells(screen, drawn.body, motion.decodeMs);
		return drawn.lines;
	};
	if (layout.tier === "narrow") {
		const reading = model.focus === "reader" && selected >= 0;
		const readerLines = reading ? paneReader(layout.pane) : 0;
		if (!reading) paneList(layout.pane);
		const { h } = layout.pane;
		const viewport = { listHeight: h, readerHeight: h, readerLines, railDrawn: false };
		return { viewport, clipped };
	}
	if (layout.tier === "wide") {
		drawRail(screen, layout.rail, railView(model, unicode));
		rule(screen, layout.railRule, true, unicode);
	} else {
		drawRailChip(screen, layout.chip, railView(model, unicode));
	}
	rule(screen, layout.listRule, false, unicode);
	paneList(layout.list);
	const readerLines = paneReader(layout.reader);
	junctions(screen, layout, unicode);
	const viewport = {
		listHeight: layout.list.h,
		readerHeight: layout.reader.h,
		readerLines,
		railDrawn: layout.tier === "wide",
	};
	return { viewport, clipped };
}
