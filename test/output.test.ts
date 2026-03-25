import { afterEach, describe, expect, it, vi } from "vitest";
import {
	printError,
	printJson,
	printSuccess,
	printTable,
	printText,
} from "../src/output.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("printJson", () => {
	it("outputs prettified JSON to stdout", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printJson({ key: "value", num: 42 });
		expect(spy).toHaveBeenCalledWith(
			JSON.stringify({ key: "value", num: 42 }, null, 2),
		);
	});

	it("handles arrays", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printJson([1, 2, 3]);
		expect(spy).toHaveBeenCalledWith(JSON.stringify([1, 2, 3], null, 2));
	});

	it("handles null", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printJson(null);
		expect(spy).toHaveBeenCalledWith("null");
	});
});

describe("printTable", () => {
	it("formats rows as ASCII table containing headers and values", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printTable([
			{ id: "1", name: "foo" },
			{ id: "2", name: "bar" },
		]);
		const output = spy.mock.calls[0]?.[0] as string;
		expect(output).toContain("id");
		expect(output).toContain("name");
		expect(output).toContain("foo");
		expect(output).toContain("bar");
	});

	it('shows "(no results)" for empty array', () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printTable([]);
		expect(spy).toHaveBeenCalledWith("(no results)");
	});

	it("respects custom keys (includes only specified columns)", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printTable([{ id: "1", name: "foo", extra: "ignored" }], ["id", "name"]);
		const output = spy.mock.calls[0]?.[0] as string;
		expect(output).toContain("id");
		expect(output).toContain("name");
		expect(output).not.toContain("extra");
	});
});

describe("printSuccess", () => {
	it("prints message with checkmark prefix", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printSuccess("Operation done");
		expect(spy).toHaveBeenCalledWith("✓ Operation done");
	});
});

describe("printText", () => {
	it("logs message to stdout", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printText("hello world");
		expect(spy).toHaveBeenCalledWith("hello world");
	});
});

describe("printError", () => {
	it("logs message to stderr", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		printError("something went wrong");
		expect(spy).toHaveBeenCalledWith("something went wrong");
	});
});
