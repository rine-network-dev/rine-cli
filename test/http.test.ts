import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RineApiError } from "../src/errors.js";
import { HttpClient, getOrRefreshToken } from "../src/http.js";
import type { TokenFn } from "../src/http.js";
import * as config from "../src/config.js";

function makeResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: String(status),
		json: async () => body,
	} as unknown as Response;
}

const TEST_API_URL = "https://api.rine.network";

function makeClient(tokenFn: TokenFn): HttpClient {
	return new HttpClient({ apiUrl: TEST_API_URL, tokenFn });
}

beforeEach(() => {
	// biome-ignore lint/performance/noDelete: env var must be fully removed, not set to "undefined" string
	delete process.env.RINE_API_URL;
});

afterEach(() => {
	vi.unstubAllGlobals();
	// biome-ignore lint/performance/noDelete: env var must be fully removed, not set to "undefined" string
	delete process.env.RINE_API_URL;
});

describe("HttpClient — Authorization header", () => {
	it("attaches Bearer token to request", async () => {
		const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, { id: "1" }));
		vi.stubGlobal("fetch", fetchMock);
		const tokenFn = vi.fn<TokenFn>().mockResolvedValue("my-token");

		await makeClient(tokenFn).get("/agents");

		const call = fetchMock.mock.calls[0] as [string, RequestInit];
		const init = call[1];
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer my-token");
	});
});

describe("HttpClient — 401 retry", () => {
	it("retries once on 401 and calls tokenFn with force=true", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(makeResponse(401, { detail: "Unauthorized" }))
			.mockResolvedValueOnce(makeResponse(200, { id: "1" }));
		vi.stubGlobal("fetch", fetchMock);
		const tokenFn = vi.fn<TokenFn>().mockResolvedValue("refreshed-token");

		const result = await makeClient(tokenFn).get("/agents");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(tokenFn).toHaveBeenNthCalledWith(2, true);
		expect(result).toEqual({ id: "1" });
	});

	it("throws RineApiError if retry also returns 401", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(makeResponse(401, { detail: "Still unauthorized" }));
		vi.stubGlobal("fetch", fetchMock);
		const tokenFn = vi.fn<TokenFn>().mockResolvedValue("token");

		await expect(makeClient(tokenFn).get("/agents")).rejects.toThrow(
			RineApiError,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("HttpClient — non-2xx errors", () => {
	it("throws RineApiError on 404", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(makeResponse(404, { detail: "Not found" })),
		);
		await expect(
			makeClient(vi.fn<TokenFn>().mockResolvedValue("tok")).get("/missing"),
		).rejects.toThrow(RineApiError);
	});

	it("throws RineApiError with correct status and detail", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(makeResponse(422, { detail: "Validation error" })),
		);
		const client = makeClient(vi.fn<TokenFn>().mockResolvedValue("tok"));
		try {
			await client.post("/agents", { name: "" });
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(RineApiError);
			expect((err as RineApiError).status).toBe(422);
			expect((err as RineApiError).detail).toBe("Validation error");
		}
	});

	it("handles array detail from FastAPI validation errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse(422, {
					detail: [
						{ msg: "field required", type: "missing" },
						{ msg: "invalid value", type: "value_error" },
					],
				}),
			),
		);
		const client = makeClient(vi.fn<TokenFn>().mockResolvedValue("tok"));
		try {
			await client.post("/agents", {});
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(RineApiError);
			expect((err as RineApiError).detail).toBe(
				"field required; invalid value",
			);
		}
	});
});

describe("HttpClient — 204 No Content", () => {
	it("returns undefined for 204 responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 204,
				statusText: "No Content",
				json: async () => {
					throw new Error("no body");
				},
			} as unknown as Response),
		);
		const result = await makeClient(
			vi.fn<TokenFn>().mockResolvedValue("tok"),
		).delete("/agents/123");
		expect(result).toBeUndefined();
	});
});

