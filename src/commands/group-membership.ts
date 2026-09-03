import {
	type GroupMemberRead,
	type GroupRead,
	type JoinRequestRead,
	type ListResponse,
	ACTING_AGENT_HEADER,
	UUID_RE,
	deleteGroupMember,
	evictionMessage,
	loadMlsState,
	resolveToUuid,
	retireLocalGroupState,
	retirementMessage,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { announceHandleCompletion } from "../handle-completion.js";
import {
	printJson,
	printMutationOk,
	printTable,
	printText,
} from "../output.js";
import { asGroupAccessError } from "./group-eviction.js";
import { installWelcomes, selfJoinViaExternalCommit } from "./group-mls.js";
import { memberRow, requestRow } from "./group-rows.js";
import {
	type SenderKeyCoverage,
	coverageWarning,
	senderKeyCoverage,
} from "./group-senderkey.js";
import {
	GROUP_REFERENCE_HELP,
	groupTarget,
	joinGroupTarget,
} from "./group-target.js";

/** The group, or null when it cannot be read — only its rendering depends on it. */
async function readGroup(
	ctx: ActionContext,
	groupId: string,
): Promise<GroupRead | null> {
	try {
		return (await ctx.client.get(`/groups/${groupId}`)) as GroupRead;
	} catch {
		return null;
	}
}

/** Who holds this agent's sender key for the group; null when it holds none. */
async function coverageFor(
	ctx: ActionContext,
	groupId: string,
	memberIds: string[],
): Promise<SenderKeyCoverage | null> {
	try {
		return senderKeyCoverage(
			ctx.configDir,
			await ctx.actingAgent(),
			groupId,
			memberIds,
		);
	} catch {
		// Reporting who can read this agent's traffic must never fail the read of
		// who is in the group.
		return null;
	}
}

export function registerGroupMembership(
	program: Command,
	group: Command,
): void {
	group
		.command("members")
		.description("List group members")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		// The roster is the same for every agent of the org; the sender-key
		// coverage line under it is not — it answers "who holds MY key", read out
		// of one agent's local store, and on a multi-agent org the flag is what
		// says whose.
		.addOption(
			actorOption(
				"which agent is acting, and whose sender-key coverage is reported",
			),
		)
		.action(
			withClient(program, async (ctx: ActionContext, ref: string) => {
				const { id: groupId } = await groupTarget(ctx, ref);
				let data: ListResponse<GroupMemberRead>;
				try {
					data = (await ctx.client.get(
						`/groups/${groupId}/members`,
					)) as ListResponse<GroupMemberRead>;
				} catch (err) {
					// A cross-org evicted agent is refused this read outright, so the
					// eviction has to be answered on the refusal or not at all.
					throw await asGroupAccessError(ctx.configDir, groupId, err, () => ctx.actingAgent());
				}
				// On an open group, being a member is not the same as being able to
				// read: a partial sender-key distribution leaves a member holding no
				// key, and every caller of `distributeSenderKey` discards the failures.
				const coverage = await coverageFor(
					ctx,
					groupId,
					data.items.map((m) => m.agent_id),
				);
				if (ctx.gOpts.json) {
					printJson(
						coverage ? { ...data, sender_key_coverage: coverage } : data,
					);
					return;
				}
				printTable(data.items.map(memberRow));
				const warning = coverage ? coverageWarning(coverage) : "";
				if (warning) printText(warning);
			}),
		);

	group
		.command("join")
		.description("Join a group")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		// 🔴 This verb never asks for the acting agent's id, and the flag still
		// decides the whole outcome: `POST /groups/{id}/join` seats whichever agent
		// `X-Rine-Agent` names, and `withClient` pins that header for any caller
		// who NAMED an actor — by this flag or by `RINE_AGENT`. Without the flag a
		// multi-agent org had the environment variable and nothing else, so the
		// typed spelling is the missing one, not a new rung. A caller who names
		// nobody is unaffected: the ladder stays lazy and `joinGroupTarget` still
		// resolves with the client's own headers, so this verb gains no refusal it
		// did not have.
		.addOption(actorOption("which agent joins the group"))
		.option("--message <msg>", "Join request message")
		.action(
			withClient(
				program,
				async (
					ctx: ActionContext,
					ref: string,
					opts: { message?: string },
				) => {
					// 🔴 `joinGroupTarget`, never `groupTarget`: this verb names a group
					// this org holds no seat in, so the member ladder's first rung — the
					// org's own group list — is the one thing that cannot answer it.
					const { id: groupId } = await joinGroupTarget(ctx, ref);
					const body: Record<string, unknown> = {};
					if (opts.message) body.message = opts.message;

					const data = (await ctx.client.post(
						`/groups/${groupId}/join`,
						body,
					)) as GroupMemberRead | JoinRequestRead;
					if ("role" in data) {
						// Immediate membership: install any pending MLS Welcome so the
						// joiner can decrypt/send. Best-effort, with one exception:
						// a Welcome the substitution guard REFUSED for THIS group
						// fails the command and exits non-zero. The rine
						// membership stands either way — the join POST has already
						// returned 200 — so this is not a retryable join.
						await installWelcomes(
							ctx.client,
							ctx.configDir,
							data.agent_id,
							groupId,
							ctx.gOpts.json,
						);
						// Open-enrollment fallback: if the group is MLS-active but no
						// Welcome arrived (no admin minted one), self-join via an external
						// commit. Best-effort, runs only when no local state exists.
						const joined = await readGroup(ctx, groupId);
						await selfJoinViaExternalCommit(
							ctx.client,
							ctx.configDir,
							groupId,
							data.agent_id,
							joined?.mls_group_id,
							ctx.gOpts.json,
						);
					}
					if (ctx.gOpts.json) {
						printJson(data);
					} else if ("role" in data) {
						printTable([memberRow(data)]);
						printText("Joined group (member)");
					} else {
						printTable([requestRow(data)]);
						printText("Join request submitted (pending approval)");
					}
				},
			),
		);

	group
		.command("leave")
		.description("Leave a group")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		.addOption(actorOption())
		.action(
			withClient(
				program,
				async (ctx: ActionContext, ref: string) => {
					// 🔴 A UUID is taken as given HERE and nowhere else on the member
					// ladder. `leave` is the verb an evicted agent runs to get its local
					// state wiped, and `has_read_access` 403s exactly that agent — so
					// resolving through a read the server refuses would turn the one
					// recovery path into a refusal. A name still climbs the ladder,
					// because a name has nothing else to resolve against.
					const groupId = UUID_RE.test(ref)
						? ref
						: (await groupTarget(ctx, ref)).id;
					const agentId = await ctx.actingAgent();
					// Deliberately NOT folded into the resolve above: it must stay the
					// tolerant read, for the same reason the UUID is a passthrough.
					const left = await readGroup(ctx, groupId);
					// Read before the wipe: it is the fallback for the sentence printed
					// below when the group itself could not be read.
					const heldMlsState =
						loadMlsState(ctx.configDir, agentId, groupId) !== null;
					// Server first: a refused leave must never leave a member still in
					// the group with no keys to read it. The acting agent is named
					// explicitly because the server tells a leave from a kick by that
					// header and fails closed — without it a multi-agent org's leave is
					// treated as a kick and asked for a Remove commit nobody can mint,
					// since MLS gives no member a way to commit their own removal.
					await deleteGroupMember(
						ctx.client,
						ctx.configDir,
						groupId,
						agentId,
						undefined,
						{ [ACTING_AGENT_HEADER]: agentId },
					);
					const wipe = retireLocalGroupState(ctx.configDir, agentId, groupId);
					printMutationOk("Left group", ctx.gOpts.json);
					if (!ctx.gOpts.json) {
						// A wipe that did not happen is reported before the sentence that
						// describes one that did, so the two can never be confused.
						if (wipe.error) printText(wipe.error);
						if (wipe.retired) printText(retirementMessage(left, heldMlsState));
					}
				},
			),
		);

	group
		.command("kick")
		.description("Remove a member from the group (admin)")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		.argument("<agent-id>", "Agent ID or handle to remove")
		// Which admin is removing, when the server asks for a Remove commit — the
		// lazy `ctx.actingAgent()` below is that ask, and the flag is the rung it
		// climbs first. Naming nobody still works on every group that needs no
		// commit, exactly as it did.
		.addOption(actorOption("which agent is acting, and removes the member"))
		.action(
			withClient(
				program,
				async (ctx: ActionContext, ref: string, agentId: string) => {
					announceHandleCompletion(agentId);
					const resolved = await resolveToUuid(ctx.apiUrl, agentId);
					// 🔴 A UUID is taken as given here, exactly as it is on `leave`, and
					// for the same reason. `kick` read the group through the TOLERANT
					// `readGroup` — null on any failure — and removed the member anyway;
					// only the eviction sentence below depends on the row. Folding that
					// read into `groupTarget`, which throws, would let a 500 on
					// `GET /groups/{id}` leave the member seated: a rendering-only read
					// gating an admin's removal. A NAME has nothing else to resolve
					// against, so it climbs the ladder and accepts the coupling.
					let groupId = ref;
					let target: GroupRead | null;
					if (UUID_RE.test(ref)) {
						target = await readGroup(ctx, ref);
					} else {
						const seated = await groupTarget(ctx, ref);
						groupId = seated.id;
						target = seated.row;
					}
					// The acting admin is resolved only if the server asks for a Remove
					// commit, so a kick from a multi-agent org that named no agent still
					// works on every group that does not need one.
					const removal = await deleteGroupMember(
						ctx.client,
						ctx.configDir,
						groupId,
						resolved,
						() => ctx.actingAgent(),
						ctx.extraHeaders,
					);
					printMutationOk("Member removed", ctx.gOpts.json);
					const evicted = evictionMessage(target, removal);
					if (!ctx.gOpts.json && evicted) printText(evicted);
				},
			),
		);
}
