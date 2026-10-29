/**
 * `rine tui --feed`: the poller's events as NDJSON lines for the Claude Code plugin. A row carries
 * its display fields (scrubbed and clipped by the view-model) and never `message.text`, so a
 * consumer cannot draw an unscrubbed string. stdout is the feed alone; stderr gets an error's name
 * and code at most.
 */
import { type ReadMessage, gapToJson, messageToJson } from "@rine-network/core";
import { type Handles, errorSentence, gapSentence } from "./copy.js";
import { Poller } from "./data.js";
import type { DataEvent } from "./data-types.js";
import {
	FEED_VERSION,
	FeedErrorCode,
	FeedEvent,
	FeedExit,
} from "./feed-schema.js";
import { type FeedProc, startLifecycle } from "./feed-lifecycle.js";
import { IdentityKind, type IdentityResult } from "./identity.js";
import { rowLabels } from "./labels.js";
import { loadOrg } from "./org-identity.js";
import { fatalLine } from "./term.js";
import { noteHandles, rowView } from "./view-model.js";

export interface FeedOptions {
	readonly agent: string | null;
	readonly group: string | null;
	readonly pollS: number;
	readonly once: boolean;
	readonly before: string | null;
	/** The server's host, named in a network error's sentence. */
	readonly host: string;
}

export interface FeedDeps {
	readonly identity: IdentityResult;
	/** One complete NDJSON line, newline included. */
	readonly write: (line: string) => void;
	readonly writeError: (text: string) => void;
	readonly proc?: FeedProc;
	/** Milliseconds. */
	readonly now?: () => number;
}

/** The `row` event: the message without its text, the display fields, and what the clip removed. */
function rowData(
	seq: number,
	message: ReadMessage,
	handles: Handles,
	ownSlug: string | null,
): Record<string, unknown> {
	const view = rowView(message, handles);
	const labels = rowLabels(message.row, ownSlug);
	const { text: _withheld, ...wire } = messageToJson(message);
	return {
		seq,
		message: wire,
		display: {
			glyph: view.verdict,
			verification_label: view.verdictLabel,
			gap_sentence: view.gapSentence,
			snippet: view.snippet,
			body: view.body,
			from_short: view.fromShort,
			to_short: view.toShort,
			from_label: labels.from,
			to_label: labels.to,
			group_label: labels.group,
		},
		hidden_chars: view.hiddenChars,
		text_truncated: view.textTruncated,
	};
}

/**
 * Runs the feed until the parent goes away, a signal, a refusal, or (with `once`) the first read.
 */
export async function runFeed(
	options: FeedOptions,
	deps: FeedDeps,
): Promise<FeedExit> {
	const { identity, write, writeError } = deps;
	const now = deps.now ?? Date.now;
	const proc: FeedProc = deps.proc ?? process;
	const handles = new Map<string, string>();
	const send = (event: FeedEvent, data: Record<string, unknown>): void =>
		write(`${JSON.stringify({ event, data: { v: FEED_VERSION, ...data } })}\n`);
	const sendError = (code: FeedErrorCode, retryS: number | null): void =>
		send(FeedEvent.Error, {
			code,
			sentence: errorSentence(code, { host: options.host, retryS }),
			retry_s: retryS,
		});
	if (identity.kind !== IdentityKind.Reader) {
		sendError(identity.code, null);
		return FeedExit.NoIdentity;
	}
	const { key, reader, bucket } = identity;
	const org = await loadOrg(reader);
	send(FeedEvent.Hello, {
		principal: "org",
		org_id: key.orgId,
		org,
		poll_s: options.pollS,
	});

	return new Promise<FeedExit>((resolve) => {
		let seq = 0;
		let pausedUntil = 0;
		let failure: FeedExit | null = null;
		let done = false;
		let detach: () => void = () => undefined;
		const stop = (code: FeedExit): void => {
			if (done) return;
			done = true;
			detach();
			void poller
				.stop()
				.then(() => reader.close())
				.catch(() => undefined)
				.finally(() => resolve(code));
		};
		const crash = (err: unknown): void => {
			writeError(fatalLine(err));
			stop(FeedExit.Failed);
		};
		const emit = (event: DataEvent): void => {
			if (done) return;
			switch (event.type) {
				case "rows":
					for (const message of event.rows) {
						noteHandles(handles, message, org?.slug ?? null);
						send(FeedEvent.Row, rowData(++seq, message, handles, org?.slug ?? null));
					}
					break;
				case "finding":
					send(FeedEvent.Finding, {
						group_id: event.finding.groupId,
						gap: gapToJson(event.finding.gap),
						sentence: gapSentence(event.finding.gap, handles),
					});
					break;
				case "page":
					pausedUntil = 0;
					send(FeedEvent.Page, {
						kind: event.kind,
						count: event.count,
						older_cursor: event.olderCursor,
					});
					break;
				case "error":
					if (
						event.code === FeedErrorCode.RateLimited &&
						event.retryS !== null
					) {
						pausedUntil = now() + event.retryS * 1000;
					}
					sendError(event.code, event.retryS);
					failure =
						event.code === FeedErrorCode.AuthRefused
							? FeedExit.Refused
							: FeedExit.Failed;
					if (event.retryS === null) stop(failure);
					break;
			}
		};
		const poller = new Poller({
			reader,
			bucket,
			emit,
			now,
			pollS: options.pollS,
			filter: { agentId: options.agent, groupId: options.group },
		});

		detach = startLifecycle(proc, {
			onStop: () => stop(FeedExit.Clean),
			onCrash: crash,
			onHeartbeat: () => {
				const left = pausedUntil - now();
				send(FeedEvent.Heartbeat, {
					at: new Date(now()).toISOString(),
					next_poll_s: options.pollS,
					paused_s: left > 0 ? Math.ceil(left / 1000) : null,
				});
			},
		});

		if (options.once) poller.setFollow(false);
		const first =
			options.before === null ? poller.start() : poller.older(options.before);
		first.then(() => {
			if (options.once) stop(failure ?? FeedExit.Clean);
		}, crash);
	});
}
