import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isActorOption } from "../src/actor.js";
import { registerGroup } from "../src/commands/group.js";

/**
 * Every `rine group` verb that DECLARES the actor flag also puts it on the wire.
 *
 * The mechanism is one line — `action.ts`'s `if (named !== undefined) await
 * actingAgent();` — which pins `X-Rine-Agent` into the client's default headers
 * before the command's own action runs, and `HttpClient` holds that object by
 * reference and spreads it into every request. So three verbs (`join`,
 * `requests`, `invites`) never ask for an agent id anywhere in their handlers
 * and are still decided by the flag, and a refactor that dropped that one line
 * would leave all three declaring an option nothing reads. `group join` would
 * seat the org's default agent instead of the named one, and on an MLS group a
 * wrong seat is a ratchet-tree leaf whose only remedy is orphan reclamation,
 * which is never automatic.
 *
 * Three rules this file is built on, each of which it would fail without:
 *
 * 1. **The verb set is WALKED, never listed.** A literal array is a second
 *    hand-maintained list beside the declarations themselves, which is the
 *    drift this gate replaces (it absorbed `group-crud-actor.test.ts`'s
 *    `ACTOR_VERBS`). The walk asks {@link isActorOption}, because `ACTOR_FLAGS`
 *    is the only thing that tells an ACTOR `--agent` (`group members`) from a
 *    FILTER spelled the same way (`webhook list --agent`, `webhook.ts`).
 * 2. **The census runs first.** The fixture registry must EQUAL the walked set,
 *    so a verb that gains `--agent` is red until somebody writes its argv — a
 *    gate that silently skipped unknown verbs would cover exactly the verbs
 *    nobody changed.
 * 3. **The assertion is on the wire.** Never that a handler called
 *    `ctx.actingAgent()`: that is how three of these verbs are correct without
 *    calling it at all, and a call-site assertion survives no refactor.
 *
 * 🔴 **Scope is `rine group`, deliberately, and this is not a general "is every
 * declared option consumed?" gate.** That gate is not tractable — 173 option
 * declarations over 83 subcommands, consumed by four different mechanisms, and
 * the only statically checkable one reports `--agent` on `group join` as inert,
 * a false positive on the very flag that motivates this file. It would need an
 * allowlist, and an allowlisted gate is a decoration. The CLI's other ~26 actor
 * flags are reachable only through `main.ts`, which assembles the whole program
 * and calls `program.parse()` at import: walking them here would mean a second
 * copy of that registration list, which is rule 1's failure by another route.
 */

const API_URL = "https://test.rine.network";
/** Where the CLI believes its credentials live. Nothing is written there. */
const CONFIG_DIR = "/tmp/test-rine-actor-flag";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";
const REQUEST_ID = "44444444-4444-4444-4444-444444444444";
/** The agent a verb ACTS ON, spelled as a UUID so no handle resolve is needed. */
const TARGET_ID = "55555555-5555-5555-5555-555555555555";

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

/** Two agents, so nothing resolves an actor by having only one to pick. */
const ALICE = agent("alice", "11111111-1111-1111-1111-111111111111");
const BOB = agent("bob", "22222222-2222-2222-2222-222222222222");

/**
 * The group every fixture acts on.
 *
 * `mls_group_id` is null and `mls_pending` unset on purpose: that is the state
 * in which every MLS branch on this surface is a no-op, so the fixtures exercise
 * the request paths without a ratchet tree, a Welcome or a key store anywhere in
 * them. The three verbs that reach MLS regardless stub it at the module
 * boundary.
 */
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

const EMPTY_LIST = { items: [], total: 0 };

const PENDING_REQUEST = {
	id: REQUEST_ID,
	group_id: GROUP_ID,
	agent_id: BOB.id,
	status: "pending",
	created_at: "2026-01-01T00:00:00Z",
};

