import { getOrgExposure, orgSummaryLine, ceilingLine } from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printJson, printText } from "../output.js";

export function registerOrgExposure(org: Command, program: Command): void {
	org
		.command("exposure")
		.description("How many of the organisation's agents are private, findable or listed")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const view = await getOrgExposure(client);
				if (gOpts.json) return printJson(view);
				printText(orgSummaryLine(view));
				if (view.ceiling) printText(ceilingLine(view.ceiling));
			}),
		);
}
