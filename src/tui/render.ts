/** One frame: the model drawn into a screen through the layout and the widgets. */
import {
	HEADER_BADGE,
	TOO_SMALL,
	errorSentence,
} from "./copy.js";
import { headerTitle } from "./header.js";
import { BINDINGS } from "./keymap.js";
import { FINDINGS_BAR_ROWS, computeLayout } from "./layout.js";
import { drawScan, scanStart } from "./motion-effects.js";
import { drawFindingsLayer } from "./render-findings.js";
import { helpView, statusView } from "./render-items.js";
import {
	type PanesDrawn,
	type RenderOptions,
	drawPanes,
	say,
} from "./render-panes.js";
import type { Screen } from "./screen.js";
import type { Model } from "./state-model.js";
import { PLAIN, Role } from "./style.js";
import { drawBox } from "./widgets/box.js";
import { drawHelp } from "./widgets/help.js";
import { drawStatus } from "./widgets/status.js";

export type { RenderOptions } from "./render-panes.js";

/**
 * Draw `model` into `screen` and return the pane sizes and the selected message's line count, which
 * the reducer needs to bound the list window and the reader's scroll.
 */
export function render(
	screen: Screen,
	model: Model,
	options: RenderOptions,
): Model["viewport"] {
	screen.clear();
	const reserved = model.findings.length > 0 ? FINDINGS_BAR_ROWS : 0;
	const layout = computeLayout(screen.cols, screen.rows, reserved);
	const full = { x: 0, y: 0, w: screen.cols, h: screen.rows };
	if (layout.tier === "tooSmall") {
		say(screen, full, TOO_SMALL, Role.Warn);
		return model.viewport;
	}
	const { unicode } = options.caps;
	const { motion } = options;
	drawBox(screen, full, {
		unicode,
		title: headerTitle(model.org, unicode, motion.revealMs),
		badge: HEADER_BADGE,
		style: { fg: Role.Accent },
		titleStyle: { fg: Role.Accent, bold: true },
		badgeStyle: PLAIN,
	});
	if (motion.scan !== null)
		drawScan(screen, scanStart(motion.scan, screen.cols));
	let drawn: PanesDrawn = { viewport: model.viewport, clipped: false };
	if (model.connection.kind === "blocked") {
		say(screen, layout.body, errorSentence(model.connection.code), Role.Warn);
	} else {
		drawn = drawPanes(screen, model, layout, options);
	}
	const wrapMatters = model.wrap || drawn.clipped;
	drawStatus(
		screen,
		{ x: 1, y: screen.rows - 1, w: screen.cols - 2, h: 1 },
		statusView(model, unicode, motion, wrapMatters),
	);
	drawFindingsLayer(screen, model, unicode);
	if (model.overlay === "help")
		drawHelp(screen, full, BINDINGS, helpView(unicode));
	return drawn.viewport;
}
