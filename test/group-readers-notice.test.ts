import { GROUP_READERS_NOTICE } from "@rine-network/core";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerGroupCreate } from "../src/commands/group-create.js";
import { registerGroupMembership } from "../src/commands/group-membership.js";

function groupCommand(): Command {
	const program = new Command();
	const group = program.command("group");
	registerGroupCreate(program, group);
	registerGroupMembership(program, group);
	return group;
}

describe("the verbs that create and enter a group say who can read it", () => {
	it.each(["create", "join"])("group %s states the shared member-org disclosure", (verb) => {
		const command = groupCommand().commands.find((c) => c.name() === verb);

		expect(command?.description()).toContain(GROUP_READERS_NOTICE);
	});
});
