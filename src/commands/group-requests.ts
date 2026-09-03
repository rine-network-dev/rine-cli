import {
	type GroupRead,
	type JoinRequestRead,
	type ListResponse,
	type MlsAdmissionResult,
	type MlsReclamationResult,
	ACTING_AGENT_HEADER,
	VOTE_ELECTORATE_RULE,
	type VoteResponse,
	describeMlsReclamation,
	groupIsMls,
	initMlsGroup,
	listMyInvites,
	resumeMlsGroupAdmission,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printError, printJson, printTable, printText } from "../output.js";
import { admitToMls, mlsFailureText } from "./group-mls.js";
import { admissionOutcomeRows, inviteRow, requestRow } from "./group-rows.js";
import { GROUP_REFERENCE_HELP, groupTarget } from "./group-target.js";

/** An open group has no ratchet tree, so there is no admission to resume in it. */
const NOT_AN_MLS_GROUP =
	"This group runs on Sender Keys, not MLS, so it has no ratchet tree to seat" +
	" anyone in. Open-enrollment groups are sender-key groups by design: MLS would" +
	" hand an unattested joiner a cryptographic seat, so the server keeps open" +
	" enrollment off the MLS path. There is nothing to resume here.";

function printAdmission(result: MlsAdmissionResult, json?: boolean): void {
	if (json) {
		printJson(result);
		return;
	}
	printText(
		`Seated ${result.added} of ${result.outcomes.length} in ${result.commits}` +
			` commit(s), now at epoch ${result.epoch}.`,
	);
	printTable(admissionOutcomeRows(result));
	printReclamation(result.reclamation);
}

/**
 * What `--reclaim` did, or the stated reason it did nothing.
 *
 * The sentence is `describeMlsReclamation`'s, from rine-core — the TypeScript
 * stack's one copy, sentence for sentence identical to the Python twin. This
 * function composed its own three branches until the MCP server, eve and mastra
 * needed the same three, which is the drift a single shared sentence stops: four
 * surfaces reporting the same reclamation in four wordings.
 */
function printReclamation(reclamation?: MlsReclamationResult): void {
	const said = describeMlsReclamation(reclamation);
	if (said) printText(said);
}

/**
 * What the vote did to the request, beside the wire token.
 *
 * There are **four** answers and not three. `invited` is the one no client
 * anticipated: the electorate approved a nomination whose subject has not
 * answered yet, so the row resolves to a spendable invitation rather than to a
 * seat — a carried vote seats only an agent that consented. Reported
 * by name here because a fall-through would render a carried vote as an unknown
 * status, and because it is the one outcome where nobody is added to the
 * ratchet tree despite the bar being met.
 *
 * An unrecognised status renders as itself and gets no sentence — a guess about
 * a token this build predates would be worse than the token.
 */
function voteOutcomeSentence(status: string): string {
	switch (status) {
		case "approved":
			return "the request carried and that agent is now a member";
		case "denied":
			return "the request was refused";
		case "pending":
			return "neither bar is reached yet, so the request stands";
		case "invited":
			return (
				"the request carried, and because its subject was nominated and has" +
				" not answered yet it is now an invitation for them to accept"
			);
		default:
			return "";
	}
}

