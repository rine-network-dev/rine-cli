import {
	type GroupAdmissionReport,
	type GroupRead,
	type HttpClient,
	type JoinRequestRead,
	type MlsAdmissionResult,
	admissionHeadline,
	admittedAgentIds,
	groupAdmissionSkipSentence,
	inviteNominates,
	resolveToUuid,
	sendGroupInviteNotification,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, type Precheck, withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { announceHandleCompletion } from "../handle-completion.js";
import { printJson, printTable, printText } from "../output.js";
import { INVITEE_REQUIRED, collect, dedupeIds } from "./group-args.js";
import { admitToMls } from "./group-mls.js";
import {
	admissionOutcomeRows,
	admissionRow,
	requestRow,
} from "./group-rows.js";
import { GROUP_REFERENCE_HELP, groupTarget } from "./group-target.js";

/**
 * An invite that names nobody is refused before it costs anything.
 *
 * It runs ahead of the acting agent, so a caller who typed no `--invitee` is
 * told that rather than being asked which of their agents is inviting — a
 * question they cannot answer usefully and did not come here to answer.
 *
 * The options object is found by the shape only this command has rather than by
 * its position, because commander's argument order depends on how many
 * arguments the command declares.
 */
const invitesSomebody: Precheck = (...args) => {
	const opts = args.find((arg) =>
		Array.isArray((arg as { invitee?: unknown } | undefined)?.invitee),
	) as { invitee: string[] } | undefined;
	if (opts === undefined) return null;
	return opts.invitee.length === 0 ? INVITEE_REQUIRED : null;
};

const INVITATION_NOTE =
	"An invitation holds a ratchet-tree seat until it is accepted or expires.";

const NOMINATION_NOTE =
	"A nomination holds a seat too, and the group's electorate decides it:" +
	" nothing is added to the ratchet tree until the vote carries.";

/**
 * What the agents this batch reached now hold — said only of what it minted.
 *
 * Read off the entries, the same place {@link admissionHeadline} reads, because
 * a batch answers one of three ways and only two of them have anything to hold.
 * An open group mints no invitation and no nomination and runs Sender Keys, so
 * it has no ratchet tree either: every entry comes back `not_applicable`, and
 * both sentences below would name objects that do not exist. The per-agent line
 * carries the fact there — the agent may join whenever it likes — so the note
 * is simply absent rather than replaced.
 *
 * A closed group's invite mints vouchers and a voting group's files
 * nominations, one policy per call, so in practice one clause prints. Both are
 * stated when both are present, which costs nothing and keeps this true of a
 * report rather than of a policy this function never sees.
 */
function admissionNote(report: GroupAdmissionReport): string {
	const notes: string[] = [];
	if (report.entries.some((entry) => entry.status === "invited")) {
		notes.push(INVITATION_NOTE);
	}
	if (report.entries.some((entry) => entry.status === "nominated")) {
		notes.push(NOMINATION_NOTE);
	}
	return notes.join(" ");
}

const UNRESOLVED_INVITER =
	"Warning: the request was filed, but this agent could not be resolved, so" +
	" no Welcome was minted and nobody was notified:";

/**
 * Nudge each reached agent's inbox with a sealed `rine.v1.group_invite` DM.
 *
 * The authoritative discovery path is `GET /groups/invites` (`group invites`),
 * which answers nominations as well as invitations and tells them
 * apart by `status` — so a failure here — a `groups_only` 403, missing keys —
 * warns and never fails the row the server has already written.
 *
 * The DM carries the group and who reached out, not a rendered sentence: its
 * payload is `{group_id, group_handle, invited_by, message}`
 * (`rine-core/src/group-invite-ops.ts`), so nothing on this path claims a seat
 * a nomination does not confer.
 */
async function notifyInvitees(
	client: HttpClient,
	configDir: string,
	inviterId: string,
	group: GroupRead,
	inviteeIds: string[],
	message: string | undefined,
	json?: boolean,
): Promise<void> {
	for (const inviteeId of inviteeIds) {
		try {
			await sendGroupInviteNotification(
				client,
				configDir,
				inviterId,
				inviteeId,
				{
					group_id: group.id,
					group_handle: group.handle,
					message: message ?? null,
				},
			);
		} catch (err) {
			if (!json) {
				printText(
					`Warning: invite notification to ${inviteeId} failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
	}
}

/**
 * The agents this call actually reached, whichever shape answered.
 *
 * A singular invite gets a bare row back and no report, so the one agent it
 * named is the answer. A plural one is `admittedAgentIds` — `rine-core`'s, not
 * a second copy of the arithmetic — which counts `not_applicable` as reached
 * because that is an open group's answer: it mints no voucher since it needs
 * none, and those agents are still being told to come in.
 *
 * 🔴 This is "who was reached and is owed a notice", NOT "who gets a leaf".
 * It also counts `nominated` entries, so feeding it to an MLS add
 * without asking {@link inviteNominates} first would Welcome an agent the
 * electorate has not decided on. {@link afterInvite} is where that question is
 * asked.
 */
function reachedAgents(
	report: GroupAdmissionReport | null,
	singular: string | undefined,
): string[] {
	if (!report) return singular ? [singular] : [];
	return admittedAgentIds(report);
}

/**
 * What one invite call did, in its own words.
 *
 * Read off the row the server wrote rather than off the group, because the row
 * is the answer: a `closed` group's invite mints a voucher (`invited`), a
 * `majority` or `unanimity` group's files a nomination (`pending`),
 * and an `open` group's is a notification with no row at all — which answers
 * `invited` and carries no `id`.
 *
 * That missing `id` is what tells the third case from the first, and it is the
 * only signal there is: the two answers carry the same status. An open group
 * mints nothing because it needs nothing, so the head says so and there is no
 * row to table underneath it — reported in `rine-core`'s words, the same
 * sentence the plural report's per-agent line carries.
 */
function singularHead(row: JoinRequestRead): string {
	if (row.status === "pending") {
		return "Nomination filed — the group's electorate decides it";
	}
	if (!row.id) {
		return `Invited: ${groupAdmissionSkipSentence("not_applicable")}`;
	}
	return "Invitation sent";
}

function printInvited(
	data: unknown,
	report: GroupAdmissionReport | null,
	admission: MlsAdmissionResult | null,
	json?: boolean,
): void {
	if (json) {
		printJson(admission ? { ...(data as object), admission } : data);
		return;
	}
	if (report) {
		const note = admissionNote(report);
		printText(
			`Admission: ${admissionHeadline(report)}${note ? ` ${note}` : ""}`,
		);
		printTable(report.entries.map(admissionRow));
	} else {
		const voucher = data as JoinRequestRead;
		printText(singularHead(voucher));
		if (voucher.id) printTable([requestRow(voucher)]);
	}
	if (admission && admission.outcomes.length > 0) {
		printText(
			`\nSeated in the ratchet tree: ${admission.added} of ${admission.outcomes.length}` +
				` in ${admission.commits} commit(s), now at epoch ${admission.epoch}.`,
		);
		printTable(admissionOutcomeRows(admission));
	}
}

/**
 * The two steps that happen *after* the server has written the row, and neither
 * of which may fail the command.
 *
 * Both need the group's handle and the acting inviter, so both are read once
 * here rather than twice inside each. That resolution is itself best-effort: a
 * multi-agent org that named no agent — no `--agent`, no `RINE_AGENT`, and more
 * than one to choose from — cannot be told which agent is inviting, and refusing
 * to report an invitation that the server already accepted would be the wrong
 * answer to that.
 *
 * 🔴 **A nomination gets the notice and no leaf.** On `majority` and
 * `unanimity` this call filed a request the electorate has not decided, so
 * claiming the nominee's KeyPackage and Welcoming them here would put an agent
 * the vote may refuse inside the ratchet tree, holding an epoch secret, with
 * only the manual reclamation pass able to retire the leaf afterwards — and
 * that pass cannot reach it while the row is live. The vote seats the member,
 * and seating is what grants the key: `group vote` posts the add on the approve
 * that carries, which is what the self-application path has always done. The
 * notice still goes out, because a nominee that never learns of the nomination
 * can never consent to it.
 *
 * The GROUP's policy decides this and not the response, because it is the same
 * question the server asked when it chose what to write, and it answers the
 * singular and the plural call in one place.
 */
async function afterInvite(
	ctx: ActionContext,
	groupId: string,
	reached: string[],
	message: string | undefined,
): Promise<MlsAdmissionResult | null> {
	let group: GroupRead;
	let inviterId: string;
	try {
		group = (await ctx.client.get(`/groups/${groupId}`)) as GroupRead;
		inviterId = await ctx.actingAgent();
	} catch (err) {
		if (!ctx.gOpts.json) {
			printText(
				`${UNRESOLVED_INVITER} ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return null;
	}
	// Give every reached invitee a leaf now, so their Welcome is waiting when
	// they accept instead of their join paying for a full external commit. One
	// batched pass whether one agent was named or five hundred — and none at all
	// when the call nominated rather than invited.
	const admission = inviteNominates(group.enrollment_policy)
		? null
		: await admitToMls(
				ctx.client,
				ctx.configDir,
				inviterId,
				groupId,
				group.mls_group_id,
				reached,
				ctx.gOpts.json,
			);
	await notifyInvitees(
		ctx.client,
		ctx.configDir,
		inviterId,
		group,
		reached,
		message,
		ctx.gOpts.json,
	);
	return admission;
}

export function registerGroupInvite(program: Command, group: Command): void {
	group
		.command("invite")
		.description(
			"Invite one or more agents to the group. On a majority or unanimity" +
				" group this nominates rather than invites: it files a join request the" +
				" group's electorate decides, counted as your own approval, and nobody" +
				" is added to the ratchet tree until the vote carries. On a closed group" +
				" an admin's invite is a voucher the agent redeems with `rine group" +
				" join`. `rine group create --member` is the exception — a founding" +
				" roster invites under every policy, because the creator is the only" +
				" member and a vote would auto-approve each row.",
		)
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		.addOption(actorOption("which agent is acting, and invites"))
		.option(
			"--invitee <id>",
			"Agent ID or handle to invite or nominate (repeatable — naming two or more reaches them in one call and reports each)",
			collect,
			[],
		)
		.option(
			"--message <msg>",
			"Message to carry with the invitation or nomination",
		)
		.action(
			withClient(
				program,
				async (
					ctx: ActionContext,
					ref: string,
					opts: { invitee: string[]; message?: string },
				) => {
					const { id: groupId } = await groupTarget(ctx, ref);
					const agentIds = dedupeIds(
						await Promise.all(
							// Item 18: announced per invitee, in the order they were
							// typed, before any resolution races.
							opts.invitee.map((a) => {
								announceHandleCompletion(a);
								return resolveToUuid(ctx.apiUrl, a);
							}),
						),
					);
					// One agent keeps the wire it has always had — `agent_id`, and a bare
					// row back. Two or more use `agent_ids` and get one outcome per
					// requested id, because a batch that refused all 32 over one revoked
					// agent would be a regression from the singular behaviour at 32x the
					// blast radius.
					const single = agentIds.length === 1 ? agentIds[0] : undefined;
					const body: Record<string, unknown> = single
						? { agent_id: single }
						: { agent_ids: agentIds };
					if (opts.message) body.message = opts.message;

					const data = await ctx.client.post(`/groups/${groupId}/invite`, body);
					const report = single ? null : (data as GroupAdmissionReport);
					const admission = await afterInvite(
						ctx,
						groupId,
						reachedAgents(report, single),
						opts.message,
					);
					printInvited(data, report, admission, ctx.gOpts.json);
				},
				invitesSomebody,
			),
		);
}
