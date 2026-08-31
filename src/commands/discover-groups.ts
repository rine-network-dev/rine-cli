import type { Command } from "commander";
import { withErrorHandler } from "../action.js";
import { HttpClient, UUID_RE, resolveApiUrl } from "@rine-network/core";
import { printError, printJson, printTable } from "../output.js";
import {
	DIRECTORY_GROUP_ID_HELP,
	directoryGroupUuidRefusal,
} from "./group-target.js";

export function registerDiscoverGroups(
	discover: Command,
	program: Command,
): void {
	const groupsCmd = discover
		.command("groups")
		.description("List public groups in the directory")
		.option("-q, --query <query>", "Search query")
		.option("--limit <n>", "Max results")
		.option("--cursor <cursor>", "Pagination cursor")
		.action(
			withErrorHandler(
				program,
				async (
					gOpts,
					opts: { query?: string; limit?: string; cursor?: string },
				) => {
					const apiUrl = resolveApiUrl();
					const params = new URLSearchParams();
					if (opts.query) params.append("q", opts.query);
					if (opts.limit) params.append("limit", opts.limit);
					if (opts.cursor) params.append("cursor", opts.cursor);

					const data = await HttpClient.publicGet(
						apiUrl,
						"/directory/groups",
						params.toString() ? params : undefined,
					);
					if (gOpts.json) {
						printJson(data);
						return;
					}
					const result = data as {
						items?: Record<string, unknown>[];
						total?: number;
					};
					printTable(
						(result.items ?? []).map((g) => ({
							Name: g.name,
							Handle: g.handle,
							Description: g.description ?? "",
							Enrollment: g.enrollment_policy,
							Members: g.member_count,
						})),
					);
				},
			),
		);

	groupsCmd
		.command("inspect")
		.description("Inspect a public group")
		.argument("<group-id>", DIRECTORY_GROUP_ID_HELP)
		.action(
			withErrorHandler(program, async (gOpts, groupId: string) => {
				// 🔴 The one group argument the handle-and-name widening does NOT reach.
				// This verb reads the PUBLIC directory, not the caller's own group
				// list, so the member ladder has nothing to match a handle or a name
				// against: `/directory/groups/{name}` used to come back 200 with a
				// table of empty cells, which is worse than a refusal because it looks
				// like an answer. The shape is refused before any request, the same way
				// `rine discover inspect` refuses an unresolvable agent.
				if (!UUID_RE.test(groupId)) {
					printError(directoryGroupUuidRefusal(groupId));
					process.exitCode = 1;
					return;
				}
				const apiUrl = resolveApiUrl();
				const data = (await HttpClient.publicGet(
					apiUrl,
					`/directory/groups/${groupId}`,
				)) as Record<string, unknown>;
				if (gOpts.json) {
					printJson(data);
					return;
				}
				printTable([
					{
						ID: data.id,
						Name: data.name,
						Handle: data.handle,
						Description: data.description ?? "",
						"Org ID": data.org_id,
						Enrollment: data.enrollment_policy,
						Members: data.member_count,
						Created: data.created_at,
					},
				]);
			}),
		);
}
