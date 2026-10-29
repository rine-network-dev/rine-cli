/**
 * `rine group list` / `rine group get` / `rine group members` and the two
 * questions a credential-scoped row could not answer on its own.
 *
 * The thread pointer exists so that an operator (and the agent reading over its
 * shoulder) can go from "which groups am I in" to `rine thread <id>` without
 * having first sent into the group or read a message out of it. `Your Agents`
 * and `Yours` exist for the neighbouring gap: the group list is scoped to the
 * ORG, so a group on it was never proof that the agent doing the asking may
 * post there, and `Members: 4` said nothing about which four.
 *
 * The empty arms are the ones that matter. `printTable` renders a null or a
 * missing key as an empty cell, and an empty cell is indistinguishable from a
 * server that never reported the field — so each placeholder is the difference
 * between a fact about the group and "this build cannot tell you".
 */

import type { GroupMemberRead, GroupRead } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import {
	NO_OWN_AGENTS,
	NO_CONVERSATION,
	groupDetailRow,
	groupRow,
	memberRow,
} from "../src/commands/group-rows.js";

const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const OWN_AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_OWN_AGENT = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_AGENT = "44444444-4444-4444-8444-444444444444";

// What `ownAgentHandles` builds from `ctx.agents()`: this org's ids, indexed
// lowercased, handles only.
const HANDLES: ReadonlyMap<string, string> = new Map([
	[OWN_AGENT, "ops@acme"],
	[OTHER_OWN_AGENT, "billing@acme"],
]);

function group(over: Partial<GroupRead> = {}): GroupRead {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "ops",
		handle: "#ops@acme.rine.network",
		description: null,
		enrollment_policy: "closed",
		visibility: "private",
		isolated: false,
		vote_duration_hours: 24,
		member_count: 4,
		created_at: "2026-08-01T00:00:00Z",
		mls_enabled: true,
		mls_group_id: "mls-abc",
		mls_pending: false,
		mls_cipher_suite: 61455,
		conversation_id: CONVERSATION_ID,
		member_agent_ids: [OWN_AGENT],
		...over,
	};
}

function member(over: Partial<GroupMemberRead> = {}): GroupMemberRead {
	return {
		id: "44444444-4444-4444-8444-444444444444",
		group_id: "11111111-1111-4111-8111-111111111111",
		agent_id: OWN_AGENT,
		role: "member",
		joined_at: "2026-08-01T00:00:00Z",
		agent_handle: "ops-bot@acme.rine.network",
		is_own_org: true,
		...over,
	};
}

describe("groupRow — the conversation pointer", () => {
	it("prints the id the server reported, verbatim", () => {
		const row = groupRow(group());
		expect(row["Conversation ID"]).toBe(CONVERSATION_ID);
	});

	it("prints the empty-thread sentence rather than a blank cell", () => {
		const row = groupRow(group({ conversation_id: null }));
		expect(row["Conversation ID"]).toBe(NO_CONVERSATION);
		expect(String(row["Conversation ID"])).not.toContain("null");
		expect(String(row["Conversation ID"])).not.toBe("");
	});

	it("keeps the column between the roster size and the creation date", () => {
		// Column order is the row's key order. Pinned because a pointer an
		// operator has to hunt for in a wide table is one they will not use.
		const keys = Object.keys(groupRow(group()));
		expect(keys.indexOf("Conversation ID")).toBe(keys.indexOf("Members") + 1);
		expect(keys.indexOf("Created")).toBe(keys.indexOf("Conversation ID") + 1);
	});
});

describe("groupDetailRow — the conversation pointer", () => {
	it("prints the id the server reported, verbatim", () => {
		const row = groupDetailRow(group());
		expect(row["Conversation ID"]).toBe(CONVERSATION_ID);
	});

	it("prints the empty-thread sentence rather than a blank cell", () => {
		const row = groupDetailRow(group({ conversation_id: null }));
		expect(row["Conversation ID"]).toBe(NO_CONVERSATION);
		expect(String(row["Conversation ID"])).not.toContain("null");
	});

	it("says the same thing the list row says", () => {
		// Two renderings of one fact is how an operator learns to distrust both.
		const empty = group({ conversation_id: null });
		expect(groupDetailRow(empty)["Conversation ID"]).toBe(
			groupRow(empty)["Conversation ID"],
		);
	});
});

