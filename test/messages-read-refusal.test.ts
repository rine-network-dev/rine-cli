/**
 * `rine message read` when the message does not open.
 *
 * The caller named ONE message, so this is the SINGLE tier of the explain-once
 * rule: the refusal is stated in full, with no "explain once" bookkeeping —
 * there is no second row for it to repeat itself on.
 *
 * Three things are pinned. First, core's `unknown sender key id: <id>` is a
 * control string for the recovery and must never reach a reader — not from the
 * recovery's own translated verdict, and not from a raw throw that reaches this
 * command untranslated. Second, `--json` learns why too: before this, the reason
 * went to stderr as prose or nowhere at all, so a program reading `--json` saw a
 * raw envelope and no cause. Third, `openMessage` never throws — whatever the
 * recovery ends in, including the transport failures of its own inbox scan, this
 * command prints a refusal rather than dying.
 *
 * The seam is `decryptGroupMessageWithRecovery`, because that is the collaborator
 * this command has: the ingest-and-retry itself belongs to core and is pinned
 * there (`rine-core/test/sender-key-recovery.test.ts`), on both of its arms.
 * Mocking the CLI's own re-export of the inbox scan measured a call this code no
 * longer makes.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerMessages } = await import("../src/commands/messages.js");
const outputModule = await import("../src/output.js");

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SENDER_ID = "22222222-2222-2222-2222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "msg-group-1";
const MISSING_KEY_ID = "sk-77";

const GROUP_MESSAGE = {
	id: MESSAGE_ID,
	conversation_id: "conv-1",
	type: "rine.v1.group_message",
	from_agent_id: SENDER_ID,
	to_agent_id: AGENT_ID,
	group_id: GROUP_ID,
	sender_handle: "alice@org.rine.network",
	encrypted_payload: "AABBCCDD-group-ciphertext",
	encryption_version: "sender-key-v1",
	created_at: "2026-08-12T12:00:00Z",
} as unknown as core.MessageRead;

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			if (path === `/messages/${MESSAGE_ID}`) {
				return Promise.resolve(GROUP_MESSAGE);
			}
			return Promise.reject(new Error(`Unknown path: ${path}`));
		},
	);
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

/** Whatever the recovery ends in, this is how the command meets it. */
function recoveryEndsIn(err: unknown): void {
	vi.spyOn(core, "decryptGroupMessageWithRecovery").mockRejectedValue(err);
}

async function readAndCollectStderr(): Promise<string> {
	const printErrorSpy = vi
		.spyOn(outputModule, "printError")
		.mockImplementation(() => {});
	vi.spyOn(outputModule, "printTable").mockImplementation(() => {});

	const program = makeProgram({ json: false });
	await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

	return printErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("read command — a group message whose sender key never arrived", () => {
	it("states the cause and the move in full, and never the control string", async () => {
		// The recovery has run and lost, so what arrives is already the verdict.
		recoveryEndsIn(new core.SenderKeyUnavailableError(MISSING_KEY_ID, GROUP_ID));

		const said = await readAndCollectStderr();

		// The whole composed sentence, imported rather than retyped: a reworded
		// clause this test does not name would otherwise keep it green while it
		// asserted nothing about the words a reader actually gets.
		expect(said).toContain(core.senderKeyUnavailableMessage(MISSING_KEY_ID));
		expect(said).not.toContain(core.UNKNOWN_SENDER_KEY_CLAUSE);
	});

	it("says it in --json too, with the typed cause beside the sentence", async () => {
		recoveryEndsIn(new core.SenderKeyUnavailableError(MISSING_KEY_ID, GROUP_ID));
		const printJsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		const program = makeProgram({ json: true });
		await program.parseAsync(["node", "rine", "read", MESSAGE_ID]);

		const out = printJsonSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(out.decrypt_error_code).toBe(core.SENDER_KEY_UNAVAILABLE_CODE);
		expect(String(out.decrypt_error)).toBe(
			core.senderKeyUnavailableMessage(MISSING_KEY_ID),
		);
		expect(String(out.decrypt_error)).not.toContain(
			core.UNKNOWN_SENDER_KEY_CLAUSE,
		);
	});

	it("translates the raw control string if one ever reaches it", async () => {
		// The second half of `asSenderKeyUnavailable`, and the reason this command
		// calls it rather than testing for the error class: a bundle carrying two
		// copies of core makes `instanceof` answer false, and an untranslated throw
		// arriving here must still be met with the sentence, never printed.
		recoveryEndsIn(
			new Error(`${core.UNKNOWN_SENDER_KEY_CLAUSE}${MISSING_KEY_ID}`),
		);

		const said = await readAndCollectStderr();

		expect(said).toContain(core.senderKeyUnavailableMessage(MISSING_KEY_ID));
		expect(said).not.toContain(core.UNKNOWN_SENDER_KEY_CLAUSE);
	});

	it("keeps its own words for a failure it knows nothing truer about", async () => {
		// Only this one cause is translated; everything else keeps the words it
		// arrived with, because nothing here knows a better thing to say.
		recoveryEndsIn(new Error("message key expired or already consumed"));

		const said = await readAndCollectStderr();

		expect(said).toContain("message key expired or already consumed");
		expect(said).not.toContain(core.senderKeyUnavailableMessage(MISSING_KEY_ID));
	});

	it("refuses rather than throws when the recovery's own fetch fails", async () => {
		// The inbox scan is inside the recovery, so its transport failures come out
		// of the same call. They used to be raised from OUTSIDE this command's try,
		// which made a documented "never throws" false and turned a flaky network
		// into an unhandled rejection instead of a refusal.
		recoveryEndsIn(new Error("503: upstream unavailable"));

		const said = await readAndCollectStderr();

		expect(said).toContain("Decryption failed");
		expect(said).toContain("503: upstream unavailable");
	});
});
