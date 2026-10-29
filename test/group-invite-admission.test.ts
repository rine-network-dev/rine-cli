import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";

// `rine group invite --json` reports a client-side MLS add that failed. The
// server row is already written when that step runs, so the command still exits
// 0, but a script reading the JSON must be able to tell a failed admission from
// a group that has no ratchet tree or a call that only nominated.

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVITER_ID = "33333333-3333-4333-8333-333333333333";
const INVITEE_ID = "44444444-4444-4444-8444-444444444444";

const GROUP = {
	id: GROUP_ID,
	name: "ops",
	handle: "#ops@org.rine.network",
	enrollment_policy: "closed",
	visibility: "private",
	member_count: 2,
	created_at: "2026-06-01T00:00:00Z",
	mls_enabled: true,
	mls_group_id: "mls-internal-abc",
	mls_pending: false,
};

const VOUCHER = {
	id: "req-9",
	group_id: GROUP_ID,
	agent_id: INVITEE_ID,
	invited_by: INVITER_ID,
	status: "invited",
	created_at: "2026-06-13T00:00:00Z",
};

let printed: string[];

beforeEach(() => {
	printed = [];
	vi.spyOn(console, "log").mockImplementation((line: string) => {
		printed.push(String(line));
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue(VOUCHER);
	vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue(GROUP);
	vi.spyOn(core, "resolveToUuid").mockResolvedValue(INVITEE_ID);
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: INVITER_ID, handle: "coach@org.rine.network" } as never,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: INVITER_ID });
	vi.spyOn(core, "sendGroupInviteNotification").mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

async function invite(json: boolean): Promise<void> {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue({ json });
	registerGroup(program);
	await program.parseAsync([
		"node",
		"rine",
		"group",
		"invite",
		GROUP_ID,
		"--invitee",
		INVITEE_ID,
	]);
}

describe("group invite --json when the client-side MLS add fails", () => {
	it("carries the failure in an admission.error key and still exits 0", async () => {
		vi.spyOn(core, "addMlsGroupMembers").mockRejectedValue(new Error("stale epoch"));
		await invite(true);
		const out = JSON.parse(printed.join("\n"));
		expect(out.id).toBe("req-9");
		expect(out.admission.error).toContain("stale epoch");
		expect(process.exitCode).toBeUndefined();
	});

	it("prints no admission key for a group that has no ratchet tree", async () => {
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue({
			...GROUP,
			mls_group_id: null,
			mls_enabled: false,
		});
		await invite(true);
		expect(JSON.parse(printed.join("\n"))).not.toHaveProperty("admission");
	});
});
