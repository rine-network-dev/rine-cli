/**
 * `rine group sync` — the two regimes it answers for, and its two exit codes.
 *
 * The command had no test of its own. What it does is choose: the recovery it
 * runs is `recoverGroup`'s to pick, but which sentence reaches the operator,
 * whether stdout or stderr carries it, and which exit code a script branches on
 * are all this file's — and none of them were pinned anywhere.
 *
 * Driven through the real command with commander, because every one of those is
 * something the operator sees. `recoverGroup` is mocked at the module boundary:
 * a real recovery needs MLS state on disk or a distribution inbox on the wire,
 * and neither says anything about the CLI's own behaviour.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";
import * as outputModule from "../src/output.js";
import { NO_ESCROW } from "./escrow-report.js";

const CONFIG_DIR = "/tmp/test-rine-group-sync";
const API_URL = "https://test.rine.network";
const GROUP_ID = "88888888-8888-8888-8888-888888888888";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";

let printed: string[];
let errors: string[];
let json: unknown[];

beforeEach(() => {
	printed = [];
	errors = [];
	json = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(outputModule, "printText").mockImplementation((s) => {
		printed.push(s);
	});
	vi.spyOn(outputModule, "printError").mockImplementation((s) => {
		errors.push(s);
	});
	vi.spyOn(outputModule, "printJson").mockImplementation((v) => {
		json.push(v);
	});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	// The acting-agent ladder's rung 4: one agent in the org, so the command
	// names an actor without the caller typing one.
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, name: "ops" } as core.AgentRead,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });

	vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue({
		id: GROUP_ID,
		name: "standup",
		handle: "#standup@acme.example",
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function run(args: string[], gOpts: Record<string, unknown> = {}) {
	const program = new Command();
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue(gOpts);
	registerGroup(program);
	return program.parseAsync(["node", "rine", "group", ...args]);
}

describe("rine group sync", () => {
	it("test_sync_when_the_group_runs_sender_keys_then_it_reports_what_was_installed_and_succeeds", async () => {
		vi.spyOn(core, "recoverGroup").mockResolvedValue({
			regime: "sender-key",
			ingested: 2,
			retired: false,
		});

		await run(["sync", GROUP_ID]);

		// An open group is not a refusal: it prints on stdout and exits 0.
		expect(process.exitCode).toBeUndefined();
		expect(errors).toEqual([]);
		const said = printed.join("\n");
		expect(said).toContain("installed 2 sender key(s)");
		// And it must not describe a ladder the group has not got. It DOES say
		// "has no epoch chain" — the absence is the point of the sentence — so
		// what is ruled out is a rung and a commit, not the word.
		expect(said).not.toContain("Replayed");
		expect(said).not.toContain("Resynced");
		expect(said).toContain("nothing was committed");
	});

	it("test_sync_when_this_agents_keys_were_retired_then_it_still_succeeds_and_says_to_retry", async () => {
		vi.spyOn(core, "recoverGroup").mockResolvedValue({
			regime: "sender-key",
			ingested: 0,
			retired: true,
		});

		await run(["sync", GROUP_ID]);

		// A retirement is a state of the group, not a failure of the command —
		// and the gate that reports it fails closed, so the operator is told to
		// retry before they are told to find an admin.
		expect(process.exitCode).toBeUndefined();
		expect(printed.join("\n")).toContain("run the sync again");
	});

	it("test_sync_when_the_group_runs_mls_then_it_reports_the_rung_it_ran", async () => {
		vi.spyOn(core, "recoverGroup").mockResolvedValue({
			regime: "mls",
			rung: "replay",
			fromEpoch: 1,
			epoch: 4,
			behind: 3,
			processed: 3,
			evicted: false,
			escrow: NO_ESCROW,
		});

		await run(["sync", GROUP_ID]);

		expect(process.exitCode).toBeUndefined();
		const said = printed.join("\n");
		expect(said).toContain("Replayed 3 commit(s)");
		expect(said).toContain("epoch 4");
	});

	it("test_sync_when_it_succeeds_then_the_summary_names_the_rows_handle_not_the_argument", async () => {
		// 🔴 The pin the wave's own named trap was missing. `group-sync.ts` used
		// to hand its raw `<group-ref>` argument to `describeMlsRecovery`, so
		// the summary would echo whichever of three spellings the
		// operator happened to type — while the in-flight guard three lines
		// above, and the Python twin, both print the row's handle. One event,
		// two sentences, decided by the caller's typing: exactly the drift
		// a single shared formatter exists to stop.
		//
		// A mutation reverting `label` to the argument left every other test in
		// this file green, which is why this one drives the SUCCESS path
		// specifically — the failing paths were already covered and the
		// recovering one was not.
		vi.spyOn(core, "recoverGroup").mockResolvedValue({
			regime: "mls",
			rung: "replay",
			fromEpoch: 1,
			epoch: 4,
			behind: 3,
			processed: 3,
			evicted: false,
			escrow: NO_ESCROW,
		});

		// Addressed by UUID, so the argument and the row's handle differ and
		// the assertion can tell which one was printed.
		await run(["sync", GROUP_ID]);

		const said = printed.join("\n");
		expect(said).toContain("group #standup@acme.example");
		expect(said).not.toContain(GROUP_ID);
	});

	it("test_sync_when_the_recovery_reports_an_eviction_then_that_sentence_names_the_handle_too", async () => {
		// The other arm of the same label: `mlsFailureText` only spends the ref
		// it is given on the inactive-group branch, so the success pin above
		// cannot reach it. The eviction sentence is the one an evicted operator
		// reads, and it must not be the only line of the run that says a UUID.
		vi.spyOn(core, "recoverGroup").mockRejectedValue(
			Object.assign(new Error("group is inactive"), {
				code: core.MLS_ERR_GROUP_INACTIVE,
			}),
		);

		await run(["sync", GROUP_ID]);

		// Not the resync-unavailable remedy: this agent is out, and no retry
		// and no admin puts it back without a fresh invite.
		expect(process.exitCode).toBe(1);
		const said = errors.join("\n");
		expect(said).toContain("You were removed from group #standup@acme.example");
		expect(said).not.toContain(GROUP_ID);
	});

	it("test_sync_when_json_is_asked_for_then_the_union_is_printed_and_no_prose", async () => {
		const result: core.GroupRecoveryResult = {
			regime: "sender-key",
			ingested: 0,
			retired: false,
		};
		vi.spyOn(core, "recoverGroup").mockResolvedValue(result);

		await run(["sync", GROUP_ID], { json: true });

		// `regime` is what a reader branches on, so it has to survive the
		// projection — a JSON answer without it cannot be told from an MLS one.
		expect(json).toEqual([result]);
		expect(printed).toEqual([]);
	});

	it("test_sync_when_local_mls_state_will_not_load_then_it_exits_2", async () => {
		vi.spyOn(core, "recoverGroup").mockRejectedValue(
			new core.MlsResyncUnavailableError(GROUP_ID),
		);

		await run(["sync", GROUP_ID]);

		// Its own exit code, because the remedy is an admin's and not a retry.
		expect(process.exitCode).toBe(2);
		expect(errors.join("\n")).toContain("Ask an admin to remove this agent");
		expect(printed).toEqual([]);
	});

	it("test_sync_when_the_agent_rotated_its_key_then_it_exits_2_and_names_the_remedy", async () => {
		vi.spyOn(core, "recoverGroup").mockRejectedValue(
			new core.MlsRotatedLeafError(AGENT_ID, GROUP_ID),
		);

		await run(["sync", GROUP_ID]);

		// The remedy is a member's (remove and re-invite), not a retry.
		expect(process.exitCode).toBe(2);
		const said = errors.join("\n");
		expect(said).toContain("still carries a key it has since rotated away from");
		expect(said).toContain("remove the agent and invite it again");
		expect(printed).toEqual([]);
	});

	it("test_sync_when_the_groups_mls_init_has_not_landed_yet_then_it_exits_2_without_recovering", async () => {
		// Driven through the row the command already fetched, because that is
		// where the refusal now lives: the in-flight window is decided from the
		// server's own fields before any recovery is attempted, so the operator
		// is told to wait without the command spending a single MLS read.
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue({
			id: GROUP_ID,
			name: "standup",
			handle: "#standup@acme.example",
			mls_group_id: null,
			mls_pending: true,
		});
		const recover = vi.spyOn(core, "recoverGroup");

		await run(["sync", GROUP_ID]);

		// Exit 2 across this CLI means "the command declined to act" — which is
		// what this is, and what `@rine-network/cli` published for this case.
		// A script branching on 2 to mean "sync cannot work here" is reading it
		// correctly; 1 would say the sync ran and failed.
		expect(process.exitCode).toBe(2);
		expect(recover).not.toHaveBeenCalled();
		expect(printed).toEqual([]);
		const said = errors.join("\n");
		expect(said).toContain("still founding its MLS state");
		// 🔴 The row's handle, never the argument the operator typed. The throw
		// this guard bypasses formats `handle ?? id` (`group-recovery.ts`)
		// because the Python twin formats the row's handle, so echoing the UUID
		// here is one event printing two sentences depending on which SDK a
		// surface wraps. Bypassing the throw must not bypass what it said.
		expect(said).toContain("Group #standup@acme.example is still founding");
		expect(said).not.toContain(GROUP_ID);
		// And the remedy IS a retry, unlike the unavailable case above — the
		// server clears this state itself.
		expect(said).toContain("run the sync again then");
		expect(said).not.toContain("Ask an admin");
	});

	it("test_sync_when_the_groups_tree_was_never_founded_then_it_succeeds_and_names_the_verb", async () => {
		// 🔴 This is no longer a refusal: the group is not frozen, so the
		// scan installs the keys that really were waiting and the warning rides
		// on the answer. It leaves `exitCode` unset, and a script that read the
		// old exit 1 as "sync cannot work here" now sees the success it is.
		vi.spyOn(core, "recoverGroup").mockResolvedValue({
			regime: "sender-key",
			ingested: 3,
			retired: false,
			mlsNeverFoundedNote: core.mlsNeverFoundedSync("cli-resume-admission"),
		});

		await run(["sync", GROUP_ID]);

		expect(process.exitCode).toBeUndefined();
		expect(errors).toEqual([]);
		const said = printed.join("\n");
		expect(said).toContain("installed 3 sender key(s)");
		expect(said).toContain("ratchet tree was never founded");
		expect(said).toContain("Run rine group resume-admission on it");
	});

	it("test_sync_when_the_groups_tree_was_never_founded_and_json_then_the_note_is_a_field", async () => {
		// `--json` is a script's answer, and a warning only a human can read is
		// no warning at all there. Absent, never null, on a group that has the
		// encryption it was created for.
		vi.spyOn(core, "recoverGroup").mockResolvedValue({
			regime: "sender-key",
			ingested: 3,
			retired: false,
			mlsNeverFoundedNote: core.mlsNeverFoundedSync("cli-resume-admission"),
		});

		await run(["sync", GROUP_ID], { json: true });

		const payload = json[0] as Record<string, unknown>;
		expect(payload.regime).toBe("sender-key");
		expect(payload.mlsNeverFoundedNote).toContain("never founded");
		expect(printed).toEqual([]);
	});

	it("test_sync_when_it_recovers_then_it_offers_the_founding_verb_this_surface_has", async () => {
		// The wiring, not the sentence: `recoverGroup` names a verb only if its
		// caller passes one, and the default is to name none. A CLI that dropped
		// this argument would refuse in words that send an operator nowhere,
		// while every assertion above still passed.
		const spy = vi.spyOn(core, "recoverGroup").mockResolvedValue({
			regime: "sender-key",
			ingested: 0,
			retired: false,
		});

		await run(["sync", GROUP_ID]);

		expect(spy.mock.calls[0]?.[5]).toBe("cli-resume-admission");
	});
});
