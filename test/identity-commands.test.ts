import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../src/commands/auth.js";
import { registerOrg } from "../src/commands/org.js";
import * as outputModule from "../src/output.js";

const ORG = {
	id: "11111111-2222-3333-4444-555555555555",
	name: "Acme",
	slug: "acme",
	trust_tier: 1,
	agent_count: 2,
	created_at: "2026-01-01T00:00:00Z",
};
const PHRASE = "abandon ability able about above absent absorb abstract";

let gets: string[];

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerAuth(program);
	registerOrg(program);
	return program;
}

function setStdoutTty(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	gets = [];
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			gets.push(path);
			if (path !== "/whoami") return Promise.reject(new Error(`403 ${path}`));
			return Promise.resolve({
				org: ORG,
				principal: { kind: "branch", branch: "partner", agent_id: null },
				agents: [],
			});
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

describe("org summary commands read /whoami", () => {
	// /org is org-only on the server: a branch or agent runtime dir that asked
	// for it would be refused, so every summary read goes through /whoami.
	it("rine status reads the org through /whoami", async () => {
		const printJson = vi.spyOn(outputModule, "printJson").mockImplementation(() => {});

		await makeProgram({ json: true }).parseAsync(["node", "rine", "status"]);

		expect(gets).toEqual(["/whoami"]);
		expect(printJson).toHaveBeenCalledWith(ORG);
	});

	it("rine org get reads the org through /whoami", async () => {
		await makeProgram({}).parseAsync(["node", "rine", "org", "get"]);

		expect(gets).toEqual(["/whoami"]);
	});
});

describe("rine whoami", () => {
	it("reads the org through /whoami for an agent-only runtime dir", async () => {
		const AGENT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
		vi.spyOn(core, "resolveAuth").mockReturnValue({
			cacheDir: "/tmp/test-rine",
			agentId: AGENT_ID,
			signer: {
				principal: { kind: core.PrincipalKind.Agent, agentId: AGENT_ID },
			},
		} as never);
		const printJson = vi.spyOn(outputModule, "printJson").mockImplementation(() => {});

		await makeProgram({ json: true }).parseAsync(["node", "rine", "whoami"]);

		expect(gets).not.toContain("/org");
		expect(gets[0]).toBe("/whoami");
		expect(printJson).toHaveBeenCalledWith(
			expect.objectContaining({ org: { name: "Acme", slug: "acme" } }),
		);
	});

	// The server answers the keys read with 404 only when it does not know the
	// agent (unknown, erased org); any other failure leaves the question open,
	// and the label says so.
	it.each([
		[new core.RineApiError(404, "Agent not found"), "server: agent not found"],
		[new core.RineApiError(503, "unavailable"), "could not check"],
		[new TypeError("fetch failed"), "could not check"],
	])("labels the server keys from the keys read failing with %s", async (failure, label) => {
		const AGENT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
		vi.spyOn(core, "resolveAuth").mockReturnValue({
			cacheDir: "/tmp/test-rine",
			agentId: AGENT_ID,
			signer: {
				principal: { kind: core.PrincipalKind.Agent, agentId: AGENT_ID },
			},
		} as never);
		vi.spyOn(core, "fetchAgents").mockResolvedValue([
			{ id: AGENT_ID, handle: "bot@acme" },
		] as never);
		vi.spyOn(core, "agentKeysExist").mockReturnValue(false);
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation((path: string) =>
			path === "/whoami"
				? Promise.resolve({ org: ORG, principal: {}, agents: [] })
				: Promise.reject(failure),
		);
		const printJson = vi.spyOn(outputModule, "printJson").mockImplementation(() => {});

		await makeProgram({ json: true }).parseAsync(["node", "rine", "whoami"]);

		expect(printJson).toHaveBeenCalledWith(
			expect.objectContaining({ agent_id: AGENT_ID, keys: label }),
		);
	});
});

describe("rine logout", () => {
	const AGENT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
	const principal = { kind: core.PrincipalKind.Agent, agentId: AGENT_ID };

	it("clears only this principal's cached token and keeps the others", async () => {
		vi.spyOn(core, "resolveAuth").mockReturnValue({
			cacheDir: "/tmp/test-rine",
			signer: { principal },
		} as never);
		vi.spyOn(core, "loadTokenCache").mockReturnValue({
			[core.principalString(principal)]: { token: "mine" },
			"org:other": { token: "theirs" },
		} as never);
		const save = vi.spyOn(core, "saveTokenCache").mockImplementation(() => {});

		await makeProgram({}).parseAsync(["node", "rine", "logout"]);

		expect(save).toHaveBeenCalledWith("/tmp/test-rine", {
			"org:other": { token: "theirs" },
		});
	});

	it("says there is nothing to clear when no identity resolves", async () => {
		const save = vi.spyOn(core, "saveTokenCache").mockImplementation(() => {});

		await makeProgram({}).parseAsync(["node", "rine", "logout"]);

		expect(save).not.toHaveBeenCalled();
	});
});

describe("rine org phrase", () => {
	const original = process.stdout.isTTY;

	afterEach(() => setStdoutTty(original));

	it("refuses off a terminal and prints no words", async () => {
		setStdoutTty(false);
		const readPhrase = vi.spyOn(core, "readOwnerPhrase").mockReturnValue(PHRASE);
		const printError = vi.spyOn(outputModule, "printError").mockImplementation(() => {});

		await makeProgram({}).parseAsync(["node", "rine", "org", "phrase"]);

		expect(printError).toHaveBeenCalledWith(expect.stringContaining("terminal only"));
		expect(process.exitCode).toBe(2);
		expect(readPhrase).not.toHaveBeenCalled();
	});

	it("prints the framed phrase on a terminal, without claiming it is shown once", async () => {
		setStdoutTty(true);
		vi.spyOn(core, "readOwnerPhrase").mockReturnValue(PHRASE);
		const log = vi.spyOn(console, "log");

		await makeProgram({}).parseAsync(["node", "rine", "org", "phrase"]);

		const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain(PHRASE);
		expect(printed).toContain(core.PHRASE_INSTRUCTION);
		expect(printed).not.toContain("shown once");
		expect(process.exitCode).toBeUndefined();
	});
});
