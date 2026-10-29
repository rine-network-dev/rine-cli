import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgent } from "../src/commands/agent.js";
import { registerFulfill } from "../src/commands/fulfill.js";
import { registerGroup } from "../src/commands/group.js";
import { registerKeys } from "../src/commands/keys.js";
import { registerMessages } from "../src/commands/messages.js";
import { registerOnboard } from "../src/commands/onboard.js";
import { registerPay } from "../src/commands/pay.js";
import { registerWebhook } from "../src/commands/webhook.js";

// The acting-agent contract as an operator meets it: which agent a command acts
// as, what it is told when two flags disagree, and what it hears when the
// environment chose. Every test drives a REAL command through commander and
// asserts what crosses a boundary — the header the client would send, the
// request that was or was not made, and which stream the sentence came out on.

const API_URL = "https://test.rine.network";

function agent(name: string, id: string): core.AgentRead {
	return {
		id,
		name,
		handle: `${name}@acme.rine.network`,
		incoming_policy: "open",
		outgoing_policy: "open",
		human_oversight: true,
		unlisted: false,
		created_at: "2026-01-01T00:00:00Z",
		revoked_at: null,
	} as core.AgentRead;
}

const ALICE = agent("alice", "11111111-1111-1111-1111-111111111111");
const BOB = agent("bob", "22222222-2222-2222-2222-222222222222");

let stdout: string[];
let stderr: string[];
/** Every request that reached the network, with the headers it carried. */
let requests: { url: string; headers: Record<string, string> }[];

/** The acting agent a request declared, as the server would read it. */
function actorOf(request: { headers: Record<string, string> }):
	| string
	| undefined {
	return request.headers["X-Rine-Agent"];
}

const MESSAGE_ID = "77777777-7777-7777-7777-777777777777";

/** Enough of a server to let a command finish; the assertions are on the way out. */
function answerFor(url: string): unknown {
	if (url.includes("/keys")) {
		return {
			signing_public_key: { x: "sig-key-material" },
			encryption_public_key: { x: "enc-key-material" },
		};
	}
	if (url.endsWith(`/messages/${MESSAGE_ID}`)) {
		return {
			id: MESSAGE_ID,
			conversation_id: "66666666-6666-6666-6666-666666666666",
			from_agent_id: ALICE.id,
			to_agent_id: BOB.id,
			type: "rine.v1.task_request",
			encrypted_payload: "sealed",
			encryption_version: "hpke-hybrid-v2",
			created_at: "2026-01-01T00:00:00Z",
		};
	}
	return { items: [] };
}

function wire(agents: core.AgentRead[]): Command {
	requests = [];
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-actor");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "fetchAgents").mockResolvedValue(agents);
	vi.spyOn(core, "agentKeysExist").mockReturnValue(false);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		requests.push({
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
		});
		return Promise.resolve(
			new Response(JSON.stringify(answerFor(String(url))), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});

	const program = new Command();
	program.option("--json", "output as JSON");
	program.option("--profile <name>", "credential profile to use");
	program.option("--as <agent>", "the retired spelling of --agent");
	program.exitOverride();
	program.configureOutput({ writeErr: () => {} });
	registerKeys(program);
	registerGroup(program);
	registerWebhook(program);
	registerAgent(program);
	registerMessages(program);
	registerOnboard(program);
	registerPay(program);
	registerFulfill(program);
	return program;
}

function run(program: Command, args: string[]): Promise<unknown> {
	return program.parseAsync(["node", "rine", ...args]);
}

