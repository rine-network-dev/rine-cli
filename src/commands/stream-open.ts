/**
 * Opens one SSE `message` event for `rine stream`: parses it, decrypts it when
 * this agent can, and says whether the row has settled. Both output modes call
 * this, so a row is opened once and `--json` stdout stays the raw event.
 */

import {
	type HttpClient,
	type MessageDecryptResult,
	type SenderKeyUnavailableError,
	type VerificationStatus,
	ENCRYPTION_VERSION_HYBRID_V2,
	agentKeysExist,
	asSenderKeyUnavailable,
	decryptGroupMessageWithRecovery,
	decryptMessage,
	groupAuthenticityStatus,
	ingestSenderKeyDistribution,
	isAuthenticityFailure,
	isGroupEncryptionVersion,
	isSettledRow,
} from "@rine-network/core";
import { a2aCleartextPreview } from "./stream-cleartext.js";

export interface MessageData {
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

export interface OpenedStreamMessage {
	readonly data: MessageData;
	/** The A2A cleartext preview, or null for every other row. */
	readonly cleartext: string | null;
	/** Whether a decrypt was in reach: a sealed payload, its sender, and local keys. */
	readonly attempted: boolean;
	/** What the decrypt returned, or undefined when none was attempted or it threw. */
	readonly result: MessageDecryptResult | undefined;
	/** The verdict of a forged group row: the group decrypt throws it, so no `result` carries it. */
	readonly forgedStatus: VerificationStatus | undefined;
	/**
	 * Set when the one-shot recovery has had its turn and the sender key still is
	 * not here — the one decrypt failure the preview can explain.
	 */
	readonly unavailable: SenderKeyUnavailableError | null;
}

/**
 * Parse and decrypt one event. Throws on a frame that is not JSON; the callers
 * treat that as "no verdict". A cleartext row whose body does not decode is
 * still a row: it has no preview, and it settles through the `none` rule, as
 * the SDK settles it.
 */
export async function openStreamMessage(
	dataStr: string,
	agentId: string,
	configDir: string,
	client: HttpClient,
): Promise<OpenedStreamMessage> {
	const data = JSON.parse(dataStr) as MessageData;
	let cleartext: string | null = null;
	let undecodable = false;
	try {
		cleartext = a2aCleartextPreview(data);
	} catch {
		undecodable = true;
	}
	let result: MessageDecryptResult | undefined;
	let unavailable: SenderKeyUnavailableError | null = null;
	let forgedStatus: VerificationStatus | undefined;

	// The envelope's claim of authorship is checked against the sender the server
	// authenticated on the event. An event without one carries nothing to check it
	// against, so its payload is left sealed.
	const fromAgentId = data.from_agent_id;
	const attempted = Boolean(
		!undecodable &&
			cleartext === null &&
			data.encrypted_payload &&
			fromAgentId &&
			agentKeysExist(configDir, agentId),
	);
	if (attempted && data.encrypted_payload && fromAgentId) {
		// Group ciphertext: the group decrypt dispatches on the version byte
		// (sender-key vs MLS) and self-heals MLS state internally (welcomes +
		// epoch sync), so the sender-key ingest retry is the only recovery this
		// path asks for — and core owns that one.
		if (isGroupEncryptionVersion(data.encryption_version) && data.group_id) {
			try {
				// The ingest-and-retry is core's, not a third copy of it here: both
				// ways it can end — the scan found nothing, or it found keys but not
				// this one — come back as the one refusal.
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
				// A refused author is a verdict, not a missing key; any other failure
				// stays the generic line.
				forgedStatus = groupAuthenticityStatus(err) ?? undefined;
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
		if (result && !isAuthenticityFailure(result.verificationStatus) && result.plaintext !== undefined) {
			ingestSenderKeyDistribution(configDir, agentId, data.type ?? "", result);
		}
	}
	return { data, cleartext, attempted, result, forgedStatus, unavailable };
}

/**
 * Whether the row has settled, so that acknowledging it loses nothing: it
 * opened, it was never ciphertext, or its author was refused. A frame this
 * agent has no keys for, or could not open yet, stays new.
 */
export function isSettledMessage(opened: OpenedStreamMessage): boolean {
	const { data, result, forgedStatus } = opened;
	return isSettledRow(
		{
			encryption_version: data.encryption_version ?? "",
			verification_status: result?.verificationStatus ?? forgedStatus,
		},
		result?.plaintext !== undefined,
	);
}
