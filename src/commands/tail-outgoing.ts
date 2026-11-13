/** What a collector hands a sink: a record verbatim, plus the fields a receiver indexes it by. */
import {
	type MessageMetadata,
	type OrgEvent,
	SignalClass,
	signalClass,
} from "@rine-network/core";
import type { AlertRecord } from "./tail-alert.js";

export const Severity = { Info: "INFO", Warn: "WARN", Error: "ERROR" } as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const Sourcetype = {
	Event: "rine:org_event",
	Metadata: "rine:org_metadata",
	Alert: "rine:collector:alert",
} as const;
export type Sourcetype = (typeof Sourcetype)[keyof typeof Sourcetype];

/** The members a receiver indexes; `seq` and `chain_epoch` are absent from an alert. */
export interface IndexedFields {
	org_id: string | undefined;
	chain_epoch?: number;
	seq?: number;
	kind: string;
	signal: SignalClass;
}

export interface Outgoing {
	/** The envelope, row or alert record, unchanged. */
	body: Record<string, unknown>;
	sourcetype: Sourcetype;
	severity: Severity;
	/** When it happened, ISO 8601; undefined takes the receiver's clock. */
	time: string | undefined;
	fields: IndexedFields;
}

const severityOf = (signal: SignalClass): Severity =>
	signal === SignalClass.Alert ? Severity.Warn : Severity.Info;

export function eventOutgoing(event: OrgEvent): Outgoing {
	const kind = String(event.kind);
	const signal = signalClass(kind, event.detail);
	return {
		body: event,
		sourcetype: Sourcetype.Event,
		severity: severityOf(signal),
		time: typeof event.occurred_at === "string" ? event.occurred_at : undefined,
		fields: {
			org_id: typeof event.org_id === "string" ? event.org_id : undefined,
			chain_epoch: Number(event.chain_epoch),
			seq: event.seq,
			kind,
			signal,
		},
	};
}

export function metadataOutgoing(
	row: MessageMetadata,
	orgId: string | undefined,
): Outgoing {
	return {
		body: row as unknown as Record<string, unknown>,
		sourcetype: Sourcetype.Metadata,
		severity: Severity.Info,
		time: row.created_at,
		fields: {
			org_id: orgId,
			chain_epoch: row.chain_epoch,
			seq: row.seq,
			kind: "message.metadata",
			signal: SignalClass.Record,
		},
	};
}

export function alertOutgoing(record: AlertRecord): Outgoing {
	return {
		body: record,
		sourcetype: Sourcetype.Alert,
		severity: Severity.Error,
		time: record.time,
		fields: {
			org_id: record.org_id,
			kind: record.reason,
			signal: SignalClass.Alert,
		},
	};
}
