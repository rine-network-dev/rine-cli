import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getCredentialEntry,
	loadCredentials,
	loadTokenCache,
	saveCredentials,
	saveTokenCache,
} from "../src/config.js";
import type { Credentials, TokenCache } from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rine-test-"));
	process.env.RINE_CONFIG_DIR = tmpDir;
	// biome-ignore lint/performance/noDelete: env vars must be fully removed
	delete process.env.RINE_CLIENT_ID;
	// biome-ignore lint/performance/noDelete: env vars must be fully removed
	delete process.env.RINE_CLIENT_SECRET;
});

afterEach(() => {
	// biome-ignore lint/performance/noDelete: env var must be fully removed, not set to "undefined" string
	delete process.env.RINE_CONFIG_DIR;
	// biome-ignore lint/performance/noDelete: env vars must be fully removed
	delete process.env.RINE_CLIENT_ID;
	// biome-ignore lint/performance/noDelete: env vars must be fully removed
	delete process.env.RINE_CLIENT_SECRET;
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadCredentials", () => {
	it("returns empty object when file is missing", () => {
		const creds = loadCredentials();
		expect(creds).toEqual({});
	});
});

describe("saveCredentials / loadCredentials", () => {
	it("round-trips flat credential format", () => {
		const creds: Credentials = {
			default: { client_id: "c1", client_secret: "s1" },
		};
		saveCredentials(creds);
		const loaded = loadCredentials();
		expect(loaded).toEqual(creds);
	});

	it("writes prettified JSON (not minified)", () => {
		const creds: Credentials = { default: { client_id: "c1", client_secret: "s1" } };
		saveCredentials(creds);
		const raw = readFileSync(join(tmpDir, "credentials.json"), "utf-8");
		expect(raw).toContain("\n");
	});

	it("overwrites previous credentials", () => {
		saveCredentials({ a: { client_id: "c1", client_secret: "s1" } });
		saveCredentials({ b: { client_id: "c2", client_secret: "s2" } });
		const loaded = loadCredentials();
		expect(loaded).not.toHaveProperty("a");
		expect(loaded).toHaveProperty("b");
	});
});

describe("loadTokenCache / saveTokenCache", () => {
	it("returns empty object when file is missing", () => {
		const cache = loadTokenCache();
		expect(cache).toEqual({});
	});

	it("round-trips token cache", () => {
		const cache: TokenCache = {
			default: { access_token: "tok-abc", expires_at: 9_999_999_999 },
		};
		saveTokenCache(cache);
		const loaded = loadTokenCache();
		expect(loaded).toEqual(cache);
	});
});

describe("getCredentialEntry", () => {
	it("returns entry from credentials.json for named profile", () => {
		saveCredentials({ default: { client_id: "c1", client_secret: "s1" } });
		const entry = getCredentialEntry("default");
		expect(entry?.client_id).toBe("c1");
		expect(entry?.client_secret).toBe("s1");
	});

	it("returns undefined when profile not found", () => {
		const entry = getCredentialEntry("missing");
		expect(entry).toBeUndefined();
	});

	it("prefers RINE_CLIENT_ID + RINE_CLIENT_SECRET env vars over file", () => {
		saveCredentials({ default: { client_id: "file-id", client_secret: "file-secret" } });
		process.env.RINE_CLIENT_ID = "env-id";
		process.env.RINE_CLIENT_SECRET = "env-secret";
		const entry = getCredentialEntry("default");
		expect(entry?.client_id).toBe("env-id");
		expect(entry?.client_secret).toBe("env-secret");
	});
});
