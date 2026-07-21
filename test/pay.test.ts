// REQ-M02 — `rine pay <message-id>`. Drives the REAL command end-to-end against a
// real temp configDir: the wallet key, spend policy, requirement selection,
// EIP-712 signing and spend accounting all run for real in rine-core. Only the
// network/crypto boundary is mocked — the peer-keyed decrypt of the quote, the
// HPKE encrypt of the payment, recipient-key fetch, and the HTTP client.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPay } from "../src/commands/pay.js";

const API_URL = "https://test.rine.network";
const PAYER = "11111111-1111-1111-1111-111111111111";
const PAYEE = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "quote-msg-1";
const EURC = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";

// A verbatim x402 PaymentRequired quote: 0.10 EURC on Base (100000 atomic, 6-dec).
const QUOTE = {
	x402Version: 2,
	accepts: [
		{
			scheme: "exact",
			network: "eip155:8453",
			amount: "100000",
			asset: EURC,
			payTo: "0x00000000000000000000000000000000000000ff",
			maxTimeoutSeconds: 60,
			extra: { name: "EURC", version: "2" },
		},
	],
	extensions: {},
};

function quoteMessage(
	overrides: Record<string, unknown> = {},
): core.MessageRead {
	return {
		id: MESSAGE_ID,
		conversation_id: "conv-1",
		type: "rine.v1.x402_payment_required",
		from_agent_id: PAYEE,
		to_agent_id: PAYER,
		encrypted_payload: "ciphertext-quote",
		encryption_version: "hpke-v1",
		created_at: "2026-07-17T00:00:00Z",
		...overrides,
	} as unknown as core.MessageRead;
}

let CONFIG_DIR: string;
let postBody: Record<string, unknown> | undefined;
let postPath: string | undefined;

const STANDARD_POLICY: core.PaymentPolicy = {
	perTxCap: "1.00",
	dailyCap: "10.00",
	allowedAssets: [EURC],
	allowedNetworks: ["eip155:8453"],
	autoPayThreshold: "0.50",
};

beforeEach(() => {
	CONFIG_DIR = fs.mkdtempSync(join(tmpdir(), "rine-pay-test-"));
	postBody = undefined;
	postPath = undefined;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: PAYER, name: "payer" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue(PAYER);
	vi.spyOn(core, "agentKeysExist").mockReturnValue(true);

	// The quote GET + the reply POST.
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			if (path === `/messages/${MESSAGE_ID}`)
				return Promise.resolve(quoteMessage());
			return Promise.reject(new Error(`Unknown GET ${path}`));
		},
	);
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		(path: string, body?: unknown) => {
			postPath = path;
			postBody = body as Record<string, unknown>;
			return Promise.resolve({
				id: "payment-msg-1",
				conversation_id: "conv-1",
			});
		},
	);

	// Crypto/network externals: the quote decrypts to the verbatim PaymentRequired;
	// the payment encrypts to an opaque envelope.
	vi.spyOn(core, "decryptMessage").mockResolvedValue({
		plaintext: JSON.stringify(QUOTE),
		senderKid: `rine:${PAYEE}`,
		verified: true,
		verificationStatus: "verified",
	} as never);
	vi.spyOn(core, "fetchRecipientKeys").mockResolvedValue({
		encryption: new Uint8Array(32),
		pqEncryption: undefined,
	} as never);
	vi.spyOn(core, "encryptMessage").mockResolvedValue({
		encrypted_payload: "ciphertext-payment",
		encryption_version: "hpke-v1",
		sender_signing_kid: `rine:${PAYER}`,
	} as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	program.option("--as <handle>", "Act as agent");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerPay(program);
	return program;
}

function run(...argv: string[]): Promise<Command> {
	return makeProgram({ json: true }).parseAsync(["node", "rine", ...argv]);
}