describe("groupDetailRow — which of your agents are seated", () => {
	it("prints the handles of the ids the server reported, in its order", () => {
		// Case 1 of the rendering rule: a handle is what an operator reads and what
		// `--agent` takes; a UUID is only the second of those.
		const row = groupDetailRow(
			group({ member_agent_ids: [OWN_AGENT, OTHER_OWN_AGENT] }),
			HANDLES,
		);
		expect(row["Your Agents"]).toBe("ops@acme, billing@acme");
	});

	it("prints an id the org cannot resolve as the id", () => {
		// Case 2, and the reason the cell can never be blank: an agent of
		// another org — or one this list predates — is still addressable by
		// UUID, so the degraded rendering is the older one.
		const row = groupDetailRow(
			group({ member_agent_ids: [OWN_AGENT, UNKNOWN_AGENT] }),
			HANDLES,
		);
		expect(row["Your Agents"]).toBe(`ops@acme, ${UNKNOWN_AGENT}`);
	});

	it("prints the ids when no agent list could be read at all", () => {
		// `ownAgentHandles` answers an empty map when `GET /agents` fails, and
		// a failed decoration must never cost the group read its answer.
		const row = groupDetailRow(
			group({ member_agent_ids: [OWN_AGENT, OTHER_OWN_AGENT] }),
			new Map(),
		);
		expect(row["Your Agents"]).toBe(`${OWN_AGENT}, ${OTHER_OWN_AGENT}`);
	});

	it("resolves an id the server spelled in upper case", () => {
		const row = groupDetailRow(
			group({ member_agent_ids: [OWN_AGENT.toUpperCase()] }),
			HANDLES,
		);
		expect(row["Your Agents"]).toBe("ops@acme");
	});

	it("prints the none-seated sentence rather than a blank cell", () => {
		// An empty list is a fact — no agent of this org is in the group, so a
		// send would be refused — and a blank cell would report it as a
		// rendering fault instead.
		const row = groupDetailRow(group({ member_agent_ids: [] }));
		expect(row["Your Agents"]).toBe(NO_OWN_AGENTS);
		expect(String(row["Your Agents"])).not.toBe("");
	});

	it("does not crash on a server that predates the field", () => {
		// Reachable inside the release-order window: the server ships before
		// the clients, but the published CLI can be pointed at any deployment.
		// Reading `.length` off the missing key would break `rine group get`
		// outright, which is a worse answer than the empty sentence.
		const { member_agent_ids, ...older } = group();
		expect(member_agent_ids).toBeDefined();
		expect(groupDetailRow(older as GroupRead)["Your Agents"]).toBe(NO_OWN_AGENTS);
	});

	it("keeps the cell beside the roster size, where the question is asked", () => {
		// `Members` says how many agents are in the group; this says which of
		// them are yours. Split across a wide table they are two facts an
		// operator has to join by hand.
		const keys = Object.keys(groupDetailRow(group()));
		expect(keys.indexOf("Your Agents")).toBe(keys.indexOf("Members") + 1);
	});

	it("is not added to the `rine group list` table", () => {
		// A deliberate asymmetry, the same one `Conversation ID` has: a UUID
		// list in a table that already carries eight columns is unreadable, and
		// one group is what `rine group get` is for.
		expect(Object.keys(groupRow(group()))).not.toContain("Your Agents");
	});
});

describe("memberRow — whose agent this row is", () => {
	it("marks the caller's own agents", () => {
		expect(memberRow(member()).Yours).toBe(true);
	});

	it("keeps another org's members on the roster, marked false", () => {
		// A MARKER, never a filter. Those rows are exactly the co-members a
		// group send reaches, and `member_count` counts them, so hiding them
		// would make the table disagree with the number above it.
		const row = memberRow(member({ is_own_org: false }));
		expect(row.Yours).toBe(false);
		expect(row["Agent ID"]).toBe(OWN_AGENT);
	});

	it("says it cannot tell rather than guessing, on a server that predates the field", () => {
		// The same distinction `denialCell` draws: "not yours" and "this build
		// cannot tell you" are different facts, and `false` on every row would
		// state something about another org's seat that nothing here knows.
		const { is_own_org, ...older } = member();
		expect(is_own_org).toBe(true);
		expect(memberRow(older as GroupMemberRead).Yours).toBe("—");
	});

	it("keeps the timestamp last, as every other row in this file does", () => {
		const keys = Object.keys(memberRow(member()));
		expect(keys.indexOf("Yours")).toBe(keys.indexOf("Role") + 1);
		expect(keys[keys.length - 1]).toBe("Joined");
	});
});
