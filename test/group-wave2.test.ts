import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";
import * as outputModule from "../src/output.js";
import { NO_ESCROW } from "./escrow-report.js";

// The group verbs, CLI half. Every test drives the REAL command through
// commander and asserts what crosses a boundary the CLI actually owns: the
// request body and path on the wire, which @rine-network/core primitive was
// called, and what the operator is told. The MLS primitives are mocked at the
// package boundary — the cryptographic round-trips are rine-core's own suites
// — but nothing that belongs to these commands is.

const CONFIG_DIR = "/tmp/test-rine-w2";
const API_URL = "https://test.rine.network";
const GROUP_ID = "88888888-8888-8888-8888-888888888888";
const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const ALICE = "22222222-2222-2222-2222-222222222222";
const BOB = "33333333-3333-3333-3333-333333333333";

type Group = core.GroupRead;

function group(overrides: Partial<Group> = {}): Group {
	return {
		id: GROUP_ID,
		name: "standup",
		handle: "#standup@acme.rine.network",
		description: null,
		enrollment_policy: "closed",
		visibility: "private",
		isolated: false,
		vote_duration_hours: 24,
		member_count: 1,
		created_at: "2026-08-01T00:00:00Z",
		mls_enabled: true,
		mls_group_id: "mls-latch-abc",
		mls_pending: false,
		mls_cipher_suite: core.MLS_CIPHER_SUITE_XWING,
		...overrides,
	} as Group;
}

const OPEN_GROUP = group({
	enrollment_policy: "open",
	visibility: "public",
	mls_group_id: null,
	mls_cipher_suite: null,
});

function admissionResult(
	overrides: Partial<core.MlsAdmissionResult> = {},
): core.MlsAdmissionResult {
	return {
		epoch: 2,
		commits: 1,
		added: 1,
		outcomes: [{ agentId: ALICE, status: "added" }],
		escrow: NO_ESCROW,
		...overrides,
	};
}

/** Everything printed by the command under test, in order. */
let printed: string[];
let errors: string[];
let jsonPayloads: unknown[];

beforeEach(() => {
	printed = [];
	errors = [];
	jsonPayloads = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(outputModule, "printText").mockImplementation((s) => {
		printed.push(s);
	});
	vi.spyOn(outputModule, "printError").mockImplementation((s) => {
		errors.push(s);
	});
	vi.spyOn(outputModule, "printJson").mockImplementation((d) => {
		jsonPayloads.push(d);
	});
	vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
	vi.spyOn(outputModule, "printMutationOk").mockImplementation(() => {});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: ADMIN_ID, handle: "admin@acme.rine.network" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: ADMIN_ID });
	vi.spyOn(core, "resolveToUuid").mockImplementation(async (_url, v) => v);
	vi.spyOn(core, "sendGroupInviteNotification").mockResolvedValue(undefined);
	vi.spyOn(core, "agentKeysExist").mockReturnValue(true);
	vi.spyOn(core, "deleteMlsState").mockReturnValue(undefined);
	vi.spyOn(core, "deleteSenderKey").mockReturnValue(undefined);
	vi.spyOn(core, "loadMlsState").mockReturnValue(null);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

/**
 * A group program wired the way `main.ts` wires one.
 *
 * `refusing` makes Commander throw its refusals instead of exiting the test
 * runner, and silences the usage text it would otherwise write to stderr — the
 * only difference between a run that is expected to work and one that is
 * expected to be turned away at parse time.
 */
function makeProgram(
	globalOpts: Record<string, unknown> = {},
	{ refusing = false }: { refusing?: boolean } = {},
): Command {
	const program = new Command();
	if (refusing) {
		program.exitOverride();
		program.configureOutput({ writeErr: () => {} });
	}
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerGroup(program);
	return program;
}

function run(
	args: string[],
	globalOpts: Record<string, unknown> = {},
): Promise<unknown> {
	return makeProgram(globalOpts).parseAsync(["node", "rine", "group", ...args]);
}

/** Record every request the command makes, answering from `routes`. */
function stubHttp(routes: {
	get?: Record<string, unknown>;
	post?: Record<string, unknown | (() => never)>;
	del?: (path: string) => Promise<unknown>;
}): {
	gets: [string, unknown][];
	posts: [string, unknown][];
	deletes: string[];
} {
	const gets: [string, unknown][] = [];
	const posts: [string, unknown][] = [];
	const deletes: string[] = [];
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string, params?: unknown) => {
			gets.push([path, params]);
			// Every group verb resolves its argument first, so the group
			// row is a call EVERY route table would otherwise have to repeat. A test
			// that cares what the row says still overrides it by naming the path.
			const answer =
				routes.get?.[path] ??
				(path === `/groups/${GROUP_ID}` ? group() : undefined);
			return answer === undefined
				? Promise.reject(new Error(`Unknown GET: ${path}`))
				: Promise.resolve(answer);
		},
	);
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		(path: string, body?: unknown) => {
			posts.push([path, body]);
			const answer = routes.post?.[path];
			if (answer === undefined) {
				return Promise.reject(new Error(`Unknown POST: ${path}`));
			}
			return Promise.resolve(
				typeof answer === "function" ? (answer as () => unknown)() : answer,
			);
		},
	);
	vi.spyOn(core.HttpClient.prototype, "delete").mockImplementation(
		(path: string) => {
			deletes.push(path);
			return routes.del ? routes.del(path) : Promise.resolve(undefined);
		},
	);
	return { gets, posts, deletes };
}

/** A server refusal, shaped as rine-core's HttpClient raises it. */
function apiError(code: string, status = 409): core.RineApiError {
	return new core.RineApiError(status, "refused", undefined, code);
}

// ── visibility must be stated ─────────────────────────────────────────────

describe("group create — visibility is required, and the refusal says what to pick", () => {
	it("refuses a create that names no visibility, before any request is made", async () => {
		const { posts } = stubHttp({});

		await run(["create", "--name", "standup", "--enrollment", "open"]);

		expect(posts).toEqual([]);
		expect(process.exitCode).toBe(2);
		const refusal = errors.join("\n");
		expect(refusal).toContain("--visibility is required");
		// Both choices, and what each one decides — no schema dump.
		expect(refusal).toContain("--visibility public");
		expect(refusal).toContain("--visibility private");
		// The coupling with the join signal is visible at the point of choice.
		expect(refusal).toContain("dir.rine.network");
		expect(refusal.toLowerCase()).toContain("join signal");
	});

	it("no longer defaults visibility for open enrollment, and says nothing about a default", async () => {
		stubHttp({});
		await run(["create", "--name", "standup", "--enrollment", "open"]);
		expect(printed.join("\n")).not.toContain("defaulted");
	});

	it("refuses a visibility that is neither public nor private", async () => {
		const { posts } = stubHttp({});
		await run(["create", "--name", "standup", "--visibility", "unlisted"]);
		expect(posts).toEqual([]);
		expect(process.exitCode).toBe(2);
		expect(errors.join("\n")).toContain('not "unlisted"');
	});

	it("sends the stated visibility and creates the group", async () => {
		vi.spyOn(core, "initMlsGroup").mockResolvedValue(admissionResult());
		const { posts } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: { "/groups": group() },
		});

		await run(["create", "--name", "standup", "--visibility", "private"]);

		expect(process.exitCode).toBeUndefined();
		expect(posts[0]?.[1]).toMatchObject({
			name: "standup",
			visibility: "private",
		});
	});
});

// ── a group can carry its house rules from the first minute ──────────────

