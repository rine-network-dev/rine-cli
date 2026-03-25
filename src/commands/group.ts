import type { Command } from "commander";
import { withClient } from "../action.js";
import type {
	GroupMemberRead,
	GroupRead,
	JoinRequestRead,
	ListResponse,
	VoteResponse,
} from "../api-types.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
	printText,
} from "../output.js";
import { promptConfirm } from "../prompt.js";
import { resolveAgent } from "../resolve-agent.js";

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
					{ client, gOpts },
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
					{ client, gOpts },
					groupId: string,
					opts: { message?: string },
				) => {
					const body: Record<string, unknown> = {};
					if (opts.message) body.message = opts.message;

					const data = (await client.post(`/groups/${groupId}/join`, body)) as
						| GroupMemberRead
						| JoinRequestRead;
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
					{ client, gOpts },
					groupId: string,
					opts: { agent?: string },
				) => {
					const agentId = await resolveAgent(client, opts.agent, gOpts.as);
					await client.delete(`/groups/${groupId}/members/${agentId}`);
					printMutationOk("Left group", gOpts.json);
				},
			),
		);

	group
		.command("kick")
		.description("Remove a member from the group (admin)")
		.argument("<group-id>", "Group ID")
		.argument("<agent-id>", "Agent ID to remove")
		.action(
			withClient(
				program,
				async ({ client, gOpts }, groupId: string, agentId: string) => {
					await client.delete(`/groups/${groupId}/members/${agentId}`);
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
					{ client, gOpts },
					groupId: string,
					opts: { agent: string; message?: string },
				) => {
					const body: Record<string, unknown> = { agent_id: opts.agent };
					if (opts.message) body.message = opts.message;

					const data = (await client.post(
						`/groups/${groupId}/invite`,
						body,
					)) as JoinRequestRead;
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
		.command("vote")
		.description("Vote on a join request")
		.argument("<group-id>", "Group ID")
		.argument("<request-id>", "Join request ID")
		.requiredOption("--vote <vote>", "Vote: approve or deny")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					groupId: string,
					requestId: string,
					opts: { vote: string },
				) => {
					if (opts.vote !== "approve" && opts.vote !== "deny") {
						printError("--vote must be 'approve' or 'deny'");
						process.exitCode = 2;
						return;
					}
					const data = (await client.post(
						`/groups/${groupId}/requests/${requestId}/vote`,
						{
							vote: opts.vote,
						},
					)) as VoteResponse;
					if (gOpts.json) {
						printJson(data);
					} else {
						printText(`Vote recorded. Request status: ${data.status}`);
					}
				},
			),
		);
}
