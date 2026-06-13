import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";
import * as outputModule from "../src/output.js";

// Phase 6 — open-enrollment self-join via external commit.
//
// When a joiner gains immediate membership in an MLS-active group but no Welcome
// was minted (the `open` enrollment case — no admin in the loop), the join path
// must fall back to the external-commit self-join orchestrator so the joiner
// becomes a real MLS member. These tests drive the REAL `group join` command and
// assert the observable wiring: core.externalJoinMlsGroup is invoked iff the
// group is MLS-active AND no local MLS state already exists.
//
// The core orchestrator (externalJoinMlsGroup) and state loader (loadMlsState)
// are mocked at the @rine-network/core module boundary — this CLI test owns only
// the surface wiring, not the cryptographic external-commit round-trip (that is
// covered by rine-core/test/mls-external-join.test.ts).

const CONFIG_DIR = "/tmp/test-rine";
const API_URL = "https://test.rine.network";
const GROUP_ID = "group-open-1";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";

const MEMBER_RESPONSE = {
	agent_id: AGENT_ID,
	agent_handle: "bot@org.rine.network",
	role: "member",
	joined_at: "2026-06-03T00:00:00Z",
};

function mlsGroup(overrides: Partial<core.GroupRead> = {}): core.GroupRead {
	return {
		id: GROUP_ID,
		name: "open-group",
		handle: "open-group.rine.network",
		enrollment_policy: "open",
		visibility: "public",
		member_count: 2,
		created_at: "2026-06-01T00:00:00Z",
		mls_enabled: true,
		mls_group_id: "mls-internal-abc",
		mls_pending: false,
		...overrides,
	} as unknown as core.GroupRead;
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");

	// processMlsWelcomes is the Phase 5 step; default to a no-op (no Welcome
	// arrived) so the external-join fallback is the path under test.
	vi.spyOn(core, "processMlsWelcomes").mockResolvedValue(undefined as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerGroup(program);
	return program;
}

function stubJoin(group: core.GroupRead | null): void {
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		(path: string) => {
			if (path === `/groups/${GROUP_ID}/join`) {
				return Promise.resolve(MEMBER_RESPONSE);
			}
			return Promise.reject(new Error(`Unknown POST: ${path}`));
		},
	);
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			if (path === `/groups/${GROUP_ID}`) {
				if (group === null) return Promise.reject(new Error("not found"));
				return Promise.resolve(group);
			}
			return Promise.reject(new Error(`Unknown GET: ${path}`));
		},
	);
}

describe("group join — open-enrollment external-commit self-join (Phase 6)", () => {
	it("self-joins via external commit when MLS-active and no local state exists", async () => {
		stubJoin(mlsGroup());
		vi.spyOn(core, "loadMlsState").mockReturnValue(null);
		const extJoin = vi
			.spyOn(core, "externalJoinMlsGroup")
			.mockResolvedValue({ epoch: 2 });

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "join", GROUP_ID]);

		expect(extJoin).toHaveBeenCalledTimes(1);
		expect(extJoin).toHaveBeenCalledWith(
			CONFIG_DIR,
			AGENT_ID,
			GROUP_ID,
			expect.any(core.HttpClient),
			{ "X-Rine-Agent": AGENT_ID },
		);
	});

	it("does NOT self-join when a Welcome already installed local MLS state", async () => {
		stubJoin(mlsGroup());
		vi.spyOn(core, "loadMlsState").mockReturnValue({
			stateBlob: new Uint8Array([1, 2, 3]),
			metadata: { groupId: GROUP_ID, epoch: 1, cipherSuite: 0x0001 },
		});
		const extJoin = vi
			.spyOn(core, "externalJoinMlsGroup")
			.mockResolvedValue({ epoch: 2 });

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "join", GROUP_ID]);

		expect(extJoin).not.toHaveBeenCalled();
	});

	it("does NOT self-join for a non-MLS (sender-key) group", async () => {
		stubJoin(mlsGroup({ mls_group_id: null, mls_enabled: false }));
		const loadState = vi.spyOn(core, "loadMlsState").mockReturnValue(null);
		const extJoin = vi
			.spyOn(core, "externalJoinMlsGroup")
			.mockResolvedValue({ epoch: 2 });

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "join", GROUP_ID]);

		expect(extJoin).not.toHaveBeenCalled();
		// Bails on the mls_group_id latch before ever inspecting local state.
		expect(loadState).not.toHaveBeenCalled();
	});

	it("self-join failure is non-fatal — the join itself still succeeds", async () => {
		stubJoin(mlsGroup());
		vi.spyOn(core, "loadMlsState").mockReturnValue(null);
		vi.spyOn(core, "externalJoinMlsGroup").mockRejectedValue(
			new Error("no published GroupInfo"),
		);

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "join", GROUP_ID]);

		// Best-effort: a failed self-join must not surface as a command error.
		expect(process.exitCode).toBeUndefined();
	});
});

