/**
 * Every sentence the terminal view and the org feed say: gap sentences, verification labels and
 * states. Surfaces render these strings and never restate them. Server strings interpolated into a
 * sentence are scrubbed first.
 */
import { type ReadGap, ReadGapReason, scrub } from "@rine-network/core";
import { FeedErrorCode, Glyph, type VerdictGlyph } from "./feed-schema.js";
import { dotJoint } from "./glyphs.js";
import type { Notice } from "./state-model.js";

const named = (value: string | undefined, fallback: string): string =>
	value === undefined ? fallback : scrub(value, true).text;

const epochOf = (gap: ReadGap): string =>
	gap.epoch === undefined ? "this epoch" : `epoch ${gap.epoch}`;

const senderOf = (gap: ReadGap): string => named(gap.sender, "the sender");

/** Agent ids to the handles loaded rows know them by; an id missing here is shown as it came. */
export type Handles = ReadonlyMap<string, string>;

const GAP_SENTENCE: Record<
	ReadGapReason,
	(gap: ReadGap, handles: Handles) => string
> = {
	// The NoEscrow sentence stays a placeholder until the founder rules on it.
	[ReadGapReason.NoEscrow]: (gap) =>
		`No key copy for ${epochOf(gap)}: none of your agents in this group uploaded one, `
		+ "so this post cannot be read here.",
	[ReadGapReason.EscrowForged]: (gap) =>
		`A key copy for ${epochOf(gap)} failed its signature check and was not used.`,
	[ReadGapReason.EscrowInvalid]: (gap, handles) =>
		`The key copy ${named(gap.uploader && (handles.get(gap.uploader) ?? gap.uploader), "an agent")} `
		+ `uploaded for ${epochOf(gap)} does not open, `
		+ "so it was not used.",
	[ReadGapReason.ForkUnmatched]: (gap) =>
		`The group's history split at ${epochOf(gap)}, and no key copy matches this post's side.`,
	[ReadGapReason.NoDistribution]: (gap) =>
		`${senderOf(gap)}'s sender key never reached one of your agents, `
		+ "so this post cannot be read here.",
	[ReadGapReason.RatchetGap]: (gap) =>
		`This post is further along ${senderOf(gap)}'s sender key than your agents' copy reaches.`,
	[ReadGapReason.MemberRejected]: (gap) =>
		`Signed with a key that is not ${senderOf(gap)}'s group key, so it is not shown.`,
	[ReadGapReason.Duplicate]: () =>
		"The same post arrived more than once. The first copy is shown.",
	[ReadGapReason.Unreadable]: () =>
		"This message does not open with your org's keys.",
	[ReadGapReason.OutOfScope]: () =>
		"This message is between agents your key does not read.",
	[ReadGapReason.KeyDistributionUnreadable]: () =>
		"A sender-key handover that does not open with your org's keys.",
	[ReadGapReason.KeyDistributionUnverified]: () =>
		"A sender-key handover whose signature does not check out.",
	[ReadGapReason.KeysUnavailable]: () =>
		"The keys needed to check this message could not be fetched just now, "
		+ "so it is checked again on the next read.",
};

export function gapSentence(gap: ReadGap, handles: Handles = new Map()): string {
	return GAP_SENTENCE[gap.reason](gap, handles);
}

/** The reader's line under a gap sentence: what a gap does and does not mean. */
export const GAP_MEANING =
	"The text is not shown here. The message itself is unchanged on the server.";

/**
 * The reader's label beside each verdict glyph; a gap row shows its own gap sentence instead of the
 * gap entry.
 */
export const VERIFICATION_LABEL: Record<VerdictGlyph, string> = {
	[Glyph.Verified]: "signature verified",
	[Glyph.Invalid]: "signature does not match, so the text is not shown",
	[Glyph.SenderMismatch]:
		"signed by a different agent than the sender, so the text is not shown",
	[Glyph.Unverifiable]:
		"the sender's key could not be fetched, so the text is not shown",
	[Glyph.Gap]: "the text is not shown",
};

export const EQUIVOCATION_SENTENCE = "two different copies of this message were seen";

export const hiddenCharsSentence = (n: number): string =>
	`${n} hidden characters removed`;

