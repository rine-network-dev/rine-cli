// Terminal-result rendering for `rine fulfill`. Turns the pure
// verify→settle outcome (from rine-core's shared `settleToReceipt`) into either a
// machine JSON payload or a human table. The in-thread `rine.v1.x402_receipt`
// reply itself is built + encrypted + sent by rine-core's shared `sendReceipt`;
// this file owns ONLY the CLI-specific rendering, so nothing here is reshaped.

import {
	type FulfillReceipt,
	type MessageRead,
	X402Error,
	X402FacilitatorError,
	matchedQuoteToWire,
} from "@rine-network/core";
import { printError, printJson, printTable } from "./output.js";

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

/** The machine `status` of a facilitator outage; a refused sender reports its error code. */
const FACILITATOR_ERROR_STATUS = "facilitator-error";

/**
 * Render a retryable outcome of `rine fulfill`: nothing was settled and no receipt
 * was sent, so the payer's thread stays open and the same payment can be fulfilled
 * again. The typed machine `status` is `facilitator-error` for an outage and the
 * error's own code (`sender-unverifiable`) for a sender check that could not run;
 * the exit code is non-zero either way.
 */
export function reportRetryable(
	json: boolean,
	err: X402FacilitatorError | X402Error,
	extra: Record<string, unknown> = {},
	headline = err.message,
): void {
	const status =
		err instanceof X402FacilitatorError ? FACILITATOR_ERROR_STATUS : err.code;
	printError(headline);
	if (json) printJson({ status, ...extra, detail: err.message });
	process.exitCode = 1;
}