/**
 * The help text commander renders for `rine group <verb>`, unwrapped.
 *
 * Commander re-wraps every description to the terminal width, so a sentence an
 * operator reads as one line arrives here split across three. Collapsing
 * whitespace asserts what is said, not where the column happened to break.
 */
function helpFor(verb: string): string {
	const groupCmd = makeProgram().commands.find((c) => c.name() === "group");
	const help =
		groupCmd?.commands.find((c) => c.name() === verb)?.helpInformation() ?? "";
	return help.replace(/\s+/g, " ");
}

describe("group create — the description is settable at create, and says it is readable", () => {
	it("sends the description in the create body", async () => {
		vi.spyOn(core, "initMlsGroup").mockResolvedValue(admissionResult());
		const { posts } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: { "/groups": group({ description: "No spoilers." }) },
		});

		await run([
			"create",
			"--name",
			"standup",
			"--visibility",
			"private",
			"--description",
			"No spoilers.",
		]);

		expect(process.exitCode).toBeUndefined();
		expect(posts[0]?.[1]).toMatchObject({
			name: "standup",
			visibility: "private",
			description: "No spoilers.",
		});
	});

	it("sends an explicit empty description rather than dropping it", async () => {
		vi.spyOn(core, "initMlsGroup").mockResolvedValue(admissionResult());
		const { posts } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: { "/groups": group() },
		});

		await run([
			"create",
			"--name",
			"standup",
			"--visibility",
			"private",
			"--description",
			"",
		]);

		expect(posts[0]?.[1]).toMatchObject({ description: "" });
	});

	it("omits the description entirely when none was given", async () => {
		vi.spyOn(core, "initMlsGroup").mockResolvedValue(admissionResult());
		const { posts } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: { "/groups": group() },
		});

		await run(["create", "--name", "standup", "--visibility", "private"]);

		expect(posts[0]?.[1]).not.toHaveProperty("description");
	});

	it("warns at the point of choice that the description is not encrypted", () => {
		// The founder was told this text is server-readable before
		// choosing to ship it. An operator meets that fact where they type it,
		// on BOTH verbs that offer the flag — or they will put a secret in it.
		for (const verb of ["create", "update"]) {
			const help = helpFor(verb);
			expect(help).toContain("--description");
			expect(help).toContain("NOT end-to-end encrypted");
			expect(help).toContain("the rine server can read it");
		}
	});
});

// ── an open group runs Sender Keys and is not post-quantum ─────────────────

describe("group create/get — the crypto regime is stated, printed and in --json", () => {
	it("tells an operator creating an open group that it runs Sender Keys, not post-quantum", async () => {
		stubHttp({ post: { "/groups": OPEN_GROUP } });

		await run([
			"create",
			"--name",
			"lounge",
			"--enrollment",
			"open",
			"--visibility",
			"public",
		]);

		const text = printed.join("\n");
		expect(text).toContain("Sender Keys");
		expect(text).toContain("NOT post-quantum");
	});

	it("carries the regime in --json, which told an operator nothing before", async () => {
		stubHttp({ post: { "/groups": OPEN_GROUP } });

		await run(
			[
				"create",
				"--name",
				"lounge",
				"--enrollment",
				"open",
				"--visibility",
				"public",
			],
			{ json: true },
		);

		const payload = jsonPayloads.at(-1) as { encryption: core.GroupRead };
		expect(payload.encryption).toMatchObject({
			regime: "sender-key",
			version: "sender-key-v1",
			post_quantum: false,
		});
	});

	it("reports a closed group as post-quantum MLS on get, printed and in --json", async () => {
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["get", GROUP_ID], { json: true });

		expect(jsonPayloads.at(-1)).toMatchObject({
			encryption: { regime: "mls", version: "mls-v1", post_quantum: true },
		});
	});

	it("reports a non-X-Wing MLS group as NOT post-quantum", async () => {
		stubHttp({
			get: {
				[`/groups/${GROUP_ID}`]: group({
					mls_cipher_suite: 0x0001,
				}),
			},
		});

		await run(["get", GROUP_ID], { json: true });
		expect(jsonPayloads.at(-1)).toMatchObject({
			encryption: { post_quantum: false },
		});

		await run(["get", GROUP_ID]);
		expect(printed.join("\n")).toContain("ciphersuite 0x0001");
	});
});

// ── plural admission, singular unchanged ──────────────────────────────────

describe("group invite — one agent or many, on one route", () => {
	it("keeps the singular wire for one agent: agent_id, and no agent_ids", async () => {
		vi.spyOn(core, "addMlsGroupMembers").mockResolvedValue(admissionResult());
		const { posts } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: {
				[`/groups/${GROUP_ID}/invite`]: { id: "req-1", agent_id: ALICE },
			},
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE]);

		expect(posts[0]?.[0]).toBe(`/groups/${GROUP_ID}/invite`);
		expect(posts[0]?.[1]).toEqual({ agent_id: ALICE });
	});

	it("invites two agents in one call and reports what happened to each", async () => {
		const admit = vi
			.spyOn(core, "addMlsGroupMembers")
			.mockResolvedValue(admissionResult());
		const report = {
			invited: 1,
			skipped: 1,
			entries: [
				{ agent_id: ALICE, status: "invited" },
				{ agent_id: BOB, status: "skipped", reason: "already_a_member" },
			],
		};
		const { posts } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: { [`/groups/${GROUP_ID}/invite`]: report },
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE, "--invitee", BOB]);

		expect(posts[0]?.[1]).toEqual({ agent_ids: [ALICE, BOB] });
		expect(printed.join("\n")).toContain(
			"1 of 2 reached; 1 new invitation to accept.",
		);
		// Only the agent the server actually invited gets a leaf and a nudge.
		expect(admit).toHaveBeenCalledWith(
			CONFIG_DIR,
			ADMIN_ID,
			GROUP_ID,
			[ALICE],
			expect.any(core.HttpClient),
			{ "X-Rine-Agent": ADMIN_ID },
		);
	});

	it("admits an open group's whole batch, which mints no voucher but is still told to come in", async () => {
		const notify = vi
			.spyOn(core, "sendGroupInviteNotification")
			.mockResolvedValue(undefined);
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: OPEN_GROUP },
			post: {
				[`/groups/${GROUP_ID}/invite`]: {
					invited: 0,
					skipped: 2,
					entries: [
						{ agent_id: ALICE, status: "skipped", reason: "not_applicable" },
						{ agent_id: BOB, status: "skipped", reason: "not_applicable" },
					],
				},
			},
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE, "--invitee", BOB]);

		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("de-duplicates a repeated agent rather than sending it twice", async () => {
		vi.spyOn(core, "addMlsGroupMembers").mockResolvedValue(admissionResult());
		const { posts } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: {
				[`/groups/${GROUP_ID}/invite`]: { id: "req-1", agent_id: ALICE },
			},
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE, "--invitee", ALICE]);

		expect(posts[0]?.[1]).toEqual({ agent_id: ALICE });
	});

	it("refuses an invite that names nobody, and says the flag repeats", async () => {
		const { posts } = stubHttp({});
		await run(["invite", GROUP_ID]);
		expect(posts).toEqual([]);
		expect(process.exitCode).toBe(2);
		expect(errors.join("\n")).toContain("--invitee");
	});

	// `--agent` named the invitee here until the rename, and now
	// names the agent doing the inviting. A stale script that spelled the
	// invitee that way therefore invites nobody: it is turned away for naming no
	// invitee, and told what the flag means now, rather than inviting whoever
	// the flag happens to resolve to.
	it("reads the retired --agent spelling as the inviter, and files nothing", async () => {
		const { posts } = stubHttp({});

		await run(["invite", GROUP_ID, "--agent", ALICE]);

		expect(posts).toEqual([]);
		expect(process.exitCode).toBe(2);
		expect(errors.join("\n")).toContain("--invitee is required");
		expect(errors.join("\n")).toContain(
			"--agent names the agent doing the inviting",
		);
	});

	it("reports the invitation even when the acting agent cannot be resolved", async () => {
		vi.spyOn(core, "resolveAgent").mockRejectedValue(
			new Error("Multiple agents found."),
		);
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: {
				[`/groups/${GROUP_ID}/invite`]: { id: "req-1", agent_id: ALICE },
			},
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE]);

		// The server already wrote the row; a client-side resolution failure warns.
		expect(process.exitCode).toBeUndefined();
		expect(printed.join("\n")).toContain("the request was filed");
	});
});