/** What a stubbed `initMlsGroup` reports back to the verbs that call it. */
const ADMISSION = { epoch: 1, commits: 1, added: 0, outcomes: [] };

/** Every request that reached the network, with the headers it carried. */
let requests: {
	method: string;
	url: string;
	headers: Record<string, string>;
}[];

/** What the stubbed server answers a request with, before it is serialised. */
type Responder = (url: string) => unknown;

/**
 * A verb, as this gate drives it.
 *
 * `argv` never carries the actor flag — {@link runVerb} appends it, so no
 * fixture can accidentally assert the flag it forgot to type.
 */
type Fixture = {
	/** The verb's own arguments and options, after the command path. */
	argv: string[];
	/** What the stubbed server answers; defaults to the group row. */
	respond?: Responder;
	/** Module-boundary stubs, for the verbs that reach MLS whatever the row says. */
	stub?: () => void;
};

/** Answer this fragment of a path with an empty page, everything else the group. */
function emptyPageOn(fragment: string): Responder {
	return (url) => (url.includes(fragment) ? EMPTY_LIST : GROUP);
}

/**
 * The argv each actor-flag verb is driven with.
 *
 * Keyed by the command path the walk produces, and asserted EQUAL to it below —
 * this registry is the census, not a selection from one.
 */
const FIXTURES: Record<string, Fixture> = {
	"group create": {
		argv: ["--name", "ops", "--visibility", "private"],
		stub: () => {
			vi.spyOn(core, "initMlsGroup").mockResolvedValue(ADMISSION);
		},
	},
	"group get": { argv: [GROUP_ID] },
	"group update": { argv: [GROUP_ID, "--description", "renamed"] },
	"group delete": { argv: [GROUP_ID, "--yes"] },
	"group members": { argv: [GROUP_ID], respond: emptyPageOn("/members") },
	"group join": {
		argv: [GROUP_ID],
		// A pending request, not a seat: a row carrying `role` sends the command
		// into the Welcome install, which is MLS state this fixture does not have.
		respond: (url) => (url.includes("/join") ? PENDING_REQUEST : GROUP),
	},
	"group leave": {
		argv: [GROUP_ID],
		stub: () => {
			// `leave` asks the local store what this agent held before it wipes it,
			// and opening that store needs the agent's signing key on disk. The
			// question here is what the DELETE carried, so the store answers
			// "nothing" rather than being planted.
			vi.spyOn(core, "loadMlsState").mockReturnValue(null);
		},
	},
	"group kick": { argv: [GROUP_ID, TARGET_ID] },
	"group invite": {
		argv: [GROUP_ID, "--invitee", TARGET_ID],
		respond: (url) => (url.includes("/invite") ? PENDING_REQUEST : GROUP),
		stub: () => {
			// The invitation notice is an encrypted 1:1 send with its own key
			// reads; what it carries is `group-invite`'s question, not this one.
			vi.spyOn(core, "sendGroupInviteNotification").mockResolvedValue(
				undefined as never,
			);
		},
	},
	"group requests": { argv: [GROUP_ID], respond: emptyPageOn("/requests") },
	"group invites": { argv: [], respond: () => EMPTY_LIST },
	"group resume-admission": {
		argv: [GROUP_ID],
		stub: () => {
			vi.spyOn(core, "initMlsGroup").mockResolvedValue(ADMISSION);
		},
	},
	"group vote": {
		argv: [GROUP_ID, REQUEST_ID, "--vote", "deny"],
		// Denied, so the vote is the whole verb: an approval that carries also
		// mints an add commit, which is `group-wave2`'s subject and not this one.
		respond: (url) => (url.endsWith("/vote") ? { status: "denied" } : GROUP),
	},
	"group sync": {
		argv: [GROUP_ID],
		stub: () => {
			vi.spyOn(core, "recoverGroup").mockResolvedValue({
				regime: "sender-key",
				ingested: 0,
				retired: false,
			});
		},
	},
};

