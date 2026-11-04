/**
 * How `rine stream` renders one SSE `message` event: a single preview line,
 * decrypted when this agent can open it, plus at most one stderr notice.
 */

import {
	SENDER_KEY_UNAVAILABLE_PREVIEW,
	type SenderKeyExplainer,
	isAuthenticityFailure,
	isDecryptableVersion,
} from "@rine-network/core";
import type { OpenedStreamMessage } from "./stream-open.js";

/**
 * One rendered stream line, plus — at most once per `rine stream` — the
 * paragraph that says why a group message could not be opened.
 *
 * The paragraph does not go IN the line. This stream is line-oriented and
 * consumed by monitors that read one message per line; a ~600-character
 * sentence spliced into a preview corrupts that for every reader of the stream,
 * so it goes beside the line instead, on the channel that is already not the
 * message channel (stderr, via `printError`).
 */
interface StreamLine {
	readonly line: string;
	readonly notice: string | null;
}

/** The one-line preview of a message that has already been opened. */
export function renderOpened(
	{ data, cleartext, attempted, result, forgedStatus, unavailable }: OpenedStreamMessage,
	explain: SenderKeyExplainer,
): StreamLine {
	const ts = (data.created_at ?? "").slice(0, 19) || "?";
	const sender = data.sender_handle ?? String(data.from_agent_id ?? "?");
	const msgType = data.type ?? "?";
	const target = data.group_handle
		? `${data.group_handle} (${msgType})`
		: msgType;

	let preview = cleartext ?? "[encrypted]";
	let notice: string | null = null;
	const verdict = result?.verificationStatus ?? forgedStatus;
	if (verdict && isAuthenticityFailure(verdict)) {
		// Tampered bytes, or content signed by someone other than the sender
		// the server authenticated: never previewed under that sender's name.
		preview =
			verdict === "sender-mismatch"
				? "[✗ sender mismatch]"
				: "[✗ invalid signature]";
	} else if (result?.plaintext !== undefined) {
		const verified = result.verified ? "✓" : "?";
		preview = `[${verified}] ${result.plaintext.slice(0, 60)}`;
	} else if (unavailable !== null) {
		// The line always carries the bounded marker; the explanation, if this
		// stream has not given it yet, rides beside it as its own notice.
		//
		// The marker's whole premise is that the full sentence is one `rine
		// message read` away, and every other MULTI surface hands the operator
		// the id that read needs. Without it, an operator who scrolled past
		// the once-per-stream notice would run `rine message list` and
		// correlate by timestamp to get back to it. The id is this
		// reader's own delivery and discloses nothing the row did not, and the
		// marker stays byte-identical so no one can count distinct keys off a
		// stream.
		preview = data.id
			? `${SENDER_KEY_UNAVAILABLE_PREVIEW} rine message read ${data.id}`
			: SENDER_KEY_UNAVAILABLE_PREVIEW;
		notice = explain(unavailable.message).notice;
	} else if (attempted && isDecryptableVersion(data.encryption_version)) {
		// A version the preview attempts that still failed reads
		// "[decrypt failed]", not the "[encrypted]" kept for versions it never
		// attempts. Nothing here knows enough about any other failure to say
		// anything truer.
		preview = "[decrypt failed]";
	}
	return { line: `[${ts}] ${sender} → ${target}: ${preview}`, notice };
}
