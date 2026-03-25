import type { Command } from "commander";
import { withClient, withErrorHandler } from "../action.js";
import type { OrgRead } from "../api-types.js";
import {
	cacheToken,
	getCredentialEntry,
	loadCredentials,
	loadTokenCache,
	saveCredentials,
	saveTokenCache,
} from "../config.js";
import { formatError } from "../errors.js";
import { fetchOAuthToken, getOrRefreshToken } from "../http.js";
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
				const clientId = opts.clientId ?? (await promptText("Client ID: "));
				const clientSecret =
					opts.clientSecret ?? (await promptPassword("Client secret: "));

				const tokenData = await fetchOAuthToken(clientId, clientSecret);

				const creds = loadCredentials();
				creds[profile] = { client_id: clientId, client_secret: clientSecret };
				saveCredentials(creds);

				cacheToken(profile, tokenData);

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
				const cache = loadTokenCache();
				delete cache[profile];
				saveTokenCache(cache);
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

				const now = Date.now() / 1000;
				const envToken = process.env.RINE_TOKEN;
				const cache = loadTokenCache();
				const cached = cache[profile];
				const source: "cache" | "server" =
					envToken !== undefined ||
					(!force && cached !== undefined && cached.expires_at - now > 60)
						? "cache"
						: "server";

				const entry = getCredentialEntry(profile);
				const token = await getOrRefreshToken(entry, profile, force);

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
