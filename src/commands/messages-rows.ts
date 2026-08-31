/**
 * How a message becomes a table row.
 *
 * Shared by every `rine message` subcommand rather than owned by one of them:
 * `read`, `inbox`, `send`, `reply` and `thread` all render the same identity
 * and verdict columns, and an operator comparing two of them must not be shown
 * two different renderings of the same fact.
 */

import type {
	MessageRead,
	ThreadRowEntry,
	VerificationStatus,
} from "@rine-network/core";
import { isAuthenticityFailure } from "@rine-network/core";

export function msgFrom(m: MessageRead): string {
	return m.sender_handle ?? m.from_agent_id ?? "";
}

export function msgTo(m: MessageRead): string {
	return m.recipient_handle ?? m.to_agent_id ?? "";
}

export function msgGroup(m: MessageRead): string {
	return m.group_handle ?? "";
}

export function sendRow(m: MessageRead): Record<string, unknown> {
	return {
		ID: m.id,
		"Conversation ID": m.conversation_id,
		From: msgFrom(m),
		To: msgTo(m),
		Group: msgGroup(m),
		Type: m.type,
		Created: m.created_at,
	};
}

export function inboxRow(m: MessageRead): Record<string, unknown> {
	return {
		ID: m.id,
		From: msgFrom(m),
		Group: msgGroup(m),
		Type: m.type,
		Status: (m.status ?? "new").toUpperCase(),
		Created: m.created_at,
	};
}

/**
 * Render the sender-signature outcome for a table column. Both authenticity
 * failures are marked, and told apart: tampered bytes and content attributed to
 * an agent that did not sign it are different problems for an operator.
 */
export function verifiedMark(status: VerificationStatus): string {
	if (status === "verified") return "\u2713";
	if (!isAuthenticityFailure(status)) return "?";
	return status === "sender-mismatch"
		? "\u2717 SENDER MISMATCH"
		: "\u2717 INVALID";
}

/** One thread turn rendered as a role-tagged row (`[sent]` you / `[received]`). */
export function threadRow(e: ThreadRowEntry): Record<string, unknown> {
	const who = e.direction === "sent" ? "you" : (e.sender_handle ?? "unknown");
	return {
		Direction: `[${e.direction}]`,
		From: who,
		Type: e.type,
		Verified: verifiedMark(e.verification_status),
		Text: e.text,
		Created: e.created_at,
	};
}
