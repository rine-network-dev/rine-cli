import {
	type GroupMemberRead,
	type GroupRead,
	type HttpClient,
	type JoinRequestRead,
	type ListResponse,
	type VoteResponse,
	addMlsGroupMember,
	externalJoinMlsGroup,
	fetchAgents,
	initMlsGroup,
	listMyInvites,
	loadMlsState,
	processMlsWelcomes,
	resolveAgent,
	resolveToUuid,
	sendGroupInviteNotification,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
	printText,
} from "../output.js";
import { promptConfirm } from "../prompt.js";

// Best-effort: fetch & install pending MLS Welcomes for a freshly-added member.
async function installWelcomes(
	client: HttpClient,
	configDir: string,
	agentId: string,
	json?: boolean,
): Promise<void> {
	try {
		await processMlsWelcomes(configDir, agentId, client);
	} catch (err) {
		if (!json) {
			printText(
				`Warning: MLS welcome install failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

// Best-effort open-enrollment fallback (Phase 6): when the joiner became a rine
// member with no Welcome (the `open` enrollment case — no admin in the loop), and
// the group is MLS-active, self-join via an RFC 9420 external commit so the joiner
// becomes a real MLS member able to send/receive. No-op if a Welcome already
// installed local MLS state, or for non-MLS (sender-key) groups.
async function selfJoinViaExternalCommit(
	client: HttpClient,
	configDir: string,
	groupId: string,
	agentId: string,
	json?: boolean,
): Promise<void> {
	try {
		const group = (await client.get(`/groups/${groupId}`)) as GroupRead;
		if (!group.mls_group_id) return;
		// A Welcome may have just installed state — only self-join if none exists.
		if (loadMlsState(configDir, agentId, groupId)) return;
		await externalJoinMlsGroup(configDir, agentId, groupId, client, {
			"X-Rine-Agent": agentId,
		});
	} catch (err) {
		if (!json) {
			printText(
				`Warning: MLS self-join failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

// Best-effort: if the group is MLS-active, add a member (claim KP, commit,
// deliver Welcome) as the acting admin. No-op for sender-key groups.
async function addMemberToMls(
	client: HttpClient,
	configDir: string,
	apiUrl: string,
	groupId: string,
	memberAgentId: string,
	as?: string,
	json?: boolean,
): Promise<void> {
	try {
		const group = (await client.get(`/groups/${groupId}`)) as GroupRead;
		if (!group.mls_group_id) return;
		const agents = await fetchAgents(client);
		const adminId = await resolveAgent(apiUrl, agents, undefined, as);
		await addMlsGroupMember(
			configDir,
			adminId,
			groupId,
			memberAgentId,
			client,
			{
				"X-Rine-Agent": adminId,
			},
		);
	} catch (err) {
		if (!json) {
			printText(
				`Warning: MLS add-member failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

// Best-effort: seal a rine.v1.group_invite DM to the invitee so their normal
// inbox alerts them. The authoritative discovery path is `GET /groups/invites`
// (the `group invites` command), so a failure here (e.g. groups_only 403,
// missing keys) warns but never fails the invite. Mirrors addMemberToMls.
async function sendInviteNotification(
	client: HttpClient,
	configDir: string,
	apiUrl: string,
	groupId: string,
	inviteeAgentId: string,
	message?: string,
	as?: string,
	json?: boolean,
): Promise<void> {
	try {
		const group = (await client.get(`/groups/${groupId}`)) as GroupRead;
		const agents = await fetchAgents(client);
		const inviterId = await resolveAgent(apiUrl, agents, undefined, as);
		await sendGroupInviteNotification(
			client,
			configDir,
			inviterId,
			inviteeAgentId,
			{
				group_id: groupId,
				group_handle: group.handle,
				message: message ?? null,
			},
		);
	} catch (err) {
		if (!json) {
			printText(
				`Warning: invite notification failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

function groupRow(g: GroupRead): Record<string, unknown> {
	return {
		ID: g.id,
		Name: g.name,
		Handle: g.handle,
		Enrollment: g.enrollment_policy,
		Visibility: g.visibility,
		Members: g.member_count,
		Created: g.created_at,
	};
}

function groupDetailRow(g: GroupRead): Record<string, unknown> {
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
		Created: g.created_at,
	};
}

function memberRow(m: GroupMemberRead): Record<string, unknown> {
	return {
		"Agent ID": m.agent_id,
		Handle: m.agent_handle ?? "",
		Role: m.role,
		Joined: m.joined_at,
	};
}

function requestRow(r: JoinRequestRead): Record<string, unknown> {
	return {
		"Request ID": r.id,
		"Agent ID": r.agent_id,
		Message: r.message ?? "",
		"Your Vote": r.your_vote ?? "",
		Expires: r.expires_at ?? "",
		Created: r.created_at,
	};
}

// The invitee's perspective: who invited you, to which group. Distinct from
// requestRow, whose `Your Vote`/`Agent ID` columns are voter-scoped.
function inviteRow(r: JoinRequestRead): Record<string, unknown> {
	return {
		Group: r.group_handle ?? r.group_name ?? "",
		"Group ID": r.group_id,
		"Invited By": r.invited_by ?? "",
		Message: r.message ?? "",
		Created: r.created_at,
	};
}

export function registerGroup(program: Command): void {
	const group = program.command("group").description("Group management");

	group
		.command("create")
		.description("Create a new group")
		.requiredOption("--name <name>", "Group name (DNS-safe slug)")
		.option(
			"--enrollment <policy>",
			"Enrollment policy (open|closed|majority|unanimity)",
		)
		.option("--visibility <vis>", "Visibility (public|private)")
		.option("--isolated", "Isolate group communication")
		.option("--vote-duration <hours>", "Vote duration in hours (1-72)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, apiUrl },
					opts: {
						name: string;
						enrollment?: string;
						visibility?: string;
						isolated?: boolean;
						voteDuration?: string;
					},
				) => {
					const body: Record<string, unknown> = { name: opts.name };
					if (opts.enrollment) body.enrollment_policy = opts.enrollment;
					if (opts.visibility) {
						body.visibility = opts.visibility;
					} else {
						// Smart default: open enrollment → public, otherwise private
						const isOpen = opts.enrollment === "open";
						body.visibility = isOpen ? "public" : "private";
						if (!gOpts.json) {
							printText(
								`Visibility defaulted to "${body.visibility as string}" (enrollment: ${opts.enrollment ?? "closed"})`,
							);
						}
					}
					if (opts.isolated) body.isolated = true;
					if (opts.voteDuration)
						body.vote_duration_hours = Number(opts.voteDuration);

					const data = (await client.post("/groups", body)) as GroupRead;

					// Best-effort: latch MLS for the new group (creator-only init).
					// New groups default to mls_enabled=true server-side. Open-
					// enrollment groups are exempt: the server refuses MLS there
					// (403 mls_open_enrollment_disabled — SECURITY.md, H4/S3), so an
					// init attempt would only ever fail; they run over Sender Keys.
					if (data.enrollment_policy !== "open") {
						try {
							const agents = await fetchAgents(client);
							const actingAgentId = await resolveAgent(
								apiUrl,
								agents,
								undefined,
								gOpts.as,
							);
							await initMlsGroup(configDir, actingAgentId, data.id, client, {
								"X-Rine-Agent": actingAgentId,
							});
						} catch (err) {
							if (!gOpts.json) {
								printText(
									`Warning: MLS init failed (group still created): ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						}
					}

					if (gOpts.json) {
						printJson(data);
					} else {
						printTable([groupDetailRow(data)]);
						printText(`\nGroup created — handle: ${data.handle}`);
					}
				},
			),
		);

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
		.argument("<group-id>", "Group ID")
		.action(
			withClient(program, async ({ client, gOpts }, groupId: string) => {
				const data = (await client.get(`/groups/${groupId}`)) as GroupRead;
				if (gOpts.json) {
					printJson(data);
				} else {
					printTable([groupDetailRow(data)]);
				}
			}),
		);

	group
		.command("update")
		.description("Update group settings")
		.argument("<group-id>", "Group ID")
		.option("--description <desc>", "Group description")
		.option(
			"--enrollment <policy>",
			"Enrollment policy (open|closed|majority|unanimity)",
		)
		.option("--visibility <vis>", "Visibility (public|private)")
		.option("--vote-duration <hours>", "Vote duration in hours (1-72)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					groupId: string,
					opts: {
						description?: string;
						enrollment?: string;
						visibility?: string;
						voteDuration?: string;
					},
				) => {
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
					const data = (await client.patch(
						`/groups/${groupId}`,
						body,
					)) as GroupRead;
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable([groupDetailRow(data)]);
						printText("Group updated");
					}
				},
			),
		);

	group
		.command("delete")
		.description("Delete a group")
		.argument("<group-id>", "Group ID")
		.option("--yes", "Skip confirmation prompt")
		.action(
			withClient(
				program,
				async ({ client, gOpts }, groupId: string, opts: { yes?: boolean }) => {
					if (!opts.yes && !gOpts.json) {
						const confirmed = await promptConfirm(`Delete group ${groupId}?`);
						if (!confirmed) return;
					}
					await client.delete(`/groups/${groupId}`);
					printMutationOk("Group deleted", gOpts.json);
				},
			),
		);

	group
		.command("members")
		.description("List group members")
		.argument("<group-id>", "Group ID")
		.action(
			withClient(program, async ({ client, gOpts }, groupId: string) => {
				const data = (await client.get(
					`/groups/${groupId}/members`,
				)) as ListResponse<GroupMemberRead>;
				if (gOpts.json) {
					printJson(data);
				} else {
					printTable(data.items.map(memberRow));
				}
			}),
		);

	group
		.command("join")
		.description("Join a group")
		.argument("<group-id>", "Group ID")
		.option("--message <msg>", "Join request message")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir },
					groupId: string,
					opts: { message?: string },
				) => {
					const body: Record<string, unknown> = {};
					if (opts.message) body.message = opts.message;

					const data = (await client.post(`/groups/${groupId}/join`, body)) as
						| GroupMemberRead
						| JoinRequestRead;
					if ("role" in data) {
						// Immediate membership: install any pending MLS Welcome so the
						// joiner can decrypt/send. Best-effort (non-fatal on failure).
						await installWelcomes(client, configDir, data.agent_id, gOpts.json);
						// Open-enrollment fallback: if the group is MLS-active but no
						// Welcome arrived (no admin minted one), self-join via an external
						// commit. Best-effort, runs only when no local state exists.
						await selfJoinViaExternalCommit(
							client,
							configDir,
							groupId,
							data.agent_id,
							gOpts.json,
						);
					}
					if (gOpts.json) {
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
		.argument("<group-id>", "Group ID")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, apiUrl },
					groupId: string,
					opts: { agent?: string },
				) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);
					await client.delete(`/groups/${groupId}/members/${agentId}`);
					printMutationOk("Left group", gOpts.json);
				},
			),
		);

	group
		.command("kick")
		.description("Remove a member from the group (admin)")
		.argument("<group-id>", "Group ID")
		.argument("<agent-id>", "Agent ID or handle to remove")
		.action(
			withClient(
				program,
				async ({ client, gOpts, apiUrl }, groupId: string, agentId: string) => {
					const resolved = await resolveToUuid(apiUrl, agentId);
					await client.delete(`/groups/${groupId}/members/${resolved}`);
					printMutationOk("Member removed", gOpts.json);
				},
			),
		);

	group
		.command("invite")
		.description("Invite an agent to the group")
		.argument("<group-id>", "Group ID")
		.requiredOption("--agent <id>", "Agent ID to invite")
		.option("--message <msg>", "Invitation message")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, apiUrl },
					groupId: string,
					opts: { agent: string; message?: string },
				) => {
					const agentId = await resolveToUuid(apiUrl, opts.agent);
					const body: Record<string, unknown> = { agent_id: agentId };
					if (opts.message) body.message = opts.message;

					const data = (await client.post(
						`/groups/${groupId}/invite`,
						body,
					)) as JoinRequestRead;

					// For MLS-active groups, add the invitee now (claims their KP and
					// delivers a Welcome) so it's waiting when they accept the invite via
					// `join`. Best-effort, acting as the inviting admin.
					await addMemberToMls(
						client,
						configDir,
						apiUrl,
						groupId,
						agentId,
						gOpts.as,
						gOpts.json,
					);

					// Nudge the invitee's inbox with a sealed rine.v1.group_invite DM so
					// they discover the invite. Authoritative path is `group invites`;
					// this is best-effort (warn-only, never fatal).
					await sendInviteNotification(
						client,
						configDir,
						apiUrl,
						groupId,
						agentId,
						opts.message,
						gOpts.as,
						gOpts.json,
					);

					if (gOpts.json) {
						printJson(data);
					} else {
						printText("Invitation sent");
						if (data.id) {
							printTable([requestRow(data)]);
						}
					}
				},
			),
		);

	group
		.command("requests")
		.description("List pending join requests")
		.argument("<group-id>", "Group ID")
		.action(
			withClient(program, async ({ client, gOpts }, groupId: string) => {
				const data = (await client.get(
					`/groups/${groupId}/requests`,
				)) as ListResponse<JoinRequestRead>;
				if (gOpts.json) {
					printJson(data);
				} else {
					printTable(data.items.map(requestRow));
				}
			}),
		);

	group
		.command("invites")
		.description("List group invitations addressed to you")
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
		.command("vote")
		.description("Vote on a join request")
		.argument("<group-id>", "Group ID")
		.argument("<request-id>", "Join request ID")
		.requiredOption("--vote <vote>", "Vote: approve or deny")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, apiUrl },
					groupId: string,
					requestId: string,
					opts: { vote: string },
				) => {
					if (opts.vote !== "approve" && opts.vote !== "deny") {
						printError("--vote must be 'approve' or 'deny'");
						process.exitCode = 2;
						return;
					}

					// Capture the applicant before voting — once approved the request
					// leaves the pending list and the agent_id is no longer queryable.
					let applicantId: string | undefined;
					if (opts.vote === "approve") {
						const reqs = (await client.get(
							`/groups/${groupId}/requests`,
						)) as ListResponse<JoinRequestRead>;
						applicantId = reqs.items.find((r) => r.id === requestId)?.agent_id;
					}

					const data = (await client.post(
						`/groups/${groupId}/requests/${requestId}/vote`,
						{
							vote: opts.vote,
						},
					)) as VoteResponse;

					// If this vote crossed the approval threshold, the applicant is now
					// a member — add them to the MLS group as the acting admin so their
					// Welcome is delivered. Best-effort (non-fatal on failure).
					if (data.status === "approved" && applicantId) {
						await addMemberToMls(
							client,
							configDir,
							apiUrl,
							groupId,
							applicantId,
							gOpts.as,
							gOpts.json,
						);
					}

					if (gOpts.json) {
						printJson(data);
					} else {
						printText(`Vote recorded. Request status: ${data.status}`);
					}
				},
			),
		);
}
