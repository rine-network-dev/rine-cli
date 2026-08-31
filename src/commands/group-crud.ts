import {
	ACTING_AGENT_HEADER,
	type GroupRead,
	type ListResponse,
	VOTE_DURATION_RULE,
	groupIsMls,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { actorOption } from "../actor.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
	printText,
} from "../output.js";
import { promptConfirm } from "../prompt.js";
import { DESCRIPTION_HELP } from "./group-args.js";
import { evictedMessage, isEvictedFrom } from "./group-eviction.js";
import {
	CLI_UNFOUNDED_REPAIR,
	encryptionLine,
	groupDetailRow,
	groupEncryption,
	groupRow,
} from "./group-rows.js";
import { GROUP_REFERENCE_HELP, groupTarget } from "./group-target.js";
import { ownAgentHandles } from "./own-agents.js";

/**
 * Whether a Remove commit has already evicted the acting agent from this group.
 *
 * Reading a group is where an evicted agent finds out, so the ratchet tree is
 * consulted here rather than left to surface as an mls-rs invariant from the
 * next send. Local and best-effort: the answer lives on disk, and a
 * group whose state this agent never held simply has no answer.
 *
 * This is the half that runs when the group *was* readable — an evicted member
 * still inside the owning org. The cross-org case never gets here at all: the
 * server refuses the read, so it is answered on the refusal instead
 * ({@link readGroup}).
 */
async function evictionState(
	ctx: ActionContext,
	group: GroupRead,
): Promise<boolean | null> {
	if (!groupIsMls(group)) return null;
	try {
		return isEvictedFrom(ctx.configDir, await ctx.actingAgent(), group.id);
	} catch {
		return null;
	}
}

export function registerGroupCrud(program: Command, group: Command): void {
	group
		.command("list")
		.description("List groups")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const data = (await client.get("/groups")) as ListResponse<GroupRead>;
				if (gOpts.json) {
					printJson(data);
				} else {
					printTable(data.items.map(groupRow));
				}
			}),
		);

	group
		.command("get")
		.description("Get group details")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		.action(
			withClient(program, async (ctx: ActionContext, ref: string) => {
				// The row the ladder already paid for: its UUID rung IS this read,
				// and its name rungs matched against the roster that carries it.
				const { row: data } = await groupTarget(ctx, ref);
				const evicted = await evictionState(ctx, data);
				if (ctx.gOpts.json) {
					printJson({
						...data,
						encryption: groupEncryption(data, CLI_UNFOUNDED_REPAIR),
						...(evicted === null ? {} : { evicted }),
					});
					return;
				}
				// One `GET /agents` so the seated ids print as handles, and
				// only when there is a seat to spell. `rine group get` names no
				// actor, so nothing has paid for the agent list yet — that cost was
				// accepted deliberately, but on a group this org holds no seat in
				// the row prints `NO_OWN_AGENTS` whatever the map says, so buying
				// one would answer nothing. Same gate the Python side takes in
				// `rine._agent_handles._seats_to_spell`. A list that fails to load
				// prints the UUIDs rather than failing a read that succeeded.
				const handles = data.member_agent_ids?.length
					? await ownAgentHandles(ctx.agents)
					: undefined;
				printTable([groupDetailRow(data, handles)]);
				printText(encryptionLine(data, CLI_UNFOUNDED_REPAIR));
				if (evicted) printText(`\n${evictedMessage(data.id)}`);
			}),
		);

	group
		.command("update")
		.description("Update group settings")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		.addOption(actorOption())
		.option("--description <desc>", DESCRIPTION_HELP)
		.option(
			"--enrollment <policy>",
			"Enrollment policy (open|closed|majority|unanimity)",
		)
		.option(
			"--visibility <vis>",
			"`public` lists the group at dir.rine.network and turns the join signal off; `private` does neither",
		)
		.option("--vote-duration <hours>", VOTE_DURATION_RULE)
		.action(
			withClient(
				program,
				async (
					ctx: ActionContext,
					ref: string,
					opts: {
						description?: string;
						enrollment?: string;
						visibility?: string;
						voteDuration?: string;
					},
				) => {
					const { client, gOpts, actingAgent, agents } = ctx;
					const body: Record<string, unknown> = {};
					if (opts.description !== undefined)
						body.description = opts.description;
					if (opts.enrollment) body.enrollment_policy = opts.enrollment;
					if (opts.visibility) body.visibility = opts.visibility;
					if (opts.voteDuration)
						body.vote_duration_hours = Number(opts.voteDuration);
					if (Object.keys(body).length === 0) {
						printError(
							"At least one of --description, --enrollment, --visibility, --vote-duration is required",
						);
						process.exitCode = 2;
						return;
					}
					// After the empty-body refusal, so a call that was never going to
					// change anything does not pay for a resolve to be told so.
					const { id: groupId } = await groupTarget(ctx, ref);
					// The server resolves who is editing before it decides whether they
					// may, so a multi-agent org has to say. Awaiting the ladder
					// here is what makes it say: an actor nobody named stays lazy in
					// `withClient`, so without this await the request would carry no
					// actor at all. Passing the header explicitly is belt-and-braces —
					// `actingAgent()` also writes it into the client's default headers
					// — and matches `group-mls.ts`, `group-create.ts` and `messages.ts`.
					const data = (await client.patch(`/groups/${groupId}`, body, {
						[ACTING_AGENT_HEADER]: await actingAgent(),
					})) as GroupRead;
					if (gOpts.json) {
						printJson({
							...data,
							encryption: groupEncryption(data, CLI_UNFOUNDED_REPAIR),
						});
					} else {
						// The ladder above has already fetched the agent list to resolve
						// the actor, and `ctx.agents()` memoises it — so the handles this
						// cell prints cost no second round trip here.
						printTable([groupDetailRow(data, await ownAgentHandles(agents))]);
						printText("Group updated");
						printText(encryptionLine(data, CLI_UNFOUNDED_REPAIR));
					}
				},
			),
		);

	group
		.command("delete")
		.description("Delete a group")
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		.addOption(actorOption())
		.option("--yes", "Skip confirmation prompt")
		.action(
			withClient(
				program,
				async (
					ctx: ActionContext,
					ref: string,
					opts: { yes?: boolean },
				) => {
					const { client, gOpts, actingAgent } = ctx;
					// Before the prompt: an org that has not said who is deleting is
					// refused without first being asked to confirm a deletion that was
					// never going to happen.
					const headers = { [ACTING_AGENT_HEADER]: await actingAgent() };
					// And before it too: a prompt naming the caller's own spelling asks
					// them to confirm the thing they typed rather than the group it
					// resolved to, which is the one irreversible verb here.
					const target = await groupTarget(ctx, ref);
					const groupId = target.id;
					if (!opts.yes && !gOpts.json) {
						const confirmed = await promptConfirm(
							`Delete group ${target.handle ?? target.id}?`,
						);
						if (!confirmed) return;
					}
					await client.delete(`/groups/${groupId}`, headers);
					printMutationOk("Group deleted", gOpts.json);
				},
			),
		);
}
