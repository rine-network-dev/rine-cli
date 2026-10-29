import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";
import * as outputModule from "../src/output.js";

// What `rine group requests` tells a member before they spend a call on a vote.
//
// A join request is decided by the members the group had when it was filed, and
// only by those of them who are still in it, so the row has to carry four
// numbers and one verdict: approvals that count, how many more the approval bar
// wants, where the denial bar stands, how many eligible voters are still there,
// and whether this reader's own vote would count. Denials refuse it on that
// same electorate, so both bars fall as members leave. The command is driven for
// real through commander; only the HTTP boundary is stubbed.

const CONFIG_DIR = "/tmp/test-rine-electorate";
const API_URL = "https://test.rine.network";
const GROUP_ID = "88888888-8888-8888-8888-888888888888";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const APPLICANT = "22222222-2222-2222-2222-222222222222";

type Request = core.JoinRequestRead;

function request(overrides: Partial<Request> = {}): Request {
	return {
		id: "req-1",
		group_id: GROUP_ID,
		agent_id: APPLICANT,
		status: "pending",
		created_at: "2026-08-03T00:00:00Z",
		expires_at: "2026-08-06T00:00:00Z",
		quorum_total_members: 9,
		electorate_size: 3,
		approvals: 1,
		denials: 0,
		approvals_needed: 1,
		denials_needed: 2,
		you_may_vote: true,
		you_may_vote_reason: "in_electorate",
		...overrides,
	} as Request;
}

/** Every row the command handed to the table renderer. */
let rows: Record<string, unknown>[];

