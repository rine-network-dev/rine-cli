import fs from "node:fs";
import { SYNC_END } from "./caps.js";
import { cleanTo } from "./clean.js";

/** The window title until the org is known. */
const TITLE_FALLBACK = "org";
/** An OSC title ends at BEL, so the name is scrubbed and cut to 64 cells here, at the point it is written. */
const titleOf = (name: string): string =>
	`\x1b]0;rine · ${cleanTo(name, 64) || TITLE_FALLBACK}\x07`;
const enterOf = (title: string): string =>
	`\x1b[22;0t${title}\x1b[?1049h\x1b[?25l\x1b[?2004h`;
const LEAVE = `${SYNC_END}\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[23;0t`;

const FATAL_CODE = /^[A-Z0-9_]{1,40}$/;
const FATAL_NAME = /^[A-Za-z0-9_]{1,40}$/;

type Proc = Pick<
	NodeJS.Process,
	"on" | "off" | "once" | "exit" | "kill" | "pid"
>;

interface InputStream {
	isTTY?: boolean;
	setRawMode?: (raw: boolean) => unknown;
	setEncoding: (encoding: BufferEncoding) => unknown;
	resume: () => unknown;
	pause: () => unknown;
	on: (event: "data", cb: (chunk: string) => void) => unknown;
	off: (event: "data", cb: (chunk: string) => void) => unknown;
}

interface OutputStream {
	fd?: number;
	isTTY?: boolean;
	columns?: number;
	rows?: number;
	write: (data: string) => unknown;
	on: (
		event: "resize" | "error",
		cb: (err?: NodeJS.ErrnoException) => void,
	) => unknown;
	off: (
		event: "resize" | "error",
		cb: (err?: NodeJS.ErrnoException) => void,
	) => unknown;
}

export interface TermOptions {
	stdin: InputStream;
	stdout: OutputStream;
	/** Where the synchronous restore bytes go; defaults to the stdout descriptor. */
	writeFd?: number;
	proc?: Proc;
	/** The terminal changed size: the app forces a full repaint. */
	onResize: () => void;
	/** The process continued after ctrl-z and the terminal is entered again: the app repaints. */
	onResume: () => void;
}

export interface Term {
	enter(): void;
	/** Safe to call twice; every exit path calls it. */
	restore(): void;
	/** ctrl-z: leave the terminal, stop the process, re-enter and repaint on SIGCONT. */
	suspend(): void;
	size(): { cols: number; rows: number };
	write(data: string): void;
	onData(cb: (chunk: string) => void): void;
	/** The window title becomes `rine · <name>`; it holds across a suspend. */
	setTitle(name: string): void;
}

/** Only the error's name and a fixed code are shown: a message or stack can quote row data. */
export function fatalLine(err: unknown): string {
	const e = (typeof err === "object" && err !== null ? err : {}) as {
		name?: unknown;
		code?: unknown;
	};
	const name =
		typeof e.name === "string" && FATAL_NAME.test(e.name) ? e.name : "Error";
	const code =
		typeof e.code === "string" && FATAL_CODE.test(e.code)
			? e.code
			: "E_UNKNOWN";
	return `rine tui stopped: ${name} (${code})\n`;
}

export function createTerm(opts: TermOptions): Term {
	const { stdin, stdout, onResize, onResume } = opts;
	const proc: Proc = opts.proc ?? process;
	const fd = opts.writeFd ?? stdout.fd ?? 1;
	let entered = false;
	let closed = false;
	let dataCb: ((chunk: string) => void) | undefined;
	let title = titleOf(TITLE_FALLBACK);
	const detach: Array<() => void> = [];

	const writeNow = (data: string): void => {
		try {
			fs.writeSync(fd, data);
		} catch {
			// The terminal is gone (EPIPE, EIO); there is nothing left to restore.
		}
	};

	const setRaw = (raw: boolean): void => {
		try {
			stdin.setRawMode?.(raw);
		} catch {
			// Not a TTY any more.
		}
	};

	const enterTerminal = (): void => {
		entered = true;
		setRaw(true);
		stdin.setEncoding("utf8");
		stdin.resume();
		writeNow(enterOf(title));
	};

	const leaveTerminal = (): void => {
		if (!entered) return;
		entered = false;
		writeNow(LEAVE);
		setRaw(false);
		stdin.pause();
	};

	const restore = (): void => {
		leaveTerminal();
		if (closed) return;
		closed = true;
		if (dataCb) stdin.off("data", dataCb);
		for (const off of detach.splice(0)) off();
	};

	const listen = (
		event: string,
		handler: (...args: unknown[]) => void,
	): void => {
		proc.on(event as "exit", handler);
		detach.push(() => proc.off(event as "exit", handler));
	};

	const die = (code: number) => () => {
		restore();
		proc.exit(code);
	};

	const crash = (err: unknown): void => {
		restore();
		process.stderr.write(fatalLine(err));
		proc.exit(1);
	};

	return {
		enter() {
			if (entered || closed) return;
			enterTerminal();
			listen("exit", restore);
			listen("SIGINT", die(130));
			listen("SIGTERM", die(143));
			listen("SIGHUP", die(129));
			listen("uncaughtException", crash);
			listen("unhandledRejection", crash);
			const resize = (): void => onResize();
			stdout.on("resize", resize);
			detach.push(() => stdout.off("resize", resize));
			const epipe = (err?: NodeJS.ErrnoException): void => {
				if (err?.code === "EPIPE") die(0)();
			};
			stdout.on("error", epipe);
			detach.push(() => stdout.off("error", epipe));
		},
		restore,
		suspend() {
			if (!entered) return;
			leaveTerminal();
			proc.once("SIGCONT", () => {
				if (closed) return;
				enterTerminal();
				onResume();
			});
			proc.kill(proc.pid, "SIGTSTP");
		},
		size: () => ({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 }),
		write(data) {
			stdout.write(data);
		},
		setTitle(name) {
			title = titleOf(name);
			if (entered) stdout.write(title);
		},
		onData(cb) {
			dataCb = cb;
			stdin.on("data", cb);
		},
	};
}
