/**
 * `rine message inbox` on a listing that holds an A2A cleartext row: the one
 * message whose body travelled without end-to-end encryption says so, in the
 * table and in `--json`, and a listing without one renders as it always has.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerMessages } = await import("../src/commands/messages.js");
const outputModule = await import("../src/output.js");

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SENDER_ID = "22222222-2222-2222-2222-222222222222";

/** The wire payload of one text part "plain", as the server serves it: unpadded base64url. */
const WIRE_PAYLOAD = "W3sidGV4dCI6ICJwbGFpbiJ9XQ";

const CLEARTEXT_ROW = {
	id: "msg-a2a-1",
	conversation_id: "conv-1",
	type: "rine.v1.a2a_message",
	from_agent_id: SENDER_ID,
	to_agent_id: AGENT_ID,
	encrypted_payload: WIRE_PAYLOAD,
	encryption_version: "none",
	created_at: "2026-10-13T12:00:00Z",
	status: "new",
} as unknown as core.MessageRead;

const SEALED_ROW = {
	id: "msg-sealed-1",
	conversation_id: "conv-1",
	type: "rine.v1.text",
	from_agent_id: SENDER_ID,
	to_agent_id: AGENT_ID,
	encrypted_payload: "c2VhbGVk",
	encryption_version: "hpke-hybrid-v2",
	created_at: "2026-10-13T12:01:00Z",
	status: "new",
} as unknown as core.MessageRead;

function inboxResponse(items: core.MessageRead[]) {
	return { items, next_cursor: null };
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, handle: "bot@org.rine.network" } as never,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });
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

describe("inbox command — an A2A cleartext row", () => {
	it("test_inbox_when_a_row_is_a2a_cleartext_then_the_table_carries_the_notice_column", async () => {
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue(
			inboxResponse([CLEARTEXT_ROW, SEALED_ROW]),
		);
		const table = vi.spyOn(outputModule, "printTable").mockImplementation(() => {});

		await makeProgram({ json: false }).parseAsync(["node", "rine", "inbox"]);

		const [rows, keys] = table.mock.calls.at(-1) as [
			Record<string, unknown>[],
			string[],
		];
		expect(keys).toContain("Notice");
		expect(rows[0]?.Notice).toBe(core.A2A_CLEARTEXT_NOTICE);
		expect(rows[1]?.Notice).toBeUndefined();
	});

	it("test_inbox_when_the_cleartext_row_is_not_first_then_the_table_still_carries_the_notice_column", async () => {
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue(
			inboxResponse([SEALED_ROW, CLEARTEXT_ROW]),
		);
		const table = vi.spyOn(outputModule, "printTable").mockImplementation(() => {});

		await makeProgram({ json: false }).parseAsync(["node", "rine", "inbox"]);

		const [rows, keys] = table.mock.calls.at(-1) as [
			Record<string, unknown>[],
			string[],
		];
		expect(keys.at(-1)).toBe("Notice");
		expect(rows[1]?.Notice).toBe(core.A2A_CLEARTEXT_NOTICE);
	});

	it("test_inbox_when_a_row_is_a2a_cleartext_then_json_carries_the_typed_flag", async () => {
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue(
			inboxResponse([CLEARTEXT_ROW, SEALED_ROW]),
		);
		const json = vi.spyOn(outputModule, "printJson").mockImplementation(() => {});

		await makeProgram({ json: true }).parseAsync(["node", "rine", "inbox"]);

		const out = json.mock.calls.at(-1)?.[0] as {
			items: Record<string, unknown>[];
		};
		expect(out.items[0]?.a2a_cleartext).toBe(true);
		expect(out.items[0]?.a2a_cleartext_notice).toBe(core.A2A_CLEARTEXT_NOTICE);
		expect(out.items[0]?.decrypted_payload).toEqual([{ text: "plain" }]);
		expect(out.items[1]).not.toHaveProperty("a2a_cleartext");
		expect(out.items[1]).not.toHaveProperty("a2a_cleartext_notice");
		expect(out.items[1]).not.toHaveProperty("decrypted_payload");
	});

	it("test_inbox_when_no_row_is_a2a_cleartext_then_the_table_has_the_six_columns", async () => {
		vi.spyOn(core.HttpClient.prototype, "get").mockResolvedValue(
			inboxResponse([SEALED_ROW]),
		);
		const table = vi.spyOn(outputModule, "printTable").mockImplementation(() => {});

		await makeProgram({ json: false }).parseAsync(["node", "rine", "inbox"]);

		const [rows, keys] = table.mock.calls.at(-1) as [
			Record<string, unknown>[],
			string[],
		];
		expect(keys).toEqual(["ID", "From", "Group", "Type", "Status", "Created"]);
		expect(rows[0]).not.toHaveProperty("Notice");
	});
});