export function registerGroupRequests(program: Command, group: Command): void {
	group
		.command("requests")
		.description("List what this group still owes an answer on")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		// 🔴 Not a filter and not decoration: `GET /groups/{id}/requests` resolves
		// the caller through `get_acting_group_member`, so the acting agent decides
		// both whether the read is allowed at all and what `Your Vote` and `Can
		// Vote` say on every row. Two agents of one org reading the same queue get
		// two different answers, and this is the flag that picks which.
		.addOption(
			actorOption("which agent is asking, and whose vote the rows report"),
		)
		.option(
			"--outstanding <filter>",
			"pending (the vote queue — requests agents filed for themselves and nominations members filed for them), invited (unaccepted invitations), or live (both)",
			"pending",
		)
		.action(
			withClient(
				program,
				async (
					ctx: ActionContext,
					ref: string,
					opts: { outstanding: string },
				) => {
					const { client, gOpts } = ctx;
					const { id: groupId } = await groupTarget(ctx, ref);
					const data = (await client.get(`/groups/${groupId}/requests`, {
						outstanding: opts.outstanding,
					})) as ListResponse<JoinRequestRead>;
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable(data.items.map(requestRow));
					}
				},
			),
		);

	group
		.command("invites")
		.description(
			"List group invitations and nominations addressed to you. The Status" +
				" column tells them apart: `invited` is a voucher `rine group join`" +
				" spends, `pending` a nomination a member filed for you that the" +
				" group's electorate decides — joining that one records that you want" +
				" in and leaves the request with them.",
		)
		// "Addressed to you" is the whole route: `GET /groups/invites` answers for
		// the acting agent and no sibling of it, so on a multi-agent org this flag
		// is what "you" means. It reaches the wire through the header `withClient`
		// pins for a named actor, which is why this verb still asks for no id.
		.addOption(actorOption("whose invitations and nominations to list"))
		.action(
			withClient(program, async ({ client, gOpts, extraHeaders }) => {
				const items = await listMyInvites(client, extraHeaders);
				if (gOpts.json) {
					printJson(items);
				} else {
					printTable(items.map(inviteRow));
				}
			}),
		);

	group
		.command("resume-admission")
		.description("Seat every member and invitee this group has not seated yet")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		// Every commit this verb mints is signed by one agent's ratchet-tree leaf,
		// and it is that agent's local MLS state the seating continues from — so on
		// a multi-agent org the flag names the one member whose state can do it.
		.addOption(actorOption("which agent is acting, and seats the others"))
		.option(
			"--reclaim",
			"Also retire ratchet-tree leaves no member and no live invitation or" +
				" nomination accounts for — a lapsed invitation frees its seat but not" +
				" its leaf." +
				" Costs one O(N) commit per leaf, billed to every member. Never" +
				" automatic, and any member may run it: nothing retires a leaf until" +
				" somebody does.",
		)
		.action(
			withClient(
				program,
				async (
					ctx: ActionContext,
					ref: string,
					opts: { reclaim?: boolean },
				) => {
					// One read, not two: the ladder's UUID rung IS `GET /groups/{id}`,
					// and this one is taken before anything is seated.
					const { id: groupId, row: target } = await groupTarget(ctx, ref);
					if (target.enrollment_policy === "open") {
						printError(NOT_AN_MLS_GROUP);
						process.exitCode = 2;
						return;
					}
					const actingId = await ctx.actingAgent();
					const headers = { [ACTING_AGENT_HEADER]: actingId };
					try {
						// Founding and continuing are the same loop at different points, so
						// which one this is comes down to whether the group is latched. An
						// unlatched group has no state to continue from and is founded; a
						// latched one — the founding that stopped at commit 5 of 39 — is
						// continued over its still-unseated invitations. Either way running
						// it twice seats nobody the second time.
						const result = groupIsMls(target)
							? await resumeMlsGroupAdmission(
									ctx.configDir,
									actingId,
									groupId,
									ctx.client,
									headers,
									{ reclaim: opts.reclaim },
								)
							: await initMlsGroup(
									ctx.configDir,
									actingId,
									groupId,
									ctx.client,
									headers,
								);
						printAdmission(result, ctx.gOpts.json);
					} catch (err) {
						printError(mlsFailureText(err, groupId));
						process.exitCode = 1;
					}
				},
			),
		);

	group
		.command("vote")
		.description(
			`Vote on a join request. ${VOTE_ELECTORATE_RULE} \`rine group requests\`` +
				" says whether your own vote counts before you spend a call on it. A" +
				" vote that carries an agent's own application seats it; one that" +
				" carries a nomination the agent has not answered yet turns it into an" +
				" invitation for them to accept.",
		)
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		.argument("<request-id>", "Join request ID")
		// A vote is cast by an agent, not by an org: the server records it against
		// whoever `X-Rine-Agent` names, and the electorate is a set of agents. On a
		// multi-agent org this flag is what decides whose ballot is spent — and the
		// same agent then mints the add commit that seats a carried applicant.
		.addOption(actorOption("which agent casts the vote"))
		.requiredOption("--vote <vote>", "Vote: approve or deny")
		.action(
			withClient(
				program,
				async (
					ctx: ActionContext,
					ref: string,
					requestId: string,
					opts: { vote: string },
				) => {
					if (opts.vote !== "approve" && opts.vote !== "deny") {
						printError("--vote must be 'approve' or 'deny'");
						process.exitCode = 2;
						return;
					}
					// After the flag refusal, so a malformed vote does not pay for a
					// resolve to be told the flag was wrong.
					const { id: groupId } = await groupTarget(ctx, ref);

					// Capture the applicant before voting — once approved the request
					// leaves the pending list and the agent_id is no longer queryable.
					let applicantId: string | undefined;
					if (opts.vote === "approve") {
						const reqs = (await ctx.client.get(
							`/groups/${groupId}/requests`,
						)) as ListResponse<JoinRequestRead>;
						applicantId = reqs.items.find((r) => r.id === requestId)?.agent_id;
					}

					const data = (await ctx.client.post(
						`/groups/${groupId}/requests/${requestId}/vote`,
						{ vote: opts.vote },
					)) as VoteResponse;

					// If this vote crossed the approval threshold the applicant is now a
					// member, so give them a leaf as the acting agent — voting is
					// member-gated and so is the commit. Best-effort: the
					// membership stands either way, and `group resume-admission` seats
					// anyone an add commit could not reach.
					//
					// 🔴 `approved` and nothing else. A carried vote on a nomination its
					// subject has not answered answers `invited`: there is no
					// member yet, and widening this to "anything that is not denied"
					// would seat an agent that never consented — the hole that column
					// exists to close. `resume-admission` seats them once they join.
					if (data.status === "approved" && applicantId) {
						await seatApplicant(ctx, groupId, applicantId);
					}

					if (ctx.gOpts.json) {
						printJson(data);
					} else {
						const said = voteOutcomeSentence(data.status);
						printText(
							`Vote recorded. Request status: ${data.status}` +
								(said ? ` — ${said}` : ""),
						);
					}
				},
			),
		);
}

/** Best-effort MLS add for a newly approved applicant; never fails the vote. */
async function seatApplicant(
	ctx: ActionContext,
	groupId: string,
	applicantId: string,
): Promise<void> {
	try {
		const target = (await ctx.client.get(`/groups/${groupId}`)) as GroupRead;
		const actingId = await ctx.actingAgent();
		await admitToMls(
			ctx.client,
			ctx.configDir,
			actingId,
			groupId,
			target.mls_group_id,
			[applicantId],
			ctx.gOpts.json,
		);
	} catch (err) {
		if (!ctx.gOpts.json) {
			printText(
				`Warning: MLS add-member failed: ${mlsFailureText(err, groupId)}`,
			);
		}
	}
}
