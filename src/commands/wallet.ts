// The `rine wallet` command group: manage the agent's secp256k1
// payment wallet (4th key type) and its client-side spend policy. Every
// sub-command runs through `withClient`, resolves the acting agent the same way
// as the other command groups, and delegates ALL key/policy logic to rine-core
// (createWallet / getWalletAddress / loadPolicy / savePolicy) — no wallet or
// policy logic is reimplemented in the CLI.

import {
	type PaymentPolicy,
	createWallet,
	fetchAgents,
	getWalletAddress,
	loadPolicy,
	resolveAgent,
	savePolicy,
	walletKeyExists,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";

function csv(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function registerWallet(program: Command): void {
	const wallet = program
		.command("wallet")
		.description("Manage the agent payment wallet and spend policy (x402)");

	wallet
		.command("create")
		.description("Create a payment wallet for an agent (refuses to overwrite)")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, apiUrl, configDir },
					opts: { agent?: string },
				) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);
					if (walletKeyExists(configDir, agentId)) {
						printError(
							`Wallet already exists for agent ${agentId}. The private key is never overwritten.`,
						);
						process.exitCode = 1;
						return;
					}
					const { address } = createWallet(configDir, agentId);
					if (gOpts.json) {
						printJson({ agent_id: agentId, address });
					} else {
						printTable([
							{ Field: "Agent ID", Value: agentId },
							{ Field: "Wallet address", Value: address },
						]);
					}
				},
			),
		);

	wallet
		.command("address")
		.description("Print an agent's payment wallet address")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, apiUrl, configDir },
					opts: { agent?: string },
				) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);
					if (!walletKeyExists(configDir, agentId)) {
						printError(
							`No wallet for agent ${agentId}. Run 'rine wallet create' first.`,
						);
						process.exitCode = 1;
						return;
					}
					const address = getWalletAddress(configDir, agentId);
					if (gOpts.json) {
						printJson({ agent_id: agentId, address });
					} else {
						printTable([{ "Wallet address": address }]);
					}
				},
			),
		);

	const policy = wallet
		.command("policy")
		.description("Show the effective spend policy (deny-by-default when unset)")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, apiUrl, configDir },
					opts: { agent?: string },
				) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);
					const p = loadPolicy(configDir, agentId);
					if (gOpts.json) {
						printJson({
							agent_id: agentId,
							policy: p,
							effective: p ? "configured" : "deny-by-default",
						});
						return;
					}
					if (!p) {
						printTable([
							{ Field: "Effective policy", Value: "DENY (no policy set)" },
							{
								Field: "Note",
								Value:
									"Payments are denied by default. Configure with 'rine wallet policy set'.",
							},
						]);
						return;
					}
					printTable([
						{ Field: "Effective policy", Value: "configured" },
						{ Field: "Per-tx cap", Value: p.perTxCap },
						{ Field: "Daily cap", Value: p.dailyCap },
						{ Field: "Auto-pay threshold", Value: p.autoPayThreshold },
						{
							Field: "Allowed assets",
							Value: p.allowedAssets.join(", ") || "—",
						},
						{
							Field: "Allowed networks",
							Value: p.allowedNetworks.join(", ") || "—",
						},
					]);
				},
			),
		);

	policy
		.command("set")
		.description(
			"Set the spend policy (all caps are decimal major-unit strings)",
		)
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.requiredOption(
			"--per-tx-cap <amount>",
			"Max per-transaction spend, e.g. 5.00",
		)
		.requiredOption(
			"--daily-cap <amount>",
			"Max total spend per UTC day, e.g. 50.00",
		)
		.requiredOption(
			"--allowed-assets <list>",
			"Comma-separated assets (symbols e.g. EURC or 0x contract addresses)",
		)
		.requiredOption(
			"--allowed-networks <list>",
			"Comma-separated CAIP-2 networks, e.g. eip155:8453",
		)
		.option(
			"--auto-pay-threshold <amount>",
			"Auto-pay ceiling for 'rine pay --auto-pay' (default 0 = never auto-pay)",
			"0",
		)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, apiUrl, configDir },
					opts: {
						agent?: string;
						perTxCap: string;
						dailyCap: string;
						allowedAssets: string;
						allowedNetworks: string;
						autoPayThreshold: string;
					},
				) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);
					const next: PaymentPolicy = {
						perTxCap: opts.perTxCap,
						dailyCap: opts.dailyCap,
						allowedAssets: csv(opts.allowedAssets),
						allowedNetworks: csv(opts.allowedNetworks),
						autoPayThreshold: opts.autoPayThreshold,
					};
					// savePolicy runs validatePolicy — a bad decimal string throws an
					// X402Error surfaced by withClient's error path (no silent write).
					savePolicy(configDir, agentId, next);
					printMutationOk("Spend policy updated", gOpts.json);
				},
			),
		);
}
