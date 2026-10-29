import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";
import { NO_ESCROW } from "./escrow-report.js";

// The `rine group` verbs say who is acting.
//
// The server resolves an acting agent on PATCH and DELETE `/groups/{id}`, so
// an org with more than one agent that names nobody is refused, and `--agent`
// is this surface's answer to that refusal. It was declared on four verbs of
// fifteen while the other eleven had `RINE_AGENT` and no typed spelling —
// including verbs whose whole ANSWER turns on which agent asks. Every
// assertion here is on what crossed the wire — the header the request carried —
// rather than on how the handler got it.

const API_URL = "https://test.rine.network";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";
/** Where the CLI believes its credentials live — asserted on, so it is named. */
const CONFIG_DIR = "/tmp/test-rine-group-crud";

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

const GROUP = {
	id: GROUP_ID,
	name: "team",
	handle: "#team@acme.rine.network",
	description: "the team",
	enrollment_policy: "closed",
	visibility: "private",
	isolated: false,
	vote_duration_hours: 24,
	member_count: 2,
	conversation_id: null,
	mls_group_id: null,
	created_at: "2026-01-01T00:00:00Z",
};

let stderr: string[];
/** Every request that reached the network, with the method and headers it carried. */
let requests: { method: string; url: string; headers: Record<string, string> }[];

/** The acting agent a request declared, as the server would read it. */
function actorOf(request: { headers: Record<string, string> }):
	| string
	| undefined {
	return request.headers[core.ACTING_AGENT_HEADER];
}

/** The requests aimed at the group itself, not the agent list the ladder reads. */
function groupRequests(): typeof requests {
	return requests.filter((r) => r.url.endsWith(`/groups/${GROUP_ID}`));
}

/** The one request of this method the group received — asserting there was one. */
function theOnly(method: string): { headers: Record<string, string> } {
	const matched = groupRequests().filter((r) => r.method === method);
	expect(matched).toHaveLength(1);
	const first = matched[0];
	if (first === undefined) throw new Error(`no ${method} reached the group`);
	return first;
}

/** What the stubbed server answers a request with, before it is serialised. */
type Responder = (url: string) => unknown;

function wire(agents: core.AgentRead[], respond: Responder = () => GROUP): Command {
	requests = [];
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "fetchAgents").mockResolvedValue(agents);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		requests.push({
			method: String(init.method ?? "GET"),
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
		});
		return Promise.resolve(
			new Response(JSON.stringify(respond(String(url))), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});

	const program = new Command();
	program.option("--json", "output as JSON");
	program.option("--profile <name>", "credential profile to use");
	// `--as` lives on the program in the real CLI (`main.ts`), so the harness
	// carries it there too — spelled from the constant rather than retyped.
	program.option(
		`${core.ACTOR_SURFACES.cli.alias} <agent>`,
		"the retired spelling of --agent",
	);
	program.exitOverride();
	program.configureOutput({ writeErr: () => {} });
	registerGroup(program);
	return program;
}

function run(program: Command, args: string[]): Promise<unknown> {
	return program.parseAsync(["node", "rine", ...args]);
}

function subcommand(program: Command, name: string): Command {
	const group = program.commands.find((c) => c.name() === "group");
	const found = group?.commands.find((c) => c.name() === name);
	if (!found) throw new Error(`no group ${name} command`);
	return found;
}

