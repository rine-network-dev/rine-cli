/**
 * The names the org feed and the terminal view agree on: events, error codes, glyphs and exit
 * codes.
 */

/** Every feed event carries this in `data.v`; a consumer refuses a version it does not know. */
export const FEED_VERSION = 1;

export const FeedEvent = {
	Hello: "hello",
	Row: "row",
	Finding: "finding",
	Page: "page",
	Heartbeat: "heartbeat",
	Error: "error",
} as const;
export type FeedEvent = (typeof FeedEvent)[keyof typeof FeedEvent];

export const PageKind = {
	Initial: "initial",
	Poll: "poll",
	Older: "older",
} as const;
export type PageKind = (typeof PageKind)[keyof typeof PageKind];

/**
 * Why the feed or the view cannot show messages; the wire spelling of an `error` event's `code`.
 */
export const FeedErrorCode = {
	NeedsOrgKey: "needs_org_key",
	NoIdentity: "no_identity",
	AuthRefused: "auth_refused",
	RateLimited: "rate_limited",
	Network: "network",
	Server: "server",
	MalformedPage: "malformed_page",
} as const;
export type FeedErrorCode = (typeof FeedErrorCode)[keyof typeof FeedErrorCode];
/**
 * The codes that mean there is no view to show: the machine cannot read, or the server refused the
 * key.
 */
export type BlockedCode =
	| typeof FeedErrorCode.NeedsOrgKey
	| typeof FeedErrorCode.NoIdentity
	| typeof FeedErrorCode.AuthRefused;

/**
 * The glyph a row carries, by name; each surface picks the character for its alphabet. The first
 * five are also the keys of the verification labels; the reducer's row verdict is `VerdictGlyph`.
 */
export const Glyph = {
	Verified: "verified",
	Invalid: "invalid",
	SenderMismatch: "senderMismatch",
	Unverifiable: "unverifiable",
	Gap: "gap",
	Equivocation: "equivocation",
} as const;
export type Glyph = (typeof Glyph)[keyof typeof Glyph];
/** The glyphs that are a row's verdict; equivocation is shown beside it. */
export type VerdictGlyph = Exclude<Glyph, typeof Glyph.Equivocation>;

/**
 * What `rine tui --feed` exits with; the plugin does not restart it on `NoIdentity` or `Refused`.
 */
export const FeedExit = { Clean: 0, Failed: 1, NoIdentity: 3, Refused: 4 } as const;
export type FeedExit = (typeof FeedExit)[keyof typeof FeedExit];

/** What the interactive `rine tui` exits with besides a clean quit. */
export const TuiExit = { Failed: 1, NeedsTerminal: 2 } as const;
export type TuiExit = (typeof TuiExit)[keyof typeof TuiExit];
