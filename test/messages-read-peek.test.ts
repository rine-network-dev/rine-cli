/**
 * `rine read --peek` — a read that does not consume the message.
 *
 * The peek opt-out ships on both SDKs, `rine-core` and this CLI, and on **no**
 * model-facing tool schema. So this surface is one of the two places a human can
 * ask for it, and the only one with a nesting problem.
 *
 * 🔴 **Why this file drives TWO argv spellings.** `registerMessages`
 * (`src/commands/messages.ts`) calls `addMessageCommands` twice — once on the
 * program and once on a `message` group — so `read` is registered as BOTH
 * `rine read <id>` and `rine message read <id>`, from one declaration. That puts
 * a boolean option on this verb inside the blast radius of the Commander
 * nested-subcommand class this CLI has already been bitten by once: `rine
 * discover agents --no-verified` still answers `error: unknown option`.
 * `test/messages-read-refusal.test.ts` drives only the top-level spelling, so
 * before this file the nested path was proven by nothing.
 *
 * Three rules this file is built on, each of which it would be worthless
 * without:
 *
 * 1. **The assertion is on the WIRE.** `fetch` is stubbed and every request is
 *    recorded with the headers it actually carried — never "the handler read
 *    `opts.peek`", which is the assertion a declared-but-unwired flag passes.
 *    The rule is `test/actor-flag-consumed.test.ts`'s, rule 3, and it is the
 *    same rule for the same reason.
 * 2. **The negative is asserted.** Without the flag the request must carry no
 *    `X-Rine-Peek` key at all — absent, not `"0"`. The server parses both as
 *    false, but a test that only checked the positive could not tell a working
 *    flag from a header wired on unconditionally, which is the mistake that
 *    would silently stop every `rine read` from marking anything delivered.
 * 3. **The header object is asserted FRESH.** `client.get`'s third argument must
 *    hold the peek header and nothing else. The shared object it must not be is
 *    the client's own default headers, which by then already carry
 *    `X-Rine-Agent` — so "exactly one key" is what tells a fresh object from the
 *    shared one, and the shared one would leak the peek onto every later request
 *    of the same invocation.
 */

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerMessages } = await import("../src/commands/messages.js");
const outputModule = await import("../src/output.js");

const API_URL = "https://test.rine.network";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SENDER_ID = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "msg-peek-1";

/**
 * The row the read fetches.
 *
 * `sender-key-v1` with no `group_id` and no local keys: nothing here decrypts,
 * so the command's whole observable behaviour is the request it made. What it
 * renders is `messages-read-refusal.test.ts`'s subject, not this file's.
 */
const MESSAGE = {
	id: MESSAGE_ID,
	conversation_id: "conv-1",
	type: "rine.v1.message",
	from_agent_id: SENDER_ID,
	to_agent_id: AGENT_ID,
	group_id: null,
	encrypted_payload: "AABBCCDD-ciphertext",
	encryption_version: "hpke-hybrid-v1",
	created_at: "2026-09-11T12:00:00Z",
};

/** Every request that reached the network, with the headers it carried. */
let requests: { url: string; headers: Record<string, string> }[];
/** Every positional argument list `HttpClient.get` was called with. */
let getArgs: unknown[][];

