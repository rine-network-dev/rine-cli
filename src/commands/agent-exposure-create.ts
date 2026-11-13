import {
	type CreatedAgent,
	type NamedPreset,
	Preset,
	cappedLine,
	createdPrivateLine,
	isNamedPreset,
	presetLine,
	presetOf,
} from "@rine-network/core";
import { printText } from "../output.js";

export const EXPOSURE_OPTION_HELP =
	"What the agent shows the outside: private, findable or listed";

/** The `--exposure` value as a preset, or an error naming the three. */
export function exposurePreset(value: string | undefined): NamedPreset | undefined {
	if (value === undefined) return undefined;
	if (!isNamedPreset(value))
		throw new Error(`--exposure takes private, findable or listed, not '${value}'.`);
	return value;
}

/**
 * After a create with `--exposure`: the summary of what the server set, in the server's own
 * preset (its effective A2A is off until the card enables it), then the capped notice when the
 * organisation's ceiling lowered it. Without the flag: the private notice when the agent came
 * back Private.
 */
export function announceExposure(agent: CreatedAgent, asked: NamedPreset | undefined): void {
	if (agent.exposure == null) return;
	if (asked !== undefined) {
		const preset = agent.preset ?? presetOf(agent.exposure, false);
		printText(presetLine(agent.name, agent.exposure, preset));
		const capped = cappedLine(asked, agent.preset);
		if (capped !== null) printText(capped);
	} else if (agent.preset === Preset.Private) printText(createdPrivateLine(agent.name));
}
