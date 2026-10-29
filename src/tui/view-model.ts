/**
 * A read message becomes a row view: everything a surface draws, with every server string scrubbed.
 * The body is made in a fixed order: parse the decrypted JSON, format it, scrub the result, then
 * clip it, so a JSON escape that decodes to a control is removed after decoding.
 */
import { type ReadMessage, displayHandle, safeBlock } from "@rine-network/core";
import { clean } from "./clean.js";
import {
	EQUIVOCATION_SENTENCE,
	type Handles,
	VERIFICATION_LABEL,
	gapSentence,
} from "./copy.js";
import { Glyph, type VerdictGlyph } from "./feed-schema.js";
import { type GlyphName, glyph } from "./glyphs.js";
import { partyLabel, rawHandles, rowLabels } from "./labels.js";
import type { ListRow, PartyRef } from "./state-data.js";
import { Role } from "./style.js";

export const BODY_MAX_CHARS = 65_536;
export const SNIPPET_MAX_CHARS = 200;
const SHORT_ID_CHARS = 8;

const GLYPH_MARKS: Record<Glyph, { readonly name: GlyphName; readonly role: Role }> = {
	[Glyph.Verified]: { name: "verified", role: Role.Ok },
	[Glyph.Invalid]: { name: "invalid", role: Role.Bad },
	[Glyph.SenderMismatch]: { name: "invalid", role: Role.Bad },
	[Glyph.Unverifiable]: { name: "unverifiable", role: Role.Warn },
	[Glyph.Gap]: { name: "gap", role: Role.Warn },
	[Glyph.Equivocation]: { name: "equivocation", role: Role.Info },
};

/** The character and colour role of a verdict for the terminal's alphabet. */
export function glyphMark(verdict: Glyph, unicode: boolean): { text: string; role: Role } {
	const mark = GLYPH_MARKS[verdict];
	return { text: glyph(mark.name, unicode), role: mark.role };
}

export const SnippetKind = { Text: "text", Gap: "gap", Verdict: "verdict" } as const;
export type SnippetKind = (typeof SnippetKind)[keyof typeof SnippetKind];

/** Everything a surface draws for one message. */
export interface RowView extends ListRow {
	readonly verdict: VerdictGlyph;
	/** When it was sent, as an ISO timestamp the list turns into its date column. */
	readonly sentAt: string;
	/** Full local timestamp for the reader. */
	readonly when: string;
	readonly kind: "1:1" | "group";
	/** The sender, in the short form against the org's own slug. */
	readonly from: string;
	/** The recipient; null for a group post. */
	readonly to: string | null;
	/** The group's handle; null for a 1:1 message. */
	readonly groupLabel: string | null;
	readonly fromShort: string;
	readonly toShort: string;
	/**
	 * One line, at most 200 characters: the text, the gap sentence, or the reason the text is
	 * withheld.
	 */
	readonly snippet: string;
	/** What the snippet is: the text, a gap's sentence, or the reason the text is withheld. */
	readonly snippetKind: SnippetKind;
	/** The scrubbed, clipped text; null when it is not shown. */
	readonly body: string | null;
	readonly hiddenChars: number;
	readonly textTruncated: number;
	readonly gapSentence: string | null;
	/** The reader's verdict label: the gap sentence for a gap row. */
	readonly verdictLabel: string;
	readonly equivocation: boolean;
	readonly equivocationSentence: string | null;
}

export const shortId = (id: string): string => clean(id).slice(0, SHORT_ID_CHARS);

type Party = ReadMessage["row"]["sender"];

const pad = (n: number): string => String(n).padStart(2, "0");

function localTime(micros: number): Date {
	return new Date(Math.floor(micros / 1000));
}

/**
 * The decrypted payload as display text: a JSON string's value, the `text` field of an object that
 * has no other field, else the payload exactly as sent. JSON is never re-serialised, so a large
 * integer, a key order or a second field cannot change or vanish on its way to an audit view, and a
 * deeply nested payload costs nothing beyond the parse.
 */
