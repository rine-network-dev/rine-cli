/**
 * `rine group join` and the one MLS failure it does NOT swallow.
 *
 * Every MLS step on the group commands runs after the operation the operator
 * asked for has already succeeded on the server, so it warns rather than
 * failing the command. There is exactly one exception: a refusal for the group
 * being joined, whether the Welcome guard's verdict on a Welcome or the seat
 * retake and external join meeting a tree the agent cannot verify. That is a
 * verdict about the group, `rine.groups.join()` on the Python SDK already
 * raises it, and a failure that is loud on one stack and a warning line on the
 * other is a defect a user only meets on the quiet one.
 *
 * The ladder behind the verb (Welcome, seat retake, external commit) is
 * rine-core's `establishMlsMembership`, tested against the real native core in
 * rine-core; this file drives the real command with commander and fakes that
 * one call, because what the CLI owns is what the operator sees: an error and
 * a non-zero exit instead of a warning printed under "Joined group (member)".
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

/** What the establishment answers when nothing failed. */
function established(outcome: core.MlsMembershipOutcome) {
	return { outcome } satisfies core.MlsMembershipResult;
}

/** What it answers when a step failed for a reason that is not a refusal. */
function failed(step: core.MlsEstablishStep, error: unknown): core.MlsMembershipResult {
	return {
		outcome: core.MlsMembershipOutcome.Failed,
		reason: String(error),
		failure: { step, error },
	};
}

/** The refusal the guard mints, as `establishMlsMembership` raises it. */
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
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "loadMlsState").mockReturnValue(null);
	vi.spyOn(core, "establishMlsMembership").mockResolvedValue(established("installed"));

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
	delete process.env.RINE_AGENT;
	process.exitCode = undefined;
});

function run(args: string[], opts: { json?: boolean } = {}): Promise<unknown> {
	const program = new Command();
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue(opts);
	registerGroup(program);
	return program.parseAsync(["node", "rine", "group", ...args]);
}

describe("rine group join — a refusal for the group fails the command", () => {
	it("test_join_when_this_groups_welcome_is_refused_then_the_command_fails", async () => {
		vi.spyOn(core, "establishMlsMembership").mockRejectedValue(refusal(GROUP_ID));

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBe(1);
		const said = errors.join("\n");
		expect(said).toContain("Refusing the MLS welcome for group");
		expect(said).toContain(GROUP_ID);
		// It must not read as a success with a footnote.
		expect(printed.join("\n")).not.toContain("Joined group (member)");
	});

	it("test_join_when_the_tree_holds_an_unverifiable_member_then_the_command_fails_with_and_without_json", async () => {
		vi.spyOn(core, "establishMlsMembership").mockRejectedValue(
			new core.MlsWelcomeRefusedError(
				GROUP_ID,
				"peer_not_admitted",
				`Cannot join the MLS group ${GROUP_ID} yet: its ratchet tree holds a member`,
			),
		);

		for (const json of [false, true]) {
			errors = [];
			printed = [];
			process.exitCode = undefined;

			await run(["join", GROUP_ID], { json });

			expect(process.exitCode).toBe(1);
			expect(errors.join("\n")).toContain("its ratchet tree holds a member");
			expect(printed.join("\n")).not.toContain("Joined group (member)");
			expect(printed.join("\n")).not.toContain("Warning");
		}
	});

	it("test_join_when_the_establishment_is_scoped_then_it_names_the_group_and_the_acting_agent", async () => {
		await run(["join", GROUP_ID]);

		expect(core.establishMlsMembership).toHaveBeenCalledWith(
			CONFIG_DIR,
			AGENT_ID,
			GROUP_ID,
			expect.anything(),
			{ [core.ACTING_AGENT_HEADER]: AGENT_ID },
		);
	});
});

