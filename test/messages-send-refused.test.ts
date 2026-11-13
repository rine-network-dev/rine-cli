// `rine send` into a group our org's rule has closed to our posts refuses
// before anything is sealed.
//
// The guard sits beside the downgrade guard, and the placement is the whole
// requirement: `getOrCreateSenderKey` fans this agent's sender key out to
// every member, and an MLS seal makes a commit. Every refusal test therefore
// asserts the typed error AND that no key, no seal and no `POST /messages`
// happened. The guard's own truth table is in rine-core's
// `test/group-postable.test.ts`.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateSenderKey = vi.fn();
vi.mock("../src/commands/sender-key-ops.js", () => ({
	getOrCreateSenderKey: (...a: unknown[]) => getOrCreateSenderKey(...a),
}));

const { registerMessages } = await import("../src/commands/messages.js");

const SENDER = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_HANDLE = "#dev@acme.rine.network";

let thrown: unknown;
let posts: string[] = [];
let printed: string[] = [];
let postResult: Record<string, unknown> = {};

function makeGroup(over: Record<string, unknown> = {}): Record<string, unknown> {
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
			if (path === `/groups/${GROUP_ID}`) return group;
			return {};
		},
	);
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		async (path: string) => {
			posts.push(path);
			return { id: "m1", conversation_id: "c1", ...postResult };
		},
	);
}

async function send(json = true): Promise<void> {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	program.option("--as <handle>", "Act as agent");
	vi.spyOn(program, "opts").mockReturnValue({ json });
	registerMessages(program);
	await program.parseAsync([
		"node",
		"rine",
		"send",
		"--to",
		GROUP_HANDLE,
		"--payload",
		'{"text":"hi group"}',
	]);
}

beforeEach(() => {
	thrown = undefined;
	posts = [];
	printed = [];
	postResult = {};
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		printed.push(a.join(" "));
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-send-refused");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "normalizeHandle").mockImplementation((h) => h);
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: SENDER, handle: "me@acme.rine.network" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: SENDER });
	vi.spyOn(core, "assertNoMlsDowngrade").mockImplementation(() => {});
	vi.spyOn(core, "encryptGroupMessage").mockResolvedValue({
		result: {
			encrypted_payload: "ENC(GROUP)",
			encryption_version: "sender-key-v1",
			sender_signing_kid: `rine:${SENDER}`,
		},
	} as never);
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
	vi.spyOn(core, "formatError").mockImplementation((err: unknown) => {
		thrown = err;
		return String((err as Error)?.message ?? err);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	getOrCreateSenderKey.mockReset();
	process.exitCode = undefined;
});

describe("rine send — a group our org may not post in", () => {
	for (const refusal of ["foreign_open_group", "refused_members"]) {
		for (const mls of [false, true]) {
			it(`send_when_the_group_says_${refusal}_on_${mls ? "mls" : "sender_key"}_makes_no_key_no_seal_and_no_post`, async () => {
				stubServer(
					makeGroup({
						posting_refused: refusal,
						refused_members: refusal === "refused_members" ? [SENDER] : null,
						mls_group_id: mls ? "opaque-latch" : null,
					}),
				);

				await send();

				expect(core.isGroupPostingRefusedError(thrown)).toBe(true);
				expect((thrown as { code: string }).code).toBe("group_posting_refused");
				expect(getOrCreateSenderKey).not.toHaveBeenCalled();
				expect(core.encryptGroupMessage).not.toHaveBeenCalled();
				expect(core.sealAndPostMlsGroupMessage).not.toHaveBeenCalled();
				expect(posts).toEqual([]);
				expect(process.exitCode).toBe(1);
			});
		}
	}

	it("send_when_posting_is_allowed_posts_once", async () => {
		stubServer(makeGroup({ posting_refused: null }));

		await send();

		expect(posts).toEqual(["/messages"]);
		expect(process.exitCode).toBeUndefined();
	});

	it("send_when_the_value_is_one_a_newer_server_added_leaves_it_to_the_server", async () => {
		stubServer(makeGroup({ posting_refused: "from_the_future" }));

		await send();

		expect(posts).toEqual(["/messages"]);
	});
});

describe("rine send — the unreadable-by-orgs sentence", () => {
	it("send_when_the_server_counts_unreadable_orgs_prints_the_sentence", async () => {
		postResult = { unreadable_by_orgs: 2 };
		stubServer(makeGroup());

		await send(false);

		expect(printed.join("\n")).toContain(
			"2 member organisations may not be able to read this post",
		);
	});

	it("send_when_nothing_is_unreadable_prints_no_sentence", async () => {
		stubServer(makeGroup());

		await send(false);

		expect(printed.join("\n")).not.toContain("may not be able to read");
	});

	it("send_as_json_carries_the_count_and_no_sentence", async () => {
		postResult = { unreadable_by_orgs: 1 };
		stubServer(makeGroup());

		await send(true);

		const out = printed.join("\n");
		expect(out).toContain('"unreadable_by_orgs": 1');
		expect(out).not.toContain("may not be able to read");
	});
});
