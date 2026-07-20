// REQ-M04 — `rine fulfill <message-id>`. Drives the REAL command end-to-end:
// decrypt the received x402_payment → verify → settle → build + send the receipt
// in-thread. Only the network/crypto boundary is mocked — the peer-keyed decrypt
// of the payment, the facilitator verify/settle HTTP, the HPKE encrypt of the
// receipt, recipient-key fetch, and the HTTP client. The receipt build layer,
// marker discipline, and typed-status routing run for real.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFulfill } from "../src/commands/fulfill.js";

const API_URL = "https://test.rine.network";
const PAYER = "11111111-1111-1111-1111-111111111111";
const PAYEE = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "payment-msg-1";
const EURC = "0x0000000000000000000000000000000000000001";
const PAY_TO = "0x00000000000000000000000000000000000000ff";

// A verbatim x402 PaymentPayload (signed authorization) received by the payee.
const PAYMENT = {
	x402Version: 2,
	resource: { description: "translate a document" },
	accepted: {
		scheme: "exact",
		network: "eip155:84532",
		amount: "100000",
		asset: EURC,
		payTo: PAY_TO,
		maxTimeoutSeconds: 60,
		extra: { name: "EURC", version: "2" },
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
};

// The facilitator echoes the v1 network SLUG (never CAIP-2) into the settlement.
const SETTLEMENT: core.SettlementResponse = {
	success: true,
	transaction: "0xdeadbeef",
	network: "base-sepolia",
	payer: PAYER,
};

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
		encryption_version: "hpke-v1",
		created_at: "2026-07-20T00:00:00Z",
		...overrides,
	} as unknown as core.MessageRead;
}

let postBody: Record<string, unknown> | undefined;
let postPath: string | undefined;

beforeEach(() => {
	postBody = undefined;
	postPath = undefined;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-fulfill");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: PAYEE, name: "payee" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue(PAYEE);
	vi.spyOn(core, "agentKeysExist").mockReturnValue(true);

	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			if (path === `/messages/${MESSAGE_ID}`)
				return Promise.resolve(paymentMessage());
			return Promise.reject(new Error(`Unknown GET ${path}`));
		},
	);
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		(path: string, body?: unknown) => {
			postPath = path;
			postBody = body as Record<string, unknown>;
			return Promise.resolve({
				id: "receipt-msg-1",
				conversation_id: "conv-1",
			});
		},
	);

	vi.spyOn(core, "decryptMessage").mockResolvedValue({
		plaintext: JSON.stringify(PAYMENT),
		senderKid: `rine:${PAYER}`,
		verified: true,
		verificationStatus: "verified",
	} as never);
	vi.spyOn(core, "fetchRecipientKeys").mockResolvedValue({
		encryption: new Uint8Array(32),
		pqEncryption: undefined,
	} as never);
	vi.spyOn(core, "encryptMessage").mockResolvedValue({
		encrypted_payload: "ciphertext-receipt",
		encryption_version: "hpke-v1",
		sender_signing_kid: `rine:${PAYEE}`,
	} as never);
	vi.spyOn(core, "verifyPayment").mockResolvedValue({ isValid: true } as never);
	vi.spyOn(core, "settlePayment").mockResolvedValue(SETTLEMENT as never);
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

describe("rine fulfill — happy path (verify → settle → receipt)", () => {
	it("replies in-thread with a rine.v1.x402_receipt as the payee", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(postPath).toBe(`/messages/${MESSAGE_ID}/reply`);
		expect(postBody?.type).toBe("rine.v1.x402_receipt");
		expect(postBody?.encrypted_payload).toBe("ciphertext-receipt");
		expect(process.exitCode).toBeUndefined();
	});

	it("verifies before settling and passes the verbatim payment payload", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		const verifyArg = (core.verifyPayment as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as core.PaymentPayload;
		expect(verifyArg.payload.authorization.from).toBe(PAYER);
		expect(verifyArg.accepted.asset).toBe(EURC);
		expect(core.verifyPayment).toHaveBeenCalledTimes(1);
		expect(core.settlePayment).toHaveBeenCalledTimes(1);
	});

	it("resolves a preset facilitator name to its base URL", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "payai");
		const opts = (core.verifyPayment as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[1] as { facilitator: core.FacilitatorConfig };
		expect(opts.facilitator.url).toBe("https://facilitator.payai.network");
	});

	it("encrypts the receipt to the PAYER (the payment's sender)", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(core.fetchRecipientKeys).toHaveBeenCalledWith(
			expect.anything(),
			PAYER,
		);
		// Sent as the payee agent.
		const headers = (core.HttpClient.prototype.post as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[2] as Record<string, string>;
		expect(headers).toEqual({ "X-Rine-Agent": PAYEE });
	});
});