// group invites — the authoritative agent-scoped pull (REQ-CLI1).
//
// `rine group invites` lists the open vouchers addressed to the calling agent
// via `GET /groups/invites` (no group-id arg). These tests drive the REAL
// command and assert the observable wiring: the HTTP GET path, the rendered
// rows (a dedicated inviteRow — not requestRow), and the --json passthrough.
// listMyInvites lives in @rine-network/core; the command is a thin renderer.

const INVITE_VOUCHER = {
	id: "req-1",
	group_id: "55555555-5555-5555-5555-555555555555",
	agent_id: AGENT_ID,
	invited_by: "33333333-3333-3333-3333-333333333333",
	message: "join us",
	status: "invited",
	created_at: "2026-06-13T00:00:00Z",
	group_handle: "ops.rine.network",
	group_name: "ops",
} as core.JoinRequestRead;

describe("group invites — authoritative agent-scoped pull (REQ-CLI1)", () => {
	function stubInvitesGet(items: core.JoinRequestRead[]): void {
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
			(path: string) => {
				if (path === "/groups/invites") {
					return Promise.resolve({ items, total: items.length });
				}
				return Promise.reject(new Error(`Unknown GET: ${path}`));
			},
		);
	}

	it("lists invites addressed to me with the invite columns", async () => {
		stubInvitesGet([INVITE_VOUCHER]);
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "group", "invites"]);

		const rows = printTableSpy.mock.calls.at(-1)?.[0] as Record<
			string,
			unknown
		>[];
		expect(rows).toHaveLength(1);
		const row = rows[0] as Record<string, unknown>;
		// Dedicated inviteRow surfaces invite semantics: who invited you + which
		// group — NOT the requestRow's `Your Vote` column.
		expect(row).not.toHaveProperty("Your Vote");
		expect(row.Group).toBe("ops.rine.network");
		expect(row["Group ID"]).toBe(INVITE_VOUCHER.group_id);
		expect(row["Invited By"]).toBe(INVITE_VOUCHER.invited_by);
		expect(row.Message).toBe("join us");
		expect(row.Created).toBe(INVITE_VOUCHER.created_at);
	});

	it("prints (no results) for an empty invite list", async () => {
		stubInvitesGet([]);
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync(["node", "rine", "group", "invites"]);

		// printTable([]) renders "(no results)" — assert it received the empty list.
		expect(printTableSpy.mock.calls.at(-1)?.[0]).toEqual([]);
	});

	it("prints the invite list (from listMyInvites) in --json mode", async () => {
		stubInvitesGet([INVITE_VOUCHER]);
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "group", "invites"]);

		// listMyInvites unwraps to the items array; --json prints that array.
		expect(printJsonSpy.mock.calls.at(-1)?.[0]).toEqual([INVITE_VOUCHER]);
		expect(process.exitCode).toBeUndefined();
	});
});

// invite notification wiring (REQ-CLI2).
//
// After the POST + best-effort MLS add, `group invite` seals a
// rine.v1.group_invite DM to the invitee so their normal inbox alerts them.
// These tests drive the REAL `group invite` command and assert the observable
// wiring at the @rine-network/core boundary the CLI actually crosses:
// sendGroupInviteNotification is invoked with the resolved inviter, the
// invitee, and the freshly-fetched group handle. The sealed-DM round-trip
// (encryptMessage / fetchRecipientKeys / the /messages POST type+body) is owned
// by rine-core/test/group-invite-ops.test.ts — it lives inside core and cannot
// be intercepted from this package's namespace spy. Here we own only the CLI
// surface wiring. Best-effort by contract: a failure must never fail the invite.

