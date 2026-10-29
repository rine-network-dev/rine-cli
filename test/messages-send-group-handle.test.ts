// `rine send` posts the group the handle RESOLVED to, not the handle
// that was typed.
//
// The ladder resolves `#dev@acme.rine.network` to the group whose real handle
// is `#dev-401@gqb401.rine.network`, seals the message for it, and used to put
// the typed spelling in `to_handle`. `POST /messages` looks that field up by
// exact equality, so the server answered a bare `Group not found` — refused on
// the way out, and indistinguishable from the ladder never having run. The
// resolve alone was never the whole fix.
//
// 🔴 The `get` stub FILTERS, and that is the whole test. A stub answering every
// `?handle=` with the row it holds makes the exact rung appear to work, so
// nothing reaches the fallback and nothing ever posts a spelling the server
// would refuse — the mock reproduces the bug's own invisibility.

import * as core from "@rine-network/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateSenderKey = vi.fn();
vi.mock("../src/commands/sender-key-ops.js", () => ({
	getOrCreateSenderKey: (...a: unknown[]) => getOrCreateSenderKey(...a),
}));

const { registerMessages } = await import("../src/commands/messages.js");

const API_URL = "https://test.rine.network";
const CONFIG_DIR = "/tmp/test-rine-send-group-handle";
const SENDER = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";

/** The handle the server holds. Nothing here answers to `acme`. */
const REAL_HANDLE = "#dev-401@gqb401.rine.network";

/** What gets typed: the name remembered, the domain guessed. */
const TYPED_HANDLE = "#dev@acme.rine.network";

const GROUP = {
	id: GROUP_ID,
	name: "dev-401",
	handle: REAL_HANDLE,
	description: null,
	enrollment_policy: "closed",
	visibility: "private",
	isolated: false,
	vote_duration_hours: 72,
	member_count: 2,
	created_at: "2026-04-11T12:00:00Z",
	mls_group_id: null,
	mls_pending: false,
};

let filters: Array<string | undefined> = [];
let bodies: Array<Record<string, unknown>> = [];

function stubServer(): void {
	vi.spyOn(core.HttpClient.prototype, "get").mockImplementation(
		async (path: string, params?: Record<string, unknown>) => {
			if (path !== "/groups") return {};
			const handle = params?.handle as string | undefined;
			filters.push(handle);
			return {
				items: handle ? [GROUP].filter((g) => g.handle === handle) : [GROUP],
			};
		},
	);
	vi.spyOn(core.HttpClient.prototype, "post").mockImplementation(
		async (_path: string, body?: unknown) => {
			bodies.push(body as Record<string, unknown>);
			return { id: "m1", conversation_id: "c1" };
		},
	);
}

async function send(to: string): Promise<void> {
	const program = new Command();
	program.option("--json", "Output JSON");
	program.option("--profile <profile>", "Profile name");
	program.option("--as <handle>", "Act as agent");
	vi.spyOn(program, "opts").mockReturnValue({ json: true });
	registerMessages(program);
	await program.parseAsync([
		"node",
		"rine",
		"send",
		"--to",
		to,
		"--payload",
		'{"text":"hi group"}',
	]);
}

