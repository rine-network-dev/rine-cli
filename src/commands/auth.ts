import type { Command } from "commander";
import { resolveDirs, withClient, withErrorHandler } from "../action.js";
import {
	DEFAULT_PROFILE,
	type WhoAmIRead,
	getOrRefreshToken,
	loadTokenCache,
	principalString,
	resolveApiUrl,
	resolveAuth,
	saveTokenCache,
} from "@rine-network/core";
import { printJson, printSuccess, printTable } from "../output.js";
import type { GlobalOpts } from "../types.js";
import { registerWhoami } from "./whoami.js";

export function registerAuth(program: Command): void {
	// rine logout
	program
		.command("logout")
		.description("Clear cached token. Keys are preserved.")
		.action(
			withErrorHandler(program, (gOpts) => {
				const profile = gOpts.profile ?? DEFAULT_PROFILE;
				const dirs = resolveDirs();
				const auth = resolveAuth(dirs, gOpts.profile);
				if (!auth) {
					printSuccess("Not logged in — nothing to clear.");
					return;
				}
				const cache = loadTokenCache(auth.cacheDir);
				delete cache[principalString(auth.signer.principal)];
				saveTokenCache(auth.cacheDir, cache);
				printSuccess(
					`Logged out — token cache cleared for profile '${profile}'. Keys preserved.`,
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

	registerWhoami(program);

	// rine auth (group)
	const authGroup = program.command("auth").description("Auth commands");

	authGroup
		.command("token")
		.description("Get or refresh access token")
		.option("--force", "Force token refresh (bypass cache)")
		.action(
			withErrorHandler(program, async (gOpts, opts: { force?: boolean }) => {
				const force = opts.force === true;
				const dirs = resolveDirs();
				const apiUrl = resolveApiUrl();
				const auth = resolveAuth(dirs, gOpts.profile);

				const now = Date.now() / 1000;
				const envToken = process.env.RINE_TOKEN;
				const cacheDir = auth?.cacheDir ?? dirs.configDir;
				const cache = loadTokenCache(cacheDir);
				const cached = auth
					? cache[principalString(auth.signer.principal)]
					: undefined;
				const source: "cache" | "server" =
					envToken !== undefined ||
					(!force && cached !== undefined && cached.expires_at - now > 60)
						? "cache"
						: "server";

				const token = await getOrRefreshToken(cacheDir, apiUrl, auth?.signer, {
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
	const { org: data } = (await client.get("/whoami")) as WhoAmIRead;
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
