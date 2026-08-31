/**
 * `rine group join` and the one MLS failure it does NOT swallow.
 *
 * Every MLS step on the group commands runs after the operation the operator
 * asked for has already succeeded on the server, so it warns rather than
 * failing the command. There is exactly one exception: a Welcome the
 * group substitution guard REFUSED. That is a security verdict about who minted
 * the Welcome, `rine.groups.join()` on the Python SDK already raises it, and a
 * failure that is loud on one stack and a warning line on the other is a defect
 * a user only meets on the quiet one.
 *
 * Driven through the real command with commander, because what changed is what
 * the operator sees: an error and a non-zero exit instead of a warning printed
 * under "Joined group (member)".
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";
import * as outputModule from "../src/output.js";

const CONFIG_DIR = "/tmp/test-rine-group-mls";
const API_URL = "https://test.rine.network";
const GROUP_ID = "88888888-8888-8888-8888-888888888888";
const OTHER_GROUP_ID = "99999999-9999-9999-9999-999999999999";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";

/** The refusal the guard mints, as `processMlsWelcomes` raises it. */
function refusal(groupId: string): core.MlsWelcomeRefusedError {
	return new core.MlsWelcomeRefusedError(
		groupId,
		"roster_uncorroborated",
		`Refusing the MLS welcome for group ${groupId}: the group's roster names ` +
			"no member holding a leaf in the ratchet tree this welcome seats the " +
			"agent in.",
	);
}

let printed: string[];
let errors: string[];

beforeEach(() => {
	printed = [];
	errors = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(outputModule, "printText").mockImplementation((s) => {
		printed.push(s);
	});
	vi.spyOn(outputModule, "printError").mockImplementation((s) => {
		errors.push(s);
	});
	vi.spyOn(outputModule, "printJson").mockImplementation(() => {});
	vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
	vi.spyOn(outputModule, "printMutationOk").mockImplementation(() => {});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "loadMlsState").mockReturnValue(null);
	vi.spyOn(core, "externalJoinMlsGroup").mockResolvedValue({ epoch: 2 });

	vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue({
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		group_id: GROUP_ID,
		agent_id: AGENT_ID,
		role: "member",
		joined_at: "2026-08-03T00:00:00Z",
	});
	vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue({
		id: GROUP_ID,
		name: "standup",
		mls_group_id: "mls-latch-abc",
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function run(args: string[]): Promise<unknown> {
	const program = new Command();
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue({});
	registerGroup(program);
	return program.parseAsync(["node", "rine", "group", ...args]);
}

describe("rine group join — a refused Welcome fails the command", () => {
	it("test_join_when_this_groups_welcome_is_refused_then_the_command_fails", async () => {
		vi.spyOn(core, "processMlsWelcomes").mockRejectedValue(refusal(GROUP_ID));

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBe(1);
		const said = errors.join("\n");
		expect(said).toContain("Refusing the MLS welcome for group");
		expect(said).toContain(GROUP_ID);
		// It must not read as a success with a footnote.
		expect(printed.join("\n")).not.toContain("Joined group (member)");
		// And it must not paper the substitution over with a self-join into
		// whatever the server hands out next.
		expect(core.externalJoinMlsGroup).not.toHaveBeenCalled();
	});

	/**
	 * The two-Welcome case, which is what the guard is actually up against: a
	 * batch carrying a refusal for the group being joined AND a decoy for
	 * another, with the decoy listed FIRST by the server. The mock is rine-core's
	 * `pickRefusal` rule (`mls-ops-join.ts`) — unscoped, the pass answers with
	 * the first refusal whose bytes arrived this pass, and the server chose that
	 * order by choosing the order of its own welcomes response.
	 *
	 * MEASURED against the real native core with two substituted Welcomes: the
	 * verb's outcome is `warned` unscoped and `raised` scoped, on that argument
	 * alone. Unscoped, `rine group join` printed "Joined group (member)" for a
	 * group whose Welcome this client had just refused, and went on to
	 * self-join it by external commit.
	 */
	it("test_join_when_the_server_orders_a_decoy_refusal_first_then_this_groups_refusal_still_fails_the_command", async () => {
		// Server response order: the decoy first, this group's refusal second.
		const batch = [refusal(OTHER_GROUP_ID), refusal(GROUP_ID)];
		vi.spyOn(core, "processMlsWelcomes").mockImplementation(
			(_dir, _agent, _client, opts) => {
				const chosen = opts?.forGroup
					? batch.find((r) => r.groupId === opts.forGroup)
					: batch[0];
				return chosen
					? Promise.reject(chosen)
					: Promise.resolve({ processed: 0, groupIds: [] });
			},
		);

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBe(1);
		const said = errors.join("\n");
		expect(said).toContain(GROUP_ID);
		expect(said).not.toContain(OTHER_GROUP_ID);
		expect(printed.join("\n")).not.toContain("Joined group (member)");
		expect(core.externalJoinMlsGroup).not.toHaveBeenCalled();
	});

	it("test_join_when_another_groups_welcome_is_refused_then_the_command_succeeds", async () => {
		vi.spyOn(core, "processMlsWelcomes").mockRejectedValue(
			refusal(OTHER_GROUP_ID),
		);

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBeUndefined();
		expect(printed.join("\n")).toContain("Joined group (member)");
		expect(printed.join("\n")).toContain(OTHER_GROUP_ID);
		expect(core.externalJoinMlsGroup).toHaveBeenCalledTimes(1);
	});

	it("test_join_when_an_ordinary_mls_step_fails_then_it_still_only_warns", async () => {
		// The control arm: a transient failure must not start failing a join
		// whose server-side half has already succeeded.
		vi.spyOn(core, "processMlsWelcomes").mockRejectedValue(
			new Error("socket hang up"),
		);

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBeUndefined();
		expect(printed.join("\n")).toContain("MLS welcome install failed");
		expect(printed.join("\n")).toContain("Joined group (member)");
	});
});
