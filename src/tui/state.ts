/**
 * The TUI reducer (Elm style): `update(model, msg)` returns the next model and the effects to run.
 */
import type { Action } from "./keymap-table.js";
import { DIRECTION_CYCLE, mergeRows, nextMarked } from "./state-data.js";
import { addFinding, scrollFindings } from "./state-findings.js";
import type { Effect, Model, Msg, Result } from "./state-model.js";
import { signed } from "./state-motion.js";
import {
	indexOfSelected,
	jumpTo,
	move,
	moveFocus,
	openRailEntry,
	refresh,
	searchEdit,
	select,
} from "./state-ops.js";

export { initialModel } from "./state-model.js";
export type {
	Connection,
	Effect,
	Focus,
	Model,
	Msg,
	Notice,
	Result,
	Viewport,
} from "./state-model.js";

function act(model: Model, action: Action): Result {
	const done = (next: Model, ...effects: Effect[]): Result => ({
		model: next,
		effects,
	});
	switch (action.kind) {
		case "move":
		case "jump": {
			if (model.overlay === "findings") return done(scrollFindings(model, action));
			const last = indexOfSelected(model) === model.visible.length - 1;
			const older =
				model.focus === "list" &&
				action.kind === "jump" &&
				action.to === "last" &&
				last;
			return older
				? done(model, { type: "loadOlder" })
				: done(move(model, action));
		}
		case "focus":
			return done(moveFocus(model, signed(action.step)));
		case "open":
			return model.focus === "rail"
				? openRailEntry(model)
				: done(model.focus === "list" ? moveFocus(model, 1) : model);
		case "close":
		case "closeOrQuit": {
			if (model.overlay !== "none") return done({ ...model, overlay: "none" });
			if (model.focus !== "list") return done({ ...model, focus: "list" });
			return action.kind === "closeOrQuit"
				? done(model, { type: "quit" })
				: done(model);
		}
		case "searchStart":
			return done({
				...model,
				search: { ...model.search, editing: true, draft: "" },
			});
		case "searchStep": {
			const { matches, at } = model.search;
			const to =
				(at + signed(action.step) + matches.length) % Math.max(1, matches.length);
			return done(
				jumpTo({ ...model, search: { ...model.search, at: to } }, matches[to]),
			);
		}
		case "gap": {
			const index = nextMarked(
				model.visible,
				Math.max(0, indexOfSelected(model)),
				signed(action.step),
			);
			return done(
				index < 0 ? { ...model, notice: "noMarked" } : select(model, index),
			);
		}
		case "cycleDirection": {
			const direction =
				DIRECTION_CYCLE[
					(DIRECTION_CYCLE.indexOf(model.filter.direction) + 1) %
						DIRECTION_CYCLE.length
				] ?? "all";
			return done(
				refresh(
					{ ...model, filter: { ...model.filter, direction } },
					model.rows,
				),
			);
		}
		case "toggleFollow":
			return done(
				model.follow
					? { ...model, follow: false }
					: select({ ...model, follow: true }, 0),
			);
		case "toggleWrap":
			return done({ ...model, wrap: !model.wrap });
		case "help":
			return done({
				...model,
				overlay: model.overlay === "help" ? "none" : "help",
			});
		case "findings":
			return done(
				model.findings.length === 0
					? model
					: {
							...model,
							findingsTop: 0,
							overlay: model.overlay === "findings" ? "none" : "findings",
						},
			);
		case "refresh":
			return done(
				{
					...model,
					connection:
						model.connection.kind === "blocked"
							? model.connection
							: { kind: "loading" },
					findings: [],
					findingsTop: 0,
					overlay: model.overlay === "findings" ? "none" : model.overlay,
				},
				{ type: "reread" },
			);
		case "quit":
		case "redraw":
		case "suspend":
			return done(model, { type: action.kind });
		case "searchInput":
		case "searchBackspace":
		case "searchCancel":
		case "searchRun":
			return done(searchEdit(model, action));
	}
}

export function update(model: Model, msg: Msg): Result {
	const only = (next: Model): Result => ({ model: next, effects: [] });
	switch (msg.type) {
		case "rows":
			return only(refresh(model, mergeRows(model.rows, msg.rows)));
		case "reset":
			return only(refresh(model, mergeRows([], msg.rows)));
		case "finding":
			return only({ ...model, findings: addFinding(model.findings, msg.finding) });
		case "connection":
			return only({ ...model, connection: msg.connection });
		case "org":
			return only({ ...model, org: msg.org });
		case "viewport": {
			const scroll = Math.min(
				model.readerScroll,
				Math.max(0, msg.viewport.readerLines - msg.viewport.readerHeight),
			);
			return only(
				select(
					{
						...model,
						viewport: msg.viewport,
						readerScroll: scroll,
						focus:
							model.focus === "rail" && !msg.viewport.railDrawn
								? "list"
								: model.focus,
					},
					Math.max(0, indexOfSelected(model)),
				),
			);
		}
		case "action":
			return act({ ...model, notice: null }, msg.action);
	}
}