export function formatPayload(plaintext: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		// V8's SyntaxError message quotes its input, so the error is dropped unread.
		return plaintext;
	}
	if (typeof parsed === "string") return parsed;
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"text" in parsed &&
		typeof parsed.text === "string" &&
		Object.keys(parsed).length === 1
	) {
		return parsed.text;
	}
	return plaintext;
}

function unreachable(status: never): VerdictGlyph {
	void status;
	return Glyph.Unverifiable;
}

function verdictOf(message: ReadMessage): VerdictGlyph {
	if (message.gap !== null) return Glyph.Gap;
	switch (message.verification) {
		case "verified":
			return Glyph.Verified;
		case "invalid":
			return Glyph.Invalid;
		case "sender-mismatch":
			return Glyph.SenderMismatch;
		case "unverifiable":
			return Glyph.Unverifiable;
		case null:
			// No verdict was recorded: text that was read is verified, anything else cannot be
			// vouched for.
			return message.text === null ? Glyph.Unverifiable : Glyph.Verified;
		default:
			return unreachable(message.verification);
	}
}

const oneLine = (text: string): string =>
	Array.from(text.replace(/\s+/g, " ").trim()).slice(0, SNIPPET_MAX_CHARS).join("");

/** Remembers each handle a row names, as the rows show it, so a sentence can name an agent the same way. */
export function noteHandles(
	handles: Map<string, string>,
	message: ReadMessage,
	ownSlug: string | null,
): void {
	for (const party of [message.row.sender, message.row.recipient])
		if (party?.handle) handles.set(party.agentId, displayHandle(clean(party.handle), ownSlug));
}

export function rowView(
	message: ReadMessage,
	handles?: Handles,
	ownSlug: string | null = null,
): RowView {
	const { row } = message;
	const verdict = verdictOf(message);
	const sentence = message.gap === null ? null : gapSentence(message.gap, handles);
	const shown =
		message.text === null ? null : safeBlock(formatPayload(message.text), BODY_MAX_CHARS);
	const body = shown?.text ?? null;
	const verdictLabel = sentence ?? VERIFICATION_LABEL[verdict];
	const labels = rowLabels(row, ownSlug);
	const group = row.groupId === null ? null : { id: row.groupId, label: labels.group ?? "" };
	const fromShort = shortId(row.sender.agentId);
	const toShort = row.recipient === null ? "" : shortId(row.recipient.agentId);
	const at = localTime(row.createdAtMicros);
	const snippet = oneLine(sentence ?? body ?? verdictLabel);
	const agents: PartyRef[] = [row.sender, ...(row.recipient === null ? [] : [row.recipient])]
		.filter((party) => party.own)
		.map((party) => ({ id: party.agentId, label: partyLabel(party, ownSlug) }));
	return {
		id: row.id,
		createdAtMicros: row.createdAtMicros,
		direction: row.direction,
		agents,
		group,
		verdict,
		searchText: `${labels.from} ${labels.to ?? ""} ${group?.label ?? ""} ${rawHandles(row)} ${snippet}`.toLowerCase(),
		sentAt: at.toISOString(),
		when:
			`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
			`${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
		kind: group === null ? "1:1" : "group",
		from: labels.from,
		to: labels.to,
		groupLabel: labels.group,
		fromShort,
		toShort,
		snippet,
		snippetKind: sentence !== null ? SnippetKind.Gap : body !== null ? SnippetKind.Text : SnippetKind.Verdict,
		body,
		hiddenChars: shown?.hiddenChars ?? 0,
		textTruncated: shown?.truncatedChars ?? 0,
		gapSentence: sentence,
		verdictLabel,
		equivocation: message.equivocation,
		equivocationSentence: message.equivocation ? EQUIVOCATION_SENTENCE : null,
	};
}
