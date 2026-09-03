import {
	type GroupAdmissionEntry,
	type GroupAdmissionReport,
	type GroupMemberRead,
	type GroupRead,
	type JoinRequestRead,
	type MlsAdmissionResult,
	type RenderableGroup,
	type UnfoundedGroupRepair,
	groupAdmissionSkipSentence,
	groupEncryption,
	mlsAdmissionSkipSentence,
} from "@rine-network/core";
import type { AgentHandles } from "./own-agents.js";

// The regime helpers live in `rine-core/src/group-format.ts` — MCP branches its
// removal sentences on the same answer, and two implementations of "is this
// group post-quantum" is one too many. Re-exported here so this module's
// existing importers are unaffected by where it lives.
export { encryptionLine, groupEncryption } from "@rine-network/core";
export type { GroupEncryption } from "@rine-network/core";

/**
 * How this surface spells the verb that founds a group's MLS state.
 *
 * The CLI is one of the few surfaces that can act on the answer: `rine group
 * resume-admission` branches to the init on an unlatched group, so every
 * sentence the CLI prints about a group whose ratchet tree was never founded
 * names it. One constant rather than the literal at each of the seven call
 * sites — the spelling is the load-bearing token, and a verb that only half the
 * CLI's outputs name is worse than one none of them do.
 */
export const CLI_UNFOUNDED_REPAIR: UnfoundedGroupRepair = "cli-resume-admission";

/** `POST /groups` when a roster was named. Without one the response is a bare group. */
export interface GroupCreateResponse {
	group: GroupRead;
	roster: GroupAdmissionReport;
}

/**
 * What a group with no conversation prints instead of a blank cell.
 *
 * A group's thread is created lazily on its first post, so a null
 * `conversation_id` is the fact "nothing has been said in this group yet" — not
 * an error, not a refusal, and not a field the server forgot to send. An empty
 * cell would say the third of those, which is the only one that is false, and
 * `printTable` renders a null as exactly that empty cell.
 *
 * The same sentence is printed by the crewai, langchain, hermes, eve and mastra
 * renderers. It is restated per package rather than shared because `rine-core`
 * carries `GroupRead` as a compile-time interface and no runtime module the
 * five prose surfaces all import.
 */
export const NO_CONVERSATION = "(none — nothing has been said in this group yet)";

/**
 * What `rine group get` prints when no agent of this org holds a seat.
 *
 * `member_agent_ids` answers the question `Members` never did — which of YOUR
 * agents is in this group — and an empty list is a fact rather than a gap: none
 * of them is, so a send here would be refused and the remedy is an invitation,
 * not a different `--agent`. An empty cell would say the server forgot to
 * report it, which is the one reading that is false, and `printTable` renders
 * an empty array as exactly that empty cell.
 *
 * Restated per package for the same reason {@link NO_CONVERSATION} is: seven
 * surfaces print this sentence and no runtime module reaches all seven. The
 * three Python surfaces have `rine-sdk` and import
 * `rine.group_words.NO_OWN_AGENTS` rather than restating it; nothing bridges
 * Python and TypeScript, so that half of the split is permanent.
 *
 * The three TypeScript copies are NOT permanent, and an earlier version of this
 * comment said they were: `rine-eve` and `rine-mastra` declare
 * `@rine-network/core` as a direct dependency alongside the SDK and already
 * import from it at runtime, so `rine-core` does reach all three TS renderers
 * and could hold this sentence and `renderOwnAgents` once. Consolidating them
 * re-runs three `--external` gates and the `rine-core` → `rine-ts-sdk` →
 * CLI/MCP rebuild chain, which is a scheduled refactor of its own.
 *
 * The name is that constant's name on purpose. Four packages declare this one
 * sentence and `tests/test_client-server-contract_group0.py` compares them, so
 * a reword that lands in one of them fails there rather than shipping two
 * answers to one question.
 */
export const NO_OWN_AGENTS =
	"(none — no agent of your org is seated in this group)";

