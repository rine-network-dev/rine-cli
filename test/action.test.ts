import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { withClient, withErrorHandler } from "../src/action.js";
import { RineApiError } from "@rine-network/core";
import * as core from "@rine-network/core";
import * as output from "../src/output.js";

// Suppress console output during tests
beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function makeProgram(opts: Record<string, unknown> = {}): Command {
	const program = new Command();
	vi.spyOn(program, "opts").mockReturnValue(opts);
	return program;
}

describe("withClient", () => {
	beforeEach(() => {
		vi.spyOn(core, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
		vi.spyOn(core, "resolveApiUrl").mockReturnValue("https://test.rine.network");
		vi.spyOn(core, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
		vi.spyOn(core, "resolveAuth").mockReturnValue(undefined);
		vi.spyOn(core, "getOrRefreshToken").mockResolvedValue("test-token");
	});

	it("calls fn with client and gOpts", async () => {
		const fn = vi.fn();
		const program = makeProgram({ profile: "test" });
		const wrapped = withClient(program, fn);
		await wrapped({ opt: true });

		expect(fn).toHaveBeenCalledTimes(1);
		const ctx = fn.mock.calls[0]![0];
		expect(ctx.client).toBeDefined();
		expect(ctx.gOpts).toEqual({ profile: "test" });
		expect(ctx.profileName).toBe("test");
		expect(ctx.configDir).toBe("/tmp/test-rine");
		expect(ctx.apiUrl).toBe("https://test.rine.network");
	});

	it("catches errors and sets exitCode", async () => {
		vi.spyOn(core, "resolveConfigDir").mockImplementation(() => {
			throw new RineApiError(401, "Unauthorized");
		});
		const printErrorSpy = vi.spyOn(output, "printError");

		const fn = vi.fn();
		const program = makeProgram({});
		const wrapped = withClient(program, fn);
		await wrapped();

		expect(fn).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(printErrorSpy).toHaveBeenCalledWith("Unauthorized");
	});

	it("catches errors thrown inside fn", async () => {
		const printErrorSpy = vi.spyOn(output, "printError");

		const fn = vi.fn().mockRejectedValue(new Error("boom"));
		const program = makeProgram({});
		const wrapped = withClient(program, fn);
		await wrapped();

		expect(process.exitCode).toBe(1);
		expect(printErrorSpy).toHaveBeenCalledWith("boom");
	});

	it("forwards positional args from commander", async () => {
		const fn = vi.fn();
		const program = makeProgram({});
		const wrapped = withClient(program, fn);
		await wrapped("arg1", "arg2", { opt: true });

		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn.mock.calls[0]![1]).toBe("arg1");
		expect(fn.mock.calls[0]![2]).toBe("arg2");
		expect(fn.mock.calls[0]![3]).toEqual({ opt: true });
	});
});

describe("withErrorHandler", () => {
	it("calls fn with gOpts and forwards args", async () => {
		const fn = vi.fn();
		const program = makeProgram({ json: true });
		const wrapped = withErrorHandler(program, fn);
		await wrapped("someArg", { flag: true });

		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn.mock.calls[0]![0]).toEqual({ json: true });
		expect(fn.mock.calls[0]![1]).toBe("someArg");
		expect(fn.mock.calls[0]![2]).toEqual({ flag: true });
	});

	it("catches errors and sets exitCode", async () => {
		const printErrorSpy = vi.spyOn(output, "printError");

		const fn = vi.fn().mockRejectedValue(new RineApiError(500, "Server Error"));
		const program = makeProgram({});
		const wrapped = withErrorHandler(program, fn);
		await wrapped();

		expect(process.exitCode).toBe(1);
		expect(printErrorSpy).toHaveBeenCalledWith("Server Error");
	});

	it("does not set exitCode on success", async () => {
		const fn = vi.fn();
		const program = makeProgram({});
		const wrapped = withErrorHandler(program, fn);
		await wrapped();

		expect(process.exitCode).toBeUndefined();
	});
});

describe("createClient — start-up escrow sweep", () => {
	it("starts the sweep for every client it builds, leaving repeats to the library gate", async () => {
		vi.resetModules();
		const freshCore = await import("@rine-network/core");
		const sweep = vi.spyOn(freshCore, "startupEscrowSweep").mockResolvedValue(undefined as never);
		vi.spyOn(freshCore, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
		vi.spyOn(freshCore, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
		vi.spyOn(freshCore, "resolveAuth").mockReturnValue(undefined);
		const fresh = await import("../src/action.js");

		await fresh.createClient("https://test.rine.network");
		await fresh.createClient("https://test.rine.network");
		await new Promise((r) => setImmediate(r));

		expect(sweep).toHaveBeenCalledTimes(2);
		expect(sweep).toHaveBeenCalledWith(expect.anything(), "/tmp/test-rine", undefined);
	});

	it("never fails the command when the sweep fails", async () => {
		vi.resetModules();
		const freshCore = await import("@rine-network/core");
		vi.spyOn(freshCore, "startupEscrowSweep").mockRejectedValue(new Error("server down"));
		vi.spyOn(freshCore, "resolveConfigDir").mockReturnValue("/tmp/test-rine");
		vi.spyOn(freshCore, "resolveOwnerDir").mockReturnValue("/tmp/test-rine-owner");
		vi.spyOn(freshCore, "resolveAuth").mockReturnValue(undefined);
		const fresh = await import("../src/action.js");

		await expect(fresh.createClient("https://test.rine.network")).resolves.toBeDefined();
		await new Promise((r) => setImmediate(r));
		expect(process.exitCode).toBeUndefined();
	});
});
