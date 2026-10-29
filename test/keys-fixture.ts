import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, vi } from "vitest";
import * as actionModule from "../src/action.js";
import { registerKeys } from "../src/commands/keys.js";

export const AGENT_ID = "11111111-1111-1111-1111-111111111111";
export const ORG_ID = "22222222-2222-2222-2222-222222222222";

export let baseDir: string;
export let srcDir: string;
export let dstDir: string;
export let exportFile: string;
export let mockClient: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

/** Registers the temp dirs and the mocked client every keys suite runs against. */
export function useKeysFixture(): void {
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
		vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
		vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
		vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");

		mockClient = { get: vi.fn(), post: vi.fn() };
		vi.spyOn(actionModule, "createClient").mockResolvedValue({
			client: mockClient as unknown as core.HttpClient,
			profileName: "default",
			dirs: { configDir: "/tmp/test-rine-config", ownerDir: "/tmp/test-rine-owner" },
			auth: undefined,
			token: vi.fn(async () => "test-token"),
		});
		vi.spyOn(core, "fetchAgents").mockResolvedValue([
			{ id: AGENT_ID, handle: "bot@org.rine.network" } as never,
		]);
		vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		// Remove the unique temp dir created in beforeEach so real key material
		// and export files don't accumulate across runs.
		fs.rmSync(baseDir, { recursive: true, force: true });
	});
}

export function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerKeys(program);
	return program;
}

/** Every secret the agent holds, as base64url, so a round trip can be compared whole. */
export function secretsOf(keys: core.AgentKeys) {
	return {
		signing: core.toBase64Url(keys.signing.privateKey),
		encryption: core.toBase64Url(keys.encryption.privateKey),
		pqSeed: core.toBase64Url(keys.pqEncryption.seed),
		mls: core.toBase64Url(keys.mls.privateKey),
		keyGen: keys.keyGen,
	};
}

/** A profile that names the agent, the way an enrolled runtime's config dir does. */
export function saveOwnOrg(dir: string): void {
	core.saveProfiles(dir, {
		default: { org_id: ORG_ID, principal: `agent:${AGENT_ID}`, agent_id: AGENT_ID },
	});
}

export async function run(...argv: string[]): Promise<void> {
	await makeProgram({ json: false }).parseAsync(["node", "rine", "keys", ...argv]);
}
