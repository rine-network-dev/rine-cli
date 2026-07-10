import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actionModule from "../src/action.js";
import { registerVerifyIdentity } from "../src/commands/verify-identity.js";
import * as outputModule from "../src/output.js";

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

const AGENT: core.AgentRead = {
	id: "agent-uuid",
	name: "my-agent",
	handle: "my-agent@test-org.rine.network",
	incoming_policy: "open",
	outgoing_policy: "open",
	human_oversight: true,
	unlisted: false,
	created_at: "2026-01-01T00:00:00Z",
	revoked_at: null,
};

const RESULT = {
	agent_id: "agent-uuid",
	spiffe_id: "spiffe://prod.acme.example/web",
	trust_domain: "prod.acme.example",
	trust_tier: 2,
	verified_at: "2026-06-30T00:00:00Z",
};

function makeProgram(globalOpts: Record<string, unknown> = {}): {
	program: Command;
	client: { post: ReturnType<typeof vi.fn> };
} {
	const client = { post: vi.fn() };
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([AGENT]);
	vi.spyOn(actionModule, "createClient").mockResolvedValue({
		client: client as unknown as core.HttpClient,
		profileName: "default",
		entry: undefined,
	});

	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	program.option("--as <agent>", "Act as agent");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerVerifyIdentity(program);
	return { program, client };
}

describe("verify-identity command", () => {
	it("resolves the agent and calls verifyIdentitySpiffe with --svid", async () => {
		const spy = vi
			.spyOn(core, "verifyIdentitySpiffe")
			.mockResolvedValue(RESULT);
		const { program } = makeProgram({ json: false });

		await program.parseAsync([
			"node",
			"rine",
			"verify-identity",
			"--svid",
			"the.jwt.svid",
		]);

		expect(core.fetchAgents).toHaveBeenCalled();
		expect(spy).toHaveBeenCalledWith(expect.anything(), "agent-uuid", {
			svid: "the.jwt.svid",
		});
	});

	it("passes an explicit --agent through to resolution", async () => {
		const resolveSpy = vi
			.spyOn(core, "resolveAgent")
			.mockResolvedValue("agent-uuid");
		vi.spyOn(core, "verifyIdentitySpiffe").mockResolvedValue(RESULT);
		const { program } = makeProgram({ json: false });

		await program.parseAsync([
			"node",
			"rine",
			"verify-identity",
			"--agent",
			"my-agent",
			"--svid",
			"jwt",
		]);

		expect(resolveSpy).toHaveBeenCalledWith(
			"https://test.rine.network",
			[AGENT],
			"my-agent",
			undefined,
		);
	});

	it("prints the typed result as JSON in --json mode", async () => {
		vi.spyOn(core, "verifyIdentitySpiffe").mockResolvedValue(RESULT);
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});
		const { program } = makeProgram({ json: true });

		await program.parseAsync([
			"node",
			"rine",
			"verify-identity",
			"--svid",
			"jwt",
		]);

		expect(printJsonSpy).toHaveBeenCalledWith(RESULT);
	});

	it("surfaces a typed verification error (no silent no-op) via the error handler", async () => {
		vi.spyOn(core, "verifyIdentitySpiffe").mockRejectedValue(
			new core.SpiffeVerificationError(
				"no svid and no endpoint",
				"no-svid",
			),
		);
		const printErrorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		const { program } = makeProgram({ json: false });

		await program.parseAsync(["node", "rine", "verify-identity"]);

		expect(printErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("no svid"),
		);
		expect(process.exitCode).toBe(1);
	});
});
