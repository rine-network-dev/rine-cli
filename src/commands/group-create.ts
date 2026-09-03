import {
	type GroupAdmissionReport,
	type GroupRead,
	type HttpClient,
	type MlsAdmissionResult,
	ACTING_AGENT_HEADER,
	VOTE_DURATION_RULE,
	admissionHeadline,
	initMlsGroup,
	resolveToUuid,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { announceHandleCompletion } from "../handle-completion.js";
import { printError, printJson, printTable, printText } from "../output.js";
import {
	DESCRIPTION_HELP,
	collect,
	dedupeIds,
	visibilityRefusal,
} from "./group-args.js";
import { warnMls } from "./group-mls.js";
import {
	type GroupCreateResponse,
	CLI_UNFOUNDED_REPAIR,
	admissionOutcomeRows,
	admissionRow,
	encryptionLine,
	groupDetailRow,
	groupEncryption,
} from "./group-rows.js";
import { type AgentHandles, ownAgentHandles } from "./own-agents.js";

const ROSTER_NOTE =
	"A founding roster invites; nobody is a member until they join. On a" +
	" closed, majority or unanimity group it mints real invitations \u2014 majority" +
	" and unanimity included, because you are the only member at this point, so" +
	" a vote would auto-approve every row \u2014 and each holds a seat until it is" +
	" accepted or expires. An open group mints nothing at all: anyone may join" +
	" it, so there is no invitation to authorise.";

interface CreateOpts {
	name: string;
	description?: string;
	enrollment?: string;
	visibility?: string;
	isolated?: boolean;
	voteDuration?: string;
	member: string[];
}

/** Read either create response: a bare group, or `{group, roster}` when a roster was named. */
function unwrapCreate(data: unknown): {
	group: GroupRead;
	roster: GroupAdmissionReport | null;
} {
	const body = data as Partial<GroupCreateResponse> & GroupRead;
	if (body.group && body.roster) {
		return { group: body.group, roster: body.roster };
	}
	return { group: body as GroupRead, roster: null };
}

/**
 * Found the new group's ratchet tree, seating its roster in size-aware batches.
 *
 * Open-enrollment groups are exempt: the server refuses MLS there, so an init
 * would only ever fail — they run on Sender Keys. Best-effort, and the group
 * stands either way; `group resume-admission` finishes an init that stopped
 * part-way.
 */
async function foundMlsState(
	ctx: ActionContext,
	group: GroupRead,
): Promise<MlsAdmissionResult | null> {
	if (group.enrollment_policy === "open") return null;
	try {
		const actingAgentId = await ctx.actingAgent();
		return await initMlsGroup(
			ctx.configDir,
			actingAgentId,
			group.id,
			ctx.client,
			{ [ACTING_AGENT_HEADER]: actingAgentId },
		);
	} catch (err) {
		warnMls(
			"MLS init failed (group still created)",
			err,
			group.id,
			ctx.gOpts.json,
		);
		return null;
	}
}

/** Re-read the group so the rendered row carries the MLS latch the init just set. */
async function refresh(
	client: HttpClient,
	group: GroupRead,
): Promise<GroupRead> {
	try {
		return (await client.get(`/groups/${group.id}`)) as GroupRead;
	} catch {
		// The group exists; only its post-init reading is missing. Report what the
		// create returned rather than failing a command that already succeeded.
		return group;
	}
}

function printCreated(
	group: GroupRead,
	roster: GroupAdmissionReport | null,
	admission: MlsAdmissionResult | null,
	json?: boolean,
	handles?: AgentHandles,
): void {
	// 🔴 The encryption answer is read off the create RESULT and never off the
	// row alone. `foundMlsState` runs after `POST /groups` has already answered,
	// so the row rendered here is the PRE-init one whenever the confirming
	// re-read was refused (`refresh` swallows that, deliberately — the group
	// exists) — and `groupEncryption` is row-only, correctly so, which made this
	// command tell an operator that the ratchet tree it had just founded was
	// never founded, and send them to `rine group resume-admission` for it.
	// Carrying the founding on the group is how `groupEncryption` is told
	// otherwise, and it is what the Python stack passes to its own twin.
	const created = admission ? { ...group, mlsAdmission: admission } : group;
	if (json) {
		// The wire row is spread, not `created`: the admission is already a
		// sibling key below, and the group object stays what the server sent.
		printJson({
			...group,
			encryption: groupEncryption(created, CLI_UNFOUNDED_REPAIR),
			...(roster ? { roster } : {}),
			...(admission ? { admission } : {}),
		});
		return;
	}
	printTable([groupDetailRow(created, handles)]);
	printText(`\nGroup created — handle: ${group.handle}`);
	printText(encryptionLine(created, CLI_UNFOUNDED_REPAIR));
	if (roster) {
		// The head is core's, derived from who was REACHED. Composed from
		// `invited`/`skipped` it read "0 invited, 2 skipped" on every open
		// group — the server answers `not_applicable` for each valid agent
		// there — directly above per-agent lines saying they may join whenever
		// they like.
		printText(`\nRoster: ${admissionHeadline(roster)} ${ROSTER_NOTE}`);
		printTable(roster.entries.map(admissionRow));
	}
	if (admission && admission.outcomes.length > 0) {
		printText(
			`\nSeated in the ratchet tree: ${admission.added} of ${admission.outcomes.length}` +
				` in ${admission.commits} commit(s), now at epoch ${admission.epoch}.`,
		);
		printTable(admissionOutcomeRows(admission));
	}
}

export function registerGroupCreate(program: Command, group: Command): void {
	group
		.command("create")
		.description("Create a new group")
		.requiredOption("--name <name>", "Group name (DNS-safe slug)")
		.option("--description <desc>", DESCRIPTION_HELP)
		.option(
			"--enrollment <policy>",
			"Enrollment policy (open|closed|majority|unanimity). `open` runs Sender Keys, which are NOT post-quantum",
		)
		.option(
			"--visibility <vis>",
			"Required. `public` lists the group at dir.rine.network and turns the join signal off; `private` does neither",
		)
		.option(
			"--member <id>",
			"Invite an agent into the new group (repeatable). A roster invites — it never seats — and it invites under every enrollment policy, because you are the only member at founding and a vote would auto-approve each row",
			collect,
			[],
		)
		.option("--isolated", "Isolate group communication")
		.option("--vote-duration <hours>", VOTE_DURATION_RULE)
		// 🔴 Not decoration, and the worst verb to leave without it: `foundMlsState`
		// founds the ratchet tree AS the acting agent, so on a multi-agent org that
		// names nobody the org's shortcut picks the leaf holder — and the only
		// remedy for the wrong one is orphan reclamation, which is never automatic.
		// `withClient` pins `X-Rine-Agent` for any actor the ladder names, so the
		// flag reaches the wire on `POST /groups` as well as the init.
		.addOption(actorOption("which agent is acting, and founds the group"))
		.action(
			withClient(program, async (ctx: ActionContext, opts: CreateOpts) => {
				const refusal = visibilityRefusal(opts.visibility);
				if (refusal) {
					printError(refusal);
					process.exitCode = 2;
					return;
				}

				const body: Record<string, unknown> = {
					name: opts.name,
					visibility: opts.visibility,
				};
				if (opts.description !== undefined) body.description = opts.description;
				if (opts.enrollment) body.enrollment_policy = opts.enrollment;
				if (opts.isolated) body.isolated = true;
				if (opts.voteDuration)
					body.vote_duration_hours = Number(opts.voteDuration);
				if (opts.member.length > 0) {
					body.members = dedupeIds(
						await Promise.all(
							// Item 18: announced per member and in the order they were
							// typed, before any resolution races. A founding roster is
							// exactly where a silent completion seats the wrong agent.
							opts.member.map((m) => {
								announceHandleCompletion(m);
								return resolveToUuid(ctx.apiUrl, m);
							}),
						),
					);
				}

				const { group: created, roster } = unwrapCreate(
					await ctx.client.post("/groups", body),
				);
				const admission = await foundMlsState(ctx, created);
				const latched = admission
					? await refresh(ctx.client, created)
					: created;
				// `--json` prints the wire, which stays UUIDs, so it buys no
				// agent list; the table prints handles and does.
				const handles = ctx.gOpts.json
					? undefined
					: await ownAgentHandles(ctx.agents);
				printCreated(latched, roster, admission, ctx.gOpts.json, handles);
			}),
		);
}