beforeEach(() => {
	requests = [];
	getArgs = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(outputModule, "printTable").mockImplementation(() => {});
	vi.spyOn(outputModule, "printJson").mockImplementation(() => {});
	vi.spyOn(outputModule, "printError").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-peek");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	});
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: AGENT_ID, handle: "bot@org.rine.network" } as never,
	]);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: AGENT_ID });
	// No key material, so no decrypt is attempted and the request under test is
	// the only thing this invocation does.
	vi.spyOn(core, "agentKeysExist").mockReturnValue(false);

	// A pass-through spy, not a replacement: the call's own arguments are
	// recorded (rule 3) AND the request still goes out through the real client,
	// so the wire assertions below observe headers this code path really built.
	const realGet = core.HttpClient.prototype.get;
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(function (
		this: core.HttpClient,
		...args: Parameters<typeof realGet>
	) {
		getArgs.push(args);
		return realGet.apply(this, args);
	});

	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		requests.push({
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
		});
		return Promise.resolve(
			new Response(JSON.stringify(MESSAGE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	process.exitCode = undefined;
});

function makeProgram(): Command {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	program.exitOverride();
	program.configureOutput({ writeErr: () => {} });
	registerMessages(program);
	return program;
}

/**
 * The two argv spellings one `addReadCommand` produces, keyed by the path a
 * caller types. Both are driven by every wire assertion below, because the
 * nesting is the whole hazard.
 */
const SPELLINGS: Record<string, string[]> = {
	"rine read": ["read", MESSAGE_ID],
	"rine message read": ["message", "read", MESSAGE_ID],
};

async function run(path: string[], flags: string[] = []): Promise<void> {
	const program = makeProgram();
	await program.parseAsync(["node", "rine", ...path, ...flags]);
}

/** The request that fetched the message, which is the one peek governs. */
function readRequest(): { url: string; headers: Record<string, string> } {
	const found = requests.find((r) => r.url.includes(`/messages/${MESSAGE_ID}`));
	// Asserting on nothing is how a command that refused before reaching the
	// network would read green here.
	if (found === undefined) {
		throw new Error(`no request fetched the message; saw ${requests.length}`);
	}
	return found;
}

/** Every `read` command the program registered, whichever depth it sits at. */
function readCommands(program: Command): Command[] {
	const found: Command[] = [];
	const walk = (command: Command): void => {
		if (command.name() === "read") found.push(command);
		for (const child of command.commands) walk(child);
	};
	walk(program);
	return found;
}

describe("rine read --peek", () => {
	// The census, so a spelling that loses the flag cannot pass by not being
	// driven. Both `read` registrations come from one `addReadCommand` call, and
	// this is what pins that they still do.
	it("declares the flag on both spellings, and declares no negation", () => {
		const commands = readCommands(makeProgram());

		expect(commands.length).toBe(Object.keys(SPELLINGS).length);
		for (const command of commands) {
			const peek = command.options.filter((o) => o.attributeName() === "peek");
			expect(peek.length).toBe(1);
			// A single plain boolean. `--no-peek` would only spell out the default,
			// and a negation pair on a subcommand registered both top-level and
			// nested is the exact shape already measured failing on this CLI, on
			// `discover agents --no-verified`.
			expect(peek[0]?.long).toBe("--peek");
			expect(peek[0]?.negate).toBe(false);
		}
	});

	it.each(Object.keys(SPELLINGS))(
		"puts the peek header on the wire for `%s --peek`",
		async (spelling) => {
			await run(SPELLINGS[spelling] as string[], ["--peek"]);

			expect(readRequest().headers[core.PEEK_HEADER]).toBe("1");
		},
	);

	it.each(Object.keys(SPELLINGS))(
		"sends no peek header at all for a plain `%s`",
		async (spelling) => {
			await run(SPELLINGS[spelling] as string[]);

			// Absent, not `"0"`. The server parses both as false, so this asserts
			// the default is the untouched request today's callers already send.
			expect(readRequest().headers).not.toHaveProperty(core.PEEK_HEADER);
		},
	);

	it.each(Object.keys(SPELLINGS))(
		"still says which agent is reading on `%s --peek`",
		async (spelling) => {
			await run(SPELLINGS[spelling] as string[], ["--peek"]);

			// Peek changes what the read DOES, never who it is AS: the header has
			// to keep naming the agent whose key decrypts, and buying the mark
			// suppression by dropping it would change which delivery row is
			// resolved and which authorization path runs.
			expect(readRequest().headers[core.ACTING_AGENT_HEADER]).toBe(AGENT_ID);
		},
	);

	it("builds a fresh header object rather than writing into the shared one", async () => {
		await run(SPELLINGS["rine read"] as string[], ["--peek"]);

		const extraHeaders = getArgs.at(-1)?.[2] as Record<string, string>;
		if (extraHeaders === undefined) {
			throw new Error("the read passed no per-request headers");
		}
		// 🔴 Exactly one key is what tells the fresh object from the shared one.
		// The client's default headers already carry `X-Rine-Agent` by this point
		// (the ladder writes it there when it resolves), and `HttpClient` holds
		// that object by reference and spreads it into every later request — so a
		// peek written into it would ride the resolves this command makes after
		// the read, and every request of the next command that reuses the client.
		expect(Object.keys(extraHeaders)).toEqual([core.PEEK_HEADER]);
	});
});
