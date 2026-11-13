import {
	type AgentRead,
	EXPOSURE_COPY,
	type ExposureSet,
	type ExposureView,
	PRESETS,
	Surface,
	aboveCeilingLine,
	ceilingLine,
	getExposure,
	invalidSurfaces,
	isNamedPreset,
	previewExposure,
	previewLines,
	putExposure,
	refusedLine,
	summaryLine,
	switchLines,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { printJson, printText } from "../output.js";
import { promptConfirm } from "../prompt.js";
import { resolveAgent } from "./agent-suspend.js";

interface SetOpts {
	directory?: string;
	card?: string;
	a2a?: string;
	did?: string;
	yes?: boolean;
}

/** The exposure lines and ceiling notices for one agent. */
function describe(name: string, view: ExposureView): string[] {
	const lines = [
		summaryLine(name, view.exposure, view.a2a_available),
		"",
		...switchLines(name, view),
	];
	if (view.ceiling) lines.push("", ceilingLine(view.ceiling));
	const above = aboveCeilingLine(name, view);
	if (above) lines.push("", above);
	return lines;
}

async function nameOf(ctx: ActionContext, id: string): Promise<string> {
	return ((await ctx.client.get(`/agents/${id}`)) as AgentRead).name;
}

function flagValue(flag: string, value: string): boolean {
	if (value !== "on" && value !== "off") throw new Error(`--${flag} takes on or off, not '${value}'.`);
	return value === "on";
}

/** The set a preset and the per-switch flags ask for; flags change the preset, or the current set. */
function targetOf(preset: string | undefined, opts: SetOpts, current: ExposureSet): ExposureSet {
	if (preset !== undefined && !isNamedPreset(preset))
		throw new Error(`The preset is one of ${Object.keys(PRESETS).join(", ")}, not '${preset}'.`);
	const target = { ...(preset === undefined ? current : PRESETS[preset as keyof typeof PRESETS]) };
	let flagged = false;
	for (const s of Object.values(Surface)) {
		const value = opts[s];
		if (value === undefined) continue;
		target[s] = flagValue(s, value);
		flagged = true;
	}
	if (preset === undefined && !flagged)
		throw new Error("Give a preset (private, findable or listed) or at least one of --directory, --card, --a2a, --did.");
	return target;
}

async function setExposure(ctx: ActionContext, ref: string, preset: string | undefined, opts: SetOpts) {
	const id = await resolveAgent(ctx, ref);
	const name = await nameOf(ctx, id);
	const current = await getExposure(ctx.client, id);
	const target = targetOf(preset, opts, current.exposure);
	if (invalidSurfaces(target).length > 0) throw new Error(EXPOSURE_COPY.invalid);
	const plan = await previewExposure(ctx.client, id, target);
	if (plan.refused.length > 0) throw new Error(refusedLine(plan));
	if (!ctx.gOpts.json) for (const line of previewLines(name, plan)) printText(line);
	if (plan.turned_on.length + plan.turned_off.length === 0) return;
	if (!opts.yes && !ctx.gOpts.json && !(await promptConfirm("Apply?"))) {
		printText("Nothing changed.");
		return;
	}
	const view = await putExposure(ctx.client, id, target);
	if (ctx.gOpts.json) return printJson(view);
	printText("");
	for (const line of describe(name, view)) printText(line);
}

export function registerAgentExposure(agent: Command, program: Command): void {
	const exposure = agent
		.command("exposure [agent]")
		.description("Show what an agent shows the outside, or change it with `exposure set`")
		.addHelpText("after", `\n${EXPOSURE_COPY.help}`)
		.action(
			withClient(program, async (ctx, ref?: string) => {
				if (ref === undefined) throw new Error("Name the agent: rine agent exposure <agent>.");
				const id = await resolveAgent(ctx, ref);
				const view = await getExposure(ctx.client, id);
				if (ctx.gOpts.json) return printJson(view);
				for (const line of describe(await nameOf(ctx, id), view)) printText(line);
			}),
		);

	exposure
		.command("set <agent> [preset]")
		.description("Set an agent's exposure: private, findable, listed, or switch by switch")
		.option("--directory <on|off>", "Directory listing")
		.option("--card <on|off>", "Profile card")
		.option("--a2a <on|off>", "A2A discovery")
		.option("--did <on|off>", "DID document")
		.option("--yes", "Skip the confirmation prompt")
		.action(withClient(program, (ctx, ref: string, preset: string | undefined, opts: SetOpts) =>
			setExposure(ctx, ref, preset, opts)));
}
