/** The help overlay: a centred box listing every binding of the keymap table. */
import { clipToWidth, displayWidth } from "@rine-network/core";
import type { BindingRow } from "../keymap.js";
import type { Screen } from "../screen.js";
import { PLAIN, Role } from "../style.js";
import type { Rect } from "../layout.js";
import { OVERLAY_MIN_WIDTH, OVERLAY_PADDING, centred, drawOverlayBox } from "./overlay.js";

export interface HelpView {
	/** The box title, for example `Keys`. */
	title: string;
	/** The line that says how to close the overlay. */
	footer: string;
	unicode: boolean;
}

const COLUMN_GAP = 2;

/**
 * The box the overlay occupies inside `area`: as wide as its longest row needs, centred, never
 * beyond the area.
 */
export function helpRect(
	area: Rect,
	rows: readonly Pick<BindingRow, "label" | "display">[],
	view: HelpView,
): Rect {
	const keys = Math.max(0, ...rows.map((r) => displayWidth(r.display)));
	const widest = Math.max(
		displayWidth(view.title) + 4,
		displayWidth(view.footer),
		...rows.map((r) => keys + COLUMN_GAP + displayWidth(r.label)),
	);
	const w = Math.min(area.w, Math.max(OVERLAY_MIN_WIDTH, widest + 2 * (OVERLAY_PADDING + 1)));
	const h = Math.min(area.h, rows.length + 4);
	return centred(area, w, h);
}

/**
 * Blank the overlay's box, draw the border and one line per binding; rows that do not fit are cut.
 */
export function drawHelp(
	screen: Screen,
	area: Rect,
	rows: readonly Pick<BindingRow, "label" | "display">[],
	view: HelpView,
): void {
	const rect = helpRect(area, rows, view);
	if (rect.w < 4 || rect.h < 3) return;
	const body = drawOverlayBox(screen, rect, view);
	if (!body) return;
	const keys = Math.max(0, ...rows.map((r) => displayWidth(r.display)));
	rows.slice(0, body.h).forEach((row, i) => {
		const y = body.y + i;
		screen.put(body.x, y, clipToWidth(row.display, body.w), { fg: Role.Accent, bold: true });
		const labelRoom = Math.max(0, body.w - keys - COLUMN_GAP);
		screen.put(body.x + keys + COLUMN_GAP, y, clipToWidth(row.label, labelRoom), PLAIN);
	});
}