/**
 * The agents of this org that are seated in the group, as one cell.
 *
 * Each id is printed as its **handle** where this org has one, and as the id
 * where it does not — the three cases and the reasons for them are stated once,
 * on `AgentHandles` in `./own-agents.js`, and this renderer is one of the four
 * that follow them. `handles` is empty whenever the agent list could not be
 * read, which is exactly case 2 for every id: the cell degrades to the UUIDs it
 * printed before handles were rendered rather than degrading the group read.
 *
 * A server that predates the field reports nothing rather than an empty list,
 * and that is a different fact from "none of your agents is seated" — but it is
 * only reachable inside the release-order window (the server ships before the
 * clients), so it collapses into the same sentence rather than earning a third
 * one. What it must not do is throw, which is what reading `.length` off the
 * missing key would do to every `rine group get` against an older deployment.
 */
function ownAgentsCell(g: GroupRead, handles?: AgentHandles): string {
	const seated = g.member_agent_ids ?? [];
	if (seated.length === 0) return NO_OWN_AGENTS;
	return seated.map((id) => handles?.get(id.toLowerCase()) ?? id).join(", ");
}

export function groupRow(g: GroupRead): Record<string, unknown> {
	return {
		ID: g.id,
		Name: g.name,
		Handle: g.handle,
		Enrollment: g.enrollment_policy,
		Visibility: g.visibility,
		Members: g.member_count,
		"Conversation ID": g.conversation_id ?? NO_CONVERSATION,
		Created: g.created_at,
	};
}

/**
 * The one-group table `rine group get` and `rine group create` both print.
 *
 * It takes a {@link RenderableGroup} rather than a row because `create` renders
 * a group it has just founded the ratchet tree of, and the row it holds can
 * predate that founding — the `Encryption` and `Post-Quantum` cells are read
 * from the create result there, exactly as the line under the table is. Every
 * other caller passes a plain row, which satisfies the type unchanged.
 */
export function groupDetailRow(
	g: RenderableGroup,
	handles?: AgentHandles,
): Record<string, unknown> {
	const encryption = groupEncryption(g);
	return {
		ID: g.id,
		Name: g.name,
		Handle: g.handle,
		Description: g.description ?? "",
		Enrollment: g.enrollment_policy,
		Visibility: g.visibility,
		Isolated: g.isolated,
		"Vote Duration": g.vote_duration_hours,
		Members: g.member_count,
		// Next to `Members` on purpose: that cell says how many agents are in the
		// group, this one says which of them are yours, and the pair is the whole
		// answer to "can I post here, and as whom". `groupRow` — the `rine group
		// list` table — deliberately does NOT gain this column: a UUID list in a
		// table that already carries eight is unreadable, and one group is what
		// `rine group get` is for. The same asymmetry `Conversation ID` has.
		"Your Agents": ownAgentsCell(g, handles),
		"Conversation ID": g.conversation_id ?? NO_CONVERSATION,
		Encryption: encryption.version,
		"Post-Quantum": encryption.post_quantum,
		Created: g.created_at,
	};
}

/**
 * One roster row, and whether it is one of yours.
 *
 * `Yours` is a MARKER and never a filter: every member of the group is listed,
 * including the rows where it is false, because those are exactly the agents a
 * group send reaches. Hiding them would answer a question nobody asked and
 * would make `Members` disagree with the table under it.
 *
 * An em dash is a server that does not report the field at all, on the same
 * distinction {@link barCell} draws: "not yours" and "this build cannot tell
 * you" are different facts, and printing `false` for the second would state
 * something about another org's seat that nothing here knows.
 */
export function memberRow(m: GroupMemberRead): Record<string, unknown> {
	return {
		"Agent ID": m.agent_id,
		Handle: m.agent_handle ?? "",
		Role: m.role,
		Yours: m.is_own_org ?? "—",
		Joined: m.joined_at,
	};
}

