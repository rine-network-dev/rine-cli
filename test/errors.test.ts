import { describe, expect, it } from "vitest";
import { RineApiError, formatError } from "../src/errors.js";

describe("RineApiError", () => {
	it("sets status, detail, and message", () => {
		const err = new RineApiError(404, "not found");
		expect(err.status).toBe(404);
		expect(err.detail).toBe("not found");
		expect(err.message).toBe("404: not found");
		expect(err.name).toBe("RineApiError");
	});

	it("is an instance of Error", () => {
		const err = new RineApiError(500, "server error");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(RineApiError);
	});

	it("accepts optional raw value", () => {
		const raw = { body: "raw" };
		const err = new RineApiError(500, "server error", raw);
		expect(err.raw).toBe(raw);
	});

	it("raw is undefined when not provided", () => {
		const err = new RineApiError(400, "bad request");
		expect(err.raw).toBeUndefined();
	});
});

describe("formatError", () => {
	it("returns detail for RineApiError", () => {
		const err = new RineApiError(422, "validation failed");
		expect(formatError(err)).toBe("validation failed");
	});

	it("returns message for generic Error", () => {
		expect(formatError(new Error("something broke"))).toBe("something broke");
	});

	it("converts string to string", () => {
		expect(formatError("plain string")).toBe("plain string");
	});

	it("converts number to string", () => {
		expect(formatError(42)).toBe("42");
	});

	it("converts null to string", () => {
		expect(formatError(null)).toBe("null");
	});
});
