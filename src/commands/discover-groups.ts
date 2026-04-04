import type { Command } from "commander";
import { withErrorHandler } from "../action.js";
import { HttpClient, resolveApiUrl } from "@rine-network/core";
import { printJson, printTable } from "../output.js";

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
		.argument("<group-id>", "Group ID")
		.action(
			withErrorHandler(program, async (gOpts, groupId: string) => {
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
