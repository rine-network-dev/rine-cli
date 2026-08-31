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
	SENDER_KEY_UNAVAILABLE_CODE,
	asSenderKeyUnavailable,
	decryptGroupMessageWithRecovery,
	decryptMessage,
} from "@rine-network/core";

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
		(data.encryption_version === "sender-key-v1" ||
			data.encryption_version === "mls-v1") &&
		data.group_id != null;

	if (!isGroup) {
		try {
			return {
				result: await decryptMessage(
					configDir,
					agentId,
					data.encrypted_payload,
					client,
					fromAgentId,
				),
				refusal: null,
			};
		} catch (err) {
			return { refusal: { message: `Decryption failed: ${text(err)}`, code: null } };
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
			),
			refusal: null,
		};
	} catch (err) {
		// Everything the recovery can end in arrives here, the transport failures
		// of the recovery's own fetch included — which is what makes this
		// function's "never throws" true rather than merely stated.
		const unavailable = asSenderKeyUnavailable(err, groupId);
		if (unavailable !== null) {
			return {
				refusal: {
					message: unavailable.message,
					code: SENDER_KEY_UNAVAILABLE_CODE,
				},
			};
		}
		return {
			refusal: { message: `Decryption failed: ${text(err)}`, code: null },
		};
	}
}

function text(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