const INVITE_GROUP_ID = "55555555-5555-5555-5555-555555555555";
const INVITER_ID = "33333333-3333-3333-3333-333333333333";
const INVITEE_ID = "44444444-4444-4444-4444-444444444444";

const VOUCHER_RESPONSE = {
	id: "req-9",
	group_id: INVITE_GROUP_ID,
	agent_id: INVITEE_ID,
	invited_by: INVITER_ID,
	status: "invited",
	created_at: "2026-06-13T00:00:00Z",
} as core.JoinRequestRead;

describe("group invite — best-effort invite notification (REQ-CLI2)", () => {
	// Non-MLS group so addMemberToMls bails — isolates the notification path.
	const NON_MLS_GROUP = mlsGroup({
		id: INVITE_GROUP_ID,
		handle: "ops.rine.network",
		mls_group_id: null,
		mls_enabled: false,
	});

	function stubInviteHttp(): void {
		vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
			(path: string) => {
				if (path === `/groups/${INVITE_GROUP_ID}/invite`) {
					return Promise.resolve(VOUCHER_RESPONSE);
				}
				return Promise.reject(new Error(`Unknown POST: ${path}`));
			},
		);
		vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
			(path: string) => {
				if (path === `/groups/${INVITE_GROUP_ID}`) {
					return Promise.resolve(NON_MLS_GROUP);
				}
				return Promise.reject(new Error(`Unknown GET: ${path}`));
			},
		);
		// resolveToUuid maps the --agent flag to the invitee; resolveAgent maps
		// the sender selection to the inviter.
		vi.spyOn(core, "resolveToUuid").mockResolvedValue(INVITEE_ID);
		vi.spyOn(core, "fetchAgents").mockResolvedValue([
			{ id: INVITER_ID, handle: "coach@org.rine.network" } as never,
		]);
		vi.spyOn(core, "resolveAgent").mockResolvedValue(INVITER_ID);
	}

	it("notifies the invitee with the locked type, inviter, and group handle", async () => {
		stubInviteHttp();
		const notifySpy = vi
			.spyOn(core, "sendGroupInviteNotification")
			.mockResolvedValue(undefined);

		const program = makeProgram({ json: true });
		await program.parseAsync([
			"node",
			"rine",
			"group",
			"invite",
			INVITE_GROUP_ID,
			"--agent",
			INVITEE_ID,
			"--message",
			"welcome aboard",
		]);

		// The locked notification type is sourced from the single core const.
		expect(core.GROUP_INVITE_TYPE).toBe("rine.v1.group_invite");
		// CLI surface wiring: inviter resolved as sender, invitee as target, and
		// the freshly-fetched group handle threaded into the sealed payload.
		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith(
			expect.any(core.HttpClient),
			CONFIG_DIR,
			INVITER_ID,
			INVITEE_ID,
			{
				group_id: INVITE_GROUP_ID,
				group_handle: "ops.rine.network",
				message: "welcome aboard",
			},
		);
		expect(process.exitCode).toBeUndefined();
	});

	it("notification failure is non-fatal — the invite still succeeds", async () => {
		stubInviteHttp();
		// The real sendGroupInviteNotification fetches keys and seals; force it to
		// reject (e.g. groups_only 403) and assert the invite is unaffected.
		vi.spyOn(core, "sendGroupInviteNotification").mockRejectedValue(
			new Error("groups_only 403"),
		);
		const printTableSpy = vi
			.spyOn(outputModule, "printTable")
			.mockImplementation(() => {});

		const program = makeProgram({ json: false });
		await program.parseAsync([
			"node",
			"rine",
			"group",
			"invite",
			INVITE_GROUP_ID,
			"--agent",
			INVITEE_ID,
		]);

		// Best-effort: a failed notification must not surface as a command error,
		// and the voucher row must still be rendered.
		expect(process.exitCode).toBeUndefined();
		expect(printTableSpy).toHaveBeenCalled();
	});
});
