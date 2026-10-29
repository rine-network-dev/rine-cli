/** What the poller reports, in the terms the reducer and the renderer take. */
import type { ReadMessage } from "@rine-network/core";
import type { DataEvent } from "./data-types.js";
import { FeedErrorCode, PageKind } from "./feed-schema.js";
import { type ListRow, mergeRows } from "./state-data.js";
import type { Connection, Msg, Viewport } from "./state-model.js";
import { type RowView, noteHandles, rowView } from "./view-model.js";

/**
 * The connection the view shows for a failed read; `retryS` is null only when the server refused
 * the key.
 */
export function connectionFor(
	code: FeedErrorCode,
	retryS: number | null,
	host: string,
): Connection {
	const wait = retryS ?? 0;
	switch (code) {
		case FeedErrorCode.AuthRefused:
		case FeedErrorCode.NeedsOrgKey:
		case FeedErrorCode.NoIdentity:
			return { kind: "blocked", code };
		case FeedErrorCode.RateLimited:
			return { kind: "paused", seconds: wait };
		case FeedErrorCode.Network:
			return { kind: "network", host, retryS: wait };
		case FeedErrorCode.Server:
		case FeedErrorCode.MalformedPage:
			return { kind: "failing", code, retryS: wait };
	}
}

export const sameViewport = (a: Viewport, b: Viewport): boolean =>
	a.listHeight === b.listHeight &&
	a.readerHeight === b.readerHeight &&
	a.readerLines === b.readerLines &&
	a.railDrawn === b.railDrawn;

export interface RowBridge {
	/** The poller's `emit`. */
	readonly onPoll: (event: DataEvent) => void;
	readonly viewOf: (row: ListRow) => RowView | undefined;
	/**
	 * The org's slug, once known: agents of this org show bare. Rows already loaded are relabelled from the
	 * messages kept, with no read.
	 */
	setOwnSlug(slug: string | null): void;
	/** The cursor of the page before the oldest one loaded, or null. */
	olderCursor(): string | null;
	/**
	 * The next initial page is a rail filter's slice: merge it, so the rail keeps listing the whole
	 * org.
	 */
	expectFilter(): void;
	/** The next initial page replaces what is loaded. */
	expectReplace(): void;
}

/**
 * Turns the poller's events into reducer messages and keeps the row views the renderer looks up by
 * id.
 */
export function rowBridge(
	dispatch: (msg: Msg) => void,
	connection: () => Connection["kind"],
	pollS: number,
	host: string,
	onArrive: (ids: readonly string[]) => void = () => undefined,
): RowBridge {
	const views = new Map<string, RowView>();
	const raw = new Map<string, ReadMessage>();
	const handles = new Map<string, string>();
	let loaded: readonly ListRow[] = [];
	let older: string | null = null;
	let merge = false;
	let ownSlug: string | null = null;
	return {
		onPoll(event) {
			switch (event.type) {
				case "rows": {
					const reset = event.kind === PageKind.Initial && !merge;
					if (event.kind === PageKind.Initial) merge = false;
					if (reset) {
						views.clear();
						raw.clear();
					}
					for (const message of event.rows) noteHandles(handles, message, ownSlug);
					const rows = event.rows.map((message) =>
						rowView(message, handles, ownSlug),
					);
					if (event.kind === PageKind.Poll) onArrive(rows.map((row) => row.id));
					for (const view of rows) views.set(view.id, view);
					for (const message of event.rows) raw.set(message.row.id, message);
					loaded = mergeRows(reset ? [] : loaded, rows);
					if (views.size > loaded.length) {
						const kept = new Set(loaded.map((row) => row.id));
						for (const id of views.keys())
							if (!kept.has(id)) {
								views.delete(id);
								raw.delete(id);
							}
					}
					dispatch({ type: reset ? "reset" : "rows", rows });
					break;
				}
				case "finding":
					dispatch({ type: "finding", finding: event.finding });
					break;
				case "page":
					if (event.kind !== PageKind.Poll) older = event.olderCursor;
					if (connection() !== "live")
						dispatch({
							type: "connection",
							connection: { kind: "live", pollS },
						});
					break;
				case "error":
					dispatch({
						type: "connection",
						connection: connectionFor(event.code, event.retryS, host),
					});
					break;
			}
		},
		viewOf: (row) => views.get(row.id),
		setOwnSlug(slug) {
			ownSlug = slug;
			if (raw.size === 0) return;
			handles.clear();
			for (const message of raw.values()) noteHandles(handles, message, ownSlug);
			const rows = [...raw.values()].map((message) =>
				rowView(message, handles, ownSlug),
			);
			for (const view of rows) views.set(view.id, view);
			loaded = mergeRows(loaded, rows);
			dispatch({ type: "rows", rows });
		},
		olderCursor: () => older,
		expectFilter() {
			merge = true;
		},
		expectReplace() {
			merge = false;
		},
	};
}
