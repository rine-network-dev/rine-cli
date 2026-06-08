import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actionModule from "../src/action.js";
import { registerKeys } from "../src/commands/keys.js";
import * as outputModule from "../src/output.js";

// A9 / regression for T3: PQ (ML-KEM) private keys must survive a
// `keys export` -> `keys import` round-trip. The hybrid PQ work added a
// 2400-byte pq_encryption.key alongside the classical signing/encryption
// keys; if export drops the field or import never writes the file, an
// hpke-hybrid-v1 agent silently loses post-quantum decryptability.
//
// These tests drive the REAL `registerKeys` export+import commands against
// real temp config directories and real key material, then load the result
// back and assert the PQ key bytes are identical. Reverting T3 (export
// omitting pq_encryption_private_key, or import not writing pq_encryption.key)
// makes the round-tripped pqEncryption disappear and fails the assertions.

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

let baseDir: string;
let srcDir: string;
let dstDir: string;
let exportFile: string;
let mockClient: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	baseDir = fs.mkdtempSync(join(os.tmpdir(), "rine-keys-test-"));
	const base = baseDir;
	srcDir = join(base, "src");
	dstDir = join(base, "dst");
	exportFile = join(base, "export.json");
	fs.mkdirSync(srcDir, { recursive: true });
	fs.mkdirSync(dstDir, { recursive: true });

	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");

	mockClient = { get: vi.fn(), post: vi.fn() };
	vi.spyOn(actionModule, "createClient").mockResolvedValue({
		client: mockClient as unknown as core.HttpClient,
		profileName: "default",
		entry: { client_id: "test-id", client_secret: "test-secret" },
	});
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, handle: "bot@org.rine.network" } as never,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue(AGENT_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	// Remove the unique temp dir created in beforeEach so real key material
	// and export files don't accumulate across runs.
	fs.rmSync(baseDir, { recursive: true, force: true });
});

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerKeys(program);
	return program;
}

/** Asserts the PQ keypair is present and returns its base64url private key. */
function pqPrivB64(keys: core.AgentKeys): string {
	expect(keys.pqEncryption).toBeDefined();
	const pq = keys.pqEncryption;
	if (!pq) throw new Error("expected pqEncryption keypair");
	return core.toBase64Url(pq.privateKey);
}

describe("keys export/import — PQ key round-trip (A9 / T3)", () => {
	it("preserves the post-quantum key through export then import", async () => {
		// Real key material including an ML-KEM-768 PQ keypair.
		const agentKeys = core.generateAgentKeys();
		const originalPqPriv = pqPrivB64(agentKeys);
		core.saveAgentKeys(srcDir, AGENT_ID, agentKeys);

		// `keys export` reads from the withClient ctx configDir.
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);
		const exportProgram = makeProgram({ json: false });
		await exportProgram.parseAsync([
			"node",
			"rine",
			"keys",
			"export",
			"--agent",
			AGENT_ID,
			"--output",
			exportFile,
		]);

		// The export file itself must carry the PQ private key.
		const exported = JSON.parse(fs.readFileSync(exportFile, "utf-8"));
		expect(exported.pq_encryption_private_key).toBe(originalPqPriv);

		// `keys import` writes into resolveConfigDir() — point it at a fresh dir.
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(dstDir);
		const importProgram = makeProgram({ json: false });
		await importProgram.parseAsync([
			"node",
			"rine",
			"keys",
			"import",
			"--input",
			exportFile,
		]);

		// Load the imported identity and confirm the PQ key survived intact.
		const reloaded = core.loadAgentKeys(dstDir, AGENT_ID);
		expect(pqPrivB64(reloaded)).toBe(originalPqPriv);
		// And the on-disk PQ key file is exactly the 2400-byte ML-KEM secret.
		const pqFile = join(dstDir, "keys", AGENT_ID, "pq_encryption.key");
		expect(fs.existsSync(pqFile)).toBe(true);
		expect(
			core.fromBase64Url(fs.readFileSync(pqFile, "utf-8").trim()),
		).toHaveLength(2400);
		expect(process.exitCode).toBeUndefined();
	});

	it("imports an export file that contains a PQ key without error", async () => {
		const agentKeys = core.generateAgentKeys();
		const expectedPq = pqPrivB64(agentKeys);
		const exportPayload = {
			agent_id: AGENT_ID,
			signing_private_key: core.toBase64Url(agentKeys.signing.privateKey),
			encryption_private_key: core.toBase64Url(agentKeys.encryption.privateKey),
			pq_encryption_private_key: expectedPq,
		};
		fs.writeFileSync(exportFile, JSON.stringify(exportPayload));

		vi.spyOn(core, "resolveConfigDir").mockReturnValue(dstDir);
		const printErrorSpy = vi.spyOn(outputModule, "printError");

		const program = makeProgram({ json: false });
		await program.parseAsync([
			"node",
			"rine",
			"keys",
			"import",
			"--input",
			exportFile,
		]);

		expect(printErrorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		const reloaded = core.loadAgentKeys(dstDir, AGENT_ID);
		expect(pqPrivB64(reloaded)).toBe(expectedPq);
	});
});