describe("rine group join — a setup step that fails only warns", () => {
	it.each([
		["welcome_install", "MLS welcome install failed"],
		["seat_retake", "MLS seat retake failed"],
		["external_join", "MLS self-join failed"],
		["group_read", "MLS group read failed"],
	] as const)("test_join_when_the_%s_step_fails_then_it_only_warns", async (step, label) => {
		vi.spyOn(core, "establishMlsMembership").mockResolvedValue(
			failed(step, new Error("socket hang up")),
		);

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBeUndefined();
		expect(printed.join("\n")).toContain(`${label}: socket hang up`);
		expect(printed.join("\n")).toContain("Joined group (member)");
	});

	it("test_join_when_a_step_fails_under_json_then_nothing_is_printed_as_a_warning", async () => {
		vi.spyOn(core, "establishMlsMembership").mockResolvedValue(
			failed("welcome_install", new Error("socket hang up")),
		);

		await run(["join", GROUP_ID], { json: true });

		expect(process.exitCode).toBeUndefined();
		expect(printed.join("\n")).not.toContain("Warning");
	});

	it("test_join_when_the_setup_loses_the_epoch_race_then_the_warning_names_the_move", async () => {
		// The refusal every MLS commit verb can meet, in the one place these
		// commands used to quote a status code at an operator: `RineApiError`'s
		// own `409: MLS epoch conflict: group at epoch 5, commit targets 5`. Both
		// numbers are the server's and both are correct — `at 5, targets 5` is
		// what a commit built one epoch behind looks like — but an equal pair
		// reads as a contradiction, and nothing in it says what to do next.
		vi.spyOn(core, "establishMlsMembership").mockResolvedValue(
			failed(
				"seat_retake",
				new core.RineApiError(
					409,
					"MLS epoch conflict: group at epoch 5, commit targets 5",
					undefined,
					"epoch_conflict",
				),
			),
		);

		await run(["join", GROUP_ID]);

		const said = printed.join("\n");
		expect(said).not.toContain("409:");
		expect(said).not.toContain("commit targets 5");
		expect(said).toContain("Another member's commit landed first");
		expect(said).toContain(`rine group sync ${GROUP_ID}`);
	});
});

describe("rine group join — an agent that is already a member", () => {
	const ALREADY = new core.RineApiError(
		409,
		"Agent is already a member of this group",
		undefined,
		"already_a_member",
	);
	const MEMBER_ROW = {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		group_id: GROUP_ID,
		agent_id: AGENT_ID,
		role: "member",
		joined_at: "2026-08-03T00:00:00Z",
	};

	beforeEach(() => {
		process.env.RINE_AGENT = AGENT_ID;
		vi.spyOn(core, "seatedMemberAfterConflict").mockResolvedValue(MEMBER_ROW);
		vi.spyOn(core.HttpClient.prototype, "post").mockRejectedValue(ALREADY);
	});

	// The 409 path is rine-core's `seatedMemberAfterConflict` (its own contract,
	// the members read included, is tested there); this surface fakes that one
	// call and owns the acting agent it hands over and the rendering.
	it("test_join_when_already_a_member_with_no_state_and_the_setup_establishes_it_then_it_reports_joined", async () => {
		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBeUndefined();
		expect(printed.join("\n")).toContain("Joined group (member)");
		expect(core.seatedMemberAfterConflict).toHaveBeenCalledWith(
			ALREADY,
			expect.objectContaining({
				configDir: CONFIG_DIR,
				groupId: GROUP_ID,
				client: expect.any(core.HttpClient),
			}),
			expect.any(Function),
		);
		const [, join] = vi.mocked(core.seatedMemberAfterConflict).mock.calls[0] ?? [];
		await expect(join?.actingAgent()).resolves.toBe(AGENT_ID);
	});

	it("test_join_when_already_a_member_and_the_409_stands_then_the_409_is_raised", async () => {
		vi.spyOn(core, "seatedMemberAfterConflict").mockResolvedValue(null);

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain("already a member");
		expect(printed.join("\n")).not.toContain("Joined group (member)");
	});

	it("test_join_when_already_a_member_and_the_setup_fails_then_it_warns_with_the_step_and_raises_the_409", async () => {
		vi.spyOn(core, "seatedMemberAfterConflict").mockImplementation(async (_c, _j, onFailed) => {
			onFailed(failed(core.MlsEstablishStep.ExternalJoin, new Error("socket hang up")));
			return null;
		});

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBe(1);
		const said = printed.join("\n");
		expect(said.match(/MLS self-join failed: socket hang up/g)).toHaveLength(1);
		expect(said).not.toContain("Joined group (member)");
		expect(errors.join("\n")).toContain("already a member");
	});

	it("test_join_when_already_a_member_and_a_refusal_is_raised_then_the_refusal_is_reported", async () => {
		vi.spyOn(core, "seatedMemberAfterConflict").mockRejectedValue(refusal(GROUP_ID));

		await run(["join", GROUP_ID]);

		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain("Refusing the MLS welcome for group");
	});
});
