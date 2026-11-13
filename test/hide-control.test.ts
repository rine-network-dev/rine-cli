/**
 * `--hide-control` on the commands that list messages: control frames (group
 * key distributions and group invites) are left out of the output, and a
 * listing without the flag renders them as before.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerMessages } = await import("../src/commands/messages.js");
const { registerStream } = await import("../src/commands/stream.js");
const outputModule = await import("../src/output.js");

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SENDER_ID = "22222222-2222-2222-2222-222222222222";
const CONV_ID = "77777777-7777-7777-7777-777777777777";

function inboxRow(id: string, type: string): core.MessageRead {
	return {
		id,
		conversation_id: "conv-1",
		type,
		from_agent_id: SENDER_ID,
		to_agent_id: AGENT_ID,
		encrypted_payload: "c2VhbGVk",
		encryption_version: "hpke-hybrid-v2",
		created_at: "2026-10-13T12:00:00Z",
		status: "new",
	} as unknown as core.MessageRead;
}

function threadEntry(type: string): core.ThreadRowEntry {
	return {
		direction: "received",
		sender_handle: "alice@org.rine.network",
		text: type,
		verification_status: "verified",
		type,
		created_at: "2026-01-15T12:00:01Z",
		from_agent_id: SENDER_ID,
		sender_class: "other",
	};
}

const TYPES = [
	"rine.v1.text",
	"rine.v1.sender_key_distribution",
	"rine.v1.group_invite",
];

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
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation((path: string) =>
		path === `/conversations/${CONV_ID}/messages`
			? Promise.resolve({ messages: [{}], truncated: false })
			: Promise.resolve({
					items: TYPES.map((t, i) => inboxRow(`msg-${i}`, t)),
					next_cursor: null,
				}),
	);
	vi.spyOn(core, "decryptThreadRows").mockResolvedValue(TYPES.map(threadEntry));
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

async function typesPrinted(argv: string[], json: boolean): Promise<string[]> {
	const table = vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
	const out = vi.spyOn(outputModule, "printJson").mockImplementation(() => {});
	await makeProgram({ json }).parseAsync(["node", "rine", ...argv]);
	if (!json) {
		const rows = table.mock.calls.at(-1)?.[0] as Array<{ Type: string }>;
		return rows.map((r) => r.Type);
	}
	const payload = out.mock.calls.at(-1)?.[0] as
		| { items: Array<{ type: string }> }
		| Array<{ type: string }>;
	return (Array.isArray(payload) ? payload : payload.items).map((r) => r.type);
}

describe("--hide-control", () => {
	it("test_inbox_when_hide_control_is_set_then_control_frames_are_omitted", async () => {
		expect(await typesPrinted(["inbox", "--hide-control"], false)).toEqual([
			"rine.v1.text",
		]);
		expect(await typesPrinted(["inbox", "--hide-control"], true)).toEqual([
			"rine.v1.text",
		]);
	});

	it("test_inbox_when_hide_control_is_not_set_then_control_frames_are_listed", async () => {
		expect(await typesPrinted(["inbox"], false)).toEqual(TYPES);
	});

	it("test_inbox_when_hide_control_is_set_then_nothing_is_marked_read", async () => {
		const post = vi.spyOn(core.HttpClient.prototype, "post");
		await typesPrinted(["inbox", "--hide-control"], false);
		expect(post).not.toHaveBeenCalled();
	});

	it("test_thread_when_hide_control_is_set_then_control_frames_are_omitted", async () => {
		expect(
			await typesPrinted(["thread", CONV_ID, "--hide-control"], false),
		).toEqual(["rine.v1.text"]);
		expect(
			await typesPrinted(["thread", CONV_ID, "--hide-control"], true),
		).toEqual(["rine.v1.text"]);
	});

	it("test_thread_when_hide_control_is_not_set_then_control_frames_are_listed", async () => {
		expect(await typesPrinted(["thread", CONV_ID], false)).toEqual(TYPES);
	});
});

describe("--hide-control help", () => {
	const helpOf = (register: (program: Command) => void, command: string) => {
		const program = new Command();
		register(program);
		const sub = program.commands.find((c) => c.name() === command);
		return sub?.options.find((o) => o.long === "--hide-control")?.description;
	};

	it("test_stream_help_when_hide_control_described_then_frames_are_marked_delivered_not_read", () => {
		const help = helpOf(registerStream, "stream");
		expect(help).toContain("marked delivered once settled");
		expect(help).not.toContain("marked read");
	});

	it("test_inbox_help_when_hide_control_described_then_frames_are_not_marked_or_changed", () => {
		expect(helpOf(registerMessages, "inbox")).toContain("not marked read or changed");
	});
});
