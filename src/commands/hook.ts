// The `rine hook` CRUD command group for the inbound webhook
// funnel. Structured on the existing `rine webhook` group (webhook.ts): every
// sub-command runs through `withClient`, resolves the agent the same way, and
// reuses the shared output helpers — no reimplemented CRUD or output logic.
//
// FROZEN-CONTRACT: the HMAC secret is generated CLIENT-SIDE and NEVER sent to
// rine — the create POST body carries ONLY {hook_name, tier} (tier is the
// termination tier or null = "backend default"; NEVER the secret). The secret is
// persisted 0600 BEFORE anything prints, put back the way it was if the
// allocation POST fails (no orphan, and an existing hook keeps its secret),
// printed exactly ONCE on create, and NEVER shown by `list`.

import {
	FUNNEL_TIERS,
	type FunnelTier,
	type HookCreated,
	type HookListResponse,
	RineApiError,
	createHook,
	deleteHookSecret,
	hookNameError,
} from "@rine-network/core";
import { type Command, Option } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";
import { promptConfirm } from "../prompt.js";

const SIGNATURE_HEADER = "X-Hub-Signature-256";
const CONTENT_TYPE = "application/json";

// User-facing `--tier` values are hyphenated (`zero-trust`/`shared-edge`); the
// wire/DB enum (FunnelTier) is underscored. This is the ONLY place that maps the
// two spellings — the CLI never recomputes the default tier (omitting --tier
// sends null and the backend's _default_tier_for_trust resolves it).
const TIER_CLI_TO_WIRE: Readonly<Record<string, FunnelTier>> =
	Object.fromEntries(FUNNEL_TIERS.map((t) => [t.replace("_", "-"), t]));

/**
 * Map a `--tier` flag value (hyphenated) to the wire FunnelTier, or `undefined`
 * when the flag was omitted (the backend resolves the default). Throws on an
 * unknown value so a typo fails loudly client-side rather than 422'ing.
 */
function resolveTier(raw: string | undefined): FunnelTier | undefined {
	if (raw === undefined) return undefined;
	const wire = TIER_CLI_TO_WIRE[raw];
	if (!wire) {
		throw new Error(
			`Invalid --tier '${raw}': expected one of ${Object.keys(TIER_CLI_TO_WIRE).join(", ")}.`,
		);
	}
	return wire;
}

