import {
	type GroupMemberRead,
	type JoinRequestRead,
	type MlsMembershipResult,
	ACTING_AGENT_HEADER,
	MlsEstablishStep,
	establishMlsMembership,
	reportFailedSetup,
	seatedMemberAfterConflict,
} from "@rine-network/core";
import type { ActionContext } from "../action.js";
import { warnMls } from "./group-mls-failure.js";

/**
 * Give a joined agent the local MLS state its membership implies, warning about
 * every step that fails.
 *
 * 🔴 With one exception: a refusal for **this** group is raised, so
 * `rine group join` reports it and exits non-zero instead of printing a warning
 * under a success line. The Python SDK's `groups.join()` raises it too: the same
 * failure must not be loud on one stack and a log line on the other. The rine
 * membership stands either way; what the operator has to act on is the
 * refusal's own text.
 *
 * Two kinds of verdict use `MlsWelcomeRefusedError`. Most reasons are the
 * substitution guard's verdict about who minted a Welcome; retrying the join
 * does not change them. Reason `peer_not_admitted` is different: the group's
 * tree holds a member the server no longer vouches for. The Welcome install, the
 * external join and the seat retake all raise it, and it clears once any member
 * reclaims that seat with `rine group resume-admission --reclaim`; then repeat
 * the join.
 *
 * The ladder itself (Welcome, seat retake, external commit) is rine-core's
 * {@link establishMlsMembership}, shared by every TypeScript surface.
 */
async function establishJoinedMls(
	ctx: ActionContext,
	groupId: string,
	agentId: string,
): Promise<void> {
	const result = await establishMlsMembership(
		ctx.configDir,
		agentId,
		groupId,
		ctx.client,
		{ [ACTING_AGENT_HEADER]: agentId },
	);
	reportFailedSetup(result, warnFailedSetup(ctx, groupId));
}

const STEP_LABEL: Record<MlsEstablishStep, string> = {
	[MlsEstablishStep.GroupRead]: "MLS group read failed",
	[MlsEstablishStep.WelcomeInstall]: "MLS welcome install failed",
	[MlsEstablishStep.SeatRetake]: "MLS seat retake failed",
	[MlsEstablishStep.ExternalJoin]: "MLS self-join failed",
};

/** Warn about the step a failed establishment stopped at. */
function warnFailedSetup(ctx: ActionContext, groupId: string) {
	return ({ failure }: MlsMembershipResult): void => {
		if (!failure) return;
		warnMls(STEP_LABEL[failure.step], failure.error, groupId, ctx.gOpts.json);
	};
}

/**
 * `POST /groups/{id}/join`, then the local MLS state an immediate membership
 * needs. A 202 (a request pending approval) is returned untouched.
 */
export async function joinAndEstablish(
	ctx: ActionContext,
	groupId: string,
	body: Record<string, unknown>,
): Promise<GroupMemberRead | JoinRequestRead> {
	let data: GroupMemberRead | JoinRequestRead;
	try {
		data = (await ctx.client.post(`/groups/${groupId}/join`, body)) as
			| GroupMemberRead
			| JoinRequestRead;
	} catch (err) {
		// An agent already seated with no local state is brought back; any
		// other failure, or a seat the setup cannot finish, stands as raised.
		const seated = await seatedMemberAfterConflict(
			err,
			{
				configDir: ctx.configDir,
				groupId,
				client: ctx.client,
				actingAgent: ctx.actingAgent,
			},
			warnFailedSetup(ctx, groupId),
		);
		if (seated) return seated;
		throw err;
	}
	if ("role" in data) await establishJoinedMls(ctx, groupId, data.agent_id);
	return data;
}
