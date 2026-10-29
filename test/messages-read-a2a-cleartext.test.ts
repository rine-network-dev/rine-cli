/**
 * `rine message read` on an A2A cleartext row: the one message whose body travelled
 * without end-to-end encryption says so, in the table and in `--json`.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerMessages } = await import("../src/commands/messages.js");
const outputModule = await import("../src/output.js");

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SENDER_ID = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "msg-a2a-1";

/** The wire payload of one text part "plain", as the server serves it: unpadded base64url. */
const WIRE_PAYLOAD = "W3sidGV4dCI6ICJwbGFpbiJ9XQ";

const A2A_MESSAGE = {
	id: MESSAGE_ID,
	conversation_id: "conv-1",
	type: "rine.v1.a2a_message",
	from_agent_id: SENDER_ID,
	to_agent_id: AGENT_ID,
	encrypted_payload: WIRE_PAYLOAD,
	encryption_version: "none",
	created_at: "2026-10-13T12:00:00Z",
} as unknown as core.MessageRead;

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue(A2A_MESSAGE);
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, handle: "bot@org.rine.network" } as never,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });
	vi.spyOn(core, "agentKeysExist").mockReturnValue(true);
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
	registerMessages(program);
	return program;
}

describe("read command — an A2A cleartext message", () => {
	it("test_read_when_the_message_is_a2a_cleartext_then_the_table_carries_the_notice", async () => {
		const table = vi.spyOn(outputModule, "printTable").mockImplementation(() => {});

		await makeProgram({ json: false }).parseAsync(["node", "rine", "read", MESSAGE_ID]);

		const row = (table.mock.calls.at(-1)?.[0] as Record<string, unknown>[])[0];
		expect(row?.Notice).toBe(core.A2A_CLEARTEXT_NOTICE);
		expect(row?.Payload).toBe('[{"text": "plain"}]');
	});

	it("test_read_when_the_message_is_a2a_cleartext_then_json_carries_the_typed_flag", async () => {
		const json = vi.spyOn(outputModule, "printJson").mockImplementation(() => {});

		await makeProgram({ json: true }).parseAsync(["node", "rine", "read", MESSAGE_ID]);

		const out = json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(out.a2a_cleartext).toBe(true);
		expect(out.a2a_cleartext_notice).toBe(core.A2A_CLEARTEXT_NOTICE);
		expect(out.decrypted_payload).toEqual([{ text: "plain" }]);
	});
});
