import type { Command } from "commander";
import { registerGroupCreate } from "./group-create.js";
import { registerGroupCrud } from "./group-crud.js";
import { registerGroupInvite } from "./group-invite.js";
import { registerGroupMembership } from "./group-membership.js";
import { registerGroupRequests } from "./group-requests.js";
import { registerGroupSync } from "./group-sync.js";

/**
 * `rine group` — the group lifecycle, in six files.
 *
 * Split by what a subcommand is about rather than left as one listing: create
 * carries the visibility refusal and the roster, membership carries the
 * removal path and what leaving retires, invite carries plural admission,
 * requests carries the vote and the resume verb, and sync carries the recovery
 * ladder. Each registrar takes the root `program` because `withClient` reads
 * the global options off it.
 */
export function registerGroup(program: Command): void {
	const group = program.command("group").description("Group management");

	registerGroupCreate(program, group);
	registerGroupCrud(program, group);
	registerGroupMembership(program, group);
	registerGroupInvite(program, group);
	registerGroupRequests(program, group);
	registerGroupSync(program, group);
}
