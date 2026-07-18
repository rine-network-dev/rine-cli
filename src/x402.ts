// Shared x402 message-assembly helper (REQ-M02). Thin wrapper over the rine-core
// build layer: given a message `type` + the parsed payload, produce the cleartext
// extras (content_type, payload_schema, optional status marker) to merge into a
// send/reply body. The x402 objects are carried VERBATIM — this never reshapes
// them; rine-core owns the build/parse/marker logic (no reimplementation here).

import {
	type BuiltX402Message,
	type PaymentPayload,
	type PaymentRequired,
	type SettlementResponse,
	X402_MESSAGE_TYPE,
	buildPaymentMessage,
	buildPaymentRequiredMessage,
	buildReceiptMessage,
	isX402MessageType,
	parseX402Payload,
} from "@rine-network/core";

/** The cleartext body fields an x402 message adds beyond `type` + ciphertext. */
export type X402SendExtras = {
	content_type: string;
	payload_schema: string;
	metadata?: BuiltX402Message["metadata"];
};

/**
 * Build the x402 send extras for a `type`/`payload` pair, or `null` when `type`
 * is not one of the three x402 message types (the caller then sends normally).
 * Validates + normalizes the payload through the core parse layer first, so a
 * malformed x402 quote/payment/receipt fails loudly before the encrypt/send.
 */
export function x402SendExtras(
	type: string,
	payload: unknown,
	emitMarker: boolean,
): X402SendExtras | null {
	if (!isX402MessageType(type)) return null;
	const parsed = parseX402Payload(type, JSON.stringify(payload));
	const opts = { emitMarker };
	let built: BuiltX402Message;
	if (type === X402_MESSAGE_TYPE.PAYMENT_REQUIRED) {
		built = buildPaymentRequiredMessage(parsed as PaymentRequired, opts);
	} else if (type === X402_MESSAGE_TYPE.PAYMENT) {
		built = buildPaymentMessage(parsed as PaymentPayload, opts);
	} else {
		built = buildReceiptMessage(parsed as SettlementResponse, opts);
	}
	const extras: X402SendExtras = {
		content_type: built.content_type,
		payload_schema: built.payload_schema,
	};
	if (built.metadata) extras.metadata = built.metadata;
	return extras;
}
