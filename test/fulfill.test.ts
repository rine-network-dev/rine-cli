// `rine fulfill <message-id>`. Drives the REAL command: fetch the
// payment message → parse the decrypted x402_payment (real `parseX402Payload`) →
// resolve the payee-owned requirement + settle via rine-core's SHARED
// `resolvePayeeRequirement`/`settleToReceipt` (the ref-bind + reconcile +
// verify/settle ladder, unit-tested exhaustively in rine-core) → build + send the
// receipt in-thread (real `buildReceiptMessage`/marker discipline). This lane owns
// the CLI wiring: it asserts the command forwards the right inputs to the shared
// orchestration (the answered payment, the operator `--expect` terms, the
// conversation + payee binding), routes every typed outcome (settled /
// verification-failed / typed refusal / facilitator error) to the correct
// receipt + exit code, and surfaces the matched quote. The rine-core seam is
// mocked (its public API — never its internals) so the CLI's own behaviour is
// what's under test, not a re-run of rine-core's reconcile matrix.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFulfill } from "../src/commands/fulfill.js";

const API_URL = "https://test.rine.network";
const PAYER = "11111111-1111-1111-1111-111111111111";
const PAYEE = "22222222-2222-2222-2222-222222222222";
/** A third agent that re-seals the payer's signed payment and posts it as its own. */
const RESEALER = "33333333-3333-3333-3333-333333333333";
const MESSAGE_ID = "payment-msg-1";
// The quote message the payment answers — carried in the signed payload.
const QUOTE_ID = "quote-msg-1";
const QUOTE_REF = core.X402_QUOTE_REF_KEY;
const EURC = "0x0000000000000000000000000000000000000001";
const PAY_TO = "0x00000000000000000000000000000000000000ff";
const REGISTRY_EURC = "0x808456652fdb597867f38412077a9182bf77359f";
const SEPOLIA = "eip155:84532";

// A verbatim x402 PaymentPayload (signed authorization) received by the payee. By
// default it stamps the answered-quote ref; pass `{}` extensions to model an
// older payer that omitted it.
function payment(
	acceptedOverrides: Record<string, unknown> = {},
	extensions: Record<string, unknown> = { [QUOTE_REF]: QUOTE_ID },
) {
	return {
		x402Version: 2,
		resource: { description: "translate a document" },
		accepted: {
			scheme: "exact",
			network: SEPOLIA,
			amount: "100000",
			asset: EURC,
			payTo: PAY_TO,
			maxTimeoutSeconds: 60,
			extra: { name: "EURC", version: "2" },
			...acceptedOverrides,
		},
		payload: {
			signature: `0x${"ab".repeat(65)}`,
			authorization: {
				from: PAYER,
				to: PAY_TO,
				value: "100000",
				validAfter: "0",
				validBefore: "9999999999",
				nonce: `0x${"00".repeat(32)}`,
			},
		},
		extensions,
	};
}

// The payee-owned requirement + matched-quote provenance rine-core resolves the
// payment to. `resolvePayeeRequirement` is mocked to return this on the happy path.
const REQUIREMENT: core.PaymentRequirements = {
	scheme: "exact",
	network: SEPOLIA,
	amount: "100000",
	asset: EURC,
	payTo: PAY_TO,
	maxTimeoutSeconds: 60,
	extra: { name: "EURC", version: "2" },
};
function resolved(
	quoteMessageId: string | null = QUOTE_ID,
): core.ResolvedPayeeRequirement {
	return {
		requirement: REQUIREMENT,
		match: {
			quoteMessageId,
			amount: REQUIREMENT.amount as string,
			asset: EURC,
			network: SEPOLIA,
		},
	};
}

// The facilitator echoes the v1 network SLUG (never CAIP-2) into the settlement.
const SETTLEMENT: core.SettlementResponse = {
	success: true,
	transaction: "0xdeadbeef",
	network: "base-sepolia",
	payer: PAYER,
};
function settled(over: Partial<core.FulfillReceipt> = {}): core.FulfillReceipt {
	return {
		status: "settled",
		receiptBody: SETTLEMENT,
		verification: { isValid: true, payer: PAYER },
		matchedQuote: resolved().match,
		...over,
	};
}

