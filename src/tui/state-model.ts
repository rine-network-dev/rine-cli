/** The TUI model and the messages and effects around its reducer (see state.ts). */
import type { ReadFinding } from "@rine-network/core";
import type { BlockedCode, FeedErrorCode } from "./feed-schema.js";
import type { Action } from "./keymap-table.js";
import type { OrgIdentity } from "./org-identity.js";
import {
	type Filter,
	IDLE_SEARCH,
	type ListRow,
	NO_FILTER,
	type RailEntry,
	type Search,
	railEntries,
} from "./state-data.js";

export type Connection =
	| { readonly kind: "loading" }
	| { readonly kind: "blocked"; readonly code: BlockedCode }
	| { readonly kind: "live"; readonly pollS: number }
	| {
			readonly kind: "failing";
			readonly code:
				| typeof FeedErrorCode.Server
				| typeof FeedErrorCode.MalformedPage;
			readonly retryS: number;
	  }
	| { readonly kind: "paused"; readonly seconds: number }
	| {
			readonly kind: "network";
			readonly host: string;
			readonly retryS: number;
	  };

export interface Viewport {
	readonly listHeight: number;
	readonly readerHeight: number;
	/** Wrapped body lines of the selected row, as the reader draws them. */
	readonly readerLines: number;
	/** Whether the layout draws the rail pane; only the wide tier does. */
	readonly railDrawn: boolean;
}

export type Msg =
	| { readonly type: "rows" | "reset"; readonly rows: readonly ListRow[] }
	| { readonly type: "finding"; readonly finding: ReadFinding }
	| { readonly type: "connection"; readonly connection: Connection }
	| { readonly type: "org"; readonly org: OrgIdentity | null }
	| { readonly type: "viewport"; readonly viewport: Viewport }
	| { readonly type: "action"; readonly action: Action };

export type Effect =
	| { readonly type: "loadOlder" | "reread" | "quit" | "redraw" | "suspend" }
	| {
			readonly type: "readFilter";
			readonly agentId: string | null;
			readonly groupId: string | null;
	  };

export type Focus = "rail" | "list" | "reader";
export type Notice = "noMatch" | "noMarked";

export interface Model {
	readonly rows: readonly ListRow[];
	readonly visible: readonly ListRow[];
	readonly rail: readonly RailEntry[];
	readonly filter: Filter;
	readonly focus: Focus;
	readonly railCursor: number;
	readonly selectedId: string | null;
	readonly listTop: number;
	readonly readerScroll: number;
	readonly viewport: Viewport;
	readonly overlay: "none" | "help" | "findings";
	/** Newest first. */
	readonly findings: readonly ReadFinding[];
	/** The first finding the findings overlay shows. */
	readonly findingsTop: number;
	readonly search: Search;
	readonly follow: boolean;
	readonly wrap: boolean;
	readonly connection: Connection;
	/** The org being read, from `GET /whoami`; null until it answers or when it cannot. */
	readonly org: OrgIdentity | null;
	readonly notice: Notice | null;
}

export interface Result {
	readonly model: Model;
	readonly effects: readonly Effect[];
}

export const initialModel: Model = {
	rows: [],
	visible: [],
	rail: railEntries([]),
	filter: NO_FILTER,
	focus: "list",
	railCursor: 0,
	selectedId: null,
	listTop: 0,
	readerScroll: 0,
	viewport: { listHeight: 1, readerHeight: 1, readerLines: 0, railDrawn: true },
	overlay: "none",
	findings: [],
	findingsTop: 0,
	search: IDLE_SEARCH,
	follow: true,
	wrap: false,
	connection: { kind: "loading" },
	org: null,
	notice: null,
};