// ── an invite to a voting group nominates ─────────────────────────────────

// The central guard of this lane. `admittedAgentIds` now counts `nominated`
// entries, so it answers "who was reached and is owed a notice" and NOT "who
// gets a leaf" — feeding it to an MLS add without asking the group's policy
// first Welcomes an agent the electorate has not decided on, which is the whole
// point. Every arm asserts BOTH halves: no add commit, and the notice still
// goes out, because a nominee that never hears of the nomination can never
// consent to it. The `closed` arms are controls — same stubs, same command —
// so a pass here is attributable to the policy and not to a dead harness.

describe("group invite — a nomination posts no commit, and still tells the nominee", () => {
	const NOMINATION = { id: "req-1", agent_id: ALICE, status: "pending" };

	function nominationReport() {
		return {
			invited: 2,
			skipped: 0,
			entries: [
				{ agent_id: ALICE, status: "nominated" },
				{ agent_id: BOB, status: "nominated" },
			],
		};
	}

	for (const policy of ["majority", "unanimity"] as const) {
		it(`files a nomination on a ${policy} group and adds nobody to the ratchet tree`, async () => {
			const admit = vi
				.spyOn(core, "addMlsGroupMembers")
				.mockResolvedValue(admissionResult());
			const notify = vi
				.spyOn(core, "sendGroupInviteNotification")
				.mockResolvedValue(undefined);
			stubHttp({
				get: { [`/groups/${GROUP_ID}`]: group({ enrollment_policy: policy }) },
				post: { [`/groups/${GROUP_ID}/invite`]: NOMINATION },
			});

			await run(["invite", GROUP_ID, "--invitee", ALICE]);

			expect(admit).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledTimes(1);
		});
	}

	it("still posts the add commit on a closed group, which invites as it always did", async () => {
		const admit = vi
			.spyOn(core, "addMlsGroupMembers")
			.mockResolvedValue(admissionResult());
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group({ enrollment_policy: "closed" }) },
			post: {
				[`/groups/${GROUP_ID}/invite`]: {
					id: "req-1",
					agent_id: ALICE,
					status: "invited",
				},
			},
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE]);

		expect(admit).toHaveBeenCalledTimes(1);
	});

	it("adds nobody for a whole batch of nominations, though every entry was reached", async () => {
		const admit = vi
			.spyOn(core, "addMlsGroupMembers")
			.mockResolvedValue(admissionResult());
		const notify = vi
			.spyOn(core, "sendGroupInviteNotification")
			.mockResolvedValue(undefined);
		stubHttp({
			get: {
				[`/groups/${GROUP_ID}`]: group({ enrollment_policy: "majority" }),
			},
			post: { [`/groups/${GROUP_ID}/invite`]: nominationReport() },
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE, "--invitee", BOB]);

		expect(admit).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("never offers a batch of nominations as invitations to accept", async () => {
		vi.spyOn(core, "addMlsGroupMembers").mockResolvedValue(admissionResult());
		stubHttp({
			get: {
				[`/groups/${GROUP_ID}`]: group({ enrollment_policy: "unanimity" }),
			},
			post: { [`/groups/${GROUP_ID}/invite`]: nominationReport() },
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE, "--invitee", BOB]);

		const said = printed.join("\n");
		expect(said).toContain("2 new nominations awaiting a vote.");
		expect(said).not.toContain("invitations to accept");
	});

	it("says a nomination was filed rather than an invitation sent", async () => {
		vi.spyOn(core, "addMlsGroupMembers").mockResolvedValue(admissionResult());
		stubHttp({
			get: {
				[`/groups/${GROUP_ID}`]: group({ enrollment_policy: "majority" }),
			},
			post: { [`/groups/${GROUP_ID}/invite`]: NOMINATION },
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE]);

		expect(printed.join("\n")).toContain("Nomination filed");
		expect(printed.join("\n")).not.toContain("Invitation sent");
	});
});

// ── The note names what the call minted, and an open group mints nothing ──

// An open group runs Sender Keys: there is no voucher, no join request and no
// ratchet tree, so an invite there creates none of the three objects the note
// describes. The closed and voting arms are controls on the same command, so a
// pass is attributable to the report and not to a note that stopped printing.

describe("group invite — an open group is promised nothing it does not have", () => {
	const OPEN_BATCH = {
		invited: 0,
		skipped: 2,
		entries: [
			{ agent_id: ALICE, status: "skipped", reason: "not_applicable" },
			{ agent_id: BOB, status: "skipped", reason: "not_applicable" },
		],
	};

	it("claims no seat for a batch that minted neither invitation nor nomination", async () => {
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: OPEN_GROUP },
			post: { [`/groups/${GROUP_ID}/invite`]: OPEN_BATCH },
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE, "--invitee", BOB]);

		const said = printed.join("\n");
		expect(said).toContain("2 of 2 reached");
		expect(said).not.toContain("ratchet-tree seat");
		expect(said).not.toContain("A nomination holds a seat");
	});

	it("tells one agent it may simply join, rather than claiming a seat it holds", async () => {
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: OPEN_GROUP },
			post: {
				// The open branch mints no row, so it answers `invited` with no `id`.
				[`/groups/${GROUP_ID}/invite`]: {
					status: "invited",
					group_id: GROUP_ID,
					agent_id: ALICE,
				},
			},
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE]);

		const said = printed.join("\n");
		expect(said).toContain("may join whenever it likes");
		expect(said).not.toContain("ratchet-tree seat");
		expect(said).not.toContain("Invitation sent");
	});

	it("still names the seat an invitation holds on a closed batch", async () => {
		vi.spyOn(core, "addMlsGroupMembers").mockResolvedValue(admissionResult());
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: {
				[`/groups/${GROUP_ID}/invite`]: {
					invited: 2,
					skipped: 0,
					entries: [
						{ agent_id: ALICE, status: "invited" },
						{ agent_id: BOB, status: "invited" },
					],
				},
			},
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE, "--invitee", BOB]);

		const said = printed.join("\n");
		expect(said).toContain("An invitation holds a ratchet-tree seat");
		expect(said).not.toContain("A nomination holds a seat");
	});

	it("names the nomination's seat, and no invitation's, on a voting batch", async () => {
		stubHttp({
			get: {
				[`/groups/${GROUP_ID}`]: group({ enrollment_policy: "majority" }),
			},
			post: {
				[`/groups/${GROUP_ID}/invite`]: {
					invited: 2,
					skipped: 0,
					entries: [
						{ agent_id: ALICE, status: "nominated" },
						{ agent_id: BOB, status: "nominated" },
					],
				},
			},
		});

		await run(["invite", GROUP_ID, "--invitee", ALICE, "--invitee", BOB]);

		const said = printed.join("\n");
		expect(said).toContain("A nomination holds a seat too");
		expect(said).not.toContain("An invitation holds a ratchet-tree seat");
	});
});

