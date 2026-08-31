import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGroup } from "../src/commands/group.js";

// `rine group update` and `rine group delete` say who is acting.
//
// The server resolves an acting agent on PATCH and DELETE `/groups/{id}`, so
// an org with more than one agent that names nobody is refused. The
// two commands were the only group verbs with no `--agent`, which left that
// refusal with no answer on this surface. Every assertion here is on what
// crossed the wire — the header the request carried — rather than on how the
// handler got it.

const API_URL = "https://test.rine.network";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";

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

function wire(agents: core.AgentRead[]): Command {
	requests = [];
	vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine-group-crud");
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "fetchAgents").mockResolvedValue(agents);
	vi.spyOn(core, "getCredentialEntry").mockReturnValue({
		client_id: "test-id",
		client_secret: "test-secret",
	} as core.CredentialEntry);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		requests.push({
			method: String(init.method ?? "GET"),
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
		});
		return Promise.resolve(
			new Response(JSON.stringify(GROUP), {
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
