import {
	a2aCleartextMark,
	a2aCleartextPlaintext,
	isA2aCleartext,
	withA2aCleartextNotice,
} from "@rine-network/core";

/** The row fields the cleartext preview reads off a streamed message event. */
interface CleartextRow {
	type?: string;
	encryption_version?: string;
	encrypted_payload?: string;
}

/**
 * The preview for a message that arrived as A2A cleartext, or null for every
 * other row.
 *
 * A cleartext body is readable without any key, so it is shown like any other
 * unverified line — the `?` mark, the same one every unverified preview uses —
 * led by the notice that says the body was never end-to-end encrypted. A
 * payload that does not decode throws, and the caller's own catch renders the
 * generic line.
 */
export function a2aCleartextPreview(data: CleartextRow): string | null {
	const row = {
		type: data.type ?? "",
		encryption_version: data.encryption_version ?? "",
	};
	if (!isA2aCleartext(row)) return null;
	if (typeof data.encrypted_payload !== "string" || data.encrypted_payload === "") {
		return null;
	}
	const text = a2aCleartextPlaintext({
		encrypted_payload: data.encrypted_payload,
	}).slice(0, 60);
	return `[?] ${withA2aCleartextNotice(row, text)}`;
}

/**
 * One `--json` stream line: the event envelope unchanged, plus — for a
 * message event whose data is an A2A cleartext row — the
 * typed flag and the sentence for it, after `data`.
 *
 * The mark comes from core's own helper, so the key names and the sentence are
 * never spelled out a second time here. Data that does not parse is not a row
 * this can say anything about, and is carried unchanged.
 */
export function messageEventLine(
	event: string | undefined,
	id: string | undefined,
	data: string,
): string {
	return JSON.stringify({
		event,
		id,
		data,
		...(event === "message" ? a2aCleartextMark(parseRow(data)) : null),
	});
}

/** The row a message event carries, or one that is no cleartext row at all. */
function parseRow(data: string): { type: string; encryption_version?: string } {
	try {
		const parsed: unknown = JSON.parse(data);
		return typeof parsed === "object" && parsed !== null
			? (parsed as { type: string; encryption_version?: string })
			: { type: "" };
	} catch {
		return { type: "" };
	}
}