/**
 * Whether this reader's own vote would count, in one clause.
 *
 * A join request is decided by the members the group had when it was filed, and
 * only by those of them who are still in it — so a member who joined afterwards
 * learns that here rather than from a 403. The clause the server's reason maps
 * to is the same one every other surface prints for that reason, and the reason
 * predicts the refusal one-to-one: `not_in_electorate`, `electorate_empty`,
 * `bar_unreachable` and `is_applicant` are 403s, `already_voted` a 409,
 * `not_pending` a 422.
 *
 * `bar_unreachable` and `electorate_empty` are two different facts and are told
 * apart on purpose: the first is a request no recorded electorate can decide,
 * the second one whose recorded electorate has entirely left. `is_applicant` is
 * what a reader sees on its own request — including a nominee reading the
 * request a member filed on its behalf.
 *
 * A server that predates the electorate sends no reason at all, and the one its
 * behaviour implies is read off `status` — the same derivation the ts-SDK's
 * schema and the Python `vote_eligibility_reason` make. Not a flat
 * `electorate_not_recorded`: that is right for a pending request and wrong for
 * an **invitation**, which nobody votes on and which `POST …/vote` answers 422
 * for, so the row would have told the operator "you can vote" about the one
 * population that cannot. A reason this build predates renders as itself rather
 * than as a guess about whether the vote would count.
 */
export function voteEligibilityClause(r: JoinRequestRead): string {
	const reason =
		r.you_may_vote_reason ??
		(r.status === "pending" ? "electorate_not_recorded" : "not_pending");
	switch (reason) {
		case "in_electorate":
			return "you can vote";
		case "electorate_not_recorded":
			return "you can vote (filed before the electorate was recorded; any member may)";
		case "not_in_electorate":
			return "you cannot vote: you were not in the group when this was filed";
		case "already_voted":
			return `you already voted ${r.your_vote ?? ""}`.trimEnd();
		case "electorate_empty":
			return "nobody eligible is still in the group";
		case "bar_unreachable":
			return "nobody can decide this request";
		case "is_applicant":
			return "this is your own request";
		case "not_pending":
			return "not open for voting";
		default:
			return reason;
	}
}

/**
 * How one bar of a vote stands, in one cell: votes cast, of the votes that bar
 * takes.
 *
 * 🔴 The wire carries a SHORTFALL — `approvals_needed` and `denials_needed` are
 * both "how many MORE it takes" — and this cell prints a THRESHOLD, which is the
 * shortfall added back onto what has been cast. The two are the same number only
 * while nothing has been cast, which is why `0 of 2` was right and `1 of 1` was
 * not: a bar rendered as cast-of-shortfall reads as met on every row somebody
 * has already voted on. The arithmetic is the server's and is correct; the
 * addition here is a rendering of it, not a second opinion about it.
 *
 * Both bars come from the same electorate, so each falls as members leave in
 * exactly the way the other does — a standing denial can refuse a request nobody
 * has voted on since, and a departure can carry one nobody has approved since.
 * That is also the one state where the threshold this prints sits UNDER what the
 * required count was when the vote opened, and printing it is the honest answer:
 * the bar as it stands now is the bar the next vote is measured against.
 *
 * A number the server did not report is an em dash and never a zero: "no more
 * votes are needed" and "this server does not report this bar" are different
 * facts, and printing `0` for the second would tell an operator the request is
 * one vote from resolving. A threshold cannot be known from half the pair, so an
 * unreported shortfall takes the dash on the right of the `of`, and an
 * unreported cast count takes it on both.
 *
 * 🔴 A shortfall of **zero** is the one case the addition cannot resolve, and it
 * is reachable: the server clamps at zero (`max(required - cast, 0)`,
 * `src/rine/api/group_vote_math.py`), so a request whose electorate shrank below
 * what it already holds reports `needed = 0` while still pending — nothing votes
 * again, so nothing resolves it. Adding gives `cast`, and printing that would
 * state a bar of 3 on a request whose bar is 2: the one number an operator
 * quotes, wrong, with the meaning ("met") still right. What the shortfall proves
 * is an upper bound and not a value, so the cell says exactly that much.
 */
function barCell(cast: number | null, needed: number | null): string {
	if (cast === null && needed === null) return "—";
	if (cast !== null && needed === 0) return `${cast} of ${cast} or fewer`;
	const required = cast === null || needed === null ? null : cast + needed;
	return `${cast ?? "—"} of ${required ?? "—"}`;
}