beforeEach(() => {
	stderr = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
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

describe("group update / delete — the acting agent reaches the server", () => {
	it("declares --agent on both commands", () => {
		const program = wire([ALICE, BOB]);
		for (const name of ["update", "delete"]) {
			const flags = subcommand(program, name)
				.options.map((o) => o.long);
			expect(flags, `group ${name}`).toContain(
				core.ACTOR_SURFACES.cli.canonical,
			);
		}
	});

	it("sends the agent --agent names on the update", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, [
			"group",
			"update",
			GROUP_ID,
			"--agent",
			"bob",
			"--description",
			"renamed",
		]);

		expect(actorOf(theOnly("PATCH"))).toBe(BOB.id);
		expect(process.exitCode).toBeUndefined();
	});

	it("sends the agent --agent names on the delete", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, [
			"group",
			"delete",
			GROUP_ID,
			"--yes",
			"--agent",
			"alice",
		]);

		expect(actorOf(theOnly("DELETE"))).toBe(ALICE.id);
		expect(process.exitCode).toBeUndefined();
	});

	// The rung below the flag: an operator who exported the variable does not
	// have to type the flag as well, and the header still says who is acting.
	it("falls back to RINE_AGENT when no flag names an actor", async () => {
		vi.stubEnv("RINE_AGENT", "bob");
		const program = wire([ALICE, BOB]);
		await run(program, ["group", "update", GROUP_ID, "--description", "x"]);

		expect(actorOf(theOnly("PATCH"))).toBe(BOB.id);
	});

	// The defect this flag answers: without an actor the request is refused, and
	// the refusal has to happen before the group is touched at all.
	it("refuses an unnamed actor in a multi-agent org, and deletes nothing", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, ["group", "delete", GROUP_ID, "--yes"]);

		expect(groupRequests()).toHaveLength(0);
		expect(stderr.join("\n")).toContain("--agent");
	});

	// A single-agent org never had to say, and still does not.
	it("names the sole agent without being asked", async () => {
		const program = wire([ALICE]);
		await run(program, ["group", "update", GROUP_ID, "--description", "x"]);

		expect(actorOf(theOnly("PATCH"))).toBe(ALICE.id);
	});

	// The delete half of the case above. It is the one case in which the
	// explicit header argument on `client.delete` is load-bearing: with nobody
	// named, the ladder never pins the actor into the client's default headers,
	// so the only thing that puts it on the wire is that argument. Drop it and
	// this is the test that goes red.
	it("names the sole agent on the delete too", async () => {
		const program = wire([ALICE]);
		await run(program, ["group", "delete", GROUP_ID, "--yes"]);

		expect(actorOf(theOnly("DELETE"))).toBe(ALICE.id);
		expect(process.exitCode).toBeUndefined();
	});

	// The conflict rule on the two commands that just gained the flag:
	// `--agent` and the program-level `--as` are the SAME rung, so two of them
	// that disagree are refused naming both, rather than one winning silently.
	// (Two that AGREE are not a conflict — `singleActorValue` compares
	// case-insensitively.)
	it("refuses --agent and --as when they name different agents", async () => {
		const program = wire([ALICE, BOB]);
		await run(program, [
			"--as",
			"alice",
			"group",
			"update",
			GROUP_ID,
			"--agent",
			"bob",
			"--description",
			"x",
		]);

		expect(groupRequests()).toHaveLength(0);
		expect(stderr.join("\n")).toContain("You named the acting agent twice");
	});
});

