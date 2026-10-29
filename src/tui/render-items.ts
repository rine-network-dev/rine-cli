/** What each widget draws, built from the model, the row views and the sentences in `copy.ts`. */
import {
	HELP_FOOTER,
	HELP_TITLE,
	NOTICE_SENTENCE,
	RAIL_ALL,
	STATE_LOADING,
	STATE_OFFLINE,
	STATE_RETRYING,
	STATE_STOPPED,
	countsText,
	errorSentence,
	liveText,
	pausedText,
} from "./copy.js";
import { FeedErrorCode, Glyph } from "./feed-schema.js";
import type { Model } from "./state-model.js";
import { hintContext } from "./hints.js";
import type { MotionFrame } from "./motion.js";
import type { HelpView } from "./widgets/help.js";
import { type RailEntry, RailKind, type RailView } from "./widgets/rail.js";
import { FeedState, type StatusView } from "./widgets/status.js";

function railEntry(entry: Model["rail"][number]): RailEntry {
	switch (entry.kind) {
		case "all":
			return { kind: RailKind.All, label: RAIL_ALL, count: entry.count };
		case "agent":
			return { kind: RailKind.Agent, label: entry.label, count: entry.count };
		default:
			return {
				kind: RailKind.Group,
				label: entry.label,
				count: entry.count,
			};
	}
}

/** Whether `entry` is the rail row the active filter selects. */
function isFiltered(entry: Model["rail"][number], filter: Model["filter"]) {
	if (filter.agentId !== null) {
		return entry.kind === "agent" && entry.id === filter.agentId;
	}
	if (filter.groupId !== null) {
		return entry.kind === "group" && entry.id === filter.groupId;
	}
	return entry.kind === "all";
}

export function railView(model: Model, unicode: boolean): RailView {
	const entries = model.rail.map(railEntry);
	const chosen = model.rail.findIndex((entry) =>
		isFiltered(entry, model.filter),
	);
	const selected =
		model.focus === "rail" ? model.railCursor : Math.max(0, chosen);
	return { entries, selected, focused: model.focus === "rail", unicode };
}

/**
 * The bar's state mark and words for the connection, and the sentence that explains it when there
 * is one.
 */
function connectionStatus(model: Model, unicode: boolean): {
	state: FeedState;
	stateText: string;
	sentence: string | null;
} {
	const { connection } = model;
	switch (connection.kind) {
		case "loading":
			return {
				state: FeedState.Loading,
				stateText: STATE_LOADING,
				sentence: null,
			};
		case "live":
			return {
				state: FeedState.Live,
				stateText: liveText(connection.pollS, unicode),
				sentence: null,
			};
		case "paused":
			return {
				state: FeedState.Paused,
				stateText: pausedText(connection.seconds, unicode),
				sentence: errorSentence(FeedErrorCode.RateLimited, {
					retryS: connection.seconds,
				}),
			};
		case "network":
			return {
				state: FeedState.Paused,
				stateText: STATE_OFFLINE,
				sentence: errorSentence(FeedErrorCode.Network, {
					host: connection.host,
					retryS: connection.retryS,
				}),
			};
		case "failing":
			return {
				state: FeedState.Paused,
				stateText: STATE_RETRYING,
				sentence: errorSentence(connection.code, { retryS: connection.retryS }),
			};
		default:
			return {
				state: FeedState.Paused,
				stateText: STATE_STOPPED,
				sentence: null,
			};
	}
}

/**
 * The bar's one-off line: the search draft while editing, else a notice, else the connection's
 * sentence.
 */
function transientText(model: Model, sentence: string | null): string | null {
	if (model.search.editing) return `/${model.search.draft}_`;
	if (model.notice !== null) return NOTICE_SENTENCE[model.notice];
	return sentence;
}

export function statusView(
	model: Model,
	unicode: boolean,
	motion: MotionFrame,
	wrapMatters: boolean,
): StatusView {
	const status = connectionStatus(model, unicode);
	const gaps = model.rows.filter((row) => row.verdict === Glyph.Gap).length;
	const transient = transientText(model, status.sentence);
	return {
		hints: hintContext(model, wrapMatters),
		transient,
		state: status.state,
		stateText: status.stateText,
		counts: countsText(model.rows.length, gaps, unicode),
		spin: motion.spin,
		pulse: motion.pulse,
		unicode,
	};
}

export const helpView = (unicode: boolean): HelpView => ({
	title: HELP_TITLE,
	footer: HELP_FOOTER,
	unicode,
});
