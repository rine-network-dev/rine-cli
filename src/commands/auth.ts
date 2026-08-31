import type { Command } from "commander";
import { withClient, withErrorHandler } from "../action.js";
import { actorLadder } from "../acting-agent.js";
import { namedActor } from "../actor.js";
import {
	type OrgRead,
	HttpClient,
	agentKeysExist,
	cacheToken,
	fetchOAuthToken,
	formatError,
	getCredentialEntry,
	getOrRefreshToken,
	loadCredentials,
	loadTokenCache,
	resolveApiUrl,
	resolveConfigDir,
	saveCredentials,
	saveTokenCache,
} from "@rine-network/core";
import { printError, printJson, printSuccess, printTable } from "../output.js";
import { promptPassword, promptText } from "../prompt.js";
import type { GlobalOpts } from "../types.js";

export function registerAuth(program: Command): void {
	// rine login [--client-id ID] [--client-secret SECRET]
	// Left as manual try/catch — interactive credential prompting is unique
	program
		.command("login")
		.description("Log in with OAuth2 client credentials")
		.option("--client-id <id>", "Client ID")
		.option("--client-secret <secret>", "Client secret")
		.action(async (opts: { clientId?: string; clientSecret?: string }) => {
			try {
				const gOpts = program.opts<GlobalOpts>();
				const profile = gOpts.profile ?? "default";
				const configDir = resolveConfigDir();
				const apiUrl = resolveApiUrl();
				const clientId = opts.clientId ?? (await promptText("Client ID: "));
				const clientSecret =
					opts.clientSecret ?? (await promptPassword("Client secret: "));

				const tokenData = await fetchOAuthToken(apiUrl, clientId, clientSecret);

				const creds = loadCredentials(configDir);
				creds[profile] = { client_id: clientId, client_secret: clientSecret };
				saveCredentials(configDir, creds);

				cacheToken(configDir, profile, tokenData);

				printSuccess(`Logged in as ${clientId}`);
			} catch (err) {
				printError(formatError(err));
				process.exitCode = 1;
			}
		});

	// rine logout
	program
		.command("logout")
		.description("Clear cached token. Credentials are preserved.")
		.action(
			withErrorHandler(program, (gOpts) => {
				const profile = gOpts.profile ?? "default";
				const configDir = resolveConfigDir();
				const cache = loadTokenCache(configDir);
				delete cache[profile];
				saveTokenCache(configDir, cache);
				printSuccess(
					`Logged out — token cache cleared for profile '${profile}'. Credentials preserved.`,
				);
			}),
		);

	// rine status (top-level alias)
	program
		.command("status")
		.description("Show org status")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				await showOrgStatus(client, gOpts);
			}),
		);

	// rine whoami
	program
		.command("whoami")
		.description("Show current identity and status")
		.action(async () => {
			const gOpts = program.opts<GlobalOpts>();
			const profile = gOpts.profile ?? "default";
			const configDir = resolveConfigDir();
			const apiUrl = resolveApiUrl();

			const entry = getCredentialEntry(configDir, profile);
			if (!entry) {
				if (gOpts.json) {
					printJson({ logged_in: false });
				} else {
					printTable([{ Field: "Status", Value: "not logged in" }]);
				}
				return;
			}

			try {
				const token = await getOrRefreshToken(configDir, apiUrl, entry, profile);
				const defaultHeaders: Record<string, string> = {};
				const client = new HttpClient({
					tokenFn: () => Promise.resolve(token),
					apiUrl,
					canRefresh: false,
					defaultHeaders,
				});
				const { agents, actingAgent } = actorLadder(
					namedActor(undefined, gOpts),
					client,
					defaultHeaders,
				);

				const org = (await client.get("/org")) as OrgRead;

				// Try to resolve agent
				let agentHandle: string | undefined;
				let agentId: string | undefined;
				let keysLabel: string | undefined;

				try {
					agentId = await actingAgent();
					const agent = (await agents()).find((a) => a.id === agentId);
					agentHandle = agent?.handle ?? undefined;

					const hasLocal = agentKeysExist(configDir, agentId);
					let hasServer = false;
					try {
						await client.get(`/agents/${agentId}/keys`);
						hasServer = true;
					} catch {
						// no server keys
					}
					keysLabel =
						hasLocal && hasServer
							? "local + server"
							: hasLocal
								? "local only"
								: hasServer
									? "server only"
									: "none";
				} catch {
					// no agent resolvable — omit agent fields
				}

				if (gOpts.json) {
					printJson({
						profile,
						api: apiUrl,
						org: { name: org.name, slug: org.slug },
						trust_tier: org.trust_tier,
						...(agentId
							? {
									agent: agentHandle ?? null,
									agent_id: agentId,
									keys: keysLabel,
								}
							: {}),
					});
				} else {
					const rows = [
						{ Field: "Profile", Value: profile },
						{ Field: "API", Value: apiUrl },
						{ Field: "Org", Value: `${org.name} (${org.slug})` },
						{ Field: "Trust Tier", Value: String(org.trust_tier) },
					];
					if (agentId) {
						rows.push({ Field: "Agent", Value: agentHandle ?? "-" });
						rows.push({ Field: "Agent ID", Value: agentId });
						rows.push({ Field: "Keys", Value: keysLabel ?? "none" });
					}
					printTable(rows);
				}
			} catch (err) {
				printError(formatError(err));
				process.exitCode = 1;
			}
		});

	// rine auth (group)
	const authGroup = program.command("auth").description("Auth commands");

	authGroup
		.command("token")
		.description("Get or refresh access token")
		.option("--force", "Force token refresh (bypass cache)")
		.action(
			withErrorHandler(program, async (gOpts, opts: { force?: boolean }) => {
				const profile = gOpts.profile ?? "default";
				const force = opts.force === true;
				const configDir = resolveConfigDir();
				const apiUrl = resolveApiUrl();

				const now = Date.now() / 1000;
				const envToken = process.env.RINE_TOKEN;
				const cache = loadTokenCache(configDir);
				const cached = cache[profile];
				const source: "cache" | "server" =
					envToken !== undefined ||
					(!force && cached !== undefined && cached.expires_at - now > 60)
						? "cache"
						: "server";

				const entry = getCredentialEntry(configDir, profile);
				const token = await getOrRefreshToken(configDir, apiUrl, entry, profile, {
					force,
					envToken,
				});

				if (gOpts.json) {
					printJson({ access_token: token, source });
				} else {
					console.log(token);
				}
			}),
		);

	authGroup
		.command("status")
		.description("Show org status")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				await showOrgStatus(client, gOpts);
			}),
		);
}

async function showOrgStatus(
	client: { get: (path: string) => Promise<unknown> },
	gOpts: GlobalOpts,
): Promise<void> {
	const data = (await client.get("/org")) as OrgRead;
	if (gOpts.json) {
		printJson(data);
		return;
	}
	printTable([
		{ Field: "Name", Value: data.name },
		{ Field: "Slug", Value: data.slug },
		{ Field: "Trust Tier", Value: String(data.trust_tier) },
		{ Field: "Agent Count", Value: String(data.agent_count) },
	]);
}