beforeEach(() => {
	stdout = [];
	stderr = [];
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		stdout.push(parts.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		stderr.push(parts.map(String).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	process.exitCode = undefined;
});

describe("the acting-agent ladder", () => {
	it("acts as the agent --agent names, in an org with several", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "bob"]);

		expect(requests.map(actorOf)).toEqual([BOB.id]);
		expect(process.exitCode).toBeUndefined();
	});

	it("acts as the agent RINE_AGENT names when no flag does", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status"]);

		expect(requests.map(actorOf)).toEqual([BOB.id]);
	});

	it("lets the flag win over RINE_AGENT, silently", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "alice"]);

		expect(requests.map(actorOf)).toEqual([ALICE.id]);
		expect(stderr.join("\n")).not.toContain("RINE_AGENT");
	});

	it("lets the retired --as win over RINE_AGENT too", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		const program = wire([ALICE, BOB]);
		await run(program, ["--as", "alice", "keys", "status"]);

		expect(requests.map(actorOf)).toEqual([ALICE.id]);
	});

	// `rine-eve`'s scaffolder writes a bare `RINE_AGENT=` into every generated
	// project, so an empty value is the shipped shape of "no actor set".
	it("treats an empty RINE_AGENT as no actor at all", async () => {
		vi.stubEnv("RINE_AGENT", "   ");
		const program = wire([ALICE]);
		await run(program, ["keys", "status"]);

		expect(requests.map(actorOf)).toEqual([ALICE.id]);
	});

	// Empty means absent on every rung, not "choose nobody": a script that
	// interpolates an unset variable into `--agent "$AGENT"` still climbs.
	it("treats an empty --agent as no actor at all", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "   "]);

		expect(requests.map(actorOf)).toEqual([BOB.id]);
	});

	it("acts as the agent a padded flag value names", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "  bob  "]);

		expect(requests.map(actorOf)).toEqual([BOB.id]);
	});

	// An acting agent is an agent this org owns, so a handle is looked up in the
	// org's own list — the same list a bare name is looked up in. It used to go
	// to WebFinger, which asks the world who owns the handle: a hit for a
	// stranger's handle acted as an agent these keys cannot sign for.
	it("acts as the agent a handle names, resolved from the org's own list", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "bob@acme.rine.network"]);

		expect(requests.map(actorOf)).toEqual([BOB.id]);
		expect(requests.map((r) => r.url).join(" ")).not.toContain("webfinger");
	});

	it("accepts the short form of a handle the same way", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "bob@acme"]);

		expect(requests.map(actorOf)).toEqual([BOB.id]);
	});

	// `--help` wraps to the terminal, so the sentence is asserted where
	// commander reads it from rather than where it lands on the screen.
	it("says in --help where else the agent can come from", () => {
		const program = wire([ALICE]);
		const keys = program.commands.find((c) => c.name() === "keys");
		const status = keys?.commands.find((c) => c.name() === "status");
		const actor = status?.options.find((o) => o.long === "--agent");

		expect(actor?.description).toContain("(env: RINE_AGENT)");
	});

	it("falls through to the org's only agent when nobody named one", async () => {
		const program = wire([ALICE]);
		await run(program, ["keys", "status"]);

		expect(requests.map(actorOf)).toEqual([ALICE.id]);
	});

	// The measured defect: a model filled the optional actor slot with the
	// schema's own placeholder text and the command died locally, before the verb
	// it was asked for ever ran. With one agent there is nothing to choose
	// between, so it acts — and stderr says what it ignored, which is the only
	// channel the CLI has for a note that must not touch stdout or `--json`.
	it("acts as that only agent on a value that named nobody, and says so", async () => {
		const program = wire([ALICE]);
		await run(program, ["keys", "status", "--agent", "null"]);

		expect(requests.map(actorOf)).toEqual([ALICE.id]);
		expect(stderr.join("\n")).toContain(
			"Ignored --agent 'null': this org has one agent, so " +
				"alice (alice@acme.rine.network) acted. Omit --agent for a " +
				"one-agent org.",
		);
		expect(stdout.join("\n")).not.toContain("Ignored");
	});

	it("stays silent when the value named that agent after all", async () => {
		const program = wire([ALICE]);
		await run(program, ["keys", "status", "--agent", "alice"]);

		expect(requests.map(actorOf)).toEqual([ALICE.id]);
		expect(stderr.join("\n")).not.toContain("Ignored");
	});

	it("reports a stale RINE_AGENT on a one-agent org, which nothing else does", async () => {
		// 🔴 `announceEnvActor` returns early below two agents and `blameEnvActor`
		// has no throw left to decorate here, so this warning is the ONLY thing
		// that tells a one-agent operator their exported RINE_AGENT names nobody.
		vi.stubEnv("RINE_AGENT", "zed");
		const program = wire([ALICE]);
		await run(program, ["keys", "status"]);

		expect(requests.map(actorOf)).toEqual([ALICE.id]);
		// It names RINE_AGENT, not `--agent`: the operator passed no flag, so
		// "omit --agent" would name something they did not do and withhold the
		// one fact that is actionable — the export is stale.
		expect(stderr.join("\n")).toContain(
			"Ignored RINE_AGENT='zed': this org has one agent, so " +
				"alice (alice@acme.rine.network) acted. RINE_AGENT names no agent " +
				"this org has — unset it, or point it at one that exists.",
		);
	});

	it("still refuses on a multi-agent org, where there is a choice to make", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "null"]);

		expect(process.exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("No agent named 'null'");
		expect(requests).toEqual([]);
	});

	it("refuses, naming every agent, when an org of several named none", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status"]);

		expect(process.exitCode).toBe(1);
		const said = stderr.join("\n");
		expect(said).toContain("This org has more than one agent");
		expect(said).toContain("alice (alice@acme.rine.network)");
		expect(said).toContain("bob (bob@acme.rine.network)");
		expect(said).toContain("--agent");
		expect(said).toContain("RINE_AGENT");
	});

	// One mistake, one kind of sentence, whichever way it was spelled. The
	// handle arm used to be answered by WebFinger availability advice, and a
	// handle belonging to another org was not refused at all — it resolved, and
	// the caller acted as an agent it does not own.
	it.each([
		["a bare name", "zed", "No agent named 'zed'"],
		[
			"a handle of this org",
			"zed@acme.rine.network",
			"No agent with handle 'zed@acme.rine.network'",
		],
		[
			"a handle of another org",
			"zed@other-org.rine.network",
			"No agent with handle 'zed@other-org.rine.network'",
		],
	])("refuses an unknown actor spelled as %s, listing this org's agents", async (
		_spelling,
		flag,
		lead,
	) => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", flag]);

		expect(process.exitCode).toBe(1);
		const said = stderr.join("\n");
		expect(said).toContain(lead);
		expect(said).toContain("Available agents:");
		expect(said).toContain("- alice (alice@acme.rine.network)");
		expect(said).toContain("- bob (bob@acme.rine.network)");
		expect(requests).toEqual([]);
	});

	// A bare name is not unique in an org — nothing on the server makes it so —
	// and the answer decides which identity the command acts as. Taking the
	// first match named an identity the operator never chose.
	it("refuses an ambiguous bare name, naming the candidates", async () => {
		const twin = agent("bob", "33333333-3333-3333-3333-333333333333");
		const program = wire([ALICE, BOB, twin]);
		await run(program, ["keys", "status", "--agent", "bob"]);

		expect(process.exitCode).toBe(1);
		const said = stderr.join("\n");
		expect(said).toContain("More than one agent is named 'bob'");
		expect(said).toContain("A name is not unique in an org — name it by handle or UUID.");
		expect(requests).toEqual([]);
	});

	it("still acts on the handle the ambiguity refusal told it to use", async () => {
		const twin = { ...agent("bob", "33333333-3333-3333-3333-333333333333") };
		twin.handle = "bob-2@acme.rine.network";
		const program = wire([ALICE, BOB, twin]);
		await run(program, ["keys", "status", "--agent", "bob-2@acme.rine.network"]);

		expect(requests.map(actorOf)).toEqual([twin.id]);
	});
});

