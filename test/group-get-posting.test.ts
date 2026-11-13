/**
 * `rine group get` says when our org's posts in the group are refused.
 *
 * The send path refuses before sealing; this is where an operator finds out why
 * ahead of the attempt. The line sits beside the encryption line and is absent
 * when posting is allowed, so a healthy group prints exactly what it printed
 * before.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";

const GROUP_ID = "44444444-4444-4444-4444-444444444444";
const MEMBER = "22222222-2222-4222-8222-222222222222";

let printed: string[];

function wire(extra: Record<string, unknown>): Command {
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-group-posting");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([]);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.stubGlobal("fetch", () =>
		Promise.resolve(
			new Response(
				JSON.stringify({
					id: GROUP_ID,
					name: "team",
					handle: "#team@acme.rine.network",
					description: "the team",
					enrollment_policy: "closed",
					visibility: "private",
					isolated: false,
					vote_duration_hours: 24,
					member_count: 4,
					member_agent_ids: [],
					conversation_id: null,
					mls_group_id: null,
					created_at: "2026-01-01T00:00:00Z",
					...extra,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
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

const get = (program: Command) =>
	program.parseAsync(["node", "rine", "group", "get", GROUP_ID]);

beforeEach(() => {
	printed = [];
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		printed.push(parts.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	process.exitCode = undefined;
});

describe("rine group get — the posting line", () => {
	it("says an open group owned by another organisation refuses our posts", async () => {
		await get(wire({ posting_refused: "foreign_open_group" }));

		expect(printed.join("\n")).toContain(
			"Posting: refused, this is an open group owned by another organisation.",
		);
	});

	it("counts the refused members when the rule names them", async () => {
		await get(
			wire({ posting_refused: "refused_members", refused_members: [MEMBER] }),
		);

		expect(printed.join("\n")).toContain(
			"Posting: refused, 1 members are from organisations outside your list.",
		);
	});

	it("prints no posting line when posting is allowed", async () => {
		await get(wire({ posting_refused: null }));

		expect(printed.join("\n")).not.toContain("Posting:");
	});

	it("prints no posting line for a value a newer server added", async () => {
		await get(wire({ posting_refused: "from_the_future" }));

		expect(printed.join("\n")).not.toContain("Posting:");
	});
});