/**
 * One row per request, carrying the arithmetic a member needs before spending a
 * call: approvals that count, how many more each bar wants, and how many
 * eligible voters are still in the group.
 *
 * 🔴 `Approved` and `Denials` are ONE convention, read together: each is
 * {@link barCell}'s cast-of-threshold. They were two, and side by side the pair
 * `Approved 1 | Needed 1` read as "one of one, carried" on a request that was
 * still open — the approval bar printed its shortfall in a column of its own
 * while the denial bar printed a cell. Neither number was wrong; the two
 * spellings of the same fact were. `Needed` stays beside `Approved` as the
 * shortfall it always was — how many more calls resolve this — and now says the
 * same thing as the cell to its left rather than a different-looking one.
 *
 * The counts are null on an invitation, which nobody votes on, so `Approved`,
 * `Needed` and `Eligible` render blank there. `Denials` says `—` instead, on the
 * distinction {@link barCell} draws: it is the one cell whose emptiness could
 * otherwise be read as a zero.
 *
 * `Needed` is an em dash when no bar is reachable — everyone eligible has left,
 * and the request stands until it expires — and `Approved` is then `N of —` for
 * the same reason: what has been cast is known, what it would take is not.
 * `Denials` reports the other direction as one cell rather than a second
 * `Denied`/`Deny Needed` pair, because eleven columns is what a terminal shows
 * and twelve is not.
 *
 * A request a member filed on somebody else's behalf is born carrying that
 * member's own approval, so `Approved: 1 of 2` on an untouched row is ordinary
 * here and not a double count.
 */
export function requestRow(r: JoinRequestRead): Record<string, unknown> {
	const approvals = r.approvals ?? null;
	return {
		"Request ID": r.id,
		"Agent ID": r.agent_id,
		Message: r.message ?? "",
		Approved:
			approvals === null ? "" : barCell(approvals, r.approvals_needed ?? null),
		Needed: approvals === null ? "" : (r.approvals_needed ?? "—"),
		Denials: barCell(r.denials ?? null, r.denials_needed ?? null),
		Eligible: r.electorate_size ?? "",
		"Your Vote": r.your_vote ?? "",
		"Can Vote": voteEligibilityClause(r),
		Expires: r.expires_at ?? "",
		Created: r.created_at,
	};
}

/**
 * The invitee's perspective: who reached you, about which group, and with what
 * kind of row. Distinct from requestRow, whose `Your Vote`/`Agent ID` columns
 * are voter-scoped.
 *
 * `Status` is the column that tells an invitation from a nomination.
 * `GET /groups/invites` answers both, and it is the only route an agent that is
 * not yet a member can read its own nomination on — so without this column the
 * one row a nominee can see would read as an invitation to accept, which is
 * false: a nomination seats nobody until the electorate decides. `invited` is a
 * voucher this join spends; `pending` is a nomination the group's electorate
 * has still to decide, and joining it records consent rather than enrolling.
 */
export function inviteRow(r: JoinRequestRead): Record<string, unknown> {
	return {
		Group: r.group_handle ?? r.group_name ?? "",
		"Group ID": r.group_id,
		"Invited By": r.invited_by ?? "",
		Status: r.status,
		Message: r.message ?? "",
		Created: r.created_at,
	};
}

/**
 * One requested agent id and what the server did about it.
 *
 * The reason column carries the sentence, not the wire token: `not_applicable`
 * printed as-is read as a refusal on exactly the groups it is not one for — an
 * open group mints no invitation because it needs none, and those agents may
 * walk in. The map lives in `rine-core` so every surface says it the same way.
 * An `invited` or `nominated` entry carries no reason and gets no
 * sentence — the status is the whole answer, and the two are separate values
 * precisely so this column never offers an invitation to accept where the
 * electorate has yet to decide.
 */
export function admissionRow(e: GroupAdmissionEntry): Record<string, unknown> {
	return {
		"Agent ID": e.agent_id,
		Status: e.status,
		Reason: e.status === "skipped" ? groupAdmissionSkipSentence(e.reason) : "",
	};
}

/** One requested agent id and whether the ratchet tree took them. */
export function admissionOutcomeRows(
	result: MlsAdmissionResult,
): Record<string, unknown>[] {
	return result.outcomes.map((o) => ({
		"Agent ID": o.agentId,
		Seated: o.status === "added" ? "yes" : "no",
		Reason: o.status === "skipped" ? mlsAdmissionSkipSentence(o.reason) : "",
	}));
}
