/**
 * `rine group get` — the wiring between the handle map and the cell that prints it.
 *
 * `group-rows.test.ts` asserts the RENDERER: handed a map, the cell prints
 * handles. `own-agents.test.ts` asserts the MAP: which agents reach it at all.
 * What neither of them can see is whether the command hands the second to the
 * first — `groupDetailRow(data)` with the argument dropped prints UUIDs while
 * every sentence in the product still says handle, and both of those suites
 * stay green through it. This is that gate, asserted on what the operator
 * reads.
 *
 * The other half is the fetch. One `GET /agents` is accepted on a command
 * that names no actor; it did not accept one on a group where no seat would be
 * spelled, because that row prints `NO_OWN_AGENTS` whichever map it is handed.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";
import { NO_OWN_AGENTS } from "../src/commands/group-rows.js";

const API_URL = "https://test.rine.network";
const GROUP_ID = "44444444-4444-4444-4444-444444444444";
const OPS = "22222222-2222-4222-8222-222222222222";
const BILLING = "33333333-3333-4333-8333-333333333333";

function agent(name: string, id: string): core.AgentRead {
	return {
		id,
		name,
		handle: `${name}@acme.rine.network`,
		incoming_policy: "open",
		outgoing_policy: "open",
		human_oversight: true,
		unlisted: false,
		created_at: "2026-01-01T00:00:00Z",
		revoked_at: null,
	} as core.AgentRead;
}

const AGENTS = [agent("ops", OPS), agent("billing", BILLING)];

/** The group as the server reports it. `mls_group_id` stays null so the read
 * consults no local ratchet state — this is a rendering gate, not an MLS one. */
function group(seated: string[]): Record<string, unknown> {
	return {
		id: GROUP_ID,
		name: "team",
		handle: "#team@acme.rine.network",
		description: "the team",
		enrollment_policy: "closed",
		visibility: "private",
		isolated: false,
		vote_duration_hours: 24,
		member_count: 4,
		member_agent_ids: seated,
		conversation_id: null,
		mls_group_id: null,
		created_at: "2026-01-01T00:00:00Z",
	};
}

let printed: string[];
/** How many times the org's agent list was fetched, which is the whole cost. */
let agentListFetches: number;

function wire(
	seated: string[],
	agents: () => Promise<core.AgentRead[]> = async () => AGENTS,
): Command {
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-group-get");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "fetchAgents").mockImplementation(() => {
		agentListFetches += 1;
		return agents();
	});
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	} as core.CredentialEntry);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.stubGlobal("fetch", () =>
		Promise.resolve(
			new Response(JSON.stringify(group(seated)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	);

	const program = new Command();
	program.option("--json", "output as JSON");
	program.option("--profile <name>", "credential profile to use");
	program.exitOverride();
	program.configureOutput({ writeErr: () => {} });
	registerGroup(program);
	return program;
}

function run(program: Command): Promise<unknown> {
	return program.parseAsync(["node", "rine", "group", "get", GROUP_ID]);
}

beforeEach(() => {
	printed = [];
	agentListFetches = 0;
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		printed.push(parts.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	process.exitCode = undefined;
});

describe("rine group get — the seated ids reach the operator as handles", () => {
	it("prints the handles of this org's seated agents, not their UUIDs", async () => {
		await run(wire([OPS, BILLING]));

		const table = printed.join("\n");
		expect(table).toContain("ops@acme.rine.network");
		expect(table).toContain("billing@acme.rine.network");
		expect(table).not.toContain(OPS);
	});

	it("prints a seated id the agent list cannot answer for as the id", async () => {
		// Case 2 of the rendering rule, and the reason the command does not
		// fail: the group read already succeeded, so an unreadable agent list
		// degrades the cell rather than the command.
		await run(
			wire([OPS], async () => {
				throw new Error("503 from /agents");
			}),
		);

		expect(printed.join("\n")).toContain(OPS);
		expect(process.exitCode).toBeUndefined();
	});

	it("buys no agent list for a group this org holds no seat in", async () => {
		// `rine group get` names no actor, so nothing else on this path has paid
		// for the list — and an empty seat list renders the same sentence
		// whichever map it is handed, so fetching one would answer nothing.
		await run(wire([]));

		expect(agentListFetches).toBe(0);
		expect(printed.join("\n")).toContain(NO_OWN_AGENTS);
	});
});
