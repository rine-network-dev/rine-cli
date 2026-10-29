import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_END } from "../src/tui/caps.js";
import { createTerm } from "../src/tui/term.js";

class FakeIn extends EventEmitter {
	raw: boolean[] = [];
	paused = 0;
	setRawMode(r: boolean) {
		this.raw.push(r);
	}
	setEncoding() {}
	resume() {}
	pause() {
		this.paused++;
	}
}

class FakeOut extends EventEmitter {
	columns = 100;
	rows = 30;
	written: string[] = [];
	write(d: string) {
		this.written.push(d);
	}
}

class FakeProc extends EventEmitter {
	pid = 4242;
	exit = vi.fn();
	kill = vi.fn();
}

let dir: string;
let fd: number;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-term-"));
	file = path.join(dir, "out");
	fd = fs.openSync(file, "w");
});

afterEach(() => {
	fs.closeSync(fd);
	fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const stdin = new FakeIn();
	const stdout = new FakeOut();
	const proc = new FakeProc();
	const onResize = vi.fn();
	const onResume = vi.fn();
	const term = createTerm({
		stdin: stdin as never,
		stdout: stdout as never,
		writeFd: fd,
		proc: proc as never,
		onResize,
		onResume,
	});
	return {
		stdin,
		stdout,
		proc,
		onResize,
		onResume,
		term,
		out: () => fs.readFileSync(file, "utf8"),
	};
}

describe("createTerm", () => {
	it("enters the alt screen with raw mode and a fixed title", () => {
		const t = setup();
		t.term.enter();
		expect(t.stdin.raw).toEqual([true]);
		expect(t.out()).toContain("\x1b[?1049h");
		expect(t.out()).toContain("\x1b[?2004h");
		expect(t.out()).toContain("\x1b]0;rine · org\x07");
		expect(t.out()).not.toContain("\x1b]8");
		expect(t.out()).not.toContain("\x1b]52");
	});

	it("retitles the window with the org name, scrubbed, and keeps it across a suspend", () => {
		const t = setup();
		t.term.setTitle("Acme");
		t.term.enter();
		expect(t.out()).toContain("\x1b]0;rine · Acme\x07");
		t.term.setTitle("Ac\x07me\x1b]0;evil\x07 Ltd");
		expect(t.stdout.written).toEqual(["\x1b]0;rine · Acme Ltd\x07"]);
		t.term.suspend();
		t.proc.emit("SIGCONT");
		expect(t.out().split("\x1b]0;rine · Acme Ltd\x07")).toHaveLength(2);
		expect(t.out()).not.toContain("evil");
	});

	it("cuts a very long org name to 64 cells in the title", () => {
		const t = setup();
		t.term.setTitle("n".repeat(500));
		t.term.enter();
		expect(t.out()).toContain(`\x1b]0;rine · ${"n".repeat(64)}\x07`);
	});

	it("restores once however many exit paths fire", () => {
		const t = setup();
		t.term.enter();
		const entered = t.out().length;
		t.term.restore();
		t.term.restore();
		t.proc.emit("exit");
		const left = t.out().slice(entered);
		expect(left.split("\x1b[?1049l")).toHaveLength(2);
		expect(left).toContain("\x1b[?25h");
		expect(left).toContain(SYNC_END);
		expect(t.stdin.raw).toEqual([true, false]);
		expect(t.stdin.paused).toBe(1);
	});

	it("is a no-op to restore before enter", () => {
		const t = setup();
		t.term.restore();
		expect(t.out()).toBe("");
	});

	it("removes its process listeners on restore", () => {
		const t = setup();
		t.term.enter();
		expect(t.proc.listenerCount("uncaughtException")).toBe(1);
		t.term.restore();
		for (const ev of [
			"exit",
			"SIGINT",
			"SIGTERM",
			"SIGHUP",
			"uncaughtException",
			"unhandledRejection",
		]) {
			expect(t.proc.listenerCount(ev)).toBe(0);
		}
		expect(t.stdout.listenerCount("resize")).toBe(0);
	});

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	])("restores and exits on %s", (sig, code) => {
		const t = setup();
		t.term.enter();
		t.proc.emit(sig);
		expect(t.out()).toContain("\x1b[?1049l");
		expect(t.proc.exit).toHaveBeenCalledWith(code);
	});

	it("restores and prints only the error name and a fixed code on a crash", () => {
		const t = setup();
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		t.term.enter();
		const err = Object.assign(
			new SyntaxError('Unexpected token in {"secret":"row"}'),
			{ code: "ERR_X" },
		);
		t.proc.emit("uncaughtException", err);
		t.proc.emit("unhandledRejection", new Error("tell\nsecret"));
		const t2 = setup();
		t2.term.enter();
		t2.proc.emit("unhandledRejection", new Error("tell\nsecret"));
		const text = stderr.mock.calls.map((c) => String(c[0])).join("");
		stderr.mockRestore();
		expect(text).toContain("rine tui stopped: SyntaxError (ERR_X)\n");
		expect(text).toContain("rine tui stopped: Error (E_UNKNOWN)\n");
		expect(text).not.toContain("secret");
		expect(t.out()).toContain("\x1b[?1049l");
		expect(t.proc.exit).toHaveBeenCalledWith(1);
	});

	it("treats EPIPE on stdout as a clean exit", () => {
		const t = setup();
		t.term.enter();
		t.stdout.emit(
			"error",
			Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
		);
		expect(t.proc.exit).toHaveBeenCalledWith(0);
		expect(t.out()).toContain("\x1b[?1049l");
	});

	it("forwards resize and reports the size", () => {
		const t = setup();
		t.term.enter();
		t.stdout.emit("resize");
		expect(t.onResize).toHaveBeenCalledTimes(1);
		expect(t.term.size()).toEqual({ cols: 100, rows: 30 });
	});

	it("suspends on ctrl-z, re-enters and repaints on SIGCONT", () => {
		const t = setup();
		t.term.enter();
		t.term.suspend();
		expect(t.proc.kill).toHaveBeenCalledWith(4242, "SIGTSTP");
		expect(t.out().split("\x1b[?1049l")).toHaveLength(2);
		t.proc.emit("SIGCONT");
		expect(t.onResume).toHaveBeenCalledTimes(1);
		expect(t.out().split("\x1b[?1049h")).toHaveLength(3);
		expect(t.stdin.raw).toEqual([true, false, true]);
	});

	it("does not re-enter on SIGCONT after restore", () => {
		const t = setup();
		t.term.enter();
		t.term.suspend();
		t.term.restore();
		t.proc.emit("SIGCONT");
		expect(t.onResume).not.toHaveBeenCalled();
	});

	it("passes input chunks to the data callback until restore", () => {
		const t = setup();
		const cb = vi.fn();
		t.term.enter();
		t.term.onData(cb);
		t.stdin.emit("data", "j");
		t.term.restore();
		t.stdin.emit("data", "k");
		expect(cb.mock.calls).toEqual([["j"]]);
	});
});