describe("keys add-pq", () => {
	it("adds PQ key for an agent without one", async () => {
		const agentKeys = core.generateAgentKeys();
		const originalSigPriv = core.toBase64Url(agentKeys.signing.privateKey);
		const originalEncPriv = core.toBase64Url(agentKeys.encryption.privateKey);
		core.saveAgentKeys(srcDir, AGENT_ID, {
			signing: agentKeys.signing,
			encryption: agentKeys.encryption,
		});
		const pqFile = join(srcDir, "keys", AGENT_ID, "pq_encryption.key");

		vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);

		let postedBody: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "POST") {
				postedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
				return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response(JSON.stringify({
				agent_id: AGENT_ID,
				signing_public_key: postedBody?.signing_public_key,
				encryption_public_key: postedBody?.encryption_public_key,
				pq_encryption_public_key: postedBody?.pq_encryption_public_key,
			}), { status: 200, headers: { "content-type": "application/json" } });
		});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "keys", "add-pq", "--agent", AGENT_ID]);

		expect(process.exitCode).toBeUndefined();
		expect(fs.existsSync(pqFile)).toBe(true);

		const reloaded = core.loadAgentKeys(srcDir, AGENT_ID);
		expect(core.toBase64Url(reloaded.signing.privateKey)).toBe(originalSigPriv);
		expect(core.toBase64Url(reloaded.encryption.privateKey)).toBe(originalEncPriv);
		expect(reloaded.pqEncryption).toBeDefined();
		expect(core.fromBase64Url(fs.readFileSync(pqFile, "utf-8").trim())).toHaveLength(2400);

		expect(postedBody).toBeDefined();
		expect((postedBody?.signing_public_key as { x: string }).x).toBe(
			core.toBase64Url(agentKeys.signing.publicKey),
		);
		expect(postedBody?.pq_encryption_public_key).toBeDefined();
	});

	it("refuses when no keys exist", async () => {
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);
		const printErrorSpy = vi.spyOn(outputModule, "printError");

		const program = makeProgram({ json: false });
		await program.parseAsync([
			"node",
			"rine",
			"keys",
			"add-pq",
			"--agent",
			AGENT_ID,
		]);

		expect(process.exitCode).toBe(1);
		expect(printErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("No keys found"),
		);
	});

	it("refuses when PQ key already exists", async () => {
		// Generate full keys including PQ.
		const agentKeys = core.generateAgentKeys();
		core.saveAgentKeys(srcDir, AGENT_ID, agentKeys);

		vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);
		const printErrorSpy = vi.spyOn(outputModule, "printError");

		const program = makeProgram({ json: false });
		await program.parseAsync([
			"node",
			"rine",
			"keys",
			"add-pq",
			"--agent",
			AGENT_ID,
		]);

		expect(process.exitCode).toBe(1);
		expect(printErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("already has a post-quantum key"),
		);
	});
});
