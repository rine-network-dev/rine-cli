/** The alert record `tail` sends to its sink before it exits, and the exit codes it exits with. */
export const TailExit = {
	Auth: 3,
	Chain: 4,
	Fork: 5,
	Silenced: 6,
	Stalled: 7,
	Truncated: 8,
	SinkDown: 9,
} as const;
export type TailExit = (typeof TailExit)[keyof typeof TailExit];

/** Why a collector stopped, or warned (`pruned_unread` does not stop it). */
export const AlertReason = {
	AuthRefused: "auth_refused",
	ChainGap: "chain_gap",
	ChainHash: "chain_hash",
	Fork: "fork",
	Silenced: "silenced",
	HeadInvalid: "head_invalid",
	NoHeadRoute: "no_head_route",
	Withheld: "withheld",
	Stalled: "stalled",
	Truncated: "truncated",
	PrunedUnread: "pruned_unread",
	/** Never sent: the sink is the thing that failed. */
	SinkDown: "sink_down",
} as const;
export type AlertReason = (typeof AlertReason)[keyof typeof AlertReason];

export const ALERT_SCHEMA = "rine.collector_alert.v1";

/** A range of sequence numbers, both ends included. */
export interface SeqRange {
	from: number;
	to: number;
}

/** What a loop concluded: the message for stderr, the exit code and the alert's members. */
export interface TailStop {
	code: TailExit;
	reason: AlertReason;
	text: string;
	/** Members beyond the common ones: `fork_after_seq`, `old_epoch`, `new_epoch`, `range`. */
	extra?: Record<string, unknown>;
}

export interface AlertRecord extends Record<string, unknown> {
	schema: typeof ALERT_SCHEMA;
	reason: AlertReason;
	/** Null for a warning that does not stop the collector. */
	exit_code: TailExit | null;
	message: string;
	org_id: string | undefined;
	time: string;
}

/** The record for a stop, or (code null) for a warning. `range` in `extra` is null when empty. */
export function alertRecord(
	stop: Omit<TailStop, "code"> & { code: TailExit | null },
	orgId: string | undefined,
	now: Date = new Date(),
): AlertRecord {
	return {
		schema: ALERT_SCHEMA,
		reason: stop.reason,
		exit_code: stop.code,
		message: stop.text,
		org_id: orgId,
		time: now.toISOString(),
		...stop.extra,
	};
}

export type SendAlert = (record: AlertRecord) => Promise<void>;
