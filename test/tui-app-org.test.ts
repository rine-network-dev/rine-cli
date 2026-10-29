import { MalformedPageError, RineApiError } from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import { createOrgLoader } from "../src/tui/app-org.js";

const ORG = { name: "Acme", slug: "acme" };

describe("createOrgLoader", () => {
	it("applies the first answer once and stops reading after it", async () => {
		const org = vi
			.fn()
			.mockRejectedValueOnce(new Error("down"))
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValue(ORG);
		const apply = vi.fn();
		const loader = createOrgLoader({ org }, apply);
		await loader.load();
		expect(await loader.retry()).toBe(false);
		expect(apply).not.toHaveBeenCalled();
		expect(await loader.retry()).toBe(true);
		expect(apply).toHaveBeenCalledExactlyOnceWith(ORG);
		expect(await loader.retry()).toBe(false);
		expect(org).toHaveBeenCalledTimes(3);
	});

	it("applies null once and never reads again when the answer has no usable org", async () => {
		const org = vi.fn().mockResolvedValue({ name: "Acme", slug: "NOT A SLUG" });
		const apply = vi.fn();
		const loader = createOrgLoader({ org }, apply);
		await loader.load();
		expect(apply).toHaveBeenCalledExactlyOnceWith(null);
		expect(await loader.retry()).toBe(false);
		expect(org).toHaveBeenCalledOnce();
	});

	it("does not start a second read while one is in flight", async () => {
		let answer: (value: typeof ORG) => void = () => undefined;
		const org = vi.fn(
			() =>
				new Promise<typeof ORG>((resolve) => {
					answer = resolve;
				}),
		);
		const loader = createOrgLoader({ org }, vi.fn());
		const first = loader.load();
		expect(await loader.retry()).toBe(false);
		expect(org).toHaveBeenCalledOnce();
		answer(ORG);
		await first;
	});

	it.each([
		["a 403", new RineApiError(403, "forbidden")],
		["a 404", new RineApiError(404, "not found")],
		["an answer with no org", new MalformedPageError()],
	])("applies null once and never reads again after %s", async (_name, refusal) => {
		const org = vi.fn().mockRejectedValue(refusal);
		const apply = vi.fn();
		const loader = createOrgLoader({ org }, apply);
		await loader.load();
		expect(apply).toHaveBeenCalledExactlyOnceWith(null);
		expect(await loader.retry()).toBe(false);
		expect(await loader.retry()).toBe(false);
		expect(org).toHaveBeenCalledOnce();
	});

	it.each([
		["a 500", new RineApiError(500, "boom")],
		["a 503", new RineApiError(503, "unavailable")],
		["a 429 throttle", new RineApiError(429, "slow down")],
		["a network error", new TypeError("fetch failed")],
	])("keeps reading on each tick after %s", async (_name, failure) => {
		const org = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue(ORG);
		const apply = vi.fn();
		const loader = createOrgLoader({ org }, apply);
		await loader.load();
		expect(await loader.retry()).toBe(false);
		expect(apply).not.toHaveBeenCalled();
		expect(await loader.retry()).toBe(true);
		expect(apply).toHaveBeenCalledExactlyOnceWith(ORG);
		expect(org).toHaveBeenCalledTimes(3);
	});
});