describe("rine pay — happy path (policy + real signing)", () => {
	beforeEach(() => {
		core.createWallet(CONFIG_DIR, PAYER);
		core.savePolicy(CONFIG_DIR, PAYER, STANDARD_POLICY);
	});

	it("replies in-thread with a signed rine.v1.x402_payment", async () => {
		await run("pay", MESSAGE_ID);
		expect(postPath).toBe(`/messages/${MESSAGE_ID}/reply`);
		expect(postBody?.type).toBe("rine.v1.x402_payment");
		expect(postBody?.encrypted_payload).toBe("ciphertext-payment");
	});

	it("attaches the payment-submitted status marker (no economic detail)", async () => {
		await run("pay", MESSAGE_ID);
		const meta = postBody?.metadata as Record<string, unknown>;
		expect(meta["rine.x402"]).toEqual({
			status: "payment-submitted",
			rail: "x402",
		});
		// The marker must never leak amounts/addresses.
		const s = JSON.stringify(meta);
		expect(s).not.toContain("100000");
		expect(s).not.toContain(EURC);
	});

	it("R-1: stamps the answered quote's message id into the signed payload", async () => {
		await run("pay", MESSAGE_ID);
		// The PaymentPayload we sealed carries the quote-ref extension so the payee
		// can bind this settlement to the ONE quote it authored.
		const pp = (core.encryptMessage as ReturnType<typeof vi.fn>).mock.calls.at(
			0,
		)?.[3] as core.PaymentPayload;
		expect(pp.extensions?.[core.X402_QUOTE_REF_KEY]).toBe(MESSAGE_ID);
	});

	it("signs the payment over the payer's real wallet key (recovers to wallet)", async () => {
		await run("pay", MESSAGE_ID);
		// The encrypted payload we sent is the PaymentPayload passed to encryptMessage.
		const pp = (core.encryptMessage as ReturnType<typeof vi.fn>).mock.calls.at(
			0,
		)?.[3] as core.PaymentPayload;
		const from = pp.payload.authorization.from;
		expect(from).toBe(core.getWalletAddress(CONFIG_DIR, PAYER));
		expect(pp.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
		expect(pp.accepted.asset).toBe(EURC);
	});

	it("reserves the spend under the lock as the last act before the send", async () => {
		expect(core.readDailySpent(CONFIG_DIR, PAYER)).toBe(0n);
		await run("pay", MESSAGE_ID);
		expect(core.readDailySpent(CONFIG_DIR, PAYER)).toBe(100000n);
	});

	it("fail-closed: reservation STANDS when the reply POST fails (no refund)", async () => {
		// O2′: the EIP-3009 authorization is settleable the instant it is built, so
		// the debit is reserved before transmit and is permanent — a failed send
		// does NOT refund it (would let a counterparty fake failures past the cap).
		(
			core.HttpClient.prototype.post as ReturnType<typeof vi.fn>
		).mockRejectedValue(new core.RineApiError(500, "boom"));
		await run("pay", MESSAGE_ID);
		expect(core.readDailySpent(CONFIG_DIR, PAYER)).toBe(100000n);
		expect(process.exitCode).toBe(1);
	});

	it("a second pay of the same quote without --force is refused as already-paid", async () => {
		// First pay reserves the message id in today's journal.
		(
			core.HttpClient.prototype.post as ReturnType<typeof vi.fn>
		).mockRejectedValue(new core.RineApiError(500, "boom"));
		await run("pay", MESSAGE_ID);
		expect(core.readDailySpent(CONFIG_DIR, PAYER)).toBe(100000n);

		// Retrying the same quote is refused (ALREADY_PAID) and does NOT debit again.
		process.exitCode = undefined;
		await run("pay", MESSAGE_ID);
		expect(process.exitCode).toBe(1);
		expect(core.readDailySpent(CONFIG_DIR, PAYER)).toBe(100000n);

		// --force re-pays: a second, deliberate, permanent debit.
		process.exitCode = undefined;
		await run("pay", MESSAGE_ID, "--force");
		expect(core.readDailySpent(CONFIG_DIR, PAYER)).toBe(200000n);
	});
});

describe("rine pay — deny-by-default + auto-pay gate", () => {
	it("refuses (exit 1) when no spend policy is configured", async () => {
		core.createWallet(CONFIG_DIR, PAYER);
		await run("pay", MESSAGE_ID);
		expect(process.exitCode).toBe(1);
		expect(core.HttpClient.prototype.post).not.toHaveBeenCalled();
	});

	it("errors (exit 1) when the payer has no wallet", async () => {
		core.savePolicy(CONFIG_DIR, PAYER, STANDARD_POLICY);
		await run("pay", MESSAGE_ID);
		expect(process.exitCode).toBe(1);
		expect(core.HttpClient.prototype.post).not.toHaveBeenCalled();
	});

	it("--auto-pay proceeds when the quote is within the threshold", async () => {
		core.createWallet(CONFIG_DIR, PAYER);
		core.savePolicy(CONFIG_DIR, PAYER, STANDARD_POLICY);
		await run("pay", MESSAGE_ID, "--auto-pay");
		expect(postBody?.type).toBe("rine.v1.x402_payment");
	});

	it("--auto-pay refuses when the quote exceeds the threshold", async () => {
		core.createWallet(CONFIG_DIR, PAYER);
		core.savePolicy(CONFIG_DIR, PAYER, {
			...STANDARD_POLICY,
			autoPayThreshold: "0.05",
		});
		await run("pay", MESSAGE_ID, "--auto-pay");
		expect(process.exitCode).toBe(1);
		expect(core.HttpClient.prototype.post).not.toHaveBeenCalled();
	});

	it("rejects a message that is not an x402 payment_required (exit 2)", async () => {
		(
			core.HttpClient.prototype.get as ReturnType<typeof vi.fn>
		).mockResolvedValue(quoteMessage({ type: "rine.v1.dm" }));
		await run("pay", MESSAGE_ID);
		expect(process.exitCode).toBe(2);
	});

	it("--no-marker omits the cleartext status marker", async () => {
		core.createWallet(CONFIG_DIR, PAYER);
		core.savePolicy(CONFIG_DIR, PAYER, STANDARD_POLICY);
		await run("pay", MESSAGE_ID, "--no-marker");
		expect(postBody?.metadata).toBeUndefined();
	});
});
