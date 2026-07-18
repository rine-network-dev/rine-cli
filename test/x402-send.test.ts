// REQ-M02 (payee send) + REQ-D03 (card terms). `rine send --type
// rine.v1.x402_payment_required` must attach the x402 cleartext extras
// (content_type/payload_schema + status marker) via rine-core's build layer;
// `rine agent set-pricing` must write rine.x402.terms while leaving the
// pricing_model enum untouched. Only the network boundary is mocked.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentProfile } from "../src/commands/agent-profile.js";
import { registerAgent } from "../src/commands/agent.js";
import { registerMessages } from "../src/commands/messages.js";

const API_URL = "https://test.rine.network";
const SENDER = "11111111-1111-1111-1111-111111111111";
const RECIPIENT = "22222222-2222-2222-2222-222222222222";

const QUOTE = {
	x402Version: 2,
	accepts: [
		{
			scheme: "exact",
			network: "eip155:8453",
			amount: "100000",
			asset: "0x0000000000000000000000000000000000000001",
			payTo: "0x00000000000000000000000000000000000000ff",
			maxTimeoutSeconds: 60,
			extra: { name: "EURC", version: "2" },
		},
	],
};

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-x402");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "resolveToUuid").mockImplementation((_url, h) =>
		Promise.resolve(h),
	);
	vi.spyOn(core, "normalizeHandle").mockImplementation((h) => h);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

// ── payee send: rine send --type rine.v1.x402_payment_required ──────────────

describe("rine send — x402 payment_required attaches cleartext extras", () => {
	function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
		const program = new Command();
		program.option("--json", "Output JSON");
		program.option("--profile <profile>", "Profile name");
		program.option("--as <handle>", "Act as agent");
		vi.spyOn(program, "opts").mockReturnValue(globalOpts);
		registerMessages(program);
		return program;
	}

	let postBody: Record<string, unknown> | undefined;

	beforeEach(() => {
		postBody = undefined;
		vi.spyOn(core, "fetchRecipientKeys").mockResolvedValue({
			encryption: new Uint8Array(32),
			pqEncryption: undefined,
		} as never);
		vi.spyOn(core, "encryptMessage").mockResolvedValue({
			encrypted_payload: "ct",
			encryption_version: "hpke-v1",
			sender_signing_kid: `rine:${SENDER}`,
		} as never);
		vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
			(_p: string, body?: unknown) => {
				postBody = body as Record<string, unknown>;
				return Promise.resolve({ id: "m1", conversation_id: "c1" });
			},
		);
	});

	async function sendQuote(...extra: string[]): Promise<void> {
		await makeProgram({ json: true }).parseAsync([
			"node",
			"rine",
			"send",
			"--to",
			RECIPIENT,
			"--from",
			SENDER,
			"--type",
			"rine.v1.x402_payment_required",
			"--payload",
			JSON.stringify(QUOTE),
			...extra,
		]);
	}

	it("sets content_type, payload_schema and the payment-required marker", async () => {
		await sendQuote();
		expect(postBody?.content_type).toBe("application/json");
		expect(postBody?.payload_schema).toBe(
			"https://rine.network/schemas/v1/x402-payment-required.json",
		);
		expect(
			(postBody?.metadata as Record<string, unknown>)["rine.x402"],
		).toEqual({ status: "payment-required", rail: "x402" });
	});

	it("--no-marker omits the status marker but keeps the schema descriptors", async () => {
		await sendQuote("--no-marker");
		expect(postBody?.metadata).toBeUndefined();
		expect(postBody?.payload_schema).toBe(
			"https://rine.network/schemas/v1/x402-payment-required.json",
		);
	});

	it("a non-x402 type sends unchanged (no schema/marker injected)", async () => {
		await makeProgram({ json: true }).parseAsync([
			"node",
			"rine",
			"send",
			"--to",
			RECIPIENT,
			"--from",
			SENDER,
			"--type",
			"rine.v1.dm",
			"--payload",
			JSON.stringify({ hello: "world" }),
		]);
		expect(postBody?.payload_schema).toBeUndefined();
		expect(postBody?.metadata).toBeUndefined();
	});

	it("rejects a malformed x402 quote (no accepts[]) before sending", async () => {
		await makeProgram({ json: true }).parseAsync([
			"node",
			"rine",
			"send",
			"--to",
			RECIPIENT,
			"--from",
			SENDER,
			"--type",
			"rine.v1.x402_payment_required",
			"--payload",
			JSON.stringify({ x402Version: 2 }),
		]);
		expect(process.exitCode).toBe(1);
		expect(core.HttpClient.prototype.post).not.toHaveBeenCalled();
	});
});

// ── REQ-D03: rine agent set-pricing --x402-terms ────────────────────────────

describe("rine agent set-pricing — x402 terms (REQ-D03)", () => {
	let putBody: Record<string, unknown> | undefined;

	const TERMS = [
		{
			rail: "x402",
			schemes: ["exact"],
			networks: ["eip155:8453"],
			assets: [
				{
					symbol: "EURC",
					network: "eip155:8453",
					address: "0x0000000000000000000000000000000000000001",
				},
			],
			mode: "settle-first",
		},
	];

	function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
		const program = new Command();
		program.option("--json", "Output JSON");
		program.option("--profile <profile>", "Profile name");
		program.option("--as <handle>", "Act as agent");
		vi.spyOn(program, "opts").mockReturnValue(globalOpts);
		registerAgent(program);
		registerAgentProfile(program);
		return program;
	}

	beforeEach(() => {
		putBody = undefined;
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue({
			id: "card-1",
			agent_id: SENDER,
			rine: { pricing_model: "per_request" },
		});
		vi.spyOn(core.HttpClient.prototype, "put").mockImplementation(
			(_p: string, body?: unknown) => {
				putBody = body as Record<string, unknown>;
				return Promise.resolve(putBody);
			},
		);
	});

	async function setPricing(...args: string[]): Promise<void> {
		await makeProgram({ json: true }).parseAsync([
			"node",
			"rine",
			"agent",
			"set-pricing",
			SENDER,
			...args,
		]);
	}

	it("writes rine.x402.terms and leaves pricing_model untouched", async () => {
		await setPricing("--x402-terms", JSON.stringify(TERMS));
		const rine = putBody?.rine as Record<string, unknown>;
		expect((rine.x402 as Record<string, unknown>).terms).toEqual(TERMS);
		expect(rine.pricing_model).toBe("per_request");
	});

	it("still sets the pricing_model enum on its own", async () => {
		await setPricing("--model", "negotiated");
		const rine = putBody?.rine as Record<string, unknown>;
		expect(rine.pricing_model).toBe("negotiated");
		expect(rine.x402).toBeUndefined();
	});

	it("rejects an invalid pricing model (exit 2, no PUT)", async () => {
		await setPricing("--model", "bogus");
		expect(process.exitCode).toBe(2);
		expect(core.HttpClient.prototype.put).not.toHaveBeenCalled();
	});

	it("rejects terms that are not a JSON array (exit 2, no PUT)", async () => {
		await setPricing("--x402-terms", JSON.stringify({ not: "an array" }));
		expect(process.exitCode).toBe(2);
		expect(core.HttpClient.prototype.put).not.toHaveBeenCalled();
	});

	it("errors when neither model nor terms is provided (exit 2)", async () => {
		await setPricing();
		expect(process.exitCode).toBe(2);
		expect(core.HttpClient.prototype.put).not.toHaveBeenCalled();
	});
});
