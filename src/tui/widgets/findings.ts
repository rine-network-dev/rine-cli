/** The findings overlay: a centred box with each finding wrapped, newest first. */
import { clipToWidth } from "@rine-network/core";
import type { Rect } from "../layout.js";
import type { Screen } from "../screen.js";
import { PLAIN } from "../style.js";
import {
	OVERLAY_MIN_WIDTH,
	OVERLAY_PADDING,
	centred,
	drawOverlayBox,
} from "./overlay.js";
import { bodyLines } from "./wrap.js";

export interface FindingsView {
	title: string;
	footer: string;
	/** The index of the first finding drawn. */
	top: number;
	/** Each finding as one sentence; the overlay wraps it. */
	findings: readonly string[];
	unicode: boolean;
}

const INDENT = "  ";
const MAX_WIDTH = 100;
const MIN_HEIGHT = 5;
/** The border, and the footer line. */
const CHROME = 4;

/** Draw the overlay inside `area`; the findings that do not fit below `top` are cut. */
export function drawFindings(
	screen: Screen,
	area: Rect,
	view: FindingsView,
): void {
	const w = Math.min(area.w, MAX_WIDTH);
	if (w < OVERLAY_MIN_WIDTH || area.h < MIN_HEIGHT) return;
	const room = w - 2 - 2 * OVERLAY_PADDING;
	const lines = view.findings
		.slice(view.top)
		.flatMap((finding) =>
			bodyLines(finding, room - INDENT.length, true).map((line, i) =>
				i === 0 ? line : INDENT + line,
			),
		);
	const h = Math.min(area.h, lines.length + CHROME);
	const body = drawOverlayBox(screen, centred(area, w, h), view);
	if (!body) return;
	lines
		.slice(0, body.h)
		.forEach((line, i) =>
			screen.put(body.x, body.y + i, clipToWidth(line, body.w), PLAIN),
		);
}