export function registerHook(program: Command): void {
	const hook = program
		.command("hook")
		.description("Manage inbound webhook funnel hooks");

	hook
		.command("create")
		.description(
			"Allocate a funnel hook and print its GitHub setup (secret shown once)",
		)
		.addOption(actorOption())
		.option("--name <name>", "Hook name (default: default)", "default")
		// TLS-termination tier. Omitting it sends null and the backend resolves the
		// default for the org's trust tier — the CLI never recomputes that default
		// `.choices` validates client-side; `resolveTier` maps to the wire.
		.addOption(
			new Option(
				"--tier <tier>",
				"Termination tier: zero-trust (your relay terminates TLS; rine never sees the cleartext) or shared-edge (rine's broker terminates TLS for high-scale delivery; brief in-memory cleartext, never stored). Default: by trust tier.",
			).choices(Object.keys(TIER_CLI_TO_WIRE)),
		)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, actingAgent },
					opts: { agent?: string; name: string; tier?: string },
				) => {
					const nameError = hookNameError(opts.name);
					if (nameError) {
						printError(`Invalid hook name '${opts.name}': ${nameError}.`);
						process.exitCode = 2;
						return;
					}
					let tier: FunnelTier | undefined;
					try {
						tier = resolveTier(opts.tier);
					} catch (err) {
						printError(err instanceof Error ? err.message : String(err));
						process.exitCode = 2;
						return;
					}
					const agentId = await actingAgent();

					const { created, secret } = await createHook(
						client,
						configDir,
						agentId,
						opts.name,
						tier,
					);
					printCreated(created, secret, gOpts.json);
				},
			),
		);

	hook
		.command("list")
		.description("List your agent's funnel hooks")
		.addOption(actorOption())
		.action(
			withClient(
				program,
				async ({ client, gOpts, actingAgent }) => {
					const agentId = await actingAgent();
					const data = (await client.get(
						`/agents/${agentId}/funnel/hooks`,
						{},
					)) as HookListResponse;
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable(
							data.items.map((h) => ({
								Name: h.hook_name,
								Hostname: h.hostname,
								Tier: h.termination.replace("_", "-"),
								Active: h.active,
								Created: h.created_at,
							})),
						);
					}
				},
			),
		);

	hook
		.command("delete")
		.description("Delete a funnel hook and purge its local secret")
		.addOption(actorOption())
		.requiredOption("--name <name>", "Hook name to delete")
		.option("--yes", "Skip confirmation prompt")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, actingAgent },
					opts: { agent?: string; name: string; yes?: boolean },
				) => {
					const agentId = await actingAgent();
					if (!opts.yes && !gOpts.json) {
						const confirmed = await promptConfirm(
							`Delete funnel hook '${opts.name}'?`,
						);
						if (!confirmed) return;
					}
					try {
						await client.delete(`/agents/${agentId}/funnel/hooks/${opts.name}`);
					} catch (err) {
						// An unknown hook is success-idempotent ONLY under
						// --yes — purge any stale local secret and report it absent. Without
						// --yes the 404 surfaces so an explicit delete of a typo'd name fails
						// loudly rather than silently "succeeding".
						if (opts.yes && err instanceof RineApiError && err.status === 404) {
							deleteHookSecret(configDir, agentId, opts.name);
							printMutationOk("Funnel hook already absent", gOpts.json);
							return;
						}
						throw err;
					}
					deleteHookSecret(configDir, agentId, opts.name);
					printMutationOk("Funnel hook deleted", gOpts.json);
				},
			),
		);
}

/** Print the print-once GitHub setup block (the secret is shown exactly once). */
function printCreated(
	created: HookCreated,
	secret: string,
	json?: boolean,
): void {
	// The hook is identified entirely by its hostname (SNI-routed); the relay
	// ignores the request path, so the payload URL is just the bare host root.
	const publicUrl = `https://${created.hostname}/`;
	if (json) {
		printJson({
			hook: {
				name: created.hook_name,
				hostname: created.hostname,
				agent_id: created.agent_id,
				tier: created.termination,
			},
			public_url: publicUrl,
			secret,
			signature_header: SIGNATURE_HEADER,
			content_type: CONTENT_TYPE,
		});
		return;
	}
	printTable([
		{ Field: "Hook", Value: created.hook_name },
		{ Field: "Hostname", Value: created.hostname },
		{ Field: "Tier", Value: created.termination.replace("_", "-") },
		{ Field: "Payload URL", Value: publicUrl },
		{ Field: "Content type", Value: CONTENT_TYPE },
		{ Field: "Signature header", Value: SIGNATURE_HEADER },
		{ Field: "Secret", Value: secret },
	]);
	console.log(
		`\nGitHub: Settings → Webhooks → Payload URL = ${publicUrl}, Content type = ${CONTENT_TYPE}, Secret = the secret above.`,
	);
	console.log(
		"Save this secret now — it is not stored on rine and cannot be retrieved.",
	);
	if (created.termination === "shared_edge") {
		// Shared-edge relaxes the zero-trust guarantee: rine's broker terminates TLS
		// and holds the decrypted request in memory for an instant (never logged or
		// stored) before forwarding it to your relay, which still verifies the HMAC
		// and re-encrypts to your agent (at rest it stays hpke-hybrid-v2).
		console.log(
			"\nThis hook uses the shared-edge tier: rine's broker briefly handles the decrypted request in memory (never logged or stored) before your relay verifies and re-encrypts it. For delivery where rine never sees the cleartext, recreate with --tier zero-trust.",
		);
	}
}