// ── the roster on create ──────────────────────────────────────────────────

describe("group create — a roster invites, and never seats", () => {
	it("sends the roster and renders the per-entry report", async () => {
		vi.spyOn(core, "initMlsGroup").mockResolvedValue(
			admissionResult({ added: 2, outcomes: [] }),
		);
		const { posts } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: {
				"/groups": {
					group: group(),
					roster: {
						invited: 2,
						skipped: 0,
						entries: [
							{ agent_id: ALICE, status: "invited" },
							{ agent_id: BOB, status: "invited" },
						],
					},
				},
			},
		});

		await run([
			"create",
			"--name",
			"standup",
			"--visibility",
			"private",
			"--member",
			ALICE,
			"--member",
			BOB,
		]);

		expect(posts[0]?.[1]).toMatchObject({ members: [ALICE, BOB] });
		const text = printed.join("\n");
		expect(text).toContain("2 of 2 reached; 2 new invitations to accept.");
		// Nobody is a member until they join.
		expect(text).toContain("nobody is a member until they join");
	});

	it("mints real invitations on a majority group, and founds the tree for them", async () => {
		// The founding carve-out, and the reason it must not be "fixed" by extending
		// the nomination gate here: at founding the creator is the entire electorate, so
		// a vote would auto-approve every row, and putting the batch schedule
		// behind one is what makes 500 members unreachable.
		const found = vi
			.spyOn(core, "initMlsGroup")
			.mockResolvedValue(admissionResult({ added: 2, outcomes: [] }));
		stubHttp({
			get: {
				[`/groups/${GROUP_ID}`]: group({ enrollment_policy: "majority" }),
			},
			post: {
				"/groups": {
					group: group({ enrollment_policy: "majority" }),
					roster: {
						invited: 2,
						skipped: 0,
						entries: [
							{ agent_id: ALICE, status: "invited" },
							{ agent_id: BOB, status: "invited" },
						],
					},
				},
			},
		});

		await run([
			"create",
			"--name",
			"standup",
			"--visibility",
			"private",
			"--enrollment",
			"majority",
			"--member",
			ALICE,
			"--member",
			BOB,
		]);

		expect(found).toHaveBeenCalledTimes(1);
		const text = printed.join("\n");
		expect(text).toContain("2 of 2 reached; 2 new invitations to accept.");
		// The note has to be true of every policy it can be printed under: an
		// OPEN founding roster mints nothing at all (`admission_mode` tests
		// "open" before the founding clause), so the note may not promise an
		// invitation there.
		expect(text).toContain("majority and unanimity included");
		expect(text).toContain("An open group mints nothing at all");
	});

	it("still reads a bare group when no roster was named", async () => {
		vi.spyOn(core, "initMlsGroup").mockResolvedValue(admissionResult());
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: { "/groups": group() },
		});

		await run(["create", "--name", "standup", "--visibility", "private"], {
			json: true,
		});

		expect(jsonPayloads.at(-1)).toMatchObject({ id: GROUP_ID });
		expect(jsonPayloads.at(-1)).not.toHaveProperty("roster");
	});
});

// ── removal posts a real Remove commit ────────────────────────────────────

// The removal mechanism itself — the DELETE-first order, the Remove commit,
// and 🔴 the `mls_removal_epoch` QUERY parameter — lives in
// `rine-core/src/group-removal-ops.ts` and is asserted in
// `rine-core/test/group-removal-ops.test.ts`. rine-core reaches
// `removeMlsGroupMember` through its own relative import, which a spy on the
// package export binding cannot intercept through the bundle. What these tests
// own is what the CLI passes to the core verb and what it prints about the
// answer.
describe("group kick — the target is named, and the sentence reports what happened", () => {
	function stubKick(removal: core.MlsRemovalCommit | null) {
		const del = vi.spyOn(core, "deleteGroupMember").mockResolvedValue(removal);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });
		return del;
	}

	it("names the resolved target and passes the acting admin lazily", async () => {
		const del = stubKick({ epoch: 7, removedLeaf: true, escrow: NO_ESCROW });

		await run(["kick", GROUP_ID, ALICE]);

		// The target is named by its AGENT ID: the core re-resolves the leaf on
		// every attempt, so a retry after a lost epoch CAS cannot evict whoever
		// inherited the seat, and the id it declares can never be a
		// different member from the leaf it takes. The admin resolver is a
		// FUNCTION, so a kick from a multi-agent org without `--as` still works on
		// every group that needs no commit.
		expect(del).toHaveBeenCalledWith(
			expect.any(core.HttpClient),
			CONFIG_DIR,
			GROUP_ID,
			ALICE,
			expect.any(Function),
			{},
		);
		expect(printed.join("\n")).toContain("epoch 7");
	});

	it("completes a removal stranded by a failed DELETE, and never claims a leaf went", async () => {
		// The first attempt's Remove commit landed and its DELETE
		// did not, so the leaf is already out of the tree. Before the rescue the
		// client threw here — it could derive an epoch only from a commit it could
		// no longer make — and the member row was stuck for good.
		stubKick({ epoch: 9, removedLeaf: false, escrow: NO_ESCROW });

		await run(["kick", GROUP_ID, ALICE]);

		expect(process.exitCode).toBeUndefined();
		// The sentence reports what happened, not what a removal usually does —
		// and it says the narrow, true thing: no leaf in the tree is theirs.
		expect(printed.join("\n")).toContain(
			"no leaf in this group's ratchet tree is theirs",
		);
		expect(printed.join("\n")).not.toContain("rotated");
		expect(printed.join("\n")).not.toContain("took their leaf out");
	});

	it("posts no commit when the server does not ask for one", async () => {
		const remove = vi.spyOn(core, "removeMlsGroupMember");
		const { deletes } = stubHttp({
			get: { [`/groups/${GROUP_ID}`]: OPEN_GROUP },
		});

		await run(["kick", GROUP_ID, ALICE]);

		expect(remove).not.toHaveBeenCalled();
		expect(deletes).toEqual([`/groups/${GROUP_ID}/members/${ALICE}`]);
		// No page may imply parity between the two group types on removal.
		expect(printed.join("\n")).toContain("no cryptographic eviction");
	});

	it("does not post a commit for an unrelated refusal", async () => {
		const remove = vi.spyOn(core, "removeMlsGroupMember");
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			del: () => Promise.reject(apiError("forbidden", 403)),
		});

		await run(["kick", GROUP_ID, ALICE]);

		expect(remove).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
});

// ── leaving retires the right keys and says what happened ─────────────────