// Which agent asks changes what these verbs DO, so each of them has to let the
// caller say. `RINE_AGENT` always could — `withClient` pins `X-Rine-Agent` for
// any actor the ladder names, by flag or by environment — so the missing half
// was the typed spelling, on verbs where a multi-agent org had no way to type
// it.
//
// 🔴 **Which verbs those are is not written down here any more.** A named list
// of the flag's own declarations is a second copy of them, and the two drift in
// silence — so the class is walked instead, in
// `actor-flag-consumed.test.ts`: it collects every command that declares the
// flag, asserts the set it drives EQUALS that walk, and puts each one on the
// wire. `list` staying out of the class is asserted there too, beside the walk
// it constrains. What stays here is the handful of verbs whose consequence is
// specific enough to be worth naming — a wrong seat, a wrong founder, a queue
// read answered for the wrong agent.
describe("group — every verb whose answer depends on the acting agent", () => {
	// `group requests` asks for no agent id anywhere in its handler, and the
	// server still resolves the caller through `get_acting_group_member` — that
	// dependency decides whether the read is allowed and what `Your Vote` and
	// `Can Vote` say on every row. So the proof has to be the header on the wire:
	// a flag whose value never leaves the process would be exactly the inert flag
	// this test exists to rule out.
	it("puts the agent --agent named on a read that asks for no id", async () => {
		// The queue read carries `?outstanding=pending`, so both the stub and the
		// assertion match on the path being CONTAINED — an `endsWith` here answers
		// every call with a group row and then finds no queue read at all.
		const program = wire([ALICE, BOB], (url) =>
			url.includes("/requests") ? { items: [], total: 0 } : GROUP,
		);
		await run(program, ["group", "requests", GROUP_ID, "--agent", "bob"]);

		const queue = requests.filter((r) => r.url.includes("/requests"));
		expect(queue).toHaveLength(1);
		expect(queue[0] && actorOf(queue[0])).toBe(BOB.id);
		expect(process.exitCode).toBeUndefined();
	});

	// 🔴 The verb with the worst consequence, and the one a declaration test says
	// least about: `POST /groups/{id}/join` seats whichever agent `X-Rine-Agent`
	// names, and on an MLS group that seat is the ratchet-tree leaf. A refactor
	// that dropped the header here would seat the org's default agent instead,
	// and the only remedy is orphan reclamation, which is never automatic. The
	// flag being declared proves nothing about that; the header on the wire does.
	it("seats the agent --agent names, not the org's first", async () => {
		const program = wire([ALICE, BOB], (url) =>
			url.includes("/join")
				? {
						id: "44444444-4444-4444-4444-444444444444",
						group_id: GROUP_ID,
						agent_id: BOB.id,
						status: "pending",
						created_at: "2026-01-01T00:00:00Z",
					}
				: GROUP,
		);
		await run(program, ["group", "join", GROUP_ID, "--agent", "bob"]);

		const joins = requests.filter((r) => r.url.includes("/join"));
		expect(joins).toHaveLength(1);
		expect(joins[0] && actorOf(joins[0])).toBe(BOB.id);
		expect(process.exitCode).toBeUndefined();
	});

	// 🔴 `join`'s class, one step earlier and with the same remedy — none.
	// `group create` founds the new group's ratchet tree AS the acting agent
	// (`foundMlsState`), so a multi-agent org that cannot name one hands the
	// tree's only leaf to whoever the org's shortcut picks, and getting it back
	// means reclaiming orphans, which is never automatic. The declaration test
	// above would pass on a flag nothing reads, so the proof is the header on
	// `POST /groups` and the agent the founding was actually attempted as.
	it("founds the group as the agent --agent names, not as the org's first", async () => {
		const founded = vi.spyOn(core, "initMlsGroup").mockResolvedValue({
			epoch: 1,
			commits: 1,
			added: 0,
			outcomes: [],
			escrow: NO_ESCROW,
		});
		const program = wire([ALICE, BOB]);
		await run(program, [
			"group",
			"create",
			"--name",
			"ops",
			"--visibility",
			"private",
			"--agent",
			"bob",
		]);

		const creates = requests.filter(
			(r) => r.method === "POST" && r.url.endsWith("/groups"),
		);
		expect(creates).toHaveLength(1);
		expect(creates[0] && actorOf(creates[0])).toBe(BOB.id);
		expect(founded).toHaveBeenCalledWith(
			CONFIG_DIR,
			BOB.id,
			GROUP_ID,
			expect.anything(),
			{ [core.ACTING_AGENT_HEADER]: BOB.id },
		);
		expect(process.exitCode).toBeUndefined();
	});

	// And the verb that is defined by the acting agent: `GET /groups/invites`
	// answers for one agent and no sibling of it, so "addressed to you" is
	// whoever this flag names.
	it("scopes the invites read to the agent --agent named", async () => {
		const program = wire([ALICE, BOB], () => ({ items: [], total: 0 }));
		await run(program, ["group", "invites", "--agent", "alice"]);

		const invites = requests.filter((r) => r.url.includes("/groups/invites"));
		expect(invites).toHaveLength(1);
		expect(invites[0] && actorOf(invites[0])).toBe(ALICE.id);
		expect(process.exitCode).toBeUndefined();
	});
});