function wire(respond: Responder): Command {
	requests = [];
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "fetchAgents").mockResolvedValue([ALICE, BOB]);
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
			new Response(JSON.stringify(respond(String(url))), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});

	const program = new Command();
	program.option("--json", "output as JSON");
	program.option("--profile <name>", "credential profile to use");
	program.option(
		`${core.ACTOR_SURFACES.cli.alias} <agent>`,
		"the retired spelling of --agent",
	);
	program.exitOverride();
	program.configureOutput({ writeErr: () => {} });
	registerGroup(program);
	return program;
}

/**
 * Every command under the program that declares an actor flag, by path.
 *
 * Recursive, so a verb that grows subcommands of its own cannot leave the
 * census by moving one level down.
 */
function actorFlagVerbs(program: Command): string[] {
	const found: string[] = [];
	const walk = (command: Command, path: string[]): void => {
		if (command.options.some(isActorOption)) found.push(path.join(" "));
		for (const child of command.commands) walk(child, [...path, child.name()]);
	};
	for (const child of program.commands) walk(child, [child.name()]);
	return found.sort();
}

/**
 * The requests this command made AS THE ORG, which are the ones an actor scopes.
 *
 * Read off `Authorization` rather than off an allowlist of paths: an
 * unauthenticated side call — the WebFinger lookup a handle costs — is not a
 * request the acting agent has anything to say about, and naming the exempt
 * URLs instead would be the allowlist this gate exists to avoid.
 */
function authenticated(): typeof requests {
	return requests.filter((r) => r.headers.Authorization !== undefined);
}

async function runVerb(verb: string, fixture: Fixture): Promise<void> {
	const program = wire(fixture.respond ?? (() => GROUP));
	fixture.stub?.();
	await program.parseAsync([
		"node",
		"rine",
		...verb.split(" "),
		...fixture.argv,
		core.ACTOR_SURFACES.cli.canonical,
		"bob",
	]);
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	process.exitCode = undefined;
});

describe("the actor flag, on every group verb that declares one", () => {
	// The census. It fails in both directions on purpose: a new `--agent` with no
	// fixture is red, and a fixture for a verb that dropped the flag is red too.
	it("drives every verb the walk finds, and no verb it does not", () => {
		const program = wire(() => GROUP);

		expect(Object.keys(FIXTURES).sort()).toEqual(actorFlagVerbs(program));
	});

	// The one verb on this surface with no notion of an acting agent, asserted
	// so the census above cannot be satisfied by widening: `GET /groups` is
	// scoped by the ORG the token names and reads identically for every agent in
	// it, and a flag there would be accepted, do nothing, and teach the caller
	// that `--agent` is decoration.
	it("leaves list out, which no agent's identity changes", () => {
		const program = wire(() => GROUP);

		expect(actorFlagVerbs(program)).not.toContain("group list");
	});

	it.each(Object.keys(FIXTURES).sort())(
		"sends the agent --agent names on %s",
		async (verb) => {
			const fixture = FIXTURES[verb];
			if (fixture === undefined) throw new Error(`no fixture for ${verb}`);

			await runVerb(verb, fixture);

			// Not "one request carried it": the header rides on the client's
			// default headers, so a verb that resolves the group, mutates it and
			// reports the result must name the same agent on all three. One that
			// did not would be reading its own state as somebody else.
			const sent = authenticated();
			expect(sent.length, `${verb} reached the network`).toBeGreaterThan(0);
			for (const request of sent) {
				expect(
					request.headers[core.ACTING_AGENT_HEADER],
					`${verb}: ${request.method} ${request.url}`,
				).toBe(BOB.id);
			}
			// A verb that refused early would satisfy the loop above vacuously on
			// whatever it managed to send first, so what it exited with is part of
			// the fixture's claim to have run.
			expect(process.exitCode, `${verb} exit code`).toBeUndefined();
		},
	);
});
