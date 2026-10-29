// `rine send` into a group refuses a downgrade.
//
// The guard sits between the group resolve and the encryption branch, and the
// placement is the whole requirement: `getOrCreateSenderKey` fans this agent's
// sender key out to whatever membership the server returns, so by the time the
// sender-key branch has run the key is already gone. Every refusal test
// therefore asserts the typed error AND that `getOrCreateSenderKey` was never
// reached — the second assertion is the one that means something.
//
// `assertNoMlsDowngrade` is substituted with the same decision over an
// in-memory set of "groups this agent holds state for", because the real one
// opens the native MLS store. It throws the real `MlsDowngradeError`, and the
// arguments it was handed are asserted, so the call site's contract is pinned
// rather than assumed. The guard's own truth table is proven in
// `rine-core/test/crypto/mls-downgrade.test.ts`.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateSenderKey = vi.fn();
vi.mock("../src/commands/sender-key-ops.js", () => ({
	getOrCreateSenderKey: (...a: unknown[]) => getOrCreateSenderKey(...a),
}));

const { registerMessages } = await import("../src/commands/messages.js");

const API_URL = "https://test.rine.network";
const CONFIG_DIR = "/tmp/test-rine-send-downgrade";
const SENDER = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_HANDLE = "#dev@acme.rine.network";

/** Groups this agent is pretending to hold local MLS state for. */
const localMlsState = new Set<string>();

interface GuardCall {
	configDir: string;
	agentId: string;
	groupId: string;
	serverSaysMls: boolean;
}
let guardCalls: GuardCall[] = [];
let thrown: unknown;
let posts: string[] = [];
let postedBodies: Record<string, unknown>[] = [];

function makeGroup(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: GROUP_ID,
		name: "dev",
		handle: GROUP_HANDLE,
		description: null,
		enrollment_policy: "closed",
		visibility: "private",
		isolated: false,
		vote_duration_hours: 72,
		member_count: 2,
		created_at: "2026-04-11T12:00:00Z",
		mls_group_id: null,
		mls_pending: false,
		...over,
	};
}

function stubServer(group: Record<string, unknown>): void {
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		async (path: string) => {
			if (path === "/groups") return { items: [group] };
			// The id rung's own route. A UUID is asked for by id, and the row it
			// answers with is the one every sentence below has to be about.
			if (path === `/groups/${GROUP_ID}`) return group;
			return {};
		},
	);
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		async (path: string, body?: unknown) => {
			posts.push(path);
			postedBodies.push(body as Record<string, unknown>);
			return { id: "m1", conversation_id: "c1" };
		},
	);
}

async function send(to: string = GROUP_HANDLE): Promise<void> {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	program.option("--as <handle>", "Act as agent");
	vi.spyOn(program, "opts").mockReturnValue({ json: true });
	registerMessages(program);
	await program.parseAsync([
		"node",
		"rine",
		"send",
		"--to",
		to,
		"--payload",
		'{"text":"hi group"}',
	]);
}