function paymentMessage(
	overrides: Record<string, unknown> = {},
): core.MessageRead {
	return {
		id: MESSAGE_ID,
		conversation_id: "conv-1",
		type: "rine.v1.x402_payment",
		from_agent_id: PAYER,
		to_agent_id: PAYEE,
		encrypted_payload: "ciphertext-payment",
		encryption_version: "hpke-hybrid-v2",
		created_at: "2026-07-20T00:00:00Z",
		...overrides,
	} as unknown as core.MessageRead;
}

let paymentPlaintext: string;
// The args the command forwards to rine-core's SHARED `sendReceipt` (the in-thread
// receipt reply seam). Its build/encrypt/marker discipline is unit-tested in
// rine-core; here we assert the CLI hands it the right receipt for each outcome.
let receiptParams: Parameters<typeof core.sendReceipt>[0] | undefined;

beforeEach(() => {
	receiptParams = undefined;
	paymentPlaintext = JSON.stringify(payment());
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-fulfill");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: PAYEE, name: "payee" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: PAYEE });
	vi.spyOn(core, "agentKeysExist").mockReturnValue(true);

	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			if (path === `/messages/${MESSAGE_ID}`)
				return Promise.resolve(paymentMessage());
			return Promise.reject(new Error(`Unknown GET ${path}`));
		},
	);
	// The command must NEVER post directly — every receipt goes through the shared
	// sendReceipt seam (mocked below). A stray raw post is a regression, so fail loud.
	vi.spyOn(core.HttpClient.prototype, "post").mockRejectedValue(
		new Error(
			"fulfill must reply via the shared sendReceipt seam, not client.post",
		),
	);

	// The received payment is decrypted directly by the command (barrel call).
	vi.spyOn(core, "decryptMessage").mockImplementation(
		() =>
			Promise.resolve({
				plaintext: paymentPlaintext,
				senderKid: `rine:${PAYER}`,
				verified: true,
				verificationStatus: "verified",
			}) as never,
	);
	// The ref-bind + reconcile + verify/settle ladder AND the receipt reply both
	// live (and are exhaustively tested) in rine-core — mock their public seams so
	// the CLI's own routing (which receipt for which outcome) is what's under test.
	vi.spyOn(core, "resolvePayeeRequirement").mockResolvedValue(resolved());
	vi.spyOn(core, "settleToReceipt").mockResolvedValue(settled());
	vi.spyOn(core, "sendReceipt").mockImplementation((params) => {
		receiptParams = params;
		return Promise.resolve({
			id: "receipt-msg-1",
			conversation_id: "conv-1",
		} as core.MessageRead);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	program.option("--as <handle>", "Act as agent");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerFulfill(program);
	return program;
}

function run(...argv: string[]): Promise<Command> {
	return makeProgram({ json: true }).parseAsync(["node", "rine", ...argv]);
}

/** Parse the last `printJson` payload (the fulfill result) off the console spy. */
function lastJson(): Record<string, unknown> {
	const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1]?.[0] as string);
}

