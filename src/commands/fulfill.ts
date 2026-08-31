// `rine fulfill <message-id>` (payee): settle a RECEIVED in-thread
// `rine.v1.x402_payment` and reply with a `rine.v1.x402_receipt` so the payer's
// thread reaches a terminal state. Decrypts the signed payment, verifies then
// settles it via the configured facilitator (plain external HTTP — never rine),
// and sends the receipt in the SAME conversation. Settle-first: on an invalid
// verification, settlement is skipped and a `success:false` receipt is sent so
// the payer still reaches `payment-failed`.
//
// The payee NEVER trusts the payer-echoed `pp.accepted`. It binds the
// payment to the ONE quote it answers — the signed `extensions[quoteMessageId]`
// ref — loads THAT payee-issued quote by id and reconciles against it. A payment
// with no/forged/cross-conversation ref fails CLOSED (no settle, no receipt)
// unless explicit operator expected-terms authorise an out-of-band quote. ALL of
// that (ref-load, reconcile, verify, settle) lives in rine-core's shared
// `payee-settle` module (`resolvePayeeRequirement`/`settleToReceipt`); this
// command is a thin adapter that wires the message plane to it. The payee signs
// nothing (it holds no payer wallet); it only needs its E2EE keys to decrypt the
// payment and its own self-sealed quote, and to encrypt the receipt. The receipt
// build, encrypt + in-thread reply live in rine-core's shared `sendReceipt`; only
// the CLI-specific terminal rendering lives in `x402-receipt.ts`.

import {
	type FacilitatorConfig,
	type MessageRead,
	type PaymentPayload,
	type ResolvedPayeeRequirement,
	X402Error,
	X402FacilitatorError,
	X402_ERROR,
	X402_MESSAGE_TYPE,
	agentKeysExist,
	decryptMessage,
	parseFacilitatorHeaders,
	parseX402Payload,
	refusalReceiptBody,
	requireAuthenticPlaintext,
	resolveFacilitatorConfig,
	resolvePayeeRequirement,
	sendReceipt,
	settleToReceipt,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printError, printJson } from "../output.js";
import { reportFulfill } from "../x402-receipt.js";

function collectHeader(v: string, acc: string[]): string[] {
	acc.push(v);
	return acc;
}

