/** The frame shared by the centred overlays: blanked box, accent border and title, footer line. */
import { clipToWidth } from "@rine-network/core";
import type { Rect } from "../layout.js";
import type { Screen } from "../screen.js";
import { PLAIN, Role } from "../style.js";
import { drawBox } from "./box.js";

export const OVERLAY_PADDING = 1;
export const OVERLAY_MIN_WIDTH = 24;

export interface OverlayFrame {
	/** The box title. */
	title: string;
	/** The line on the last inner row. */
	footer: string;
	unicode: boolean;
}

/** A `w` by `h` rect centred inside `area`. */
export function centred(area: Rect, w: number, h: number): Rect {
	return {
		x: area.x + Math.floor((area.w - w) / 2),
		y: area.y + Math.floor((area.h - h) / 2),
		w,
		h,
	};
}

/**
 * Blank `rect`, draw the border, title and footer; returns the padded rows between the border and
 * the footer, or undefined when there is no room for text.
 */
export function drawOverlayBox(screen: Screen, rect: Rect, frame: OverlayFrame): Rect | undefined {
	for (let y = rect.y; y < rect.y + rect.h; y++) screen.put(rect.x, y, " ".repeat(rect.w), PLAIN);
	const inner = drawBox(screen, rect, {
		unicode: frame.unicode,
		title: [{ text: frame.title }],
		style: { fg: Role.Accent },
		titleStyle: { fg: Role.Accent, bold: true },
	});
	const room = inner.w - 2 * OVERLAY_PADDING;
	if (room <= 0) return undefined;
	const x = inner.x + OVERLAY_PADDING;
	if (inner.h >= 1) {
		screen.put(x, inner.y + inner.h - 1, clipToWidth(frame.footer, room), { fg: Role.Dim });
	}
	return { x, y: inner.y + 1, w: room, h: Math.max(0, inner.h - 2) };
}