beforeEach(() => {
	rows = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(outputModule, "printTable").mockImplementation((r) => {
		rows = r as Record<string, unknown>[];
	});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, handle: "bot@acme.rine.network" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

/** Run `group requests` against one request, and hand back the row it rendered. */
async function renderRow(item: Request): Promise<Record<string, unknown>> {
	// Path-aware: the verb resolves its group argument before it
	// reads the queue, so `GET /groups/{id}` is a second, different call and a
	// blanket body would answer it with a page that names no group at all.
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(async (path: string) =>
			path === `/groups/${GROUP_ID}`
				? { id: GROUP_ID, handle: "#ops@acme.rine.network" }
				: { items: [item], total: 1 }) as never,
	);
	const program = new Command();
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue({});
	registerGroup(program);
	await program.parseAsync(["node", "rine", "group", "requests", GROUP_ID]);
	const row = rows[0];
	if (!row) throw new Error("the command rendered no rows");
	return row;
}

describe("group requests — the bar, and whether your vote counts", () => {
	it("reports the shortfall and says an eligible member can vote", async () => {
		const row = await renderRow(request());

		// `1 of 2`, never a bare `1`: the wire carries the SHORTFALL, and this
		// row's one approval against a shortfall of one used to print
		// `Approved 1 | Needed 1` — which reads as carried on a request that is
		// still open. The threshold is the shortfall added back on.
		expect(row.Approved).toBe("1 of 2");
		expect(row.Needed).toBe(1);
		expect(row.Eligible).toBe(3);
		expect(row["Can Vote"]).toBe("you can vote");
	});

	// The whole of the vote-table fix in one row: both bars stand at one vote cast and one more
	// wanted, so a cast-of-shortfall rendering prints `1 of 1` for each and says
	// the request is simultaneously carried and refused. Read together, the two
	// cells must agree on one convention and both must say the request is open.
	it("renders both bars in one convention, so neither reads as met", async () => {
		const row = await renderRow(
			request({ approvals: 1, approvals_needed: 1, denials: 1, denials_needed: 1 }),
		);

		expect(row.Approved).toBe("1 of 2");
		expect(row.Denials).toBe("1 of 2");
		expect(row.Needed).toBe(1);
	});

	it("never quotes a bar it cannot know, on a request that already met one", async () => {
		// The clamped arm. The server's shortfall is `max(required - cast, 0)`,
		// so a request whose electorate shrank below what it already holds
		// reports `needed = 0` and stays PENDING — nothing votes again, so
		// nothing recomputes it. Adding the shortfall back on gives `3 of 3`
		// about a request whose bar is 2: the meaning survives and the number an
		// operator quotes does not. Zero proves an upper bound, not a value, and
		// that is the whole of what the cell may claim.
		const row = await renderRow(
			request({
				approvals: 3,
				approvals_needed: 0,
				denials: 0,
				denials_needed: 2,
				electorate_size: 3,
			}),
		);

		expect(row.Approved).toBe("3 of 3 or fewer");
		expect(row.Approved).not.toBe("3 of 3");
		// The other bar is untouched: a clamp on one says nothing about the other.
		expect(row.Denials).toBe("0 of 2");
		expect(row.Needed).toBe(0);
	});

	it("tells a member who joined after filing that their vote would not count", async () => {
		const row = await renderRow(
			request({
				you_may_vote: false,
				you_may_vote_reason: "not_in_electorate",
			}),
		);

		expect(row["Can Vote"]).toBe(
			"you cannot vote: you were not in the group when this was filed",
		);
	});

	it("says nobody eligible is left, and prints no bar, when the electorate has gone", async () => {
		const row = await renderRow(
			request({
				electorate_size: 0,
				approvals: 0,
				approvals_needed: null,
				denials_needed: null,
				you_may_vote: false,
				you_may_vote_reason: "electorate_empty",
			}),
		);

		expect(row.Eligible).toBe(0);
		// Neither bar is reachable: the request stands until it expires. What has
		// been cast is still known and still printed — it is the threshold that
		// cannot be computed, so the dash sits on the right of the `of`.
		expect(row.Needed).toBe("—");
		expect(row.Approved).toBe("0 of —");
		expect(row.Denials).toBe("0 of —");
		expect(row["Can Vote"]).toBe("nobody eligible is still in the group");
	});

	// ── the denial bar is a column, not a shortfall against nothing ────────────

	it("reports the denials cast against the count that would refuse the request", async () => {
		// Two rows of one bar. Nothing cast yet is the case where shortfall and
		// threshold coincide, which is exactly why the old rendering read as
		// correct; the second row is where they part, and one denial of the two
		// this bar takes must not print as `1 of 1`.
		expect(
			(await renderRow(request({ denials: 0, denials_needed: 2 }))).Denials,
		).toBe("0 of 2");
		expect(
			(await renderRow(request({ denials: 1, denials_needed: 1 }))).Denials,
		).toBe("1 of 2");
	});

	it("renders a denial bar the server did not report as a dash and never as zero", async () => {
		// "no more denials are needed" and "this server does not report the denial
		// bar" are different facts, and `0` would tell the operator the request is
		// one denial from refusal.
		const row = await renderRow(request({ denials: 0, denials_needed: null }));

		expect(row.Denials).toBe("0 of —");
	});

	it("renders a whole denial cell the server said nothing about as one dash", async () => {
		const row = await renderRow(
			request({ denials: null, denials_needed: null }),
		);

		expect(row.Denials).toBe("—");
	});

	// ── Two reason tokens the vocabulary gained, so that each one predicts the
	// refusal a vote would actually hit: an applicant reading its own request
	// used to be told it was not in the electorate, which named a reason the
	// server does not refuse on, and a request no recorded electorate can decide
	// had no token at all. One reason per outcome is the invariant this whole
	// read model rests on. ─────────────────────────────────────────────────────

	it("tells a reader looking at its own request that it is theirs", async () => {
		const row = await renderRow(
			request({
				you_may_vote: false,
				you_may_vote_reason: "is_applicant",
			}),
		);

		expect(row["Can Vote"]).toBe("this is your own request");
	});

	it("does not call a request no recorded electorate can decide an empty one", async () => {
		const row = await renderRow(
			request({
				electorate_size: null,
				approvals_needed: null,
				denials_needed: null,
				you_may_vote: false,
				you_may_vote_reason: "bar_unreachable",
			}),
		);

		expect(row["Can Vote"]).toBe("nobody can decide this request");
	});

	// The nomination row too: it is born carrying the nominating member's
	// own approval, so `Approved: 1 of 2` on an untouched request is ordinary, and the
	// nominator reads their vote as counted rather than as one they still owe.
	it("names the vote already cast", async () => {
		const row = await renderRow(
			request({
				your_vote: "approve",
				you_may_vote: false,
				you_may_vote_reason: "already_voted",
			}),
		);

		expect(row.Approved).toBe("1 of 2");
		expect(row["Your Vote"]).toBe("approve");
		expect(row["Can Vote"]).toBe("you already voted approve");
	});

	it("says any member may vote on a request filed before electorates were recorded", async () => {
		const row = await renderRow(
			request({
				electorate_size: null,
				approvals_needed: 2,
				you_may_vote_reason: "electorate_not_recorded",
			}),
		);

		expect(row.Eligible).toBe("");
		// An unrecorded electorate does not make the bar unknown: the server still
		// says how many more approvals it takes, so the threshold is still a sum.
		expect(row.Approved).toBe("1 of 3");
		expect(row["Can Vote"]).toBe(
			"you can vote (filed before the electorate was recorded; any member may)",
		);
	});

	it("leaves the counts blank on an invitation, which nobody votes on", async () => {
		const row = await renderRow(
			request({
				status: "invited",
				quorum_total_members: null,
				electorate_size: null,
				approvals: null,
				denials: null,
				approvals_needed: null,
				denials_needed: null,
				you_may_vote: false,
				you_may_vote_reason: "not_pending",
			}),
		);

		expect(row.Approved).toBe("");
		expect(row.Needed).toBe("");
		expect(row.Denials).toBe("—");
		expect(row.Eligible).toBe("");
		expect(row["Can Vote"]).toBe("not open for voting");
	});

	it("does not offer a vote on an invitation an older server said nothing about", async () => {
		// A flat `electorate_not_recorded` fallback reads "you can vote" — on the
		// one population nobody votes on, and which `POST …/vote` answers 422 for.
		const row = await renderRow(
			request({
				status: "invited",
				quorum_total_members: null,
				electorate_size: null,
				approvals: null,
				denials: null,
				approvals_needed: null,
				denials_needed: null,
				you_may_vote: undefined,
				you_may_vote_reason: undefined,
			}),
		);

		expect(row["Can Vote"]).toBe("not open for voting");
	});

	// Updated deliberately when the denial bar landed, never deleted: the row
	// went 10 columns to 11, `Denials` sits between `Needed` and `Eligible`, and
	// everything the row carried before the electorate was reported is still
	// here and still in order. A guard that only counts columns would not catch
	// a reorder.
	it("keeps every column it had before the electorate was reported", async () => {
		const row = await renderRow(request({ message: "let me in" }));

		expect(Object.keys(row)).toEqual([
			"Request ID",
			"Agent ID",
			"Message",
			"Approved",
			"Needed",
			"Denials",
			"Eligible",
			"Your Vote",
			"Can Vote",
			"Expires",
			"Created",
		]);
		expect(row["Request ID"]).toBe("req-1");
		expect(row["Agent ID"]).toBe(APPLICANT);
		expect(row.Message).toBe("let me in");
		expect(row.Expires).toBe("2026-08-06T00:00:00Z");
		expect(row.Created).toBe("2026-08-03T00:00:00Z");
	});
});

// The rule is founder-pinned verbatim and every surface renders the same
// sentence. Putting the denial bar on the wire re-pinned it, and it lived in
// this command as a hand-wrapped literal — which is how that re-pin of the
// Python constant left five TypeScript surfaces stating the old rule with
// nothing to catch it. Asserting the constant reaches `--help` is what makes the
// next re-pin one edit rather than six.
describe("group vote — the electorate rule, from the one constant", () => {
	it("states the pinned rule verbatim in its help text", () => {
		const program = new Command();
		program.option("--json", "Output JSON");
		registerGroup(program);
		const group = program.commands.find((c) => c.name() === "group");
		const vote = group?.commands.find((c) => c.name() === "vote");

		expect(vote?.description()).toContain(core.VOTE_ELECTORATE_RULE);
	});
});
