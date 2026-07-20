// REQ-M04 (payee) — `rine fulfill <message-id>`: settle a RECEIVED in-thread
// `rine.v1.x402_payment` and reply with a `rine.v1.x402_receipt` so the payer's
// thread reaches a terminal state. Decrypts the signed payment, verifies then
// settles it via the configured facilitator (plain external HTTP — never rine),
// and sends the receipt in the SAME conversation. Settle-first: on an invalid
// verification, settlement is skipped and a `success:false` receipt is sent so
// the payer still reaches `payment-failed`.
//
// ALL verify/settle logic lives in rine-core (`verifyPayment`/`settlePayment`,
// via `settleToReceipt`) — this command is a thin adapter that wires the message
// plane to it. The payee signs nothing (it holds no payer wallet); it only needs
// its E2EE keys to decrypt the payment and encrypt the receipt. The receipt build,
// encrypt + in-thread reply, and result rendering live in `x402-receipt.ts`.

import {
	type FacilitatorConfig,
	type MessageRead,
	type PaymentPayload,
	X402FacilitatorError,
	X402_MESSAGE_TYPE,
	agentKeysExist,
	decryptMessage,
	fetchAgents,
	parseX402Payload,
	resolveAgent,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printError, printJson } from "../output.js";
import { resolveFacilitator, settleToReceipt } from "../x402-facilitator.js";
import { reportFulfill, sendReceipt } from "../x402-receipt.js";

function collectHeader(v: string, acc: string[]): string[] {
	acc.push(v);
	return acc;
}

export function registerFulfill(program: Command): void {
	program
		.command("fulfill")
		.description(
			"Settle a received x402_payment via the facilitator and reply with an x402_receipt",
		)
		.argument("<message-id>", "ID of the received rine.v1.x402_payment")
		.option("--agent <id>", "Payee agent ID (defaults to your agent)")
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
		.option("--no-marker", "Omit the cleartext status marker (fully sealed)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, apiUrl },
					messageId: string,
					opts: {
						agent?: string;
						facilitator: string;
						facilitatorHeader: string[];
						verifyPath?: string;
						settlePath?: string;
						marker?: boolean;
					},
				) => {
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
					const agents = await fetchAgents(client);
					const payeeAgentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);
					if (payeeAgentId === payerAgentId) {
						printError("Cannot fulfill your own payment.");
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
						facilitator = resolveFacilitator(opts.facilitator, {
							headers: opts.facilitatorHeader,
							verifyPath: opts.verifyPath,
							settlePath: opts.settlePath,
						});
					} catch (err) {
						printError(err instanceof Error ? err.message : String(err));
						process.exitCode = 2;
						return;
					}

					// Decrypt the signed payment → verbatim x402 PaymentPayload object.
					const decrypted = await decryptMessage(
						configDir,
						payeeAgentId,
						message.encrypted_payload,
						client,
					);
					const pp = parseX402Payload(
						message.type,
						decrypted.plaintext,
					) as PaymentPayload;

					// verify → (if valid) settle → receipt body. A facilitator HTTP
					// failure is a typed outcome, not a stack trace: no receipt is sent
					// and the payer's thread stays open for a retry.
					let outcome: Awaited<ReturnType<typeof settleToReceipt>>;
					try {
						outcome = await settleToReceipt(pp, facilitator);
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
