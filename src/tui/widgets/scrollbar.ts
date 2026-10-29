/** A proportional scrollbar thumb on one column. */
import { glyph } from "../glyphs.js";
import type { Screen } from "../screen.js";
import { PLAIN, type Style } from "../style.js";

export interface ScrollMetrics {
	/** Rows in the whole list. */
	total: number;
	/** Rows on screen. */
	visible: number;
	/** Index of the first row on screen. */
	offset: number;
}

export interface ScrollbarOptions {
	unicode: boolean;
	trackStyle?: Style;
	thumbStyle?: Style;
}

/** The thumb's first row and length within a track of `height` rows; null when everything fits. */
export function thumbSpan(
	height: number,
	{ total, visible, offset }: ScrollMetrics,
): { start: number; length: number } | null {
	if (height <= 0 || total <= visible) return null;
	const length = Math.max(1, Math.min(height, Math.round((height * visible) / total)));
	const travel = height - length;
	const range = total - visible;
	const clamped = Math.min(Math.max(offset, 0), range);
	const start = Math.min(travel, Math.round((clamped / range) * travel));
	return { start, length };
}

/** Draw the track and thumb down column `x` from row `y`. Draws nothing when everything fits. */
export function drawScrollbar(
	screen: Screen,
	x: number,
	y: number,
	height: number,
	metrics: ScrollMetrics,
	options: ScrollbarOptions,
): void {
	const span = thumbSpan(height, metrics);
	if (!span) return;
	const track = glyph("lineV", options.unicode);
	const thumb = glyph("scrollThumb", options.unicode);
	for (let row = 0; row < height; row++) {
		const onThumb = row >= span.start && row < span.start + span.length;
		const style = onThumb ? (options.thumbStyle ?? PLAIN) : (options.trackStyle ?? PLAIN);
		screen.put(x, y + row, onThumb ? thumb : track, style);
	}
}