describe("rine fulfill — happy path (ref-bind → settle → receipt)", () => {
	it("replies in-thread with the settlement receipt as the payee", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// The shared sendReceipt is handed the in-thread reply target (the payment),
		// the payee identity, and the successful settlement body.
		expect(core.sendReceipt).toHaveBeenCalledTimes(1);
		expect(receiptParams?.messageId).toBe(MESSAGE_ID);
		expect(receiptParams?.payeeAgentId).toBe(PAYEE);
		expect(receiptParams?.receiptBody).toEqual(SETTLEMENT);
		expect(process.exitCode).toBeUndefined();
	});

	it("checks the payment envelope against the payer the server says sent it", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		const args = (core.decryptMessage as ReturnType<typeof vi.fn>).mock
			.calls[0] as unknown[];
		// Never the kid or the `sender_signing_kid` header the sender supplied.
		expect(args[4]).toBe(PAYER);
	});

	it("opens the payment under the key generation current at its created_at", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		const args = (core.decryptMessage as ReturnType<typeof vi.fn>).mock
			.calls[0] as unknown[];
		expect(args[6]).toBe("2026-07-20T00:00:00Z");
	});

	it("binds the settle to the answered payment + conversation + payee", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		const resolveArg = (
			core.resolvePayeeRequirement as ReturnType<typeof vi.fn>
		).mock.calls[0]?.[0] as {
			payment: core.PaymentPayload;
			expected: Record<string, unknown>;
			conversationId: string;
			payeeAgentId: string;
		};
		// The verbatim payment the payee received is what gets reconciled…
		expect(resolveArg.payment.payload.authorization.from).toBe(PAYER);
		// …bound to THIS conversation and THIS payee (the real binding inputs).
		expect(resolveArg.conversationId).toBe("conv-1");
		expect(resolveArg.payeeAgentId).toBe(PAYEE);
		// No operator override supplied → the ref path is taken.
		expect(resolveArg.expected).toEqual({
			payTo: undefined,
			expectAmount: undefined,
			expectAsset: undefined,
			expectNetwork: undefined,
		});
		// The RESOLVED payee-owned struct (never pp.accepted) is forwarded to settle.
		const settleArgs = (core.settleToReceipt as ReturnType<typeof vi.fn>).mock
			.calls[0];
		expect(settleArgs?.[0]).toMatchObject({
			payload: { authorization: { from: PAYER } },
		});
		expect(settleArgs?.[1]).toEqual(resolved());
	});

	it("surfaces the matched quote (id + amount + asset + network) in the result", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(lastJson().matched_quote).toEqual({
			message_id: QUOTE_ID,
			amount: "100000",
			asset: EURC,
			network: SEPOLIA,
		});
	});

	it("resolves a preset facilitator name to its base URL", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "payai");
		const facilitator = (core.settleToReceipt as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[2] as core.FacilitatorConfig;
		expect(facilitator.url).toBe("https://facilitator.payai.network");
	});

	it("addresses the receipt to the PAYER and sends it as the PAYEE", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// sendReceipt encrypts to the payer (the payment's original sender) and
		// replies as the payee — the CLI supplies both identities.
		expect(receiptParams?.payerAgentId).toBe(PAYER);
		expect(receiptParams?.payeeAgentId).toBe(PAYEE);
	});
});

