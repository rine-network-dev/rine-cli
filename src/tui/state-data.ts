/** The reducer's data half: the loaded rows, the filter over them, the rail built from them, and search. */
import { Glyph, type VerdictGlyph } from "./feed-schema.js";
import type { Action } from "./keymap-table.js";

export type DirectionFilter = "all" | "sent" | "received" | "internal";

export const DIRECTION_CYCLE: readonly DirectionFilter[] = [
	"all",
	"sent",
	"received",
	"internal",
];

export interface PartyRef {
	readonly id: string;
	readonly label: string;
}

/** What the reducer needs of a row; the view-model's `RowView` satisfies it. Newest first by `createdAtMicros`, then `id`. */
export interface ListRow {
	readonly id: string;
	readonly createdAtMicros: number;
	readonly direction: RowDirection;
	/** The org's own agents among the row's parties. */
	readonly agents: readonly PartyRef[];
	readonly group: PartyRef | null;
	readonly verdict: VerdictGlyph;
	/** Lower-cased text the `/` search matches against. */
	readonly searchText: string;
}

/** A row's direction: the filter members a row can carry. */
export type RowDirection = Exclude<DirectionFilter, "all">;

export interface Filter {
	readonly direction: DirectionFilter;
	readonly agentId: string | null;
	readonly groupId: string | null;
}

export const NO_FILTER: Filter = {
	direction: "all",
	agentId: null,
	groupId: null,
};

export type RailEntry =
	| { readonly kind: "all"; readonly count: number }
	| {
			readonly kind: "agent";
			readonly id: string;
			readonly label: string;
			readonly count: number;
	  }
	| {
			readonly kind: "group";
			readonly id: string;
			readonly label: string;
			readonly count: number;
	  };

/** Ids order by UTF-16 code unit, so the same rows sort the same under any locale. */
const compareIds = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0;

const newestFirst = (a: ListRow, b: ListRow): number =>
	b.createdAtMicros - a.createdAtMicros || compareIds(b.id, a.id);

/** The most rows held at once; past it the oldest drop, so a long session on a busy org stays bounded. */
export const MAX_LOADED_ROWS = 5000;

/** Incoming rows replace loaded rows with the same id (a gap that now opens, a new equivocation flag). */
export function mergeRows(
	loaded: readonly ListRow[],
	incoming: readonly ListRow[],
): ListRow[] {
	const byId = new Map(loaded.map((row) => [row.id, row]));
	for (const row of incoming) byId.set(row.id, row);
	return [...byId.values()].sort(newestFirst).slice(0, MAX_LOADED_ROWS);
}

export function visibleRows(
	rows: readonly ListRow[],
	filter: Filter,
): ListRow[] {
	return rows.filter(
		(row) =>
			(filter.direction === "all" || row.direction === filter.direction) &&
			(filter.agentId === null ||
				row.agents.some((agent) => agent.id === filter.agentId)) &&
			(filter.groupId === null || row.group?.id === filter.groupId),
	);
}

/** All messages, then agents, then groups, from the loaded rows only. */
export function railEntries(rows: readonly ListRow[]): RailEntry[] {
	const agents = new Map<string, { label: string; count: number }>();
	const groups = new Map<string, { label: string; count: number }>();
	const bump = (into: typeof agents, party: PartyRef): void => {
		const entry = into.get(party.id) ?? { label: party.label, count: 0 };
		entry.count += 1;
		into.set(party.id, entry);
	};
	for (const row of rows) {
		for (const agent of new Map(row.agents.map((a) => [a.id, a])).values())
			bump(agents, agent);
		if (row.group !== null) bump(groups, row.group);
	}
	const sorted = <K extends "agent" | "group">(kind: K, from: typeof agents) =>
		[...from]
			.sort(([, a], [, b]) => a.label.localeCompare(b.label))
			.map(([id, { label, count }]) => ({ kind, id, label, count }));
	return [
		{ kind: "all", count: rows.length },
		...sorted("agent", agents),
		...sorted("group", groups),
	];
}

/** The handle a loaded row gave the group, or null when only its id is known (the rail then labels it by id). */
export function groupHandle(
	rail: readonly RailEntry[],
	groupId: string,
): string | null {
	for (const entry of rail)
		if (entry.kind === "group" && entry.id === groupId)
			return entry.label === groupId ? null : entry.label;
	return null;
}

/** Ids of the rows whose text contains the query, case-insensitively, in list order. */
export function searchMatches(
	rows: readonly ListRow[],
	query: string,
): string[] {
	const needle = query.toLowerCase();
	return needle === ""
		? []
		: rows
				.filter((row) => row.searchText.includes(needle))
				.map((row) => row.id);
}

export interface Search {
	readonly editing: boolean;
	readonly draft: string;
	readonly query: string;
	readonly matches: readonly string[];
	readonly at: number;
}

export const IDLE_SEARCH: Search = {
	editing: false,
	draft: "",
	query: "",
	matches: [],
	at: 0,
};

export type SearchInput = Extract<
	Action,
	{ kind: "searchInput" | "searchBackspace" | "searchRun" | "searchCancel" }
>;

/** One keystroke of the `/` prompt; `searchRun` turns the draft into the query and its matches. */
export function editSearch(
	search: Search,
	input: SearchInput,
	rows: readonly ListRow[],
): Search {
	if (!search.editing) return search;
	switch (input.kind) {
		case "searchInput":
			return { ...search, draft: search.draft + input.text };
		case "searchBackspace":
			return { ...search, draft: [...search.draft].slice(0, -1).join("") };
		case "searchCancel":
			return { ...search, editing: false, draft: "" };
		case "searchRun":
			return {
				editing: false,
				draft: "",
				query: search.draft,
				matches: searchMatches(rows, search.draft),
				at: 0,
			};
	}
}

/** Index of the next gap or unverified row after `from` in the direction `step` (1 or -1), or -1. */
export function nextMarked(
	rows: readonly ListRow[],
	from: number,
	step: 1 | -1,
): number {
	for (let i = from + step; i >= 0 && i < rows.length; i += step) {
		if (rows[i]?.verdict !== Glyph.Verified) return i;
	}
	return -1;
}
