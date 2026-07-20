// Receipt message-plane helper for `rine fulfill` (REQ-M04). Turns the pure
// verify→settle outcome (from `settleToReceipt`) into an in-thread
// `rine.v1.x402_receipt` reply and renders the terminal result. Kept separate from
// the `fulfill` command so that command layer only does argument parsing +
// facilitator resolution; the settle ladder itself lives in `x402-facilitator.ts`.
//
// The payee holds no payer wallet — it only needs its own E2EE keys to encrypt the
// receipt. The settlement's `network` is the facilitator's verbatim v1 slug, echoed
// through unchanged (NEVER CAIP-2 string-matched). rine-core owns the receipt build
// + marker logic; nothing is reshaped here.

import {
	type HttpClient,
	type MessageRead,
	buildReceiptMessage,
	encryptMessage,
	fetchRecipientKeys,
} from "@rine-network/core";
import { printJson, printTable } from "./output.js";
import type { FulfillReceipt } from "./x402-facilitator.js";

/**
 * Build the `x402_receipt` message from the settlement body, HPKE-encrypt it to the
 * PAYER (the payment's original sender), and reply in-thread as the payee. Returns
 * the sent message. `emitMarker` toggles the cleartext `{status,rail}` marker.
 */
export async function sendReceipt(params: {
	client: HttpClient;
	configDir: string;
	payeeAgentId: string;
	payerAgentId: string;
	messageId: string;
	receiptBody: FulfillReceipt["receiptBody"];
	emitMarker: boolean;
}): Promise<MessageRead> {
	const built = buildReceiptMessage(params.receiptBody, {
		emitMarker: params.emitMarker,
	});
	const recipientKeys = await fetchRecipientKeys(
		params.client,
		params.payerAgentId,
	);
	const encrypted = await encryptMessage(
		params.configDir,
		params.payeeAgentId,
		recipientKeys.encryption,
		built.payload,
		recipientKeys.pqEncryption,
	);
	const body: Record<string, unknown> = {
		type: built.type,
		content_type: built.content_type,
		payload_schema: built.payload_schema,
		...encrypted,
	};
	if (built.metadata) body.metadata = built.metadata;
	return (await params.client.post(
		`/messages/${params.messageId}/reply`,
		body,
		{ "X-Rine-Agent": params.payeeAgentId },
	)) as MessageRead;
}

/**
 * Render the terminal fulfill outcome — JSON (machine) or a human table. The typed
 * `status` (`settled` / `settlement-failed` / `verification-failed`) is authoritative;
 * `sent` is the receipt message the payer will read.
 */
export function reportFulfill(
	json: boolean,
	outcome: FulfillReceipt,
	sent: MessageRead,
): void {
	const { status, receiptBody } = outcome;
	if (json) {
		printJson({
			status,
			receipt_id: sent.id,
			conversation_id: sent.conversation_id,
			success: receiptBody.success,
			transaction: receiptBody.transaction || null,
			network: receiptBody.network,
			payer: receiptBody.payer,
		});
		return;
	}
	printTable([
		{ Field: "Outcome", Value: status },
		{ Field: "Receipt sent", Value: sent.id },
		{ Field: "Conversation", Value: sent.conversation_id },
		{ Field: "Settled", Value: String(receiptBody.success) },
		{ Field: "Transaction", Value: receiptBody.transaction || "—" },
		{ Field: "Network", Value: receiptBody.network },
	]);
}
