// `rine send` names the handle it actually addressed.
//
// `resolveToUuid` completes a short handle before WebFinger sees it, and hands
// back a UUID rather than the spelling it resolved. On `send` that is the most
// expensive silence in the CLI: the message is sealed for, and delivered to,
// whoever the completed handle names, and the caller is told nothing. The
// announcement covers every call site.
//
// 🔴 The whole reason this file is separate from the other two `send` suites is
// that both of them mock `normalizeHandle` to identity. This one runs the REAL
// completion, because the completion IS the thing under test — a suite that
// stubs it out cannot tell an announcement from a no-op.
//
// 🔴 The trap this pins: `send` normalises `opts.to` into `to` ABOVE the branch,
// so handing the announcement `to` compares a completed spelling against its own
// completion — always equal, never announced, and indistinguishable from a
// working notice at the call site. The caller's own spelling is `opts.to`, and
// `TYPED` below is only ever passed on the command line.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessages } from "../src/commands/messages.js";
import * as outputModule from "../src/output.js";

const API_URL = "https://test.rine.network";
const CONFIG_DIR = "/tmp/test-rine-send-completion";
const SENDER = "11111111-1111-1111-1111-111111111111";
const RECIPIENT = "22222222-2222-2222-2222-222222222222";

/** What gets typed: the org half without its domain. */
const TYPED = "kofi@acme";
/** What `normalizeHandle` completes it to, and what is actually addressed. */
const COMPLETED = "kofi@acme.rine.network";

let errors: string[];
let posts: [string, unknown][];

beforeEach(() => {
	errors = [];
	posts = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(outputModule, "printError").mockImplementation((s) => {
		errors.push(s);
	});
	vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
	vi.spyOn(outputModule, "printJson").mockImplementation(() => {});

	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: SENDER, handle: "me@acme.rine.network" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: SENDER });
	// 🔴 NOT mocked: `normalizeHandle`. See the header.
	vi.spyOn(core, "resolveToUuid").mockResolvedValue(RECIPIENT);
	vi.spyOn(core, "sealForAgent").mockResolvedValue({
		encrypted_payload: "ENC",
		encryption_version: "hpke-hybrid-v2",
		sender_signing_kid: `rine:${SENDER}`,
	} as never);
	// 🔴 `send --to <uuid>` asks the group namespace before the agent one,
	// so a suite that sends to a UUID has to answer that read or the probe
	// reaches the network. `RECIPIENT` names an agent, so the group route is a
	// 404 — the miss that hands the spelling to the agent arm, which is the
	// path this file is actually about.
	vi.spyOn(core.HttpClient.prototype, "get").mockRejectedValue(
		new core.RineApiError(404, "Group not found"),
	);
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		async (path: string, body?: unknown) => {
			posts.push([path, body]);
			return { id: "m1", conversation_id: "c1" };
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function send(
	to: string,
	globalOpts: Record<string, unknown> = {},
): Promise<unknown> {
	const program = new Command();
	program.option("--json", "Output JSON");
	vi.spyOn(program, "opts").mockReturnValue(globalOpts);
	registerMessages(program);
	return program.parseAsync([
		"node",
		"rine",
		"send",
		"--to",
		to,
		"--payload",
		"{}",
	]);
}

describe("rine send — a completed recipient handle is announced", () => {
	it("names both spellings, and addresses the completed one", async () => {
		await send(TYPED);

		const said = errors.join("\n");
		expect(said).toContain(TYPED);
		expect(said).toContain(COMPLETED);
		// 🔴 The caller's own two strings and no third handle — not this
		// agent's own, not an example org for a model to copy.
		expect(said.match(/@[a-z0-9.-]+/g)).toEqual([
			"@acme",
			"@acme.rine.network",
		]);
		// The announcement REPORTS the substitution; it does not perform it, and
		// it does not undo it. What crossed the wire is still the completion.
		expect(posts).toHaveLength(1);
		expect(posts[0]?.[1]).toMatchObject({ to_handle: COMPLETED });
		// The seal is signed by the acting agent and scoped to the resolved recipient.
		expect(vi.mocked(core.sealForAgent).mock.calls[0]?.[2]).toEqual({
			senderAgentId: SENDER,
			recipientAgentId: RECIPIENT,
		});
	});

	it("still announces under --json, leaving stdout one parseable document", async () => {
		const jsonSpy = vi
			.spyOn(outputModule, "printJson")
			.mockImplementation(() => {});

		await send(TYPED, { json: true });

		expect(errors.join("\n")).toContain(COMPLETED);
		expect(jsonSpy).toHaveBeenCalledTimes(1);
	});

	it("says nothing when the spelling was already whole", async () => {
		await send(COMPLETED);

		expect(errors).toEqual([]);
		expect(posts[0]?.[1]).toMatchObject({ to_handle: COMPLETED });
	});

	it("says nothing for a UUID, which names no domain to complete", async () => {
		await send(RECIPIENT);

		expect(errors).toEqual([]);
		expect(posts[0]?.[1]).toMatchObject({ to_agent_id: RECIPIENT });
	});

	it("says nothing for a sigiled group name, which this arm never resolves", async () => {
		// A group send takes the branch above and never reaches `resolveToUuid`,
		// so there is no substitution here to report even though the spelling is
		// short. The group ladder answers a half-remembered handle by resolving
		// it, not by completing it.
		vi.spyOn(core, "resolveGroupByHandle").mockRejectedValue(
			new Error("no such group"),
		);
		vi.spyOn(core, "formatError").mockReturnValue("no such group");

		await send("#logistics@acme");

		expect(errors.join("\n")).not.toContain("completed to");
	});
});
