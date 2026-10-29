/**
 * How `rine stream` renders one SSE `message` event: a single preview line,
 * decrypted when this agent can open it, plus at most one stderr notice.
 */

import {
	type HttpClient,
	SENDER_KEY_UNAVAILABLE_PREVIEW,
	type SenderKeyExplainer,
	ENCRYPTION_VERSION_HYBRID_V2,
	type SenderKeyUnavailableError,
	agentKeysExist,
	asSenderKeyUnavailable,
	decryptGroupMessageWithRecovery,
	decryptMessage,
	ingestSenderKeyDistribution,
	isAuthenticityFailure,
	isDecryptableVersion,
	isGroupEncryptionVersion,
} from "@rine-network/core";
import { a2aCleartextPreview } from "./stream-cleartext.js";

interface MessageData {
	/** The row's own id — what `rine message read` takes, on the one line that offers it. */
	id?: string;
	created_at?: string;
	sender_handle?: string;
	from_agent_id?: string;
	group_handle?: string;
	group_id?: string;
	type?: string;
	encrypted_payload?: string;
	encryption_version?: string;
}

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

/** Never rejects: an event it cannot render becomes a truncated `[message]` line. */
export async function formatMessageLine(
	dataStr: string,
	agentId: string,
	configDir: string,
	client: HttpClient,
	explain: SenderKeyExplainer,
): Promise<StreamLine> {
	try {
		const data = JSON.parse(dataStr) as MessageData;
		const ts = (data.created_at ?? "").slice(0, 19) || "?";
		const sender = data.sender_handle ?? String(data.from_agent_id ?? "?");
		const msgType = data.type ?? "?";
		const target = data.group_handle
			? `${data.group_handle} (${msgType})`
			: msgType;

		const cleartext = a2aCleartextPreview(data);
		let preview = cleartext ?? "[encrypted]";
		let notice: string | null = null;
		// The envelope's claim of authorship is checked against the sender the
		// server authenticated on the event. An event without one carries nothing
		// to check it against, so its payload is left sealed.
		const fromAgentId = data.from_agent_id;
		if (
			cleartext === null &&
			data.encrypted_payload &&
			fromAgentId &&
			agentKeysExist(configDir, agentId)
		) {
			let result: Awaited<ReturnType<typeof decryptMessage>> | undefined;
			// Set when the one-shot recovery has had its turn and the sender key
			// still is not here — the one decrypt failure this preview can explain,
			// and it carries the sentence the paragraph is made of.
			let unavailable: SenderKeyUnavailableError | null = null;

			// Group ciphertext: the group decrypt dispatches on the version byte
			// (sender-key vs MLS) and self-heals MLS state internally (welcomes +
			// epoch sync), so the sender-key ingest retry is the only recovery this
			// path asks for — and core owns that one.
			if (isGroupEncryptionVersion(data.encryption_version) && data.group_id) {
				try {
					// The ingest-and-retry is core's, not a third copy of it here: both
					// ways it can end — the scan found nothing, or it found keys but not
					// this one — come back as the one refusal, and `[decrypt failed]`
					// names neither the cause nor the thing that fixes it.
					result = await decryptGroupMessageWithRecovery(
						client,
						configDir,
						agentId,
						data.group_id,
						data.encrypted_payload,
						fromAgentId,
						data.created_at,
					);
				} catch (err) {
					// Any other failure stays the generic line.
					unavailable = asSenderKeyUnavailable(err, data.group_id);
				}
			} else if (data.encryption_version === ENCRYPTION_VERSION_HYBRID_V2) {
				try {
					result = await decryptMessage(
						configDir,
						agentId,
						data.encrypted_payload,
						client,
						fromAgentId,
						agentId,
						data.created_at,
					);
				} catch {
					/* decrypt failed */
				}
			}

			if (result && isAuthenticityFailure(result.verificationStatus)) {
				// Tampered bytes, or content signed by someone other than the sender
				// the server authenticated: never previewed under that sender's name.
				preview =
					result.verificationStatus === "sender-mismatch"
						? "[\u2717 sender mismatch]"
						: "[\u2717 invalid signature]";
			} else if (result?.plaintext !== undefined) {
				ingestSenderKeyDistribution(
					configDir,
					agentId,
					data.type ?? "",
					result,
				);
				const verified = result.verified ? "\u2713" : "?";
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
			} else if (isDecryptableVersion(data.encryption_version)) {
				// A version this preview attempts that still failed reads
				// "[decrypt failed]", not the "[encrypted]" kept for versions it never
				// attempts. A group message whose sender key never arrived says more
				// (the branch above); nothing here knows enough about any other
				// failure to say anything truer.
				preview = "[decrypt failed]";
			}
		}

		return { line: `[${ts}] ${sender} \u2192 ${target}: ${preview}`, notice };
	} catch {
		return { line: `[message] ${dataStr.slice(0, 80)}`, notice: null };
	}
}