beforeEach(() => {
	localMlsState.clear();
	guardCalls = [];
	posts = [];
	postedBodies = [];
	thrown = undefined;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "normalizeHandle").mockImplementation((h) => h);
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: SENDER, handle: "me@acme.rine.network" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: SENDER });
	vi.spyOn(core, "encryptGroupMessage").mockResolvedValue({
		result: {
			encrypted_payload: "ENC(GROUP)",
			encryption_version: "sender-key-v1",
			sender_signing_kid: `rine:${SENDER}`,
		},
	} as never);
	// The seal-and-post is rine-core's: its ordering, retry and recovery are
	// tested there. This file pins the CLI side of the seam.
	vi.spyOn(core, "sealAndPostMlsGroupMessage").mockImplementation(
		async (_actor, _groupId, _payload, post) =>
			post({
				encrypted_payload: "ENC(MLS)",
				encryption_version: "mls-v1",
				sender_signing_kid: `rine:${SENDER}`,
				escrow_fp: "ESCROW_FP",
			} as never),
	);
	getOrCreateSenderKey.mockResolvedValue({
		state: { __state: true },
		groupId: GROUP_ID,
	});
	// The CLI swallows a thrown error into `printError(formatError(err))`, so
	// this is where a refusal is observable as an object rather than as text.
	vi.spyOn(core, "formatError").mockImplementation((err: unknown) => {
		thrown = err;
		return String((err as Error)?.message ?? err);
	});
	vi.spyOn(core, "assertNoMlsDowngrade").mockImplementation(
		(
			configDir: string,
			agentId: string,
			groupId: string,
			serverSaysMls: boolean,
		) => {
			guardCalls.push({ configDir, agentId, groupId, serverSaysMls });
			if (serverSaysMls) return;
			if (!localMlsState.has(groupId)) return;
			throw new core.MlsDowngradeError(groupId);
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

describe("rine send — a group send refuses a downgrade", () => {
	it("send_when_server_contradicts_local_mls_state_refuses", async () => {
		localMlsState.add(GROUP_ID);
		stubServer(makeGroup());

		await send();

		expect(core.isMlsDowngradeError(thrown)).toBe(true);
		expect((thrown as { code: string }).code).toBe(core.DOWNGRADE_REFUSED_CODE);
		expect(process.exitCode).toBe(1);
	});

	it("send_when_server_contradicts_local_mls_state_never_makes_a_sender_key", async () => {
		localMlsState.add(GROUP_ID);
		stubServer(makeGroup());

		await send();

		expect(getOrCreateSenderKey).not.toHaveBeenCalled();
		expect(core.encryptGroupMessage).not.toHaveBeenCalled();
		expect(posts).toEqual([]);
	});

	it("send_when_refused_does_not_retry_as_sender_key", async () => {
		localMlsState.add(GROUP_ID);
		stubServer(makeGroup());

		await send();
		await send();

		expect(getOrCreateSenderKey).not.toHaveBeenCalled();
	});

	it("send_when_guarding_passes_the_config_dir_agent_and_group_uuid", async () => {
		stubServer(makeGroup());

		await send();

		expect(guardCalls).toEqual([
			{
				configDir: CONFIG_DIR,
				agentId: SENDER,
				groupId: GROUP_ID,
				serverSaysMls: false,
			},
		]);
	});

	it("send_when_billboard_group_has_no_mls_state_still_uses_sender_keys", async () => {
		stubServer(makeGroup());

		await send();

		expect(getOrCreateSenderKey).toHaveBeenCalledTimes(1);
		expect(posts).toEqual(["/messages"]);
		expect(process.exitCode).toBeUndefined();
	});
});

describe("rine send — the branch is the send predicate", () => {
	it("send_when_group_is_mls_latched_takes_the_mls_branch", async () => {
		stubServer(makeGroup({ mls_group_id: "opaque-latch" }));

		await send();

		expect(core.sealAndPostMlsGroupMessage).toHaveBeenCalledTimes(1);
		expect(getOrCreateSenderKey).not.toHaveBeenCalled();
		expect(guardCalls[0]?.serverSaysMls).toBe(true);
	});

	it("send_when_init_is_pending_never_makes_a_sender_key", async () => {
		stubServer(makeGroup({ mls_pending: true }));

		await send();

		expect(getOrCreateSenderKey).not.toHaveBeenCalled();
		expect(posts).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("send_when_init_is_pending_refuses_with_the_stable_code", async () => {
		// The code is the caller's handle on this refusal; the message is for the
		// operator reading it, and naming the self-clear window is its job.
		stubServer(makeGroup({ mls_pending: true }));

		await send();

		expect(core.isMlsInitInFlightError(thrown)).toBe(true);
		expect((thrown as { code: string }).code).toBe(
			core.MLS_INIT_IN_FLIGHT_CODE,
		);
		const minutes = Math.round(core.MLS_PENDING_SELF_CLEAR_SECONDS / 60);
		expect((thrown as Error).message).toContain(`${minutes} minutes`);
	});

	it("send_when_init_is_pending_names_the_group_the_server_holds_not_the_spelling_typed", async () => {
		// A UUID may address a group, and the note printed a line earlier
		// has already resolved it to `#dev@…`. The refusal echoed the UUID back,
		// so one event read two ways — the same defect `group-recovery.ts` calls
		// out by name on the sync path. `to_handle` on the wire is the server's
		// spelling; the sentence has to be the same one.
		stubServer(makeGroup({ mls_pending: true }));

		await send(GROUP_ID);

		expect((thrown as Error).message).toContain(GROUP_HANDLE);
		expect((thrown as Error).message).not.toContain(GROUP_ID);
	});

	it("send_when_init_is_pending_tells_the_guard_the_group_is_mls", async () => {
		// The guard's input is the SEND predicate. Reading `mls_group_id` alone
		// here would ask the guard the render question and refuse a member who
		// legitimately holds state for a group mid-init.
		stubServer(makeGroup({ mls_pending: true }));

		await send();

		expect(guardCalls[0]?.serverSaysMls).toBe(true);
	});
});
describe("rine send — an MLS send goes through the core seal-and-post", () => {
	it("send_when_group_is_mls_then_core_gets_the_actor_group_uuid_and_payload", async () => {
		stubServer(makeGroup({ mls_group_id: "opaque-latch" }));

		await send();

		expect(core.sealAndPostMlsGroupMessage).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: SENDER, configDir: CONFIG_DIR }),
			GROUP_ID,
			{ text: "hi group" },
			expect.any(Function),
		);
	});

	it("send_when_group_is_mls_then_the_body_carries_the_sealed_fields_and_escrow_fp", async () => {
		stubServer(makeGroup({ mls_group_id: "opaque-latch" }));

		await send();

		expect(postedBodies).toHaveLength(1);
		expect(postedBodies[0]).toMatchObject({
			encryption_version: "mls-v1",
			escrow_fp: "ESCROW_FP",
			to_handle: GROUP_HANDLE,
		});
	});

	it("send_when_core_refuses_with_an_escrow_gap_then_nothing_is_posted", async () => {
		stubServer(makeGroup({ mls_group_id: "opaque-latch" }));
		vi.mocked(core.sealAndPostMlsGroupMessage).mockRejectedValue(
			new core.EscrowGapError(GROUP_ID, 7, "too_many_leaves" as never),
		);

		await send();

		expect(posts).toEqual([]);
		expect(core.isEscrowGapError(thrown)).toBe(true);
		expect(process.exitCode).toBe(1);
	});

	it("send_when_the_group_is_sender_key_then_no_mls_seal_runs", async () => {
		stubServer(makeGroup());

		await send();

		expect(core.sealAndPostMlsGroupMessage).not.toHaveBeenCalled();
		expect(postedBodies[0]).not.toHaveProperty("escrow_fp");
	});
});