describe("group leave — both retirements run, and the sentence is per group type", () => {
	// Which files the retirement unlinks is `rine-core`'s, and is asserted in
	// `rine-core/test/group-removal-ops.test.ts`. What is owned here is that the
	// command asks for it, and that the sentence it prints matches the answer.
	function stubLeave(
		target: Group,
		wipe: core.LocalStateRetirement = { retired: true },
	): void {
		vi.spyOn(core, "retireLocalGroupState").mockReturnValue(wipe);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: target } });
	}

	it("retires this agent's local key material for the group it left", async () => {
		stubLeave(group());
		await run(["leave", GROUP_ID]);

		// The wipe that did not exist before, on the surface that
		// claimed for a year that it had happened.
		expect(core.retireLocalGroupState).toHaveBeenCalledWith(
			CONFIG_DIR,
			ADMIN_ID,
			GROUP_ID,
		);
	});

	it("tells a closed group's leaver that MLS state is gone", async () => {
		stubLeave(group());
		await run(["leave", GROUP_ID]);
		expect(printed.join("\n")).toContain(
			"Local MLS state for this group is gone",
		);
	});

	it("tells an open group's leaver what actually bounds their reach", async () => {
		stubLeave(OPEN_GROUP);
		await run(["leave", GROUP_ID]);

		const text = printed.join("\n");
		expect(text).toContain("Local sender-key material for this group is gone");
		expect(text).toContain("rotating on their next send");
		// The sentence this replaces was false in both halves on an open group.
		expect(text).not.toContain("rejoining the group is the only way back in");
	});

	it("names the acting agent, so the server can tell a leave from a kick", async () => {
		const del = vi
			.spyOn(core.HttpClient.prototype, "delete")
			.mockResolvedValue(undefined);
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue(group());

		await run(["leave", GROUP_ID]);

		expect(del).toHaveBeenCalledWith(
			`/groups/${GROUP_ID}/members/${ADMIN_ID}`,
			{
				"X-Rine-Agent": ADMIN_ID,
			},
		);
	});

	it("does not claim a wipe that failed", async () => {
		// A wipe that did not happen is reported before the sentence that
		// describes one that did, so the two can never be confused.
		stubLeave(group(), {
			retired: false,
			error:
				"Warning: local group key material was NOT removed and is still on disk: EACCES",
		});

		await run(["leave", GROUP_ID]);

		const text = printed.join("\n");
		expect(text).toContain("NOT removed and is still on disk");
		expect(text).not.toContain("Local MLS state for this group is gone");
	});
});

// ── resume is continuation, not re-initialisation ─────────────────────────

describe("group resume-admission", () => {
	it("continues a latched group over its still-unseated invitations", async () => {
		const resume = vi
			.spyOn(core, "resumeMlsGroupAdmission")
			.mockResolvedValue(admissionResult({ added: 3, outcomes: [] }));
		const init = vi.spyOn(core, "initMlsGroup");
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["resume-admission", GROUP_ID]);

		expect(init).not.toHaveBeenCalled();
		expect(resume).toHaveBeenCalledWith(
			CONFIG_DIR,
			ADMIN_ID,
			GROUP_ID,
			expect.any(core.HttpClient),
			{ "X-Rine-Agent": ADMIN_ID },
			// Reclamation is off unless the operator asks for it. It
			// removes leaves and costs one O(N) commit per leaf, so a resume must
			// never pick that up by default.
			{ reclaim: undefined },
		);
		expect(printed.join("\n")).toContain("Seated 3 of");
		expect(printed.join("\n")).not.toContain("Reclaimed");
	});

	it("retires orphaned leaves only when --reclaim is given, and says what it cost", async () => {
		const resume = vi.spyOn(core, "resumeMlsGroupAdmission").mockResolvedValue(
			admissionResult({
				added: 0,
				outcomes: [],
				epoch: 9,
				reclamation: {
					found: 2,
					reclaimed: 2,
					commits: 2,
					epoch: 9,
					escrow: NO_ESCROW,
				},
			}),
		);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["resume-admission", GROUP_ID, "--reclaim"]);

		expect(resume).toHaveBeenCalledWith(
			CONFIG_DIR,
			ADMIN_ID,
			GROUP_ID,
			expect.any(core.HttpClient),
			{ "X-Rine-Agent": ADMIN_ID },
			{ reclaim: true },
		);
		const text = printed.join("\n");
		expect(text).toContain("Reclaimed 2 of 2 orphaned leaves");
		// The operator paid for O(N) commits and is told so.
		expect(text).toContain("billed to every member");
	});

	it("renders a declined reclamation as its own sentence, not as a silent zero", async () => {
		vi.spyOn(core, "resumeMlsGroupAdmission").mockResolvedValue(
			admissionResult({
				reclamation: {
					found: 0,
					reclaimed: 0,
					commits: 0,
					epoch: 2,
					escrow: NO_ESCROW,
					declined: {
						reason: "identity_unknown",
						detail: "Reclaimed nothing: 1 agent(s) publish no readable key.",
					},
				},
			}),
		);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["resume-admission", GROUP_ID, "--reclaim"]);

		const text = printed.join("\n");
		expect(text).toContain("no readable key");
		expect(text).not.toContain("Every leaf");
	});

	it("founds a group whose very first commit never landed", async () => {
		const init = vi
			.spyOn(core, "initMlsGroup")
			.mockResolvedValue(admissionResult());
		const resume = vi.spyOn(core, "resumeMlsGroupAdmission");
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group({ mls_group_id: null }) },
		});

		await run(["resume-admission", GROUP_ID]);

		expect(resume).not.toHaveBeenCalled();
		expect(init).toHaveBeenCalled();
	});

	it("refuses an open group, which has no ratchet tree to seat anyone in", async () => {
		const resume = vi.spyOn(core, "resumeMlsGroupAdmission");
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: OPEN_GROUP } });

		await run(["resume-admission", GROUP_ID]);

		expect(resume).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
		expect(errors.join("\n")).toContain("Sender Keys");
	});
});

// ── isActive() === false is a named refusal in rine's words ───────────────

describe("an evicted agent is told it was evicted", () => {
	it("translates the native core's retired-handle failure on resume-admission", async () => {
		const inactive = Object.assign(new Error("group is inactive"), {
			code: core.MLS_ERR_GROUP_INACTIVE,
		});
		vi.spyOn(core, "resumeMlsGroupAdmission").mockRejectedValue(inactive);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["resume-admission", GROUP_ID]);

		const refusal = errors.join("\n");
		expect(refusal).toContain(`You were removed from group ${GROUP_ID}`);
		expect(refusal).not.toContain("group is inactive");
		expect(refusal).toContain("invite you again");
	});

	it("says so when reading a group whose ratchet tree has retired this leaf", async () => {
		vi.spyOn(core, "openMlsClient").mockReturnValue({} as never);
		vi.spyOn(core, "loadMlsGroup").mockReturnValue({
			isActive: () => false,
		} as never);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["get", GROUP_ID]);

		expect(printed.join("\n")).toContain(
			`You were removed from group ${GROUP_ID}`,
		);
	});

	it("says nothing of the sort for a member still in the tree", async () => {
		vi.spyOn(core, "openMlsClient").mockReturnValue({} as never);
		vi.spyOn(core, "loadMlsGroup").mockReturnValue({
			isActive: () => true,
		} as never);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["get", GROUP_ID], { json: true });

		expect(jsonPayloads.at(-1)).toMatchObject({ evicted: false });
		expect(printed.join("\n")).not.toContain("You were removed");
	});
});

// ── a partial sender-key distribution is no longer silent

