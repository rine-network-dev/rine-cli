/** The poller's inputs and the events it emits. */
import type {
	ActivityQuery,
	ReadFinding,
	ReadMessage,
	ReadPage,
	TokenBucket,
} from "@rine-network/core";
import type { FeedErrorCode, PageKind } from "./feed-schema.js";

/** The part of the org reader the poller needs. */
export interface DataReader {
	read(query: ActivityQuery): Promise<ReadPage>;
}

export interface DataFilter {
	readonly agentId: string | null;
	readonly groupId: string | null;
}

export type DataEvent =
	| {
			readonly type: "rows";
			/** An initial page replaces whatever was loaded before it. */
			readonly kind: PageKind;
			readonly rows: readonly ReadMessage[];
	  }
	| { readonly type: "finding"; readonly finding: ReadFinding }
	| {
			readonly type: "page";
			readonly kind: PageKind;
			readonly count: number;
			readonly olderCursor: string | null;
	  }
	| {
			readonly type: "error";
			readonly code: FeedErrorCode;
			/** Null when the poller has stopped for good. */
			readonly retryS: number | null;
	  };

export interface PollerOptions {
	readonly reader: DataReader;
	readonly emit: (event: DataEvent) => void;
	/** The bucket the reader draws from; a poll is deferred, never dropped, while it is empty. */
	readonly bucket?: Pick<TokenBucket, "msUntilToken">;
	readonly pollS?: number;
	/** Reads the slice of one agent or group from the start. */
	readonly filter?: DataFilter;
	/** Milliseconds. */
	readonly now?: () => number;
}

/** Where the next poll reads from. */
export interface Resume {
	readonly since: string | undefined;
	readonly cursor: string | null;
}

export const NO_FILTER: DataFilter = { agentId: null, groupId: null };
