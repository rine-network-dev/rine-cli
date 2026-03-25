import * as fs from "node:fs";
import { join } from "node:path";
import type { CredentialEntry, Credentials, TokenCache } from "./types.js";

export function getConfigDir(): string {
	return process.env.RINE_CONFIG_DIR ?? join(process.cwd(), ".rine");
}

export function getApiUrl(): string {
	return (process.env.RINE_API_URL ?? "https://rine.network").replace(
		/\/$/,
		"",
	);
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomic(path: string, content: string): void {
	const tmpPath = `${path}.tmp`;
	fs.writeFileSync(tmpPath, content, "utf-8");
	fs.renameSync(tmpPath, path);
	fs.chmodSync(path, 0o600);
}

export function loadCredentials(): Credentials {
	const path = join(getConfigDir(), "credentials.json");
	try {
		const raw = fs.readFileSync(path, "utf-8");
		return JSON.parse(raw) as Credentials;
	} catch {
		return {};
	}
}

export function saveCredentials(creds: Credentials): void {
	const dir = getConfigDir();
	ensureDir(dir);
	writeAtomic(join(dir, "credentials.json"), JSON.stringify(creds, null, 2));
}

export function loadTokenCache(): TokenCache {
	const path = join(getConfigDir(), "token_cache.json");
	try {
		const raw = fs.readFileSync(path, "utf-8");
		return JSON.parse(raw) as TokenCache;
	} catch {
		return {};
	}
}

export function saveTokenCache(cache: TokenCache): void {
	const dir = getConfigDir();
	ensureDir(dir);
	writeAtomic(join(dir, "token_cache.json"), JSON.stringify(cache, null, 2));
}

export function cacheToken(
	profile: string,
	token: { access_token: string; expires_in: number },
): void {
	const cache = loadTokenCache();
	cache[profile] = {
		access_token: token.access_token,
		expires_at: Date.now() / 1000 + token.expires_in,
	};
	saveTokenCache(cache);
}

/**
 * Resolves credentials for a profile. Priority:
 * 1. RINE_CLIENT_ID + RINE_CLIENT_SECRET env vars (both required)
 * 2. credentials.json for the given profile
 * Returns undefined if no credentials found.
 */
export function getCredentialEntry(
	profile = "default",
): CredentialEntry | undefined {
	const envId = process.env.RINE_CLIENT_ID;
	const envSecret = process.env.RINE_CLIENT_SECRET;
	if (envId && envSecret) {
		return { client_id: envId, client_secret: envSecret };
	}
	const creds = loadCredentials();
	return creds[profile];
}