describe("a command that never asks who is acting", () => {
	// `group join` and `group invites` resolve no agent of their own:
	// they POST and let the server read the header. The pin therefore has to be
	// decided by the ladder, on every rung that names an actor, or exporting
	// `RINE_AGENT` would be silently ignored by exactly the two commands an
	// operator reaches for after being invited.
	it("still acts as the agent RINE_AGENT named — join", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		const program = wire([ALICE, BOB]);
		await run(program, [
			"--json",
			"group",
			"join",
			"88888888-8888-8888-8888-888888888888",
		]);

		const join = requests.find((r) => r.url.endsWith("/join"));
		expect(join).toBeDefined();
		expect(actorOf(join!)).toBe(BOB.id);
	});

	it("still acts as the agent RINE_AGENT named — invites", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		const program = wire([ALICE, BOB]);
		await run(program, ["--json", "group", "invites"]);

		expect(process.exitCode).toBeUndefined();
		const invites = requests.filter((r) => !r.url.includes("/agents"));
		expect(invites.length).toBeGreaterThan(0);
		for (const request of invites) expect(actorOf(request)).toBe(BOB.id);
	});
});

describe("two spellings that disagree", () => {
	it("refuses --agent against --as, and names both", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["--as", "bob", "keys", "status", "--agent", "alice"]);

		expect(process.exitCode).toBe(1);
		expect(stderr.join("\n")).toContain(
			"You named the acting agent twice: --agent alice and --as bob",
		);
		expect(requests).toEqual([]);
	});

	// The apparent success this phase removes: `--as bob send --from alice`
	// returned 201 and sent as alice.
	it("refuses send --from against --as, and sends nothing", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, [
			"--as",
			"bob",
			"send",
			"--to",
			"someone@acme.rine.network",
			"--from",
			"alice",
			"--payload",
			"{}",
		]);

		expect(process.exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("You named the acting agent twice");
		expect(requests).toEqual([]);
	});

	it("accepts two spellings that agree, case aside", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["--as", "BOB", "keys", "status", "--agent", "bob"]);

		expect(process.exitCode).toBeUndefined();
		expect(requests.map(actorOf)).toEqual([BOB.id]);
	});
});