describe("rine fulfill — typed refusal routing (fail closed)", () => {
	it("REFUSES when the payment cannot be bound to a payee quote (NO_QUOTE)", async () => {
		(
			core.resolvePayeeRequirement as ReturnType<typeof vi.fn>
		).mockRejectedValue(
			new core.X402Error(core.X402_ERROR.NO_QUOTE, "no bound quote"),
		);
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// Fail closed = "no settle", NEVER "no receipt": the facilitator is never
		// contacted, but the payer still reaches a terminal payment-failed state.
		expect(core.settleToReceipt).not.toHaveBeenCalled();
		expect(lastJson()).toMatchObject({
			status: "payment-refused",
			code: core.X402_ERROR.NO_QUOTE,
			receipt_id: "receipt-msg-1",
		});
		expect(process.exitCode).toBe(1);
	});

	it("threads a terminal payment-failed receipt to the payer on refusal", async () => {
		(
			core.resolvePayeeRequirement as ReturnType<typeof vi.fn>
		).mockRejectedValue(
			new core.X402Error(core.X402_ERROR.NO_QUOTE, "no bound quote"),
		);
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// A refusal receipt is replied in-thread to the payer's payment — the payer's
		// thread now reaches its terminal state instead of hanging open forever.
		// No funds move: the settle ladder was never entered.
		expect(core.settleToReceipt).not.toHaveBeenCalled();
		expect(core.sendReceipt).toHaveBeenCalledTimes(1);
		expect(receiptParams?.messageId).toBe(MESSAGE_ID);
		expect(receiptParams?.payerAgentId).toBe(PAYER);
		// A failure receipt (success:false) with the typed refusal code — core turns
		// this into the payment-failed marker (marker discipline tested in rine-core).
		expect(receiptParams?.receiptBody).toMatchObject({
			success: false,
			transaction: "",
			payer: PAYER,
			errorReason: core.X402_ERROR.NO_QUOTE,
		});
		expect(receiptParams?.emitMarker).toBe(true);
	});

	it("REFUSES a hostile payer whose terms match no quote (REQUIREMENT_MISMATCH)", async () => {
		(
			core.resolvePayeeRequirement as ReturnType<typeof vi.fn>
		).mockRejectedValue(
			new core.X402Error(
				core.X402_ERROR.REQUIREMENT_MISMATCH,
				"payTo redirect / underpay / wrong asset",
			),
		);
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// Still no settle — but the payer gets a payment-failed receipt so its
		// thread terminates rather than waiting on a settlement that never comes.
		expect(core.settleToReceipt).not.toHaveBeenCalled();
		expect(receiptParams?.receiptBody).toMatchObject({
			success: false,
			errorReason: core.X402_ERROR.REQUIREMENT_MISMATCH,
		});
		expect(lastJson()).toMatchObject({
			status: "payment-refused",
			code: core.X402_ERROR.REQUIREMENT_MISMATCH,
			receipt_id: "receipt-msg-1",
		});
		expect(process.exitCode).toBe(1);
	});
});

