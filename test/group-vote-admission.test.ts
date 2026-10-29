import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";

// `rine group vote --json` reports a client-side MLS add that failed. The vote is
// already recorded when that step runs, so the command still exits 0, but a script
// reading the JSON must be able to tell an applicant who was not given a leaf from
// one whose group has no ratchet tree.

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTING_ID = "33333333-3333-4333-8333-333333333333";
const APPLICANT_ID = "44444444-4444-4444-8444-444444444444";

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

const PENDING = { items: [{ id: "req-9", agent_id: APPLICANT_ID }] };

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
	vi.spyOn(core.HttpClient.prototype, "post").mockResolvedValue({ status: "approved" });
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(async (path: string) =>
		path.endsWith("/requests") ? PENDING : GROUP,
	);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: ACTING_ID });
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

async function approve(json: boolean): Promise<void> {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue({ json });
	registerGroup(program);
	await program.parseAsync(["node", "rine", "group", "vote", GROUP_ID, "req-9", "--vote", "approve"]);
}

describe("group vote --json when the client-side MLS add fails", () => {
	it("carries the failure in an admission.error key and still exits 0", async () => {
		vi.spyOn(core, "addMlsGroupMembers").mockRejectedValue(new Error("stale epoch"));
		await approve(true);
		const out = JSON.parse(printed.join("\n"));
		expect(out.status).toBe("approved");
		expect(out.admission.error).toContain("stale epoch");
		expect(process.exitCode).toBeUndefined();
	});

	it("carries a failure to read the group the same way", async () => {
		let groupReads = 0;
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(async (path: string) => {
			if (path.endsWith("/requests")) return PENDING;
			// The first read resolves the reference; the one before the add is the one that fails.
			if (++groupReads === 1) return GROUP;
			throw new Error("group read refused");
		});
		await approve(true);
		expect(JSON.parse(printed.join("\n")).admission.error).toContain("group read refused");
	});

	it("prints no admission key for a group that has no ratchet tree", async () => {
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(async (path: string) =>
			path.endsWith("/requests") ? PENDING : { ...GROUP, mls_group_id: null, mls_enabled: false },
		);
		await approve(true);
		expect(JSON.parse(printed.join("\n"))).not.toHaveProperty("admission");
	});

	it("reports the seated result beside the vote when the add lands", async () => {
		const seated = { added: 1, outcomes: [{}], commits: 1, epoch: 4 };
		vi.spyOn(core, "addMlsGroupMembers").mockResolvedValue(seated as never);
		await approve(true);
		expect(JSON.parse(printed.join("\n")).admission).toEqual(seated);
	});

	it("seats nobody and posts nothing else when the vote leaves the request pending", async () => {
		const post = vi
			.spyOn(core.HttpClient.prototype, "post")
			.mockResolvedValue({ status: "pending" });
		const add = vi.spyOn(core, "addMlsGroupMembers").mockResolvedValue({} as never);
		await approve(true);
		expect(add).not.toHaveBeenCalled();
		expect(post).toHaveBeenCalledTimes(1);
		const out = JSON.parse(printed.join("\n"));
		expect(out.status).toBe("pending");
		expect(out).not.toHaveProperty("admission");
	});
});
