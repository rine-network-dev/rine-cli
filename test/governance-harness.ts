import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, vi } from "vitest";
import { registerAgentSuspend } from "../src/commands/agent-suspend.js";
import { registerOrgCounterparties } from "../src/commands/org-counterparties.js";
import { registerOrgDelegate } from "../src/commands/org-delegate.js";
import { registerOrgDomain } from "../src/commands/org-domain.js";
import {
	registerBranchHold,
	registerOrgFreeze,
} from "../src/commands/org-freeze.js";
import { registerOrgLogSettings } from "../src/commands/org-log-settings.js";
import { registerOrgRules } from "../src/commands/org-rules.js";
import { RUNTIME_MARKERS } from "../src/commands/runtime-warning.js";

export const ORG = "11111111-2222-4333-8444-555555555555";

/** What one test sees: the requests the client made, the lines printed, and the server's reply. */
export const h = {
	dir: "",
	calls: [] as { method: string; path: string; body?: unknown }[],
	out: [] as string[],
	reply: ((_method: string, _path: string): unknown => ({
		changed: true,
	})) as (method: string, path: string) => unknown,
	principal: { kind: core.PrincipalKind.Org, orgId: ORG } as core.Principal,
};

export function program(json = false): Command {
	const p = new Command();
	p.option("--json").option("--profile <p>");
	vi.spyOn(p, "opts").mockReturnValue(json ? { json: true } : {});
	const org = p.command("org");
	registerOrgFreeze(org, p);
	registerOrgRules(org, p);
	registerOrgDelegate(org, p);
	registerOrgCounterparties(org, p);
	registerOrgDomain(org, p);
	registerOrgLogSettings(org, p);
	registerBranchHold(org.command("branch"), p);
	registerAgentSuspend(p.command("agent"), p);
	return p;
}

export const run = (p: Command, ...argv: string[]) =>
	p.parseAsync(["node", "rine", ...argv]);

/** Mocks the config dirs, the auth and every HttpClient verb; call once at the top of a test file. */
export function useGovernanceHarness(): void {
	beforeEach(() => {
		for (const { vars } of RUNTIME_MARKERS)
			for (const v of vars) vi.stubEnv(v, "");
		h.dir = fs.mkdtempSync(join(tmpdir(), "rine-cli-gov-"));
		h.calls = [];
		h.out = [];
		h.principal = { kind: core.PrincipalKind.Org, orgId: ORG };
		h.reply = () => ({ changed: true });
		vi.spyOn(console, "log").mockImplementation(
			(m) => void h.out.push(String(m)),
		);
		vi.spyOn(console, "error").mockImplementation(
			(m) => void h.out.push(String(m)),
		);
		vi.spyOn(core, "resolveConfigDir").mockReturnValue(join(h.dir, "config"));
		vi.spyOn(core, "resolveOwnerDir").mockReturnValue(join(h.dir, "owner"));
		vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
		vi.spyOn(core, "resolveAuth").mockImplementation(
			() =>
				({
					signer: { principal: h.principal, seed: new Uint8Array(32) },
					orgId: ORG,
					cacheDir: h.dir,
				}) as core.ResolvedAuth,
		);
		vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("t");
		for (const method of ["get", "post", "put", "patch", "delete"] as const) {
			vi.spyOn(core.HttpClient.prototype, method).mockImplementation(((
				path: string,
				body?: unknown,
			) => {
				h.calls.push({ method, path, body });
				return Promise.resolve(h.reply(method, path));
			}) as never);
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		fs.rmSync(h.dir, { recursive: true, force: true });
		process.exitCode = undefined;
	});
}
