import type { Command } from "commander";
import {
	type CredentialEntry,
	type HttpClient,
	type TokenFn,
	HttpClient as HttpClientClass,
	fetchAgents,
	formatError,
	getCredentialEntry,
	getOrRefreshToken,
	isBareAgentName,
	resolveAgent,
	resolveApiUrl,
	resolveConfigDir,
	resolveToUuid,
} from "@rine-network/core";
import { printError } from "./output.js";
import type { GlobalOpts } from "./types.js";

export type ActionContext = {
	client: HttpClient;
	gOpts: GlobalOpts;
	profileName: string;
	configDir: string;
	apiUrl: string;
	extraHeaders: Record<string, string>;
};

// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
type ActionFn = (ctx: ActionContext, ...args: any[]) => Promise<void>;
// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
type WrappedFn = (...args: any[]) => Promise<void>;

async function createClient(
	configDir: string,
	apiUrl: string,
	profileFlag?: string,
	defaultHeaders?: Record<string, string>,
): Promise<{
	client: HttpClientClass;
	profileName: string;
	entry: CredentialEntry | undefined;
}> {
	const profileName = profileFlag ?? "default";
	const entry = getCredentialEntry(configDir, profileName);
	const envToken = process.env.RINE_TOKEN;
	const canRefresh = !envToken && entry !== undefined;
	const tokenFn: TokenFn = (force = false) =>
		getOrRefreshToken(configDir, apiUrl, entry, profileName, { force, envToken });
	const client = new HttpClientClass({ tokenFn, apiUrl, canRefresh, defaultHeaders });
	return { client, profileName, entry };
}

export { createClient };

export function withClient(program: Command, fn: ActionFn): WrappedFn {
	return async (...args) => {
		try {
			const gOpts = program.opts<GlobalOpts>();
			const configDir = resolveConfigDir();
			const apiUrl = resolveApiUrl();
			const defaultHeaders: Record<string, string> = {};
			if (gOpts.as && !isBareAgentName(gOpts.as)) {
				defaultHeaders["X-Rine-Agent"] = await resolveToUuid(apiUrl, gOpts.as);
			}
			const { client, profileName } = await createClient(
				configDir,
				apiUrl,
				gOpts.profile,
				defaultHeaders,
			);
			if (gOpts.as && isBareAgentName(gOpts.as)) {
				const agents = await fetchAgents(client);
				defaultHeaders["X-Rine-Agent"] = await resolveAgent(
					apiUrl,
					agents,
					undefined,
					gOpts.as,
				);
			}
			await fn(
				{ client, gOpts, profileName, configDir, apiUrl, extraHeaders: defaultHeaders },
				...args,
			);
		} catch (err) {
			printError(formatError(err));
			process.exitCode = 1;
		}
	};
}

export function withErrorHandler(
	program: Command,
	// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
	fn: (gOpts: GlobalOpts, ...args: any[]) => Promise<void> | void,
): WrappedFn {
	return async (...args) => {
		try {
			const gOpts = program.opts<GlobalOpts>();
			await fn(gOpts, ...args);
		} catch (err) {
			printError(formatError(err));
			process.exitCode = 1;
		}
	};
}