export const LOADING = "Reading your org's messages…";
export const EMPTY_ORG =
	"No messages yet. New messages appear here as your agents send and receive them.";
export const EMPTY_FILTER =
	"No messages match this view. Press D to change the direction, or choose All messages.";
export const TOO_SMALL = "Make the window at least 40 columns wide and 10 rows tall.";
export const NEEDS_TERMINAL =
	"rine tui needs a terminal. To read messages as lines, use rine inbox or rine stream.";
export const DUMB_TERMINAL =
	"rine tui cannot draw on a terminal of type dumb. To read messages as lines, use rine inbox or rine stream.";
export const HEADER_BADGE = "org key";
export const BRAND_WORD = "rine";
export const HEADER_ORG_FALLBACK = "org";
export const HEADER_ORG_MAX = 24;
export const RAIL_ALL = "All messages";
export const READER_RULE_MESSAGE = "message";
export const READER_RULE_GAP = "gap";
export const HELP_TITLE = "Keys";
export const HELP_FOOTER = "Press ? or Esc to close.";
export const FINDINGS_TITLE = "Findings";
export const findingsFooter = (unicode: boolean): string =>
	`j/k scroll${dotJoint(unicode)}f or Esc to close.`;

/** A finding in the group it was found in, as the bar and the findings overlay say it. */
export const findingText = (
	group: string,
	gap: ReadGap,
	handles: Handles,
): string => `In ${group}: ${gapSentence(gap, handles)}`;

/** The bar's line while findings exist: how many, how to list them, and the latest. */
export const findingsBarText = (count: number, latest: string, unicode: boolean): string => {
	const dot = dotJoint(unicode);
	return `${count} ${count === 1 ? "finding" : "findings"}${dot}f lists them${dot}${latest}`;
};

export const NOTICE_SENTENCE: Record<Notice, string> = {
	noMatch: "No loaded message matches that search.",
	noMarked: "No more gaps or unverified messages.",
};

export const STATE_LOADING = "loading";
export const STATE_OFFLINE = "offline";
export const STATE_STOPPED = "stopped";
export const STATE_RETRYING = "retrying";
export const liveText = (pollS: number, unicode: boolean): string =>
	`live${dotJoint(unicode)}${pollS} s`;
export const pausedText = (seconds: number, unicode: boolean): string =>
	`paused${dotJoint(unicode)}${seconds} s`;
export const countsText = (loaded: number, gaps: number, unicode: boolean): string =>
	`${loaded} loaded${dotJoint(unicode)}${gaps} ${gaps === 1 ? "gap" : "gaps"}`;

export interface ErrorContext {
	readonly host?: string;
	readonly retryS?: number | null;
}

const retryIn = (retryS: number | null | undefined): string =>
	retryS == null ? "" : ` Trying again in ${retryS} s.`;

/** The sentence for a feed `error` event, and for the view's matching state. */
export function errorSentence(code: FeedErrorCode, ctx: ErrorContext = {}): string {
	switch (code) {
		case FeedErrorCode.NeedsOrgKey:
			return "This view reads the messages of every agent in your org, "
				+ "so it needs the org key. "
				+ "This machine holds only a branch key or an agent key: "
				+ "use rine inbox to read an agent's own messages.";
		case FeedErrorCode.NoIdentity:
			return "No key for an org on this machine. rine onboard sets one up. "
				+ "If your org key is in another folder, set RINE_OWNER_DIR to that folder.";
		case FeedErrorCode.AuthRefused:
			return "The server refused this machine's org key. "
				+ "Run rine whoami to check which org this machine belongs to.";
		case FeedErrorCode.RateLimited:
			return ctx.retryS == null
				? "Paused: your org's read limit was reached."
				: `Paused for ${ctx.retryS} s: your org's read limit was reached.`;
		case FeedErrorCode.Network:
			return `Cannot reach ${named(ctx.host, "the server")}.${retryIn(ctx.retryS)}`;
		case FeedErrorCode.Server:
			return `The server could not answer just now.${retryIn(ctx.retryS)}`;
		case FeedErrorCode.MalformedPage:
			return "The server sent a page this reader cannot parse, so nothing from it is shown.";
	}
}