describe("group members — who can actually read what this agent sends", () => {
	const ownState = (distributedTo: string[]) => [
		{
			senderKeyId: "sk-1",
			groupId: GROUP_ID,
			senderAgentId: ADMIN_ID,
			chainKey: new Uint8Array(32),
			messageIndex: 0,
			distributedTo,
		},
	];

	function stubMembers(): void {
		stubHttp({
			get: {
				[`/groups/${GROUP_ID}/members`]: {
					items: [ADMIN_ID, ALICE, BOB].map((id) => ({
						id: `m-${id}`,
						group_id: GROUP_ID,
						agent_id: id,
						role: "member",
						joined_at: "2026-08-01T00:00:00Z",
					})),
					total: 3,
				},
			},
		});
	}

	it("names the members a distribution never reached", async () => {
		stubMembers();
		vi.spyOn(core, "loadSenderKeyStates").mockReturnValue(
			ownState([ALICE]) as never,
		);

		await run(["members", GROUP_ID]);

		const text = printed.join("\n");
		expect(text).toContain("reached 1 of 2 other members");
		expect(text).toContain(BOB);
		// `distributeSenderKey` reports the failures and every caller drops them;
		// before this the operator saw a complete member list and nothing else.
		expect(text).toContain("cannot read what you send");
	});

	it("says nothing when every member holds the key", async () => {
		stubMembers();
		vi.spyOn(core, "loadSenderKeyStates").mockReturnValue(
			ownState([ALICE, BOB]) as never,
		);

		await run(["members", GROUP_ID]);

		expect(printed.join("\n")).not.toContain("cannot read");
	});

	it("reads the CURRENT key's audience, not a superseded one's", async () => {
		stubMembers();
		vi.spyOn(core, "loadSenderKeyStates").mockReturnValue([
			...(ownState([ALICE, BOB]) as never[]),
			...(ownState([ALICE]) as never[]),
		] as never);

		await run(["members", GROUP_ID], { json: true });

		expect(jsonPayloads.at(-1)).toMatchObject({
			sender_key_coverage: { reached: [ALICE], unreached: [BOB] },
		});
	});

	it("reports nothing for a group this agent holds no sender key for", async () => {
		stubMembers();
		vi.spyOn(core, "loadSenderKeyStates").mockReturnValue([]);

		await run(["members", GROUP_ID], { json: true });

		expect(jsonPayloads.at(-1)).not.toHaveProperty("sender_key_coverage");
	});
});

// ── the outstanding set is readable ───────────────────────────────────────

describe("group requests", () => {
	it("asks for the vote queue by default, which is the wire every shipped client sees", async () => {
		const { gets } = stubHttp({
			get: { [`/groups/${GROUP_ID}/requests`]: { items: [], total: 0 } },
		});

		await run(["requests", GROUP_ID]);

		expect(gets.at(-1)).toEqual([
			`/groups/${GROUP_ID}/requests`,
			{ outstanding: "pending" },
		]);
	});

	it("can list the unaccepted invitations that hold a ratchet-tree seat", async () => {
		const { gets } = stubHttp({
			get: { [`/groups/${GROUP_ID}/requests`]: { items: [], total: 0 } },
		});

		await run(["requests", GROUP_ID, "--outstanding", "live"]);

		expect(gets.at(-1)).toEqual([
			`/groups/${GROUP_ID}/requests`,
			{ outstanding: "live" },
		]);
	});
});

// ── a carried vote has FOUR answers, and one of them seats nobody ────────────

describe("group vote — what the outcome is called, and who gets a leaf", () => {
	function stubVote(status: string) {
		const seat = vi
			.spyOn(core, "addMlsGroupMembers")
			.mockResolvedValue(admissionResult());
		stubHttp({
			get: {
				[`/groups/${GROUP_ID}`]: group({ enrollment_policy: "majority" }),
				[`/groups/${GROUP_ID}/requests`]: {
					items: [{ id: "req-1", agent_id: ALICE }],
					total: 1,
				},
			},
			post: {
				[`/groups/${GROUP_ID}/requests/req-1/vote`]: {
					request_id: "req-1",
					your_vote: "approve",
					status,
				},
			},
		});
		return { seat };
	}

	it("seats the applicant when an approve carries their own application", async () => {
		const { seat } = stubVote("approved");

		await run(["vote", GROUP_ID, "req-1", "--vote", "approve"]);

		expect(seat).toHaveBeenCalledTimes(1);
		expect(printed.join("\n")).toContain("that agent is now a member");
	});

	it("seats nobody when a carried nomination resolves to an invitation", async () => {
		// The fourth value. An agent that was nominated and has not answered is not
		// a member yet, so a branch widened to "anything that is not denied" would
		// seat one that never consented.
		const { seat } = stubVote("invited");

		await run(["vote", GROUP_ID, "req-1", "--vote", "approve"]);

		expect(seat).not.toHaveBeenCalled();
		const said = printed.join("\n");
		expect(said).toContain("Request status: invited");
		expect(said).toContain("an invitation for them to accept");
	});

	it("says the request still stands when neither bar is reached", async () => {
		const { seat } = stubVote("pending");

		await run(["vote", GROUP_ID, "req-1", "--vote", "approve"]);

		expect(seat).not.toHaveBeenCalled();
		expect(printed.join("\n")).toContain("neither bar is reached yet");
	});
});

// ── an evicted agent finds out on the read the server refuses ─────────────────

describe("group read — a refusal that is really an eviction says so", () => {
	function refuseWith(status: number): void {
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(() =>
			Promise.reject(apiError("forbidden", status)),
		);
	}

	// `has_read_access` 403s a cross-org evicted agent, so the group never comes
	// back and a check on the response body can never fire. This is the only path
	// that reaches that agent.
	it("names the eviction when `group get` is refused and this agent holds MLS state", async () => {
		refuseWith(403);
		vi.spyOn(core, "holdsMlsState").mockReturnValue(true);

		await run(["get", GROUP_ID]);

		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain(
			`You were removed from group ${GROUP_ID}`,
		);
	});

	it("names it on `group members` too — the other read an evicted agent tries", async () => {
		refuseWith(403);
		vi.spyOn(core, "holdsMlsState").mockReturnValue(true);

		await run(["members", GROUP_ID]);

		expect(errors.join("\n")).toContain(
			`You were removed from group ${GROUP_ID}`,
		);
	});

	// An agent who was never a member holds no state, and an open group holds
	// none either — neither may be described as an eviction.
	it("passes the server's own refusal through when this agent holds no MLS state", async () => {
		refuseWith(403);
		vi.spyOn(core, "holdsMlsState").mockReturnValue(false);

		await run(["get", GROUP_ID]);

		expect(errors.join("\n")).not.toContain("You were removed");
	});

	// A sibling in this org is seated, so the server's refusal names that
	// sibling and the header to retry with: an eviction notice would hide the
	// one instruction that works.
	it.each([["get"], ["members"]])(
		"passes a refusal that names a seated sibling through on `group %s`",
		async (verb) => {
			const detail = `Agent ${GROUP_ID} ${core.NOT_A_MEMBER_CLAUSE}; a sibling is seated, ${core.SEATED_SIBLING_CLAUSE}: bot@acme`;
			vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(() =>
				Promise.reject(new core.RineApiError(403, detail)),
			);
			vi.spyOn(core, "holdsMlsState").mockReturnValue(true);

			await run([verb, GROUP_ID]);

			expect(process.exitCode).toBe(1);
			expect(errors.join("\n")).not.toContain("You were removed");
			expect(errors.join("\n")).toContain(core.SEATED_SIBLING_CLAUSE);
		},
	);

	it("leaves an unrelated failure alone", async () => {
		refuseWith(500);
		const holds = vi.spyOn(core, "holdsMlsState").mockReturnValue(true);

		await run(["get", GROUP_ID]);

		expect(holds).not.toHaveBeenCalled();
		expect(errors.join("\n")).not.toContain("You were removed");
	});
});

// ── a UUID reads the group, never the roster ──────────────────────────────
//
// 🔴 The premise this closes: no `rine-cli` test was believed to pass a UUID
// anywhere, so this path had never executed from this surface. The
// premise is wrong in the letter (the eviction block above passes `GROUP_ID`)
// and right in the substance — every one of those drives a REFUSAL, so the
// seated UUID rung's success path was asserted by nothing here.
//
// The shape is the whole of it: a UUID reads `GET /groups/{id}` and the
// roster is fetched only to compose a refusal. The verb used to spend that id
// read TWICE (resolve, then the verb's own); a regression that re-adds the
// second, or one that walks the roster on a spelling that needs no rung above
// the first, both show up right here.

