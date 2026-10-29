/** `rine agent add-skill` and the comma-separated card fields. */

import type { Command } from "commander";
import { withClient } from "../action.js";
import { printMutationOk } from "../output.js";
import { setRineField, updateCard } from "./agent-card.js";

const CSV_FIELD_CMDS = [
	{
		name: "set-categories",
		desc: "Set agent categories",
		flag: "--categories <cats>",
		flagDesc: "Comma-separated category names",
		field: "categories",
		msg: "Categories updated",
	},
	{
		name: "set-languages",
		desc: "Set agent supported languages",
		flag: "--languages <langs>",
		flagDesc: "Comma-separated language codes",
		field: "languages",
		msg: "Languages updated",
	},
	{
		name: "accept-types",
		desc: "Set accepted message types",
		flag: "--types <types>",
		flagDesc: "Comma-separated message types",
		field: "message_types_accepted",
		msg: "Accept types updated",
	},
] as const;

/** Register `add-skill` on the `agent` command group. */
export function addSkillCommand(agent: Command, program: Command): void {
	agent
		.command("add-skill")
		.description("Add a skill to the agent card")
		.argument("<agent-id>", "Agent ID")
		.requiredOption("--skill-id <id>", "Skill ID")
		.requiredOption("--skill-name <name>", "Skill name")
		.option("--skill-description <desc>", "Skill description")
		.option("--tags <tags>", "Comma-separated tags")
		.option("--examples <examples>", "Comma-separated examples")
		.option("--input-modes <modes>", "Comma-separated input modes")
		.option("--output-modes <modes>", "Comma-separated output modes")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: {
						skillId: string;
						skillName: string;
						skillDescription?: string;
						tags?: string;
						examples?: string;
						inputModes?: string;
						outputModes?: string;
					},
				) => {
					await updateCard(client, agentId, (card) => {
						const skill: Record<string, unknown> = {
							id: opts.skillId,
							name: opts.skillName,
							description: opts.skillDescription ?? "",
							tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [],
						};
						if (opts.examples)
							skill.examples = opts.examples.split(",").map((e) => e.trim());
						if (opts.inputModes)
							skill.inputModes = opts.inputModes
								.split(",")
								.map((m) => m.trim());
						if (opts.outputModes)
							skill.outputModes = opts.outputModes
								.split(",")
								.map((m) => m.trim());
						card.skills = [
							...(Array.isArray(card.skills)
								? (card.skills as Record<string, unknown>[])
								: []),
							skill,
						];
					});
					printMutationOk("Skill added", gOpts.json);
				},
			),
		);
}

/** Register `set-categories`, `set-languages` and `accept-types`. */
export function addCsvFieldCommands(agent: Command, program: Command): void {
	for (const def of CSV_FIELD_CMDS) {
		agent
			.command(def.name)
			.description(def.desc)
			.argument("<agent-id>", "Agent ID")
			.requiredOption(def.flag, def.flagDesc)
			.action(
				withClient(
					program,
					async (
						{ client, gOpts },
						agentId: string,
						opts: Record<string, string>,
					) => {
						const raw = Object.values(opts)[0]!;
						await updateCard(client, agentId, (card) =>
							setRineField(
								card,
								def.field,
								raw.split(",").map((s) => s.trim()),
							),
						);
						printMutationOk(def.msg, gOpts.json);
					},
				),
			);
	}
}
