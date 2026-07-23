// `rine wallet create|address|policy` command group. These tests drive
// the REAL commands via Commander.parseAsync against a real temp configDir, so
// the rine-core wallet/policy primitives (createWallet, getWalletAddress,
// loadPolicy/savePolicy) run for real; only the network/auth boundary is mocked.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWallet } from "../src/commands/wallet.js";

const API_URL = "https://test.rine.network";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";

let CONFIG_DIR: string;

beforeEach(() => {
	CONFIG_DIR = fs.mkdtempSync(join(tmpdir(), "rine-wallet-test-"));
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
		{ id: AGENT_ID, name: "bot" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue(AGENT_ID);
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
	registerWallet(program);
	return program;
}

function walletKeyPath(): string {
	return join(CONFIG_DIR, "keys", AGENT_ID, "wallet.key");
}

function run(...argv: string[]): Promise<Command> {
	return makeProgram({ json: true }).parseAsync(["node", "rine", ...argv]);
}

describe("rine wallet — command group", () => {
	it("registers create, address and policy subcommands", () => {
		const wallet = makeProgram().commands.find((c) => c.name() === "wallet");
		const names = wallet?.commands.map((c) => c.name()).sort();
		expect(names).toEqual(["address", "create", "policy"]);
	});
});

describe("rine wallet create", () => {
	it("writes a secp256k1 wallet key at keys/{agentId}/wallet.key (0600)", async () => {
		await run("wallet", "create", "--agent", AGENT_ID);
		const p = walletKeyPath();
		expect(fs.existsSync(p)).toBe(true);
		expect(fs.statSync(p).mode & 0o777).toBe(0o600);
	});

	it("prints a checksummed EVM address for the new wallet", async () => {
		const lines: string[] = [];
		(console.log as ReturnType<typeof vi.fn>).mockImplementation(
			(...a: unknown[]) => lines.push(a.map(String).join(" ")),
		);
		await run("wallet", "create", "--agent", AGENT_ID);
		const obj = lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((o) => o?.address);
		expect(obj.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
	});

	it("refuses to overwrite an existing wallet (exit 1, key unchanged)", async () => {
		await run("wallet", "create", "--agent", AGENT_ID);
		const before = fs.readFileSync(walletKeyPath(), "utf-8");
		await run("wallet", "create", "--agent", AGENT_ID);
		expect(process.exitCode).toBe(1);
		expect(fs.readFileSync(walletKeyPath(), "utf-8")).toBe(before);
	});
});

describe("rine wallet address", () => {
	it("prints the same address the wallet was created with", async () => {
		const { address } = core.createWallet(CONFIG_DIR, AGENT_ID);
		const lines: string[] = [];
		(console.log as ReturnType<typeof vi.fn>).mockImplementation(
			(...a: unknown[]) => lines.push(a.map(String).join(" ")),
		);
		await run("wallet", "address", "--agent", AGENT_ID);
		expect(lines.join("\n")).toContain(address);
	});

	it("errors (exit 1) when no wallet exists", async () => {
		await run("wallet", "address", "--agent", AGENT_ID);
		expect(process.exitCode).toBe(1);
	});
});

describe("rine wallet policy", () => {
	it("reports deny-by-default when no policy is configured", async () => {
		const lines: string[] = [];
		(console.log as ReturnType<typeof vi.fn>).mockImplementation(
			(...a: unknown[]) => lines.push(a.map(String).join(" ")),
		);
		await run("wallet", "policy", "--agent", AGENT_ID);
		const obj = lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((o) => o && "effective" in o);
		expect(obj.effective).toBe("deny-by-default");
		expect(obj.policy).toBeNull();
	});

	it("policy set persists a policy that loadPolicy then returns", async () => {
		await run(
			"wallet",
			"policy",
			"set",
			"--agent",
			AGENT_ID,
			"--per-tx-cap",
			"5.00",
			"--daily-cap",
			"50.00",
			"--allowed-assets",
			"EURC,USDC",
			"--allowed-networks",
			"eip155:8453",
			"--auto-pay-threshold",
			"0.50",
		);
		const stored = core.loadPolicy(CONFIG_DIR, AGENT_ID);
		expect(stored).toEqual({
			perTxCap: "5.00",
			dailyCap: "50.00",
			allowedAssets: ["EURC", "USDC"],
			allowedNetworks: ["eip155:8453"],
			autoPayThreshold: "0.50",
		});
	});

	it("policy set rejects a non-decimal cap (validatePolicy) and writes nothing", async () => {
		await run(
			"wallet",
			"policy",
			"set",
			"--agent",
			AGENT_ID,
			"--per-tx-cap",
			"not-a-number",
			"--daily-cap",
			"50.00",
			"--allowed-assets",
			"EURC",
			"--allowed-networks",
			"eip155:8453",
		);
		expect(process.exitCode).toBe(1);
		expect(core.loadPolicy(CONFIG_DIR, AGENT_ID)).toBeNull();
	});
});
