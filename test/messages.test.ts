import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessages } from "../src/commands/messages.js";
import * as outputModule from "../src/output.js";

// A10 / regression for C3: `rine read` must recognise hpke-hybrid-v1 messages
// as decryptable. The hybrid PQ work added a new encryption_version, but the
// read command's canDecrypt gate originally only matched hpke-v1 and
// sender-key-v1, so hybrid messages silently fell through to the raw
// "Encrypted Payload" fallback and were never decrypted.
//
// These tests drive the REAL `read` command with a message whose
// encryption_version === "hpke-hybrid-v1". canDecrypt is the gate that
// decides whether core.decryptMessage is invoked at all. Reverting C3
// (dropping "hpke-hybrid-v1" from the canDecrypt union) makes canDecrypt
// false, so decryptMessage is never called and the decrypted payload is
// never shown — failing every assertion below.
//
// SCOPE — IMPORTANT: these CLI tests cover ONLY the CLI-layer gate
// (`canDecrypt` in src/commands/messages.ts) and the read command's
// observable rendering. core.decryptMessage is intentionally mocked here,
// so these tests do NOT exercise the cryptographic VERSION_HYBRID
// byte-routing inside core/crypto/message.ts. That dispatch — including the
// regression where a hpke-hybrid-v1 ciphertext must NOT silently fall back
// to classical HPKE — is owned by rine-core/test/crypto/message-hybrid.test.ts
// (see its `describe("decryptMessage version dispatch")` block). Keep the
// split intentional: do not try to assert real PQ decryption here.

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const MESSAGE_ID = "msg-hybrid-1";

const HYBRID_MESSAGE: core.MessageRead = {
	id: MESSAGE_ID,
	conversation_id: "conv-1",
	type: "rine.v1.dm",
	from_agent_id: "22222222-2222-2222-2222-222222222222",
	to_agent_id: AGENT_ID,
	sender_handle: "alice@org.rine.network",
	recipient_handle: "bot@org.rine.network",
	encrypted_payload: "AABBCCDD-hybrid-ciphertext",
	encryption_version: "hpke-hybrid-v1",
	created_at: "2026-01-15T12:00:00Z",
} as unknown as core.MessageRead;

const DECRYPT_RESULT = {
	plaintext: JSON.stringify({ hello: "post-quantum" }),
	senderKid: "rine:22222222-2222-2222-2222-222222222222",
	verified: true,
	verificationStatus: "verified" as const,
};

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");

	// withClient (action.ts) builds a real HttpClient internally, so intercept
	// the GET at the prototype level rather than mocking createClient.
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			if (path === `/messages/${MESSAGE_ID}`) {
				return Promise.resolve(HYBRID_MESSAGE);
			}
			return Promise.reject(new Error(`Unknown path: ${path}`));
		},
	);
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, handle: "bot@org.rine.network" } as never,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue(AGENT_ID);
	// Recipient holds local keys, so canDecrypt depends purely on the version.
	vi.spyOn(core, "agentKeysExist").mockReturnValue(true);
	vi.spyOn(core, "ingestSenderKeyDistribution").mockReturnValue(false);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerMessages(program);
	return program;
}

describe("read command — hpke-hybrid-v1 is decryptable (A10 / C3)", () => {
	it("invokes decryptMessage for a hybrid message", async () => {
		const decryptSpy = vi
			.spyOn(core, "decryptMessage")
			.mockResolvedValue(DECRYPT_RESULT);
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		// Reverting C3 makes canDecrypt false → this is never called.
		expect(decryptSpy).toHaveBeenCalledTimes(1);
		expect(decryptSpy).toHaveBeenCalledWith(
			"/tmp/test-rine",
			AGENT_ID,
			HYBRID_MESSAGE.encrypted_payload,
			expect.any(core.HttpClient),
		);

		// Observable outcome: the rendered row must be the decrypted view, not
		// the raw "Encrypted Payload" fallback. This guards against decryptMessage
		// being invoked but its result never reaching the output.
		const row = printTableSpy.mock.calls.at(-1)?.[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(row).not.toHaveProperty("Encrypted Payload");
	});

	it("renders the decrypted payload, not the raw encrypted fallback (text)", async () => {
		vi.spyOn(core, "decryptMessage").mockResolvedValue(DECRYPT_RESULT);
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		const row = printTableSpy.mock.calls.at(-1)?.[0]?.[0] as Record<
			string,
			unknown
		>;
		// Decrypted path emits a Payload/Verified row; the raw fallback would
		// instead emit "Encrypted Payload" + "Encryption" keys.
		expect(row).toHaveProperty(
			"Payload",
			DECRYPT_RESULT.plaintext.slice(0, 200),
		);
		expect(row).toHaveProperty("Verified", "✓");
		expect(row).not.toHaveProperty("Encrypted Payload");
		expect(row).not.toHaveProperty("Encryption");
	});

	it("emits decrypted_payload in JSON mode for a hybrid message", async () => {
		vi.spyOn(core, "decryptMessage").mockResolvedValue(DECRYPT_RESULT);
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		expect(printJsonSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: MESSAGE_ID,
				decrypted_payload: { hello: "post-quantum" },
				signature_verified: true,
				verification_status: "verified",
			}),
		);
	});

	it("falls back to raw encrypted output when hybrid decryption fails", async () => {
		// Distinct branch from the success cases above: canDecrypt is still true
		// for a hybrid message (so the gate is exercised), but decryptMessage
		// rejects. The read command must then emit the raw message WITHOUT a
		// decrypted_payload key rather than crashing or pretending it decrypted.
		const decryptSpy = vi
			.spyOn(core, "decryptMessage")
			.mockRejectedValue(new Error("pq private key missing"));
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		// The gate let us reach decryptMessage (proves canDecrypt was true for
		// the hybrid version)...
		expect(decryptSpy).toHaveBeenCalledTimes(1);
		// ...but decryption threw, so the raw fallback is emitted instead.
		const arg = printJsonSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(arg).not.toHaveProperty("decrypted_payload");
		expect(arg).toHaveProperty(
			"encryption_version",
			"hpke-hybrid-v1",
		);
	});
});