describe("rine fulfill — sender binding on the money path", () => {
	/** The payment decrypts and parses; only its signer is wrong. */
	function resealedPayment(status: string): void {
		(core.decryptMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
			plaintext: paymentPlaintext,
			senderKid: `rine:${RESEALER}`,
			verified: false,
			verificationStatus: status,
		} as never);
	}

	it("REFUSES a payment the row's sender did not sign, and still terminates the thread", async () => {
		resealedPayment("sender-mismatch");

		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");

		// A payer-signed authorization inside a re-sealed envelope never reaches the
		// facilitator: nothing is reconciled and nothing is settled.
		expect(core.resolvePayeeRequirement).not.toHaveBeenCalled();
		expect(core.settleToReceipt).not.toHaveBeenCalled();
		// Fail closed still means a terminal state for the thread it arrived in.
		expect(receiptParams?.receiptBody).toMatchObject({
			success: false,
			errorReason: core.X402_ERROR.INAUTHENTIC_SENDER,
		});
		expect(lastJson()).toMatchObject({
			status: "payment-refused",
			code: core.X402_ERROR.INAUTHENTIC_SENDER,
			receipt_id: "receipt-msg-1",
		});
		expect(process.exitCode).toBe(1);
	});

	it("leaves the thread open, with no receipt, when the payer's key could not be read", async () => {
		resealedPayment("unverifiable");

		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");

		// Nothing is settled and no terminal receipt is sent: the same payment is
		// fulfilled once the key lookup works, exactly like a facilitator outage.
		expect(core.resolvePayeeRequirement).not.toHaveBeenCalled();
		expect(core.settleToReceipt).not.toHaveBeenCalled();
		expect(core.sendReceipt).not.toHaveBeenCalled();
		expect(lastJson()).toMatchObject({ status: "sender-unverifiable" });
		expect(process.exitCode).toBe(1);
	});

	it("REFUSES it under the out-of-band --expect terms as well", async () => {
		// The override short-circuits the quote-ref binding, so this is the mode in
		// which a re-sealed payment would otherwise settle into the payee's own
		// wallet with the receipt and the goods routed to the resealer.
		resealedPayment("sender-mismatch");

		await run(
			"fulfill",
			MESSAGE_ID,
			"--facilitator",
			"https://fac.test",
			"--pay-to",
			PAY_TO,
			"--expect-amount",
			"0.10",
			"--expect-asset",
			REGISTRY_EURC,
			"--expect-network",
			SEPOLIA,
		);

		expect(core.resolvePayeeRequirement).not.toHaveBeenCalled();
		expect(core.settleToReceipt).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("REFUSES a payment whose signature does not check out", async () => {
		resealedPayment("invalid");

		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");

		expect(core.settleToReceipt).not.toHaveBeenCalled();
		expect(lastJson()).toMatchObject({
			status: "payment-refused",
			code: core.X402_ERROR.INAUTHENTIC_SENDER,
		});
		expect(process.exitCode).toBe(1);
	});

	it("settles a payment the row's sender did sign (false-positive guard)", async () => {
		// The identical payment, correctly attributed, still settles — without this
		// the refusals above would pass against a gate that refuses everything.
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");

		expect(core.settleToReceipt).toHaveBeenCalledTimes(1);
		expect(receiptParams?.receiptBody).toEqual(SETTLEMENT);
		expect(process.exitCode).toBeUndefined();
	});
});

describe("rine fulfill — explicit expected-terms override (out-of-band quote)", () => {
	it("forwards the --pay-to/--expect-* terms to the shared resolver and settles", async () => {
		(
			core.resolvePayeeRequirement as ReturnType<typeof vi.fn>
		).mockResolvedValue(resolved(null));
		// settleToReceipt threads the resolved match through — an override yields a
		// null quote message-id.
		(core.settleToReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(
			settled({ matchedQuote: resolved(null).match }),
		);
		await run(
			"fulfill",
			MESSAGE_ID,
			"--facilitator",
			"https://fac.test",
			"--pay-to",
			PAY_TO,
			"--expect-amount",
			"0.10",
			"--expect-asset",
			REGISTRY_EURC,
			"--expect-network",
			SEPOLIA,
		);
		const resolveArg = (
			core.resolvePayeeRequirement as ReturnType<typeof vi.fn>
		).mock.calls[0]?.[0] as { expected: Record<string, unknown> };
		expect(resolveArg.expected).toEqual({
			payTo: PAY_TO,
			expectAmount: "0.10",
			expectAsset: REGISTRY_EURC,
			expectNetwork: SEPOLIA,
		});
		expect(core.settleToReceipt).toHaveBeenCalledTimes(1);
		// An operator override surfaces a null quote message-id.
		expect(lastJson().matched_quote).toMatchObject({ message_id: null });
		expect(process.exitCode).toBeUndefined();
	});
});

describe("rine fulfill — marker discipline", () => {
	it("forwards emitMarker=true by default so core emits the status marker", async () => {
		// The cleartext {status,rail} marker byte-shape + its economic-leak freedom
		// are unit-tested in rine-core's buildReceiptMessage; the CLI's job is only to
		// forward the emitMarker flag, which defaults on.
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(receiptParams?.emitMarker).toBe(true);
	});

	it("--no-marker forwards emitMarker=false (fully sealed receipt)", async () => {
		await run(
			"fulfill",
			MESSAGE_ID,
			"--facilitator",
			"https://fac.test",
			"--no-marker",
		);
		expect(receiptParams?.emitMarker).toBe(false);
	});
});

describe("rine fulfill — failure branches (typed outcomes)", () => {
	it("sends a payment-failed receipt when verification is invalid (exit 1)", async () => {
		const failureBody = {
			success: false,
			transaction: "",
			network: SEPOLIA,
			payer: PAYER,
			errorReason: "signature_mismatch",
		};
		(core.settleToReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(
			settled({ status: "verification-failed", receiptBody: failureBody }),
		);
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// The failed settlement body is threaded verbatim to the payer (core turns
		// success:false into the payment-failed marker).
		expect(receiptParams?.receiptBody).toEqual(failureBody);
		expect(process.exitCode).toBe(1);
	});

	it("sends a payment-failed receipt when the settlement itself fails (exit 1)", async () => {
		const failureBody = {
			success: false,
			transaction: "",
			network: "base-sepolia",
			payer: PAYER,
			errorReason: "insufficient_funds",
		};
		(core.settleToReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(
			settled({ status: "settlement-failed", receiptBody: failureBody }),
		);
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(receiptParams?.receiptBody).toEqual(failureBody);
		expect(process.exitCode).toBe(1);
	});

	it("threads a graceful payment-failed receipt on a malformed payload (no crash)", async () => {
		paymentPlaintext = JSON.stringify({ payload: {} }); // no `accepted`
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// The malformed payload never reaches the resolver/settle ladder…
		expect(core.resolvePayeeRequirement).not.toHaveBeenCalled();
		expect(core.settleToReceipt).not.toHaveBeenCalled();
		// …but the payer still reaches a terminal payment-failed state via a refusal
		// receipt built from the shared refusalReceiptBody (empty
		// network/payer since the payload could not even be parsed).
		expect(core.sendReceipt).toHaveBeenCalledTimes(1);
		expect(receiptParams?.receiptBody).toMatchObject({
			success: false,
			transaction: "",
			network: "",
			payer: "",
		});
		expect(receiptParams?.receiptBody.errorReason).toBeTruthy();
		expect(process.exitCode).toBe(1);
	});

	it("surfaces a facilitator HTTP failure as facilitator-error and sends NO receipt", async () => {
		(core.settleToReceipt as ReturnType<typeof vi.fn>).mockRejectedValue(
			new core.X402FacilitatorError("verify 400", 400, {
				error: "no resource",
			}),
		);
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// A facilitator transport failure leaves the thread open for a retry — no
		// receipt is sent at all.
		expect(core.sendReceipt).not.toHaveBeenCalled();
		expect(lastJson()).toMatchObject({ status: "facilitator-error" });
		expect(process.exitCode).toBe(1);
	});

	it("rejects a non-x402_payment message (exit 2, nothing sent)", async () => {
		(
			core.HttpClient.prototype.get as ReturnType<typeof vi.fn>
		).mockResolvedValue(paymentMessage({ type: "rine.v1.dm" }));
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(process.exitCode).toBe(2);
		expect(core.resolvePayeeRequirement).not.toHaveBeenCalled();
		expect(core.sendReceipt).not.toHaveBeenCalled();
	});

	it("refuses a payment addressed to a sibling, naming the addressee (exit 1)", async () => {
		// The payment is sealed to RESEALER; this invocation acts as PAYEE. Only
		// the addressee holds the key that opens it, so the settle was never
		// going to happen — but the first symptom used to be an opaque decrypt
		// failure. Refuse before the facilitator or any receipt, and say which
		// agent it was for.
		(
			core.HttpClient.prototype.get as ReturnType<typeof vi.fn>
		).mockResolvedValue(paymentMessage({ to_agent_id: RESEALER }));

		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");

		expect(process.exitCode).toBe(1);
		const stderr = (console.error as ReturnType<typeof vi.fn>).mock.calls
			.map((c) => String(c[0]))
			.join("\n");
		expect(stderr).toContain(RESEALER);
		expect(core.decryptMessage).not.toHaveBeenCalled();
		expect(core.settleToReceipt).not.toHaveBeenCalled();
		expect(core.sendReceipt).not.toHaveBeenCalled();
	});

	it("refuses fulfilling your own payment (exit 1)", async () => {
		(core.resolveAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ agentId: PAYER });
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(process.exitCode).toBe(1);
		expect(core.resolvePayeeRequirement).not.toHaveBeenCalled();
	});

	it("errors on an unknown facilitator spec before any external call (exit 2)", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "not-a-facilitator");
		expect(process.exitCode).toBe(2);
		expect(core.decryptMessage).not.toHaveBeenCalled();
		expect(core.resolvePayeeRequirement).not.toHaveBeenCalled();
	});
});
