/**
 * The bottom bar: key hints (or a transient message) on the left, the feed state and counts on the
 * right.
 */
import { clipToWidth, displayWidth } from "@rine-network/core";
import { PULSE, SPINNER, dotJoint, frameAt, glyph } from "../glyphs.js";
import { type HintContext, HintScope, hintRuns } from "../hints.js";
import type { Rect } from "../layout.js";
import type { Screen } from "../screen.js";
import { PLAIN, Role, type Style } from "../style.js";
import { putRuns } from "./runs.js";

export const FeedState = {
	Live: "live",
	Paused: "paused",
	Loading: "loading",
} as const;
export type FeedState = (typeof FeedState)[keyof typeof FeedState];

export interface StatusView {
	/** Where the person is, which picks the key hints. */
	hints: HintContext;
	/** A message that replaces the hints until it expires; null when there is none. */
	transient: string | null;
	state: FeedState;
	/** The state in words, for example `live · 5 s`. */
	stateText: string;
	/** The loaded and gap counts, for example `248 loaded · 3 gaps`. */
	counts: string;
	/** Spinner step while loading. */
	spin: number;
	/** Pulse step of the live dot. */
	pulse: number;
	unicode: boolean;
}

const MIN_LEFT = 8;

function stateMark(view: StatusView): { glyph: string; style: Style } {
	switch (view.state) {
		case FeedState.Live:
			return { glyph: frameAt(PULSE, view.unicode, view.pulse), style: { fg: Role.Ok } };
		case FeedState.Paused:
			return { glyph: glyph("paused", view.unicode), style: { fg: Role.Warn } };
		case FeedState.Loading:
			return { glyph: frameAt(SPINNER, view.unicode, view.spin), style: { fg: Role.Info } };
	}
}

/**
 * Draw the bar on the first row of `rect`. The right side keeps its room; the left is cut to what
 * remains.
 */
export function drawStatus(screen: Screen, rect: Rect, view: StatusView): void {
	if (rect.w <= 0 || rect.h <= 0) return;
	screen.put(rect.x, rect.y, " ".repeat(rect.w), PLAIN);
	const mark = stateMark(view);
	const tail = `${view.stateText}${dotJoint(view.unicode)}${view.counts}`;
	const rightWidth = 2 + displayWidth(tail);
	const showRight = rect.w >= rightWidth + MIN_LEFT;
	const right = showRight ? rightWidth : 0;
	const room = Math.max(0, rect.w - right - 1);
	if (view.transient === null) {
		putRuns(screen, rect.x, rect.y, hintRuns(view.hints, room, view.unicode));
	} else {
		const shown = clipToWidth(view.transient, room);
		screen.put(rect.x, rect.y, shown, { fg: Role.Accent, bold: true });
		if (view.hints.scope === HintScope.Search) {
			const lead = displayWidth(shown) + 2;
			if (room - lead >= 1) {
				putRuns(screen, rect.x + lead, rect.y, hintRuns(view.hints, room - lead, view.unicode));
			}
		}
	}
	if (!showRight) return;
	const x = rect.x + rect.w - right;
	screen.put(x, rect.y, mark.glyph, mark.style);
	screen.put(x + 2, rect.y, tail, PLAIN);
}
