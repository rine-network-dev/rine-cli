/**
 * Open one fetched message with the caller's own keys, and — when it stays
 * closed — say why in one sentence a reader can act on.
 *
 * Split out of `messages-read.ts` (file-size budget) so that command is left
 * with its rendering. This is the SINGLE tier of the explain-once rule: the
 * caller named ONE message, so the refusal is stated in full. There is no
 * second row for it to repeat itself on, and nothing here creates a
 * `senderKeyExplainer`.
 *
 * A refusal is returned rather than printed, because the same fact has to reach
 * two different outputs: stderr prose for a human, and a field on the `--json`
 * envelope for a program. A helper that printed could only serve one of them.
 */

import {
	type HttpClient,
	type MessageRead,
	MLS_ERR_GROUP_INACTIVE,
	SENDER_KEY_UNAVAILABLE_CODE,
	asSenderKeyUnavailable,
	cliSyncRemedy,
	decryptGroupMessageWithRecovery,
	decryptMessage,
	formatError,
	isGroupEncryptionVersion,
	isRecoverableMlsRead,
	mlsReadRefusal,
	mlsErrorCode,
} from "@rine-network/core";
import { mlsFailureText } from "./group-mls-failure.js";

type DecryptResult = Awaited<ReturnType<typeof decryptMessage>>;

/**
 * Why a message could not be opened.
 *
 * `message` is the sentence for a reader. `code` is the machine-readable cause,
 * set only where this read reached a NAMED verdict — today, a sender key that
 * was still missing after the one-shot recovery ran. Every other failure leaves
 * it null, so a consumer reads "no code" as "no claim about the cause". It is
 * the same value, spelled the same way, that the TS and Python SDKs put on
 * `decrypt_error_code`.
 */
export interface DecryptRefusal {
	readonly message: string;
	readonly code: typeof SENDER_KEY_UNAVAILABLE_CODE | null;
}

export interface OpenedMessage {
	readonly result?: DecryptResult;
	readonly refusal: DecryptRefusal | null;
}

/** Decrypt one message, dispatching on its encryption version. Never throws. */
export async function openMessage(opts: {
	client: HttpClient;
	configDir: string;
	agentId: string;
	data: MessageRead;
	fromAgentId: string;
}): Promise<OpenedMessage> {
	const { client, configDir, agentId, data, fromAgentId } = opts;
	const isGroup =
		isGroupEncryptionVersion(data.encryption_version) && data.group_id != null;

	if (!isGroup) {
		try {
			return {
				result: await decryptMessage(
					configDir,
					agentId,
					data.encrypted_payload,
					client,
					fromAgentId,
					agentId,
					data.created_at,
				),
				refusal: null,
			};
		} catch (err) {
			return { refusal: refusalFor(err, null) };
		}
	}

	const groupId = data.group_id as string;
	try {
		return {
			// The one-shot ingest-and-retry lives in core, which is where every
			// other surface reaches it from. Written out here it was a third copy
			// of the same control flow, and the copies had already stopped
			// agreeing about what "the retry ran and still missed" means.
			result: await decryptGroupMessageWithRecovery(
				client,
				configDir,
				agentId,
				groupId,
				data.encrypted_payload,
				fromAgentId,
				data.created_at,
			),
			refusal: null,
		};
	} catch (err) {
		// Everything the recovery can end in arrives here, the transport failures
		// of the recovery's own fetch included — which is what makes this
		// function's "never throws" true rather than merely stated.
		return { refusal: refusalFor(err, groupId) };
	}
}

/**
 * Why the message stayed closed, chosen by the failure's machine-readable CODE
 * and never by its words.
 *
 * `groupId` is null for a 1:1 envelope, where no group arm can apply.
 *
 * `rine thread` has degraded correctly since it was written — a recognised
 * cause becomes a rine sentence, an unrecognised one becomes `[unavailable]` —
 * while this path interpolated whatever it caught. What that let through was
 * mls-rs's own KDF error, *the provided length of the key 0 is shorter than the
 * minimum length 32*: the crypto library refusing to derive from an epoch
 * secret this member never held. Same message, same agent, same moment, two
 * renderers, and the raw one was the outlier.
 */
function refusalFor(err: unknown, groupId: string | null): DecryptRefusal {
	if (groupId !== null) {
		const unavailable = asSenderKeyUnavailable(err, groupId);
		if (unavailable !== null) {
			return {
				message: unavailable.message,
				code: SENDER_KEY_UNAVAILABLE_CODE,
			};
		}
		// 🔴 Asked BEFORE the recoverable arm, which answers **true** for an
		// eviction: the core classifies it as an unprocessable commit, and it is
		// one. But no sync undoes a Remove, so offering the remedy below would be
		// a false move — and rine already states this one as a membership fact,
		// in `mlsFailureText`, which is where the words stay.
		if (mlsErrorCode(err) === MLS_ERR_GROUP_INACTIVE) {
			return { message: mlsFailureText(err, groupId), code: null };
		}
		// The core's own classifier for "no key here opens this, and installing
		// Welcomes or syncing commits might change that". It answers false for a
		// self-read cache miss, which forward secrecy has made permanent, and for
		// the three local-process failures — naming a remedy for a store I/O
		// failure would be a lie. Those keep the words they arrived with.
		if (isRecoverableMlsRead(err)) {
			return {
				message: mlsReadRefusal(groupId, cliSyncRemedy(groupId)),
				code: null,
			};
		}
	}
	return { message: `Decryption failed: ${formatError(err)}`, code: null };
}