describe("a group verb given a real UUID", () => {
	it("reads the group by id and never lists the org's groups", async () => {
		const { gets } = stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["get", GROUP_ID], { json: true });

		expect(gets.map(([path]) => path)).toEqual([`/groups/${GROUP_ID}`]);
		// And it SUCCEEDED — a refusal would also have listed nothing.
		expect(process.exitCode).toBeUndefined();
	});

	it("spends that read once, not once per consumer", async () => {
		// The fold: `groupTarget` hands the row back, so `group get` renders the
		// row the ladder already paid for instead of re-fetching it.
		const { gets } = stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["get", GROUP_ID], { json: true });

		expect(
			gets.filter(([path]) => path === `/groups/${GROUP_ID}`),
		).toHaveLength(1);
	});
});

// ── the parts the twelve-verb widening left unasserted ─────────────────
//
// Three holes an audit named, each with a one-line mutation that
// turns the test below red:
//
//  1. `kick` folded a TOLERANT read into a throwing resolve, so a 500 on
//     `GET /groups/{id}` stopped an admin's removal. Mutation: swap the UUID
//     arm back to `await groupTarget(ctx, ref)`.
//  2. The fold ("one read, not two") was pinned for `group get` alone, while
//     the harness answers `/groups/{id}` for every route table. Mutation:
//     insert one `ctx.client.get(`/groups/${groupId}`)` into `group members`.
//  3. The widening itself was asserted by nothing outside `group get` — every
//     other test passes a UUID. Mutation: make `groupTarget` call
//     `resolveGroupUuid` instead of `resolveGroup`.

describe("group kick — a rendering-only read never gates the removal", () => {
	it("removes the member even when the group row cannot be read", async () => {
		// At ba742fb6 `kick` read the group through the tolerant `readGroup`, which
		// answers null on ANY failure, and removed the member anyway: `target` feeds
		// the OPTIONAL eviction sentence and nothing else. A resolve that throws
		// would make a 500 on a read the removal does not need leave the member
		// seated — an admin action blocked by rendering.
		const del = vi
			.spyOn(core, "deleteGroupMember")
			.mockResolvedValue({ epoch: 7, removedLeaf: true, escrow: NO_ESCROW });
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(() =>
			Promise.reject(apiError("server_error", 500)),
		);

		await run(["kick", GROUP_ID, ALICE]);

		expect(del).toHaveBeenCalled();
		// And the run completed: `evictionMessage` already accepts a null row, so
		// the removal is reported and only the row-derived half is omitted.
		expect(printed.join("\n")).toContain("Remove commit at epoch 7");
		expect(process.exitCode).toBeUndefined();
	});

	it("still climbs the ladder for a NAME, which has nothing else to resolve", async () => {
		// The tolerance is a property of the UUID rung only. A name cannot be
		// passed through — there is no id in it — so it accepts the coupling.
		const del = vi
			.spyOn(core, "deleteGroupMember")
			.mockResolvedValue({ epoch: 7, removedLeaf: true, escrow: NO_ESCROW });
		const { gets } = stubHttp({ get: { "/groups": { items: [group()] } } });

		await run(["kick", "standup", ALICE]);

		expect(gets.map(([path]) => path)).toEqual(["/groups"]);
		expect(del).toHaveBeenCalledWith(
			expect.any(core.HttpClient),
			CONFIG_DIR,
			GROUP_ID,
			ALICE,
			expect.any(Function),
			{},
		);
	});
});

describe("group members — the widened argument, and what the resolve costs", () => {
	it("spends the group read once on the hottest group verb", async () => {
		const { gets } = stubHttp({
			get: {
				[`/groups/${GROUP_ID}`]: group(),
				[`/groups/${GROUP_ID}/members`]: { items: [] },
			},
		});

		await run(["members", GROUP_ID], { json: true });

		// Exactly two round-trips, in this order. The harness answers
		// `/groups/{id}` by default, so only a count can see a second one.
		expect(gets.map(([path]) => path)).toEqual([
			`/groups/${GROUP_ID}`,
			`/groups/${GROUP_ID}/members`,
		]);
	});

	it("takes a HANDLE, on a verb that is not `group get`", async () => {
		// The whole widening from an operator's side: the help now promises a handle
		// on twelve verbs, and until this test one verb kept that promise.
		const { gets } = stubHttp({
			get: {
				"/groups": { items: [group()] },
				[`/groups/${GROUP_ID}/members`]: { items: [] },
			},
		});

		await run(["members", "#standup@acme.rine.network"], { json: true });

		expect(gets.map(([path]) => path)).toEqual([
			"/groups",
			`/groups/${GROUP_ID}/members`,
		]);
		expect((gets[0]?.[1] as { handle?: string } | undefined)?.handle).toContain(
			"standup@acme.rine.network",
		);
		expect(process.exitCode).toBeUndefined();
	});

	it("takes a NAME, resolved against the org's own groups", async () => {
		const { gets } = stubHttp({
			get: {
				"/groups": { items: [group()] },
				[`/groups/${GROUP_ID}/members`]: { items: [] },
			},
		});

		await run(["members", "standup"], { json: true });

		expect(gets.map(([path]) => path)).toEqual([
			"/groups",
			`/groups/${GROUP_ID}/members`,
		]);
		expect(gets[0]?.[1]).toBeUndefined();
	});
});

// ── the two refusals rewritten here ─────────────────────────────────────
//
// A refusal like this has to be gated here, because nothing binds a
// CLI refusal cross-stack. This one fires on every mistyped invite.

describe("group invite — the refusal that names no placeholder handle", () => {
	it("says the flag repeats and the shape of a handle, and prints no example", async () => {
		const { posts } = stubHttp({});

		await run(["invite", GROUP_ID]);

		const said = errors.join("\n");
		expect(posts).toEqual([]);
		expect(said).toContain("--invitee is required, and it repeats");
		expect(said).toContain("an at sign, and its org's domain");
		expect(said).toContain("--agent names the agent doing the inviting");
		// 🔴 A refusal may not hand a model a pasteable handle to copy.
		// The old text demonstrated the repeat with two, domain and all.
		expect(said).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
		// A precheck refusal, so commander's own exit code 2 — not the exit 1 a
		// server refusal carries.
		expect(process.exitCode).toBe(2);
	});
});

// 🔴 The rule here: widen the refusal's tail; do not build a local index, and
// do not merely disclose.
//
// The eviction sentence is reachable on a UUID and on nothing else: the
// wrap keys off `UUID_RE.test(ref)` because `holdsMlsState` is UUID-keyed, and
// a handle that names a group this agent no longer sits in resolves to no row
// at all — there is no id to ask the local question with. The help advertises
// that spelling on twelve verbs, so the gap is REACHABLE.
//
// The remedy is a POINTER, not that sentence: `holdsAnyMlsState` is the weaker
// question the CLI can still ask without an id, and it can only justify "you
// may have been removed from something — this verb will tell you which".
// Nothing here read a ratchet tree, so "You were removed" stays on the UUID arm
// in both arms below.

