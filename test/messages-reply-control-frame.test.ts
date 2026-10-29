// `rine reply` refuses to answer a control frame.
//
// A reply mirrors the original's type, so a prose answer to a sender-key
// distribution would go on the wire labelled as one and be discarded at the far
// end. The server accepts it, so the refusal has to happen here, before the
// seal and the post.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessages } from "../src/commands/messages.js";
import * as outputModule from "../src/output.js";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const PEER_ID = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "33333333-3333-3333-3333-333333333333";

let posts: string[];

beforeEach(() => {
	posts = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-reply");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, handle: "bot@org.rine.network" } as never,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });
	vi.spyOn(core, "agentKeysExist").mockReturnValue(true);
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		async (path: string) => {
			posts.push(path);
			return {};
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function stubOriginal(type: string): void {
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		async (path: string) => {
			if (path === `/messages/${MESSAGE_ID}`) {
				return {
					id: MESSAGE_ID,
					type,
					from_agent_id: PEER_ID,
					to_agent_id: AGENT_ID,
				};
			}
			throw new Error(`Unknown path: ${path}`);
		},
	);
}

function makeProgram(): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	vi.spyOn(program, "opts").mockReturnValue({});
	registerMessages(program);
	return program;
}

describe("rine reply to a control frame", () => {
	it.each([
		["the mirrored type", core.SENDER_KEY_DISTRIBUTION_TYPE, []],
		["an explicit --type", core.GROUP_INVITE_TYPE, ["--type", "rine.v1.dm"]],
	])(
		"test_reply_when_original_is_a_control_frame_with_%s_then_refused_before_the_seal",
		async (_label, frameType, extra) => {
			stubOriginal(frameType);
			const seal = vi.spyOn(core, "sealForAgent");
			const errors = vi
				.spyOn(outputModule, "printError")
				.mockImplementation(() => {});

			await makeProgram().parseAsync([
				"node",
				"rine",
				"reply",
				MESSAGE_ID,
				"--payload",
				'{"text":"thanks"}',
				...extra,
			]);

			expect(errors.mock.calls.at(-1)?.[0]).toBe(
				`Cannot reply to a ${frameType} control frame — it is machine-parsed, not part of a conversation.`,
			);
			expect(process.exitCode).toBe(1);
			expect(seal).not.toHaveBeenCalled();
			expect(posts).toEqual([]);
		},
	);

	it("test_reply_when_original_is_a_conversation_turn_then_sealed_and_posted", async () => {
		stubOriginal("rine.v1.dm");
		const seal = vi.spyOn(core, "sealForAgent").mockResolvedValue({
			encrypted_payload: "sealed",
			encryption_version: "hpke-hybrid-v2",
			sender_signing_kid: `rine:${AGENT_ID}#0`,
		} as never);

		await makeProgram().parseAsync([
			"node",
			"rine",
			"reply",
			MESSAGE_ID,
			"--payload",
			'{"text":"thanks"}',
		]);

		expect(seal).toHaveBeenCalledWith(
			expect.anything(),
			"/tmp/test-rine-reply",
			{ senderAgentId: AGENT_ID, recipientAgentId: PEER_ID },
			{ text: "thanks" },
		);
		expect(posts).toEqual([`/messages/${MESSAGE_ID}/reply`]);
	});
});
