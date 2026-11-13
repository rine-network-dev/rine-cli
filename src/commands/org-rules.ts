import {
	type PolicyPreview,
	PolicyRule,
	getPolicy,
	humanTime,
	previewRule,
	stopExisting,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printJson, printText } from "../output.js";
import { registerRulesSet } from "./org-rules-set.js";
import {
	groupsPreviewLines,
	ruleNotes,
	stoppedLines,
	summaryLine,
} from "./org-rules-words.js";
import { warnInAgentRuntime } from "./runtime-warning.js";

const STOPPABLE: PolicyRule[] = [
	PolicyRule.WebhookHosts,
	PolicyRule.Funnel,
	PolicyRule.DirectoryListing,
];

function ruleArg(name: string, among: readonly PolicyRule[]): PolicyRule {
	const rule = among.find((r) => r === name);
	if (rule === undefined)
		throw new Error(`Unknown rule '${name}'. Rules: ${among.join(", ")}.`);
	return rule;
}

/** What a message rule would have refused; for the group rule, what it would find; else what already stands. */
function previewLines(p: PolicyPreview): string[] {
	if (p.kind === "groups") return groupsPreviewLines(p);
	if (p.kind === "existing") {
		return [
			p.total === 0
				? `Nothing stands outside ${p.rule} today.`
				: `${p.total} ${p.standing?.replaceAll("_", " ")} would be outside ${p.rule}.${p.ids_more > 0 ? ` ${p.ids_more} more not listed.` : ""}`,
		];
	}
	const way = p.rule === PolicyRule.ExternalOutbound ? "to" : "from";
	const lines = [
		`About ${p.refused_messages} messages ${way} ${p.counterparties} organisations in the last ${p.window_days} days would have been refused.`,
	];
	const now = Date.now();
	for (const c of p.top)
		lines.push(
			`  @${c.slug ?? `${c.org_id.slice(0, 8)}…`}  ${c.messages} messages  last ${humanTime(c.last_at, now)}`,
		);
	lines.push(`Of these, about ${p.key_messages} were group key messages.`);
	lines.push(
		`Not counted: Welcomes, and anything older than your ${p.window_days}-day retention.`,
	);
	return lines;
}

export function registerOrgRules(org: Command, program: Command): void {
	const rules = org.command("rules").description("Organisation rules");

	rules
		.command("show")
		.description("Show the organisation's rules")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const policy = await getPolicy(client);
				if (gOpts.json) return printJson(policy);
				for (const rule of Object.values(PolicyRule)) {
					if (policy.rules[rule] === undefined) continue;
					printText(`${rule}: ${policy.rules[rule].mode}`);
					for (const note of ruleNotes(policy, rule)) printText(`  ${note}`);
				}
				printText(summaryLine(policy));
			}),
		);

	registerRulesSet(rules, program);

	rules
		.command("preview <rule>")
		.description(
			"What enforcing a rule would do, writing nothing (message rules count past messages)",
		)
		.action(
			withClient(program, async ({ client, gOpts }, name: string) => {
				const preview = await previewRule(
					client,
					ruleArg(name, Object.values(PolicyRule)),
				);
				if (gOpts.json) return printJson(preview);
				for (const line of previewLines(preview)) printText(line);
			}),
		);

	rules
		.command("stop-existing <rule>")
		.description(
			"Stop what an enforced rule found already standing (webhook_hosts, funnel, directory_listing)",
		)
		.action(
			withClient(program, async ({ client, gOpts }, name: string) => {
				const rule = ruleArg(name, STOPPABLE);
				warnInAgentRuntime();
				const result = await stopExisting(client, rule);
				if (gOpts.json) return printJson(result);
				for (const line of stoppedLines(result)) printText(line);
			}),
		);
}