beforeEach(() => {
	filters = [];
	bodies = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(core, "resolveConfigDir").mockReturnValue(CONFIG_DIR);
	vi.spyOn(core, "resolveApiUrl").mockReturnValue(API_URL);
	vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
	vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
	vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	vi.spyOn(core, "normalizeHandle").mockImplementation((h) => h);
	vi.spyOn(core, "fetchAgents").mockResolvedValue([
		{ id: SENDER, handle: "me@acme.rine.network" },
	] as never);
	vi.spyOn(core, "resolveAgent").mockResolvedValue({ agentId: SENDER });
	vi.spyOn(core, "encryptGroupMessage").mockResolvedValue({
		result: {
			encrypted_payload: "ENC(GROUP)",
			encryption_version: "sender-key-v1",
			sender_signing_kid: `rine:${SENDER}`,
		},
	} as never);
	vi.spyOn(core, "assertNoMlsDowngrade").mockImplementation(() => {});
	getOrCreateSenderKey.mockResolvedValue({
		state: { __state: true },
		groupId: GROUP_ID,
	});
	stubServer();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("rine send into a group whose handle was typed wrong", () => {
	it("posts the handle the server holds", async () => {
		await send(TYPED_HANDLE);

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.to_handle).toBe(REAL_HANDLE);
		// The exact rung was tried first and answered nothing — otherwise this
		// proves only that a correct handle survives being sent.
		expect(filters).toEqual([TYPED_HANDLE, undefined]);
	});

	it("keys the sender key to the resolved handle too", async () => {
		// Everything downstream addresses the group the SERVER holds; the
		// sender-key helper resolves whatever handle it is handed all over again.
		await send(TYPED_HANDLE);

		expect(getOrCreateSenderKey).toHaveBeenCalledWith(
			expect.anything(),
			CONFIG_DIR,
			SENDER,
			REAL_HANDLE,
		);
	});

	it("leaves a handle the server does hold exactly as written", async () => {
		// The fallback is a fallback: a correct handle still costs one round trip.
		await send(REAL_HANDLE);

		expect(bodies[0]?.to_handle).toBe(REAL_HANDLE);
		expect(filters).toEqual([REAL_HANDLE]);
	});
});

// ── The sigil, not the at-sign, decides what a `--to` is ──────────────────
//
// `#logistics` is a first-class group spelling — the sigil form of the group's
// own name, with no org half. `send` filed its destination by looking for an
// `@`, so a sigiled ref without one fell into the AGENT arm: it set
// `to_agent_id = "#logistics"`, and then the group arm set `to_handle` from the
// resolved row on top of it. `MessageCreate.check_exactly_one_destination`
// refuses a body carrying both ("Provide exactly one of to_agent_id or
// to_handle, not both") — so the send died at the server AFTER the group was
// resolved, the sender key minted and the payload sealed. All of it thrown
// away for a 422 that names neither the group nor the sigil.
//
// 🔴 The bare-name rule is the other half and it is pinned below: a BARE
// `logistics`, no sigil, still means an AGENT on this CLI, and the
// fix above must not widen it — only the `#` arm moved.

/** The same group, named the way it needs no org half. */
const SIGIL_ONLY = "#dev-401";

describe("rine send --to a sigiled group reference with no org half", () => {
	it("sets to_handle alone — never both destinations", async () => {
		await send(SIGIL_ONLY);

		expect(bodies).toHaveLength(1);
		const body = bodies[0] ?? {};
		expect(body.to_handle).toBe(REAL_HANDLE);
		// The assertion the server would have made, made here instead: exactly
		// one destination, and `to_agent_id` absent rather than merely falsy —
		// a present `undefined` still serialises on some paths.
		expect("to_agent_id" in body).toBe(false);
		expect(
			[body.to_agent_id, body.to_handle].filter((v) => v !== undefined),
		).toHaveLength(1);
	});

	it("still resolves the group, so the sigil is not just being dropped", async () => {
		await send(SIGIL_ONLY);

		// It reached the ladder: the exact rung was tried with the typed
		// spelling first, then the listing fallback answered.
		expect(filters).toEqual([SIGIL_ONLY, undefined]);
	});

	it("keeps a bare name an AGENT, unchanged", async () => {
		// No sigil and no at-sign. This must NOT become a group send: no group
		// is resolved, and the bare word goes out as `to_agent_id` exactly as it
		// always has. `messages-send.ts`'s `--to` help says so and stays true.
		//
		// The DM arm is only reachable with its own mock — which is itself
		// the assertion: reaching them at all proves the bare word took the
		// AGENT branch and not the group one.
		vi.spyOn(core, "sealForAgent").mockResolvedValue({
			encrypted_payload: "ENC(DM)",
			encryption_version: "hpke-hybrid-v2",
			sender_signing_kid: `rine:${SENDER}`,
		} as never);

		await send("dev-401");

		expect(bodies).toHaveLength(1);
		const body = bodies[0] ?? {};
		expect(body.to_agent_id).toBe("dev-401");
		expect("to_handle" in body).toBe(false);
		// Never asked the group ladder anything.
		expect(filters).toEqual([]);
	});
});

// ── the help advertises the spelling the block above proves ───────────────
//
// The three tests above are the whole justification for this one: `#dev-401`
// resolves today, and `--to`'s help did not say so. The help text is a
// widening over already-shipped behaviour, so a test that only read the string
// would prove nothing — this one reads it BESIDE the vectors that prove the
// behaviour, and the last of those three is the bare-name rule still holding.

/** What `rine send --to` tells an operator it takes. */
function toDescription(): string {
	const program = new Command();
	program.option("--json", "Output JSON");
	registerMessages(program);
	const send = program.commands.find((c) => c.name() === "send");
	return send?.options.find((o) => o.long === "--to")?.description ?? "";
}

describe("rine send --to help text", () => {
	it("advertises the sigiled short form", () => {
		expect(toDescription()).toContain("(#logistics)");
	});

	it("keeps both worked examples — the placeholder ban exempts a description", () => {
		// 🔴 The placeholder ban is a rule about REFUSALS. Stripping these while
		// widening the sentence would silently trade one item's fix for another
		// item's regression, and nothing else in this suite would notice.
		const said = toDescription();
		expect(said).toContain("kofi@acme.rine.network");
		expect(said).toContain("#logistics@acme.rine.network");
	});

	it("advertises no BARE name as a group, in the help this time", () => {
		// Every group spelling it names carries the sigil. A `logistics` written
		// without one would be advertising the thing this CLI resolves as an
		// AGENT, which is the ring-fence this CLI draws.
		const said = toDescription();
		for (const at of [...said.matchAll(/logistics/g)]) {
			expect(said[(at.index ?? 0) - 1]).toBe("#");
		}
		expect(said).toContain("agent ID");
	});
});

// ── `send` widens the same refusal the twelve verbs widen ─────────────────
//
// The eviction pointer's trigger lives in `groupTarget`'s catch, and `send`
// does not climb that ladder: it calls `resolveGroupByHandle` itself. Without
// the shared trigger an evicted agent got the pointer from `rine group get`
// and a bare roster refusal from `rine send`, on the same spelling of the same
// group — a smaller copy of the inconsistency the shared trigger ends.
//
// 🔴 The pointer is not the eviction sentence. Nothing here read a ratchet tree.

/** A handle no row answers to: the exact rung misses, the fallback name misses. */
const EVICTED_HANDLE = "#standup@acme.rine.network";

describe("rine send --to a group this agent can no longer resolve", () => {
	let said: string[] = [];

	beforeEach(() => {
		said = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			said.push(args.map(String).join(" "));
		});
	});

	it("grows the eviction pointer when the agent holds MLS state", async () => {
		const holds = vi.spyOn(core, "holdsAnyMlsState").mockReturnValue(true);

		await send(EVICTED_HANDLE);

		const printed = said.join("\n");
		expect(printed).toContain(core.GROUP_NOT_FOUND_LEAD);
		expect(printed).toContain(core.EVICTION_POINTER_TAIL);
		expect(printed).not.toContain("..");
		// Never the eviction sentence: no group's tree was consulted.
		expect(printed).not.toContain("You were removed");
		expect(bodies).toEqual([]);
		// The acting agent was already resolved for the send, so the gate is
		// free here — one local question, no extra round trip.
		expect(holds).toHaveBeenCalledTimes(1);
		expect(holds).toHaveBeenCalledWith(CONFIG_DIR, SENDER);
	});

	it("adds nothing for an agent that holds no MLS state at all", async () => {
		// The common case is a mistyped group name. Telling that caller it may
		// have been removed from a group would be a lie.
		vi.spyOn(core, "holdsAnyMlsState").mockReturnValue(false);

		await send(EVICTED_HANDLE);

		const printed = said.join("\n");
		expect(printed).toContain(core.GROUP_NOT_FOUND_LEAD);
		expect(printed).not.toContain("may have been removed");
		expect(bodies).toEqual([]);
	});
});
