/**
 * The reducer's building blocks: selection, derived-state refresh, motions, focus, the rail and the
 * search prompt.
 */
import type { Action } from "./keymap-table.js";
import {
	type ListRow,
	type SearchInput,
	editSearch,
	railEntries,
	searchMatches,
	visibleRows,
} from "./state-data.js";
import type { Filter } from "./state-data.js";
import type { Focus, Model, Result } from "./state-model.js";
import { listTarget, scrollTarget } from "./state-motion.js";
import { scrollIntoView } from "./widgets/list.js";

export const clamp = (value: number, low: number, high: number): number =>
	Math.max(low, Math.min(high, value));

export const indexOfSelected = (model: Model): number =>
	model.visible.findIndex((row) => row.id === model.selectedId);

export function select(model: Model, index: number): Model {
	const at = clamp(index, 0, model.visible.length - 1);
	const row = model.visible[at];
	if (row === undefined)
		return { ...model, selectedId: null, listTop: 0, readerScroll: 0 };
	const { listHeight } = model.viewport;
	const listTop = scrollIntoView(model.listTop, at, listHeight, model.visible.length);
	const readerScroll = row.id === model.selectedId ? model.readerScroll : 0;
	return {
		...model,
		selectedId: row.id,
		readerScroll,
		listTop,
		follow: model.follow && at === 0,
	};
}

/**
 * Recompute everything derived from `rows`, `filter` and the search query; follow pins the newest
 * row.
 */
export function refresh(model: Model, rows: readonly ListRow[]): Model {
	const visible = visibleRows(rows, model.filter);
	const matches = searchMatches(visible, model.search.query);
	const at = Math.min(model.search.at, Math.max(0, matches.length - 1));
	const next: Model = {
		...model,
		rows,
		visible,
		rail: railEntries(rows),
		search: { ...model.search, matches, at },
	};
	const keep = indexOfSelected(next);
	return select(next, model.follow || keep < 0 ? 0 : keep);
}

export function move(
	model: Model,
	action: Extract<Action, { kind: "move" | "jump" }>,
): Model {
	if (model.focus === "reader") {
		const { readerHeight, readerLines } = model.viewport;
		const to = scrollTarget(action, model.readerScroll, readerHeight);
		return {
			...model,
			readerScroll: clamp(to, 0, Math.max(0, readerLines - readerHeight)),
		};
	}
	const rail = model.focus === "rail";
	const rows = rail ? model.rail.length : model.visible.length;
	const index = Math.max(0, rail ? model.railCursor : indexOfSelected(model));
	const { listHeight: height } = model.viewport;
	if (action.kind === "jump" && action.to === "centre") {
		return {
			...model,
			listTop: clamp(index - (height >> 1), 0, Math.max(0, rows - height)),
		};
	}
	const view = rail ? { top: 0, height: rows } : { top: model.listTop, height };
	const to = listTarget(action, index, rows, view) ?? index;
	return rail
		? { ...model, railCursor: clamp(to, 0, rows - 1) }
		: select(model, to);
}

const ORDER: readonly Focus[] = ["rail", "list", "reader"];

export function moveFocus(model: Model, step: 1 | -1): Model {
	const focus =
		ORDER[clamp(ORDER.indexOf(model.focus) + step, 0, ORDER.length - 1)] ??
		model.focus;
	const hidden =
		(focus === "reader" && model.selectedId === null) ||
		(focus === "rail" && !model.viewport.railDrawn);
	return hidden ? model : { ...model, focus };
}

export function jumpTo(model: Model, id: string | undefined): Model {
	const index = model.visible.findIndex((row) => row.id === id);
	return index < 0 ? { ...model, notice: "noMatch" } : select(model, index);
}

export function openRailEntry(model: Model): Result {
	const entry = model.rail[model.railCursor];
	if (entry === undefined) return { model, effects: [] };
	const filter: Filter = {
		...model.filter,
		agentId: entry.kind === "agent" ? entry.id : null,
		groupId: entry.kind === "group" ? entry.id : null,
	};
	const next = refresh(
		{ ...model, filter, focus: "list", follow: true },
		model.rows,
	);
	return {
		model: next,
		effects: [
			{ type: "readFilter", agentId: filter.agentId, groupId: filter.groupId },
		],
	};
}

export function searchEdit(model: Model, input: SearchInput): Model {
	const search = editSearch(model.search, input, model.visible);
	const next = { ...model, search };
	if (input.kind !== "searchRun" || !model.search.editing) return next;
	if (search.query === "") return next;
	return search.matches.length === 0
		? { ...next, notice: "noMatch" }
		: jumpTo(next, search.matches[0]);
}