describe("rine fulfill — marker discipline (REQ-X03)", () => {
	it("attaches only the payment-completed {status,rail} marker on success", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		const meta = postBody?.metadata as Record<string, unknown>;
		expect(meta["rine.x402"]).toEqual({
			status: "payment-completed",
			rail: "x402",
		});
		// The marker must never leak the tx hash, amount, network, or payer.
		const s = JSON.stringify(meta);
		expect(s).not.toContain("0xdeadbeef");
		expect(s).not.toContain("100000");
		expect(s).not.toContain("base-sepolia");
	});

	it("--no-marker omits the cleartext status marker", async () => {
		await run(
			"fulfill",
			MESSAGE_ID,
			"--facilitator",
			"https://fac.test",
			"--no-marker",
		);
		expect(postBody?.metadata).toBeUndefined();
	});
});

describe("rine fulfill — failure branches (typed outcomes)", () => {
	it("sends a payment-failed receipt when verification is invalid (exit 1)", async () => {
		(core.verifyPayment as ReturnType<typeof vi.fn>).mockResolvedValue({
			isValid: false,
			invalidReason: "signature_mismatch",
		});
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		// Settlement is SKIPPED on invalid verification.
		expect(core.settlePayment).not.toHaveBeenCalled();
		// A failure receipt is still sent so the payer reaches a terminal state.
		expect(postBody?.type).toBe("rine.v1.x402_receipt");
		const meta = postBody?.metadata as Record<string, unknown>;
		expect(meta["rine.x402"]).toEqual({
			status: "payment-failed",
			rail: "x402",
		});
		expect(process.exitCode).toBe(1);
	});

	it("sends a payment-failed receipt when the settlement itself fails (exit 1)", async () => {
		(core.settlePayment as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			transaction: "",
			network: "base-sepolia",
			payer: PAYER,
			errorReason: "insufficient_funds",
		});
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(postBody?.type).toBe("rine.v1.x402_receipt");
		expect(process.exitCode).toBe(1);
	});

	it("surfaces a facilitator HTTP failure as facilitator-error and sends NO receipt", async () => {
		(core.verifyPayment as ReturnType<typeof vi.fn>).mockRejectedValue(
			new core.X402FacilitatorError("verify 400", 400, {
				error: "no resource",
			}),
		);
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(core.HttpClient.prototype.post).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("rejects a non-x402_payment message (exit 2, nothing sent)", async () => {
		(
			core.HttpClient.prototype.get as ReturnType<typeof vi.fn>
		).mockResolvedValue(paymentMessage({ type: "rine.v1.dm" }));
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(process.exitCode).toBe(2);
		expect(core.verifyPayment).not.toHaveBeenCalled();
		expect(core.HttpClient.prototype.post).not.toHaveBeenCalled();
	});

	it("refuses fulfilling your own payment (exit 1)", async () => {
		(core.resolveAgent as ReturnType<typeof vi.fn>).mockResolvedValue(PAYER);
		await run("fulfill", MESSAGE_ID, "--facilitator", "https://fac.test");
		expect(process.exitCode).toBe(1);
		expect(core.verifyPayment).not.toHaveBeenCalled();
	});

	it("errors on an unknown facilitator spec before any external call (exit 2)", async () => {
		await run("fulfill", MESSAGE_ID, "--facilitator", "not-a-facilitator");
		expect(process.exitCode).toBe(2);
		expect(core.decryptMessage).not.toHaveBeenCalled();
		expect(core.verifyPayment).not.toHaveBeenCalled();
	});
});
