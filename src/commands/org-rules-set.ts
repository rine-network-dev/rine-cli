import {
	type ExposureSet,
	PRESETS,
	PolicyRule,
	type PolicyView,
	RULE_MODES,
	RuleMode,
	type RulesPatch,
	Surface,
	invalidSurfaces,
	isNamedPreset,
	MessageDefault,
	getPolicy,
	patchRules,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { printJson, printText } from "../output.js";
import { resolveAgent } from "./agent-suspend.js";
import { collect } from "./group-args.js";
import { EXPOSURE_INVALID, existingLine, groupsSetLine } from "./org-rules-words.js";
import { warnInAgentRuntime } from "./runtime-warning.js";

export interface SetOpts {
	default?: string;
	host: string[];
	agent: string[];
	max?: string;
	maxDirectory?: string;
	maxCard?: string;
	maxA2a?: string;
	maxDid?: string;
}

const pick = <T extends string>(
	label: string,
	values: readonly T[],
	value: string,
): T => {
	const hit = values.find((v) => v === value);
	if (hit === undefined)
		throw new Error(`${label} takes ${values.join(" or ")}, not '${value}'.`);
	return hit;
};

const SWITCH_FLAGS: Record<Surface, keyof SetOpts> = {
	directory: "maxDirectory",
	card: "maxCard",
	a2a: "maxA2a",
	did: "maxDid",
};

/** The ceiling a `--max` preset and the per-switch flags ask for, over the stored one. */
function ceilingOf(opts: SetOpts, stored: ExposureSet): ExposureSet {
	const named =
		opts.max === undefined
			? stored
			: isNamedPreset(opts.max)
				? PRESETS[opts.max]
				: undefined;
	if (named === undefined)
		throw new Error(
			`--max takes ${Object.keys(PRESETS).join(", ")}, not '${opts.max}'.`,
		);
	const max = { ...named };
	for (const s of Object.values(Surface)) {
		const flag = opts[SWITCH_FLAGS[s]];
		if (typeof flag === "string")
			max[s] = pick(`--max-${s}`, ["on", "off"], flag) === "on";
	}
	if (invalidSurfaces(max).length > 0) throw new Error(EXPOSURE_INVALID);
	return max;
}

function onlyWhereApplicable(rule: PolicyRule, opts: SetOpts): void {
	const given: [string, boolean][] = [
		["--default", opts.default !== undefined],
		["--host", opts.host.length > 0],
		["--agent", opts.agent.length > 0],
		["--max*", Object.values(SWITCH_FLAGS).some((f) => opts[f] !== undefined) || opts.max !== undefined],
	];
	const owner: Record<string, PolicyRule[]> = {
		"--default": [PolicyRule.ExternalOutbound, PolicyRule.ExternalInbound],
		"--host": [PolicyRule.WebhookHosts],
		"--agent": [PolicyRule.ActingAs],
		"--max*": [PolicyRule.DirectoryListing],
	};
	for (const [flag, used] of given)
		if (used && !(owner[flag] ?? []).includes(rule))
			throw new Error(`${flag} does not apply to ${rule}.`);
}

async function patchOf(
	ctx: ActionContext,
	policy: PolicyView,
	rule: PolicyRule,
	mode: RuleMode,
	opts: SetOpts,
): Promise<RulesPatch> {
	const { rules } = policy;
	switch (rule) {
		case PolicyRule.ExternalOutbound:
		case PolicyRule.ExternalInbound:
			return {
				[rule]: {
					mode,
					default: opts.default
						? pick("--default", Object.values(MessageDefault), opts.default)
						: rules[rule].default,
				},
			};
		case PolicyRule.DirectoryListing:
			return {
				directory_listing: {
					mode,
					max: ceilingOf(opts, rules.directory_listing.max),
				},
			};
		case PolicyRule.WebhookHosts:
			return {
				webhook_hosts: {
					mode,
					allow: opts.host.length > 0 ? opts.host : rules.webhook_hosts.allow,
				},
			};
		case PolicyRule.ActingAs:
			return {
				acting_as: {
					mode,
					agents:
						opts.agent.length > 0
							? [...new Set(await Promise.all(opts.agent.map((a) => resolveAgent(ctx, a))))]
							: rules.acting_as.agents,
				},
			};
		default:
			return { [rule]: { mode } };
	}
}

export function registerRulesSet(rules: Command, program: Command): void {
	rules
		.command("set <rule> <mode>")
		.description(
			"Set a rule's mode (off|report|enforce; new_agents, directory_listing, webhook_hosts, funnel and acting_as take no report)",
		)
		.option("--default <deny|allow>", "Message rules: what no entry decides")
		.option("--host <pattern>", "webhook_hosts: an allowed host (repeatable)", collect, [])
		.option("--agent <agent>", "acting_as: an agent that acts only with its own key (repeatable)", collect, [])
		.option("--max <preset>", "directory_listing: the most agents may show (private, findable or listed)")
		.option("--max-directory <on|off>", "directory_listing ceiling: directory listing")
		.option("--max-card <on|off>", "directory_listing ceiling: profile card")
		.option("--max-a2a <on|off>", "directory_listing ceiling: A2A discovery")
		.option("--max-did <on|off>", "directory_listing ceiling: DID document")
		.action(
			withClient(program, async (ctx, ruleName: string, modeName: string, opts: SetOpts) => {
				const rule = pick("rule", Object.values(PolicyRule), ruleName);
				const mode = pick(`${rule} mode`, RULE_MODES[rule], modeName);
				onlyWhereApplicable(rule, opts);
				warnInAgentRuntime();
				const current = await getPolicy(ctx.client);
				const policy = await patchRules(
					ctx.client,
					current.version,
					await patchOf(ctx, current, rule, mode, opts),
				);
				if (ctx.gOpts.json) return printJson(policy);
				const set = policy.rules[rule];
				if (set !== undefined) printText(`${rule}: ${set.mode}`);
				const line =
					rule === PolicyRule.ExternalGroups
						? groupsSetLine(policy)
						: existingLine(policy, rule);
				if (line !== undefined) printText(line);
			}),
		);
}
