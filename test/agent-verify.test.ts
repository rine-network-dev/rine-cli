import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgent } from "../src/commands/agent.js";
import * as outputModule from "../src/output.js";
import * as promptModule from "../src/prompt.js";
import { derivedAgentKeys } from "./derived-keys.js";

/**
 * `rine agent verify` — the compare-and-confirm half of identity verification.
 *
 * The verb shows a peer's published words beside the words this client derives
 * for its OWN agent, and records that an operator read them back. It is
 * advisory: nothing here refuses a send, and a peer that has never been
 * confirmed is still addressable.
 */

const OWN_ID = "11111111-2222-3333-4444-555555555555";
const PEER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PEER_WORDS = "abandon ability able about above";

let configDir: string;
let ownWords: string;
let cardBody: unknown;
let gets: string[];

const OWN_AGENT = {
	id: OWN_ID,
	name: "me",
	handle: "me@myorg",
	incoming_policy: "open",
	outgoing_policy: "open",
	human_oversight: true,
	unlisted: false,
	created_at: "2026-01-01T00:00:00Z",
	revoked_at: null,
} as unknown as core.AgentRead;

function peerCard(words: string | null): unknown {
	return {
		card: {
			name: "bot",
			rine: { handle: "bot@acme", verification_words: words },
		},
	};
}

function makeProgram(globalOpts: Record<string, unknown> = {}): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerAgent(program);
	return program;
}

const ARGS = ["node", "rine", "agent", "verify", "bot@acme"];

beforeEach(() => {
	configDir = fs.mkdtempSync(join(tmpdir(), "rine-cli-verify-"));
	const keys = derivedAgentKeys(OWN_ID);
	core.saveAgentKeys(configDir, OWN_ID, keys);
	ownWords = core.verificationWordsForKey(keys.signing.publicKey);

	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(configDir);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ ...OWN_AGENT, verification_words: ownWords },
	]);
	vi.spyOn(core, "resolveToUuid").mockResolvedValue(PEER_ID);

	// The verb runs through the REAL `withClient`, so the client it uses is a
	// real HttpClient — stub the prototype, not the factory.
	cardBody = peerCard(PEER_WORDS);
	gets = [];
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		(path: string) => {
			gets.push(path);
			return Promise.resolve(cardBody);
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(configDir, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("rine agent verify", () => {
	it("prints the peer's words beside this agent's own", async () => {
		const textSpy = vi
			.spyOn(outputModule, "printText")
			.mockImplementation(() => {});
		vi.spyOn(promptModule, "promptConfirm").mockResolvedValue(false);

		await makeProgram({}).parseAsync(ARGS);

		const printed = textSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain(PEER_WORDS);
		expect(printed).toContain(ownWords);
		expect(printed).toContain("bot@acme");
		expect(printed).toContain("me@myorg");
		// The peer's words come off its PUBLIC card — the reason this flow needs
		// no server change.
		expect(gets).toContain(`/directory/agents/${PEER_ID}`);
	});

	it("records nothing when the operator does not confirm", async () => {
		vi.spyOn(outputModule, "printText").mockImplementation(() => {});
		vi.spyOn(promptModule, "promptConfirm").mockResolvedValue(false);

		await makeProgram({}).parseAsync(ARGS);

		expect(core.loadPeerVerification(configDir, OWN_ID, PEER_ID)).toBeNull();
	});

	it("records the peer's words when the operator confirms", async () => {
		vi.spyOn(outputModule, "printText").mockImplementation(() => {});
		vi.spyOn(outputModule, "printSuccess").mockImplementation(() => {});
		vi.spyOn(promptModule, "promptConfirm").mockResolvedValue(true);

		await makeProgram({}).parseAsync(ARGS);

		expect(core.loadPeerVerification(configDir, OWN_ID, PEER_ID)?.words).toBe(
			PEER_WORDS,
		);
	});

	it("never prompts in JSON mode, and ships both values plus a boolean", async () => {
		const jsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});
		const promptSpy = vi.spyOn(promptModule, "promptConfirm");

		await makeProgram({ json: true }).parseAsync(ARGS);

		expect(promptSpy).not.toHaveBeenCalled();
		expect(jsonSpy).toHaveBeenCalledTimes(1);
		const payload = jsonSpy.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.recorded).toBe(false);
		expect(payload.peer).toMatchObject({ verification_words: PEER_WORDS });
		expect(payload.verification).toMatchObject({
			status: "match",
			computed: ownWords,
			asserted: ownWords,
			match: true,
		});
	});

	it("records under --yes in JSON mode, without a prompt", async () => {
		vi.spyOn(outputModule, "printJson").mockImplementation(() => {});
		const promptSpy = vi.spyOn(promptModule, "promptConfirm");

		await makeProgram({ json: true }).parseAsync([...ARGS, "--yes"]);

		expect(promptSpy).not.toHaveBeenCalled();
		expect(core.loadPeerVerification(configDir, OWN_ID, PEER_ID)?.words).toBe(
			PEER_WORDS,
		);
	});

	it("says a peer names no words rather than recording an empty confirmation", async () => {
		const textSpy = vi
			.spyOn(outputModule, "printText")
			.mockImplementation(() => {});
		const promptSpy = vi.spyOn(promptModule, "promptConfirm");
		cardBody = peerCard(null);

		await makeProgram({}).parseAsync(ARGS);

		expect(promptSpy).not.toHaveBeenCalled();
		expect(core.loadPeerVerification(configDir, OWN_ID, PEER_ID)).toBeNull();
		expect(textSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
			"nothing to record",
		);
	});

	it("refuses to confirm this agent against itself", async () => {
		const errorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		vi.spyOn(core, "resolveToUuid").mockResolvedValue(OWN_ID);

		await makeProgram({}).parseAsync([
			"node",
			"rine",
			"agent",
			"verify",
			"me@myorg",
		]);

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("another operator"),
		);
		expect(process.exitCode).toBe(2);
	});

	// ── the peer spelling that was actually looked up ────────────────────────

	/**
	 * `resolveToUuid` completes `bot@acme` to `bot@acme.rine.network` and hands
	 * back a UUID, never the handle it resolved. On this verb the substitution is
	 * worse than invisible: the whole point is to confirm that two operators are
	 * looking at the same agent, and the one comparing has no way to see that the
	 * domain was filled in for them.
	 */
	it("names the spelling it completed the peer handle to", async () => {
		const errorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		vi.spyOn(outputModule, "printText").mockImplementation(() => {});
		vi.spyOn(promptModule, "promptConfirm").mockResolvedValue(false);

		await makeProgram({}).parseAsync(ARGS);

		const said = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(said).toContain("bot@acme");
		expect(said).toContain("bot@acme.rine.network");
		// 🔴 The caller's own two strings, and no third handle beside them —
		// not this agent's, not the peer's card handle, not an example.
		expect(said.match(/@[a-z0-9.-]+/g)).toEqual([
			"@acme",
			"@acme.rine.network",
		]);
	});

	it("says nothing when the peer was named by UUID", async () => {
		const errorSpy = vi
			.spyOn(outputModule, "printError")
			.mockImplementation(() => {});
		vi.spyOn(outputModule, "printText").mockImplementation(() => {});
		vi.spyOn(promptModule, "promptConfirm").mockResolvedValue(false);

		await makeProgram({}).parseAsync([
			"node",
			"rine",
			"agent",
			"verify",
			PEER_ID,
		]);

		expect(errorSpy).not.toHaveBeenCalled();
	});
});
