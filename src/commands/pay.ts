// REQ-M02 — `rine pay <message-id>`: respond to a received in-thread x402
// payment_required by signing an EIP-3009 authorization (wallet + spend policy
// enforced in rine-core) and replying with a `rine.v1.x402_payment` message in
// the SAME conversation. `--auto-pay` proceeds only when the quote is at/below
// the wallet's autoPayThreshold; otherwise the operator must approve by running
// `rine pay` without the flag.
//
// ALL payment logic (requirement selection, policy enforcement, EIP-712 signing,
// spend accounting) lives in rine-core — this command is a thin wrapper that
// decrypts the quote, drives the core select→build→reserve→send sequence, and
// renders the result. It never reimplements crypto or policy. The spend is
// reserved under a cross-process lock as the last act before the reply is sent
// (fail-closed: the debit stands even if the send then fails); `--force` re-pays
// a quote already in today's journal.

import {
	type MessageRead,
	type PaymentRequired,
	X402Error,
	X402_MESSAGE_TYPE,
	agentKeysExist,
	buildPaymentMessage,
	buildPaymentPayload,
	decryptMessage,
	encryptMessage,
	fetchAgents,
	fetchRecipientKeys,
	isAutoPayable,
	loadPolicy,
	loadWalletKey,
	parseX402Payload,
	readDailySpent,
	reserveSpend,
	resolveAgent,
	selectRequirement,
	walletKeyExists,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printError, printJson, printTable } from "../output.js";

export function registerPay(program: Command): void {
	program
		.command("pay")
		.description(
			"Pay an in-thread x402 payment_required (sign + reply with x402_payment)",
		)
		.argument(
			"<message-id>",
			"ID of the received rine.v1.x402_payment_required",
		)
		.option("--agent <id>", "Payer agent ID (defaults to your agent)")
		.option(
			"--auto-pay",
			"Only pay when the quote is at/below the wallet autoPayThreshold",
		)
		.option(
			"--force",
			"Re-pay a quote already paid today (bypasses the once-per-message guard)",
		)
		.option("--no-marker", "Omit the cleartext status marker (fully sealed)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, apiUrl },
					messageId: string,
					opts: {
						agent?: string;
						autoPay?: boolean;
						force?: boolean;
						marker?: boolean;
					},
				) => {
					const message = (await client.get(
						`/messages/${messageId}`,
					)) as MessageRead;

					if (message.type !== X402_MESSAGE_TYPE.PAYMENT_REQUIRED) {
						printError(
							`Message ${messageId} is '${message.type}', not ${X402_MESSAGE_TYPE.PAYMENT_REQUIRED}. Nothing to pay.`,
						);
						process.exitCode = 2;
						return;
					}

					const payeeAgentId = message.from_agent_id;
					if (!payeeAgentId) {
						printError("Cannot pay: the quote has no resolvable sender agent.");
						process.exitCode = 1;
						return;
					}

					const agents = await fetchAgents(client);
					const payerAgentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);

					if (payeeAgentId === payerAgentId) {
						printError("Cannot pay your own quote.");
						process.exitCode = 1;
						return;
					}
					if (!agentKeysExist(configDir, payerAgentId)) {
						printError(
							`No E2EE keys for agent ${payerAgentId}. Run 'rine keys generate' first.`,
						);
						process.exitCode = 1;
						return;
					}
					if (!walletKeyExists(configDir, payerAgentId)) {
						printError(
							`No payment wallet for agent ${payerAgentId}. Run 'rine wallet create' first.`,
						);
						process.exitCode = 1;
						return;
					}

					// Decrypt the quote → verbatim x402 PaymentRequired object.
					const decrypted = await decryptMessage(
						configDir,
						payerAgentId,
						message.encrypted_payload,
						client,
					);
					const pr = parseX402Payload(
						message.type,
						decrypted.plaintext,
					) as PaymentRequired;

					const policy = loadPolicy(configDir, payerAgentId);
					const dailySpent = readDailySpent(configDir, payerAgentId);

					try {
						// select→build→reserve→send. Deny-by-default + caps are enforced
						// inside selectRequirement; a null policy always throws here.
						const requirement = selectRequirement(pr, policy, dailySpent);

						if (opts.autoPay) {
							// --auto-pay only proceeds within the autoPayThreshold; policy is
							// non-null here (selectRequirement would have thrown otherwise).
							if (!policy || !isAutoPayable(policy, requirement)) {
								printError(
									"Quote exceeds the auto-pay threshold. Run 'rine pay' without --auto-pay to approve it manually.",
								);
								process.exitCode = 1;
								return;
							}
						}

						const walletKey = loadWalletKey(configDir, payerAgentId);
						const built = buildPaymentMessage(
							buildPaymentPayload(pr, requirement, walletKey),
							{ emitMarker: opts.marker !== false },
						);

						const recipientKeys = await fetchRecipientKeys(
							client,
							payeeAgentId,
						);
						const encrypted = await encryptMessage(
							configDir,
							payerAgentId,
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

						// Last local act before transmit: reserve the spend under the
						// cross-process lock (re-runs the full policy against the fresh
						// daily total, refuses a same-quote re-pay unless --force). The
						// debit is permanent — a failed send below does NOT refund it.
						await reserveSpend(configDir, payerAgentId, policy, requirement, {
							messageId,
							force: opts.force,
						});

						const sent = (await client.post(
							`/messages/${messageId}/reply`,
							body,
							{ "X-Rine-Agent": payerAgentId },
						)) as MessageRead;

						if (gOpts.json) {
							printJson({
								ok: true,
								payment_message_id: sent.id,
								conversation_id: sent.conversation_id,
								paid_to: requirement.payTo,
								amount: requirement.amount,
								asset: requirement.asset,
								network: requirement.network,
							});
						} else {
							printTable([
								{ Field: "Payment sent", Value: sent.id },
								{ Field: "Conversation", Value: sent.conversation_id },
								{ Field: "Pay to", Value: requirement.payTo },
								{ Field: "Amount", Value: requirement.amount },
								{ Field: "Asset", Value: requirement.asset },
								{ Field: "Network", Value: requirement.network },
							]);
						}
					} catch (err) {
						if (err instanceof X402Error) {
							printError(`Payment refused: ${err.message}`);
							process.exitCode = 1;
							return;
						}
						throw err;
					}
				},
			),
		);
}
