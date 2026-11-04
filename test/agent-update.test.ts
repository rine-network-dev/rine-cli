import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgent } from "../src/commands/agent.js";

// `rine agent update` sends what its flags name and nothing else. Every
// assertion is on what crossed the wire, with HTTP stubbed: the PATCH body for
// the flags that exist, and no PATCH at all for the ones that do not.

const API_URL = "https://test.rine.network";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";

let stderr: string[];
/** Every request that reached the network. */
let requests: { method: string; url: string; body: unknown }[];

function wire(): Command {
	requests = [];
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-agent-update");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		requests.push({
			method: String(init.method ?? "GET"),
			url: String(url),
			body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
		});
		return Promise.resolve(
			new Response(JSON.stringify({ id: AGENT_ID, warnings: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});

	const program = new Command();
	program.option("--json", "output as JSON");
	program.option("--profile <name>", "credential profile to use");
	program.exitOverride();
	program.configureOutput({ writeErr: () => {} });
	registerAgent(program);
	return program;
}

function run(args: string[]): Promise<unknown> {
	return wire().parseAsync(["node", "rine", "agent", "update", AGENT_ID, ...args]);
}

const patches = () => requests.filter((r) => r.method === "PATCH");

beforeEach(() => {
	stderr = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		stderr.push(parts.map(String).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	process.exitCode = undefined;
});

describe("rine agent update", () => {
	it("test_agent_update_when_name_is_passed_then_it_is_an_unknown_option_and_nothing_is_sent", async () => {
		await expect(run(["--name", "x"])).rejects.toMatchObject({
			code: "commander.unknownOption",
		});

		expect(patches()).toHaveLength(0);
	});

	it("test_agent_update_when_no_flag_is_given_then_it_exits_2_naming_the_flags_that_exist", async () => {
		await run([]);

		expect(process.exitCode).toBe(2);
		expect(stderr).toEqual([
			"At least one of --incoming-policy, --outgoing-policy, --human-oversight, --no-human-oversight, --unlisted or --no-unlisted is required",
		]);
		expect(patches()).toHaveLength(0);
	});

	it("test_agent_update_when_unlisted_is_passed_then_the_body_carries_true", async () => {
		await run(["--unlisted"]);

		expect(patches()).toHaveLength(1);
		expect(patches()[0]?.url).toBe(`${API_URL}/agents/${AGENT_ID}`);
		expect(patches()[0]?.body).toEqual({ unlisted: true });
	});

	it("test_agent_update_when_no_unlisted_is_passed_then_the_body_carries_false", async () => {
		await run(["--no-unlisted"]);

		expect(patches()[0]?.body).toEqual({ unlisted: false });
	});

	it("test_agent_update_when_unlisted_is_absent_then_the_body_omits_it", async () => {
		await run(["--incoming-policy", "groups_only"]);

		expect(patches()[0]?.body).toEqual({ incoming_policy: "groups_only" });
	});
});
