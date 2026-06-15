import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStreamCursor, saveStreamCursor } from "../src/commands/stream-cursor.js";

describe("stream-cursor (REQ-SSE-05)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rine-cursor-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns undefined when no cursor file exists", () => {
		expect(loadStreamCursor(dir, "agent-1")).toBeUndefined();
	});

	it("round-trips a persisted id for an agent", () => {
		saveStreamCursor(dir, "agent-1", "evt-100");
		expect(loadStreamCursor(dir, "agent-1")).toBe("evt-100");
	});

	it("keys cursors per agent independently", () => {
		saveStreamCursor(dir, "agent-1", "evt-1");
		saveStreamCursor(dir, "agent-2", "evt-2");
		expect(loadStreamCursor(dir, "agent-1")).toBe("evt-1");
		expect(loadStreamCursor(dir, "agent-2")).toBe("evt-2");
	});

	it("overwrites an agent's cursor with a newer id, leaving peers intact", () => {
		saveStreamCursor(dir, "agent-1", "evt-1");
		saveStreamCursor(dir, "agent-2", "evt-9");
		saveStreamCursor(dir, "agent-1", "evt-2");
		expect(loadStreamCursor(dir, "agent-1")).toBe("evt-2");
		expect(loadStreamCursor(dir, "agent-2")).toBe("evt-9");
	});

	it("writes the cursor under state/ with 0600 perms", () => {
		saveStreamCursor(dir, "agent-1", "evt-1");
		const path = join(dir, "state", "stream-cursor.json");
		expect(fs.existsSync(path)).toBe(true);
		expect(fs.statSync(path).mode & 0o777).toBe(0o600);
	});

	it("ignores an empty event id (no write)", () => {
		saveStreamCursor(dir, "agent-1", "");
		expect(loadStreamCursor(dir, "agent-1")).toBeUndefined();
	});

	it("returns undefined on a corrupt cursor file", () => {
		const stateDir = join(dir, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(join(stateDir, "stream-cursor.json"), "not json{", "utf-8");
		expect(loadStreamCursor(dir, "agent-1")).toBeUndefined();
	});

	it("never throws when the cursor dir cannot be created (best-effort)", () => {
		// A regular file used as the config dir → mkdir of state/ fails ENOTDIR;
		// the write must swallow it rather than crash the stream loop.
		const filePath = join(dir, "not-a-dir");
		fs.writeFileSync(filePath, "x", "utf-8");
		expect(() => saveStreamCursor(filePath, "agent-1", "evt-1")).not.toThrow();
		expect(loadStreamCursor(filePath, "agent-1")).toBeUndefined();
	});
});
