// Terminal-result rendering for `rine fulfill`. Turns the pure
// verify→settle outcome (from rine-core's shared `settleToReceipt`) into either a
// machine JSON payload or a human table. The in-thread `rine.v1.x402_receipt`
// reply itself is built + encrypted + sent by rine-core's shared `sendReceipt`;
// this file owns ONLY the CLI-specific rendering, so nothing here is reshaped.

import {
	type FulfillReceipt,
	type MessageRead,
	matchedQuoteToWire,
} from "@rine-network/core";
import { printJson, printTable } from "./output.js";

/**
 * Render the terminal fulfill outcome — JSON (machine) or a human table. The typed
 * `status` (`settled` / `settlement-failed` / `verification-failed`) is authoritative;
 * `sent` is the receipt message the payer will read. The `matchedQuote` (the
 * payee-issued quote the payment answered — `message_id` `null` for an operator
 * override) is surfaced so an integration can bind the good it delivers to the
 * quote that was actually reconciled + settled.
 */
export function reportFulfill(
	json: boolean,
	outcome: FulfillReceipt,
	sent: MessageRead,
): void {
	const { status, receiptBody, matchedQuote } = outcome;
	if (json) {
		printJson({
			status,
			receipt_id: sent.id,
			conversation_id: sent.conversation_id,
			success: receiptBody.success,
			transaction: receiptBody.transaction || null,
			network: receiptBody.network,
			payer: receiptBody.payer,
			matched_quote: matchedQuoteToWire(matchedQuote),
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
		{
			Field: "Quote",
			Value: matchedQuote.quoteMessageId ?? "(operator override)",
		},
		{
			Field: "Quote amount",
			Value: `${matchedQuote.amount} ${matchedQuote.asset}`,
		},
	]);
}