describe("an evicted agent naming its group by HANDLE, and the pointer it gets", () => {
	it("keeps the roster refusal and adds the pointer, holding state", async () => {
		const holds = vi.spyOn(core, "holdsAnyMlsState").mockReturnValue(true);
		stubHttp({ get: { "/groups": { items: [] } } });

		await run(["get", "#standup@acme.rine.network"]);

		const said = errors.join("\n");
		// The refusal it grew onto is unchanged, and so is the thing it does not
		// claim: no group's tree was consulted, so no removal is asserted.
		expect(said).toContain(core.GROUP_NOT_FOUND_LEAD);
		expect(said).not.toContain("You were removed");
		expect(said).toContain(core.EVICTION_POINTER_TAIL);
		expect(said).not.toContain("..");
		// Deliberately inverted: the local question is now asked, once, and only
		// after the refusal proved to be the unknown-group one.
		expect(holds).toHaveBeenCalledTimes(1);
		expect(holds).toHaveBeenCalledWith(CONFIG_DIR, ADMIN_ID);
		expect(process.exitCode).toBe(1);
	});

	it("adds nothing for an agent that holds no MLS state at all", async () => {
		// 🔴 The arm the pinned test had no reason to have. An agent that was
		// never in a group must not be told it may have been removed from one —
		// the pointer would be a lie on the most common refusal there is, a
		// mistyped group name.
		const holds = vi.spyOn(core, "holdsAnyMlsState").mockReturnValue(false);
		stubHttp({ get: { "/groups": { items: [] } } });

		await run(["get", "#standup@acme.rine.network"]);

		const said = errors.join("\n");
		expect(said).toContain(core.GROUP_NOT_FOUND_LEAD);
		expect(said).not.toContain("may have been removed");
		expect(holds).toHaveBeenCalledTimes(1);
		expect(process.exitCode).toBe(1);
	});

	it("adds nothing when the local store cannot be read", async () => {
		// A store that raises has proved nothing about a removal, exactly as
		// `asEvictionRefusal` treats it.
		vi.spyOn(core, "holdsAnyMlsState").mockImplementation(() => {
			throw new Error("EACCES");
		});
		stubHttp({ get: { "/groups": { items: [] } } });

		await run(["get", "#standup@acme.rine.network"]);

		const said = errors.join("\n");
		expect(said).toContain(core.GROUP_NOT_FOUND_LEAD);
		expect(said).not.toContain("may have been removed");
		expect(process.exitCode).toBe(1);
	});

	it("adds nothing to an AMBIGUOUS reference, which opens with another lead", async () => {
		// 🔴 Two groups answered; none was missing. The pointer is keyed on the
		// unknown-group lead precisely so this refusal cannot collect it.
		const holds = vi.spyOn(core, "holdsAnyMlsState").mockReturnValue(true);
		stubHttp({
			get: {
				"/groups": {
					items: [
						group({ id: GROUP_ID, handle: "#standup@acme.rine.network" }),
						group({
							id: ALICE,
							handle: "#standup@beta.rine.network",
						}),
					],
				},
			},
		});

		const acting = vi.spyOn(core, "resolveAgent");
		acting.mockClear();

		await run(["get", "standup"]);

		const said = errors.join("\n");
		expect(said).toContain("is ambiguous");
		expect(said).not.toContain("may have been removed");
		expect(holds).not.toHaveBeenCalled();
		// 🔴 The laziness the wrap's docstring sells, asserted rather than
		// described. Hoisting `await ctx.actingAgent()` above the lead test reads
		// as a tidy-up and keeps every other arm here green, while buying a
		// `GET /agents` on every ambiguous and every transport-failure group
		// refusal across twelve verbs.
		expect(acting).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("never reaches the JOIN ladder — the sacred path stays free of it", async () => {
		// 🔴 `join` names a group this org holds no seat in BY DEFINITION, so
		// "you may have been removed from a group you still hold state for" is
		// nonsense there, not a milder truth. Today `joinGroupTarget` is safe
		// because it has no catch at all; the symmetry move that adds one is a
		// natural later refactor and every other arm in this block would stay
		// green through it.
		vi.spyOn(core, "holdsAnyMlsState").mockReturnValue(true);
		// Every rung of the join ladder, all answering nothing: the seated
		// lookup, the caller's own invitations, the open or voted groups its org sits in,
		// then the public directory. The refusal that falls out of the end opens
		// with the SAME lead the pointer keys on, which is what makes this arm
		// worth having.
		stubHttp({
			get: {
				"/groups": { items: [] },
				"/groups/invites": { items: [] },
				"/groups/org-joinable": { id: null },
				"/directory/groups": { items: [], total: 0 },
			},
		});

		await run(["join", "#standup@other.rine.network"]);

		expect(errors.join("\n")).toContain(core.GROUP_NOT_FOUND_LEAD);

		const said = errors.join("\n");
		expect(said).not.toContain("may have been removed");
		expect(said).not.toContain(core.EVICTION_POINTER_TAIL);
	});
});

// ── a completed handle is announced on every verb that resolves one ──

/**
 * The announcement covers all seven `resolveToUuid` call sites. These are the
 * three group verbs.
 *
 * `resolveToUuid` completes a short handle and returns a UUID, never the
 * spelling it resolved, so the substitution is invisible at every call site by
 * construction. On a founding roster or an invite it is invisible AND seats
 * somebody: `--member kofi@acme` reaches an agent at a domain the caller never
 * typed.
 *
 * The notice is STDERR and is not gated on `--json` — the machine reader is the
 * caller a silent rewrite harms most, and stdout is unchanged either way.
 */
describe("item 18 — the group verbs announce a handle they completed", () => {
	/** What gets typed: the org half without its domain. */
	const TYPED = "kofi@acme";
	/** What `normalizeHandle` completes it to, and what is actually looked up. */
	const COMPLETED = "kofi@acme.rine.network";

	/** Both spellings said, and no third handle beside them. */
	function assertAnnounced(said: string): void {
		expect(said).toContain(TYPED);
		expect(said).toContain(COMPLETED);
		expect(said.match(/@[a-z0-9.-]+/g)).toEqual([
			"@acme",
			"@acme.rine.network",
		]);
	}

	it("announces a founding roster member before the roster is resolved", async () => {
		vi.spyOn(core, "initMlsGroup").mockResolvedValue(admissionResult());
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: { "/groups": group() },
		});

		await run([
			"create",
			"--name",
			"standup",
			"--visibility",
			"private",
			"--member",
			TYPED,
		]);

		assertAnnounced(errors.join("\n"));
	});

	it("announces an invitee", async () => {
		vi.spyOn(core, "addMlsGroupMembers").mockResolvedValue(admissionResult());
		stubHttp({
			get: { [`/groups/${GROUP_ID}`]: group() },
			post: {
				[`/groups/${GROUP_ID}/invite`]: { id: "req-1", agent_id: TYPED },
			},
		});

		await run(["invite", GROUP_ID, "--invitee", TYPED]);

		assertAnnounced(errors.join("\n"));
	});

	it("announces a kick target", async () => {
		vi.spyOn(core, "deleteGroupMember").mockResolvedValue(null);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["kick", GROUP_ID, TYPED]);

		assertAnnounced(errors.join("\n"));
	});

	it("still announces under --json, leaving stdout untouched", async () => {
		vi.spyOn(core, "deleteGroupMember").mockResolvedValue(null);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["kick", GROUP_ID, TYPED], { json: true });

		assertAnnounced(errors.join("\n"));
		expect(printed).toEqual([]);
	});

	it("says nothing when the spelling was already whole", async () => {
		vi.spyOn(core, "deleteGroupMember").mockResolvedValue(null);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["kick", GROUP_ID, COMPLETED]);

		expect(errors).toEqual([]);
	});

	it("says nothing for a UUID, which names no domain to complete", async () => {
		vi.spyOn(core, "deleteGroupMember").mockResolvedValue(null);
		stubHttp({ get: { [`/groups/${GROUP_ID}`]: group() } });

		await run(["kick", GROUP_ID, ALICE]);

		expect(errors).toEqual([]);
	});
});