export function registerFulfill(program: Command): void {
	program
		.command("fulfill")
		.description(
			"Settle a received x402_payment via the facilitator and reply with an x402_receipt. " +
				"The payment is bound to the ONE payee-issued x402_payment_required quote it " +
				"references (the signed quoteMessageId) and reconciled against THAT quote " +
				"(payTo/amount/asset/network/scheme) — the payer's echoed terms are never trusted. " +
				"A payment carrying no/forged/cross-conversation quote reference REFUSES to settle " +
				"(fail closed) unless explicit expected terms " +
				"(--pay-to/--expect-amount/--expect-asset/--expect-network) authorise an " +
				"out-of-band quote.",
		)
		.argument("<message-id>", "ID of the received rine.v1.x402_payment")
		.addOption(actorOption(
			"which agent is acting, as payee (name, handle, or agent ID)",
		))
		.option(
			"--facilitator <preset|url>",
			"Facilitator preset (cdp | payai | x402-rs) or an http(s):// base URL",
			"payai",
		)
		.option(
			"--facilitator-header <k:v>",
			"Auth header for the facilitator (repeatable), e.g. 'Authorization: Bearer …'",
			collectHeader,
			[] as string[],
		)
		.option("--verify-path <path>", "Override the facilitator /verify path")
		.option("--settle-path <path>", "Override the facilitator /settle path")
		.option(
			"--pay-to <address>",
			"Out-of-band quote: expected payee wallet (0x). Requires --expect-amount/--expect-asset/--expect-network; overrides the referenced quote (no quoteMessageId needed)",
		)
		.option(
			"--expect-amount <major>",
			"Out-of-band quote: expected amount in MAJOR units (e.g. 1.00). Overpayment is accepted, underpayment refused",
		)
		.option(
			"--expect-asset <address>",
			"Out-of-band quote: expected token contract (0x)",
		)
		.option(
			"--expect-network <caip2>",
			"Out-of-band quote: expected CAIP-2 network (e.g. eip155:8453)",
		)
		.option("--no-marker", "Omit the cleartext status marker (fully sealed)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, actingAgent },
					messageId: string,
					opts: {
						agent?: string;
						facilitator: string;
						facilitatorHeader: string[];
						verifyPath?: string;
						settlePath?: string;
						payTo?: string;
						expectAmount?: string;
						expectAsset?: string;
						expectNetwork?: string;
						marker?: boolean;
					},
				) => {
					// Resolved BEFORE the fetch (see `ActorLadder.actingAgent`).
					const payeeAgentId = await actingAgent();

					const message = (await client.get(
						`/messages/${messageId}`,
					)) as MessageRead;

					if (message.type !== X402_MESSAGE_TYPE.PAYMENT) {
						printError(
							`Message ${messageId} is '${message.type}', not ${X402_MESSAGE_TYPE.PAYMENT}. Nothing to fulfill.`,
						);
						process.exitCode = 2;
						return;
					}

					// The payer (who receives the receipt) is the payment's sender; the
					// payee (this agent, who decrypts + settles) is its recipient.
					const payerAgentId = message.from_agent_id;
					if (!payerAgentId) {
						printError("Cannot fulfill: the payment has no resolvable sender.");
						process.exitCode = 1;
						return;
					}
					if (payeeAgentId === payerAgentId) {
						printError("Cannot fulfill your own payment.");
						process.exitCode = 1;
						return;
					}
					// A payment is sealed to the ONE agent it was addressed to.
					// Settling as a sibling cannot work — and without this the first
					// symptom is `decryptMessage` failing to open an envelope it has
					// no key for, which reads as broken crypto rather than the wrong
					// agent. Name the addressee, and do it before the facilitator is
					// reached and before any receipt is threaded.
					if (message.to_agent_id && message.to_agent_id !== payeeAgentId) {
						printError(
							`Payment ${messageId} is addressed to agent ${message.to_agent_id}, not ${payeeAgentId}. ` +
								"Fulfill as that agent (--agent) — only the addressee holds the key that opens it.",
						);
						process.exitCode = 1;
						return;
					}
					if (!agentKeysExist(configDir, payeeAgentId)) {
						printError(
							`No E2EE keys for agent ${payeeAgentId}. Run 'rine keys generate' first.`,
						);
						process.exitCode = 1;
						return;
					}

					let facilitator: FacilitatorConfig;
					try {
						facilitator = resolveFacilitatorConfig(opts.facilitator, {
							headers: parseFacilitatorHeaders(opts.facilitatorHeader),
							verifyPath: opts.verifyPath,
							settlePath: opts.settlePath,
						});
					} catch (err) {
						printError(err instanceof Error ? err.message : String(err));
						process.exitCode = 2;
						return;
					}

					// Decrypt the signed payment → verbatim x402 PaymentPayload object. The
					// envelope's signature is checked against the payer the server
					// authenticated as the payment's sender.
					const decrypted = await decryptMessage(
						configDir,
						payeeAgentId,
						message.encrypted_payload,
						client,
						payerAgentId,
					);
					// A payment is only the payer's word when the payer signed it, and a
					// structurally malformed one (no `accepted` / no signed authorization)
					// cannot be acted on either. Both are typed, catchable refusals —
					// thread a graceful payment-failed receipt so the payer reaches a
					// terminal state, never a stack trace.
					let pp: PaymentPayload;
					try {
						pp = parseX402Payload(
							message.type,
							requireAuthenticPlaintext(decrypted, payerAgentId, messageId),
						) as PaymentPayload;
					} catch (err) {
						if (!(err instanceof X402Error)) throw err;
						const resealed = err.code === X402_ERROR.INAUTHENTIC_SENDER;
						const sent = await sendReceipt({
							client,
							configDir,
							payeeAgentId,
							payerAgentId,
							messageId,
							receiptBody: refusalReceiptBody("", "", err.code),
							emitMarker: opts.marker !== false,
						});
						printError(
							resealed
								? `Refusing to settle: ${err.message}`
								: `Malformed payment payload: ${err.message}`,
						);
						if (gOpts.json)
							printJson({
								status: resealed ? "payment-refused" : "malformed-payload",
								code: err.code,
								detail: err.message,
								receipt_id: sent.id,
							});
						process.exitCode = 1;
						return;
					}

					// Bind the payment to the ONE payee-issued quote it references
					// (or explicit operator expected terms) and forward the RETURNED
					// payee-owned requirement — never the payer-echoed `pp.accepted` — to
					// the facilitator. A missing/forged/cross-conversation ref (or no
					// override) ⇒ REFUSE: settle nothing and thread no receipt, so a
					// malicious payer can never coax a settlement out of terms it authored.
					let resolved: ResolvedPayeeRequirement;
					try {
						resolved = await resolvePayeeRequirement({
							payment: pp,
							expected: {
								payTo: opts.payTo,
								expectAmount: opts.expectAmount,
								expectAsset: opts.expectAsset,
								expectNetwork: opts.expectNetwork,
							},
							client,
							configDir,
							payeeAgentId,
							conversationId: message.conversation_id,
						});
					} catch (err) {
						if (!(err instanceof X402Error)) throw err;
						// Fail-closed means "no settle" — never "no receipt". Thread a
						// graceful payment-failed receipt (parity with the malformed-payload
						// branch and both SDK payees) so the payer still reaches a terminal
						// state. `network`/`payer` are echoed for provenance only — no funds
						// move and the facilitator was never contacted.
						const sent = await sendReceipt({
							client,
							configDir,
							payeeAgentId,
							payerAgentId,
							messageId,
							receiptBody: refusalReceiptBody(
								pp.accepted.network,
								pp.payload.authorization.from,
								err.code,
							),
							emitMarker: opts.marker !== false,
						});
						printError(`Refusing to settle: ${err.message}`);
						if (gOpts.json)
							printJson({
								status: "payment-refused",
								code: err.code,
								detail: err.message,
								receipt_id: sent.id,
							});
						process.exitCode = 1;
						return;
					}

					// verify → (if valid) settle → receipt body. A facilitator HTTP
					// failure is a typed outcome, not a stack trace: no receipt is sent
					// and the payer's thread stays open for a retry.
					let outcome: Awaited<ReturnType<typeof settleToReceipt>>;
					try {
						outcome = await settleToReceipt(pp, resolved, facilitator);
					} catch (err) {
						if (err instanceof X402FacilitatorError) {
							printError(
								`Facilitator error${
									err.status ? ` (${err.status})` : ""
								}: ${err.message}`,
							);
							if (gOpts.json)
								printJson({
									status: "facilitator-error",
									facilitator_status: err.status ?? null,
									detail: err.message,
								});
							process.exitCode = 1;
							return;
						}
						throw err;
					}

					const sent = await sendReceipt({
						client,
						configDir,
						payeeAgentId,
						payerAgentId,
						messageId,
						receiptBody: outcome.receiptBody,
						emitMarker: opts.marker !== false,
					});
					reportFulfill(Boolean(gOpts.json), outcome, sent);
					// exit 0 only when the payee actually got paid; a sent failure
					// receipt (verification/settlement failure) is a non-zero result.
					if (outcome.status !== "settled") process.exitCode = 1;
				},
			),
		);
}
