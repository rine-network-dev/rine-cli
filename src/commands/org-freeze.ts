import {
	type BranchHoldView,
	type OrgFreezeView,
	freezeOrg,
	resumeBranch,
	suspendBranch,
	unfreezeOrg,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printJson, printText } from "../output.js";

function render(
	view: OrgFreezeView,
	json: boolean | undefined,
	frozen: boolean,
): void {
	if (json) {
		printJson(view);
		return;
	}
	const state = frozen ? "frozen" : "unfrozen";
	printText(
		view.changed
			? `Organisation ${state}.`
			: `Organisation was already ${state}.`,
	);
}

export function registerOrgFreeze(org: Command, program: Command): void {
	org
		.command("freeze")
		.description("Stop every agent in the organisation at once")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				render(await freezeOrg(client), gOpts.json, true);
			}),
		);

	org
		.command("unfreeze")
		.description(
			"Lift your organisation's freeze; agents you suspended one by one stay suspended",
		)
		.action(
			withClient(program, async ({ client, gOpts }) => {
				render(await unfreezeOrg(client), gOpts.json, false);
			}),
		);
}

function renderBranch(
	view: BranchHoldView,
	json: boolean | undefined,
	state: string,
): void {
	if (json) {
		printJson(view);
		return;
	}
	printText(
		view.changed
			? `Branch '${view.name}' ${state}.`
			: `Branch '${view.name}' was already ${state}.`,
	);
}

export function registerBranchHold(branch: Command, program: Command): void {
	branch
		.command("suspend <name>")
		.description(
			"Stop every agent in a branch at once; messages to them wait in their queues",
		)
		.action(
			withClient(program, async ({ client, gOpts }, name: string) => {
				renderBranch(
					await suspendBranch(client, name),
					gOpts.json,
					"suspended",
				);
			}),
		);

	branch
		.command("resume <name>")
		.description(
			"Resume a suspended branch; agents suspended one by one stay suspended",
		)
		.action(
			withClient(program, async ({ client, gOpts }, name: string) => {
				renderBranch(await resumeBranch(client, name), gOpts.json, "resumed");
			}),
		);
}