describe("provenance, when the environment chose", () => {
	it("says so once, on stderr, in an org with several agents", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status"]);

		const lines = stderr.filter((l) => l.includes("RINE_AGENT"));
		expect(lines).toEqual(["acting as bob (from RINE_AGENT)"]);
	});

	it("names the rung when the environment's choice is what failed", async () => {
		vi.stubEnv("RINE_AGENT", "zed");
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status"]);

		expect(process.exitCode).toBe(1);
		const said = stderr.join("\n");
		expect(said).toContain("No agent named 'zed'");
		expect(said).toContain("the acting agent came from RINE_AGENT");
	});

	it("blames no rung when the caller typed the name themselves", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "zed"]);

		expect(process.exitCode).toBe(1);
		const said = stderr.join("\n");
		expect(said).toContain("No agent named 'zed'");
		expect(said).not.toContain("came from RINE_AGENT");
	});

	it("names the rung when the environment named an unknown handle", async () => {
		// The handle spelling used to leave this rung entirely: it went to
		// WebFinger and came back "Ensure WebFinger is available or use a UUID",
		// which names no agent and blames the caller's infrastructure for a typo.
		vi.stubEnv("RINE_AGENT", "zed@acme.rine.network");
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status"]);

		expect(process.exitCode).toBe(1);
		const said = stderr.join("\n");
		expect(said).toContain("No agent with handle 'zed@acme.rine.network'");
		expect(said).toContain("- alice (alice@acme.rine.network)");
		expect(said).toContain("- bob (bob@acme.rine.network)");
		expect(said).toContain("the acting agent came from RINE_AGENT");
	});

	it("says nothing when the org has one agent to disambiguate", async () => {
		vi.stubEnv("RINE_AGENT", "alice");
		const program = wire([ALICE]);
		await run(program, ["keys", "status"]);

		expect(stderr.join("\n")).not.toContain("RINE_AGENT");
	});

	it("says nothing when the caller named the agent", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["keys", "status", "--agent", "bob"]);

		expect(stderr.join("\n")).not.toContain("RINE_AGENT");
	});

	it("leaves --json stdout byte-identical", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		await run(wire([ALICE, BOB]), ["--json", "keys", "status"]);
		const withEnv = stdout.join("\n");

		stdout = [];
		vi.unstubAllEnvs();
		await run(wire([ALICE, BOB]), [
			"--json",
			"keys",
			"status",
			"--agent",
			"bob",
		]);

		expect(stdout.join("\n")).toBe(withEnv);
		expect(withEnv).not.toContain("RINE_AGENT");
	});
});

