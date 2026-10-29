import * as fs from "node:fs";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import * as outputModule from "../src/output.js";
import { derivedAgentKeys } from "./derived-keys.js";
import {
	AGENT_ID,
	ORG_ID,
	dstDir,
	exportFile,
	makeProgram,
	mockClient,
	run,
	saveOwnOrg,
	secretsOf,
	srcDir,
	useKeysFixture,
} from "./keys-fixture.js";

// chmodSync passes through unless a test disarms it.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

useKeysFixture();

// The agent's leaf keys are derived from the org root: five files per agent
// (signing, encryption, ML-KEM seed, MLS leaf, key generation). `keys export`
// and `keys import` must carry all five, or an imported agent cannot open its
// MLS groups or decrypt under the right generation.
describe("keys export/import", () => {
	it("round-trips every secret, including the PQ seed, MLS key and generation", async () => {
		const agentKeys = derivedAgentKeys(AGENT_ID, 3);
		core.saveAgentKeys(srcDir, AGENT_ID, agentKeys);
		saveOwnOrg(srcDir);

		vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);
		await run("export", "--agent", AGENT_ID, "--output", exportFile);
		const exported = JSON.parse(fs.readFileSync(exportFile, "utf-8"));
		expect(exported.org_id).toBe(ORG_ID);
		expect(exported.pq_encryption_seed).toBe(core.toBase64Url(agentKeys.pqEncryption.seed));

		vi.spyOn(core, "resolveConfigDir").mockReturnValue(dstDir);
		await run("import", "--input", exportFile);

		expect(secretsOf(core.loadAgentKeys(dstDir, AGENT_ID))).toEqual(secretsOf(agentKeys));
		const pqFile = join(dstDir, "keys", AGENT_ID, "pq_encryption.key");
		expect(core.fromBase64Url(fs.readFileSync(pqFile, "utf-8").trim())).toHaveLength(64);
		expect(process.exitCode).toBeUndefined();
	});

	// A key file is created at 0600, never written at the umask default and
	// narrowed afterwards: with every later chmod disarmed, the mode on disk is
	// the one the file was created with.
	it("creates the export file and every imported key file at mode 0600", async () => {
		core.saveAgentKeys(srcDir, AGENT_ID, derivedAgentKeys(AGENT_ID, 2));
		saveOwnOrg(srcDir);
		vi.mocked(fs.chmodSync).mockImplementation(() => {});
		const umask = process.umask(0o022);
		try {
			vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);
			await run("export", "--agent", AGENT_ID, "--output", exportFile);
			vi.spyOn(core, "resolveConfigDir").mockReturnValue(dstDir);
			await run("import", "--input", exportFile);
		} finally {
			process.umask(umask);
		}

		const modeOf = (path: string) => fs.statSync(path).mode & 0o777;
		expect(modeOf(exportFile)).toBe(0o600);
		const keyDir = join(dstDir, "keys", AGENT_ID);
		for (const name of ["signing.key", "encryption.key", "pq_encryption.key", "mls.key", "key_gen"]) {
			expect([name, modeOf(join(keyDir, name))]).toEqual([name, 0o600]);
		}
	});

	it("refuses to export when no profile names the agent's org, writing nothing", async () => {
		core.saveAgentKeys(srcDir, AGENT_ID, derivedAgentKeys(AGENT_ID, 1));

		vi.spyOn(core, "resolveConfigDir").mockReturnValue(srcDir);
		await run("export", "--agent", AGENT_ID, "--output", exportFile);

		expect(fs.existsSync(exportFile)).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("refuses an export file that lacks the MLS key, writing nothing", async () => {
		const agentKeys = derivedAgentKeys(AGENT_ID);
		const exported = {
			agent_id: AGENT_ID,
			signing_private_key: core.toBase64Url(agentKeys.signing.privateKey),
			encryption_private_key: core.toBase64Url(agentKeys.encryption.privateKey),
			pq_encryption_seed: core.toBase64Url(agentKeys.pqEncryption.seed),
			key_gen: 0,
		};
		fs.writeFileSync(exportFile, JSON.stringify(exported));
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(dstDir);
		const printErrorSpy = vi.spyOn(outputModule, "printError");

		await run("import", "--input", exportFile);

		expect(process.exitCode).toBe(2);
		expect(printErrorSpy).toHaveBeenCalledWith("Invalid key export file");
		expect(fs.existsSync(join(dstDir, "keys", AGENT_ID))).toBe(false);
	});

	it("refuses a PQ value that is not the 64-byte seed", async () => {
		const agentKeys = derivedAgentKeys(AGENT_ID);
		const exported = {
			agent_id: AGENT_ID,
			signing_private_key: core.toBase64Url(agentKeys.signing.privateKey),
			encryption_private_key: core.toBase64Url(agentKeys.encryption.privateKey),
			pq_encryption_seed: core.toBase64Url(agentKeys.pqEncryption.privateKey),
			mls_private_key: core.toBase64Url(agentKeys.mls.privateKey),
			key_gen: 0,
		};
		fs.writeFileSync(exportFile, JSON.stringify(exported));
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(dstDir);
		const printErrorSpy = vi.spyOn(outputModule, "printError");

		await run("import", "--input", exportFile);

		expect(process.exitCode).toBe(2);
		expect(printErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Invalid PQ encryption seed"),
		);
	});

	it("refuses an agent_id that is not a UUID, so it cannot name a path", async () => {
		const agentKeys = derivedAgentKeys(AGENT_ID);
		const exported = {
			agent_id: "../../escape",
			signing_private_key: core.toBase64Url(agentKeys.signing.privateKey),
			encryption_private_key: core.toBase64Url(agentKeys.encryption.privateKey),
			pq_encryption_seed: core.toBase64Url(agentKeys.pqEncryption.seed),
			mls_private_key: core.toBase64Url(agentKeys.mls.privateKey),
			key_gen: 0,
		};
		fs.writeFileSync(exportFile, JSON.stringify(exported));
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(dstDir);

		await run("import", "--input", exportFile);

		expect(process.exitCode).toBe(2);
		expect(fs.existsSync(join(dstDir, "keys"))).toBe(false);
	});
});