describe("getOrRefreshToken", () => {
	const entry = { client_id: "cid", client_secret: "csec" };

	beforeEach(() => {
		vi.spyOn(config, "loadTokenCache").mockReturnValue({});
		vi.spyOn(config, "saveTokenCache").mockImplementation(() => {});
		// biome-ignore lint/performance/noDelete: env cleanup
		delete process.env.RINE_TOKEN;
	});

	it("returns RINE_TOKEN env var if set (no fetch)", async () => {
		process.env.RINE_TOKEN = "env-tok";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const token = await getOrRefreshToken(entry, "default");
		expect(token).toBe("env-tok");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns cached token if not expired", async () => {
		const future = Date.now() / 1000 + 3600;
		vi.spyOn(config, "loadTokenCache").mockReturnValue({
			default: { access_token: "cached-tok", expires_at: future },
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const token = await getOrRefreshToken(entry, "default");
		expect(token).toBe("cached-tok");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refreshes token if cached token expires within 60s margin", async () => {
		const almostExpired = Date.now() / 1000 + 30; // 30s left, within 60s margin
		vi.spyOn(config, "loadTokenCache").mockReturnValue({
			default: { access_token: "old-tok", expires_at: almostExpired },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse(200, { access_token: "fresh-tok", expires_in: 3600 }),
			),
		);

		const token = await getOrRefreshToken(entry, "default");
		expect(token).toBe("fresh-tok");
	});

	it("fetches from /oauth/token when cache is empty", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			makeResponse(200, { access_token: "new-tok", expires_in: 3600 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const token = await getOrRefreshToken(entry, "default");
		expect(token).toBe("new-tok");

		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toContain("/oauth/token");

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.headers).toEqual({
			"Content-Type": "application/x-www-form-urlencoded",
		});
		expect(init.body).toContain("grant_type=client_credentials");
		expect(init.body).toContain("client_id=cid");
	});

	it("bypasses cache when force=true", async () => {
		const future = Date.now() / 1000 + 3600;
		vi.spyOn(config, "loadTokenCache").mockReturnValue({
			default: { access_token: "cached-tok", expires_at: future },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse(200, { access_token: "forced-tok", expires_in: 3600 }),
			),
		);

		const token = await getOrRefreshToken(entry, "default", true);
		expect(token).toBe("forced-tok");
	});

	it("throws when no credentials and no cache", async () => {
		await expect(getOrRefreshToken(undefined, "default")).rejects.toThrow(
			"No credentials found",
		);
	});

	it("saves token to cache after fetch", async () => {
		const cacheSpy = vi.spyOn(config, "cacheToken");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse(200, { access_token: "new-tok", expires_in: 3600 }),
			),
		);

		await getOrRefreshToken(entry, "myprofile");
		expect(cacheSpy).toHaveBeenCalledTimes(1);
		expect(cacheSpy).toHaveBeenCalledWith("myprofile", {
			access_token: "new-tok",
			expires_in: 3600,
		});
	});
});

describe("HttpClient.publicGet — unauthenticated requests", () => {
	it("sends GET without Authorization header", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(makeResponse(200, { items: [] }));
		vi.stubGlobal("fetch", fetchMock);
		process.env.RINE_API_URL = TEST_API_URL;

		await HttpClient.publicGet("/directory/agents");

		const call = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(call[0]).toBe(`${TEST_API_URL}/directory/agents`);
		const headers = call[1].headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(headers.Accept).toBe("application/json");
	});

	it("appends query params", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(makeResponse(200, { items: [] }));
		vi.stubGlobal("fetch", fetchMock);
		process.env.RINE_API_URL = TEST_API_URL;

		const params = new URLSearchParams({ q: "test", limit: "5" });
		await HttpClient.publicGet("/directory/agents", params);

		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toContain("q=test");
		expect(url).toContain("limit=5");
	});

	it("throws RineApiError on non-2xx", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(makeResponse(404, { detail: "Not found" })),
		);
		process.env.RINE_API_URL = TEST_API_URL;

		await expect(HttpClient.publicGet("/directory/missing")).rejects.toThrow(
			RineApiError,
		);
	});
});

describe("HttpClient — HTTP methods", () => {
	it("sends GET request to correct URL", async () => {
		const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, []));
		vi.stubGlobal("fetch", fetchMock);

		await makeClient(vi.fn<TokenFn>().mockResolvedValue("tok")).get("/agents");

		const call = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(call[0]).toBe(`${TEST_API_URL}/agents`);
		expect(call[1].method).toBe("GET");
	});

	it("appends query params to GET URL", async () => {
		const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, []));
		vi.stubGlobal("fetch", fetchMock);

		await makeClient(vi.fn<TokenFn>().mockResolvedValue("tok")).get("/agents", {
			limit: 10,
			offset: 0,
		});

		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toContain("limit=10");
		expect(url).toContain("offset=0");
	});

	it("sends POST with JSON body and Content-Type header", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(makeResponse(201, { id: "new" }));
		vi.stubGlobal("fetch", fetchMock);

		await makeClient(vi.fn<TokenFn>().mockResolvedValue("tok")).post(
			"/agents",
			{
				name: "bot",
			},
		);

		const call = fetchMock.mock.calls[0] as [string, RequestInit];
		const init = call[1];
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
			"application/json",
		);
		expect(init.body).toBe(JSON.stringify({ name: "bot" }));
	});
});