describe("where the flag is declared", () => {
	// Commander resolves a parent's declared options against the whole
	// argv before it dispatches, so a program-level `--agent` would steal the
	// flag from the subcommands that have one of their own.
	it("declares --agent on the subcommand, never on the program", async () => {
		const program = wire([ALICE, BOB]);
		await expect(
			run(program, ["--agent", "bob", "keys", "status"]),
		).rejects.toThrow(/unknown option '--agent'/);
	});

	it("leaves onboard --agent-name to onboard", async () => {
		const program = wire([ALICE]);
		const onboard = program.commands.find((c) => c.name() === "onboard");
		expect(onboard?.options.map((o) => o.long)).toContain("--agent-name");
		expect(onboard?.options.map((o) => o.long)).not.toContain("--agent");
	});

	it("leaves webhook list --agent a filter, and resolves no actor for it", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["webhook", "list", "--agent", BOB.id]);

		// A filter names a row to look at, not an agent to be: an org with
		// several agents and no actor named is not asked to choose one.
		expect(process.exitCode).toBeUndefined();
		expect(requests.map((r) => r.url)).toEqual([
			`${API_URL}/webhooks?agent_id=${BOB.id}`,
		]);
		expect(requests.map(actorOf)).toEqual([undefined]);
	});
});

describe("a refusal that costs nothing", () => {
	// The invite that names nobody is turned away before the acting agent
	// is resolved, so the operator hears about the flag they left out rather
	// than about an org they have several agents in.
	it("refuses an invite with no --invitee before it resolves an actor", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, [
			"group",
			"invite",
			"88888888-8888-8888-8888-888888888888",
		]);

		expect(process.exitCode).toBe(2);
		expect(stderr.join("\n")).toContain("--invitee is required");
		expect(stderr.join("\n")).not.toContain("more than one agent");
		expect(requests).toEqual([]);
	});
});

describe("a read that has to say who is reading", () => {
	// The delivery mark is per AGENT: the server marks the row of the
	// agent the header names and no sibling's. So the id has to be on the GET
	// itself — resolving it afterwards cannot retroactively name the reader, and
	// a bare GET shows the message and marks nothing.
	it("names the acting agent on the GET of the message", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["--json", "read", MESSAGE_ID, "--agent", "bob"]);

		const read = requests.find((r) => r.url.endsWith(`/messages/${MESSAGE_ID}`));
		expect(read).toBeDefined();
		// The RESOLVED id, never the spelling the flag carried: `X-Rine-Agent`
		// takes a UUID or a handle, and `bob` is neither.
		expect(actorOf(read!)).toBe(BOB.id);
	});
});

describe("the money paths resolve their actor before they read", () => {
	// `pay` and `fulfill` resolve the actor above their GET, for the same
	// reason `read` does. That ordering is visible to an operator: an org with
	// several agents and no `--agent` now hears which agents it has, instead of
	// hearing about the message it named — and, crucially, nothing is fetched.
	it("refuses pay in a multi-agent org before fetching the quote", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["pay", MESSAGE_ID]);

		expect(process.exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("This org has more than one agent");
		expect(requests).toEqual([]);
	});

	it("refuses fulfill in a multi-agent org before fetching the payment", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["fulfill", MESSAGE_ID]);

		expect(process.exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("This org has more than one agent");
		expect(requests).toEqual([]);
	});
});

describe("no persisted default", () => {
	// `RINE_AGENT` is the pin. An env var is scoped to the process that
	// set it; a file on disk is shared by every process in the config dir.
	it("ships no command that would select an agent for later", async () => {
		const program = wire([ALICE]);
		const selectors = ["use", "default", "select", "switch", "current"];
		const names = (command: Command): string[] =>
			command.commands.flatMap((c) => [c.name(), ...c.aliases(), ...names(c)]);

		expect(names(program).filter((n) => selectors.includes(n))).toEqual([]);
	});
});
