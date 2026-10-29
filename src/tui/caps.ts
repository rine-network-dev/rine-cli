/** Terminal capabilities: colour depth and unicode, decided once at start from the environment. */

/**
 * DEC 2026 synchronized output: the renderer wraps each frame in these, and the restore path closes
 * any open block.
 */
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

export type ColorDepth = "none" | "16" | "256" | "truecolor";

export interface Caps {
	color: ColorDepth;
	unicode: boolean;
}

export type CapsResult =
	| { ok: true; caps: Caps }
	| { ok: false; refused: "dumb-terminal" };

export interface CapsInput {
	env: NodeJS.ProcessEnv;
	/** The output stream; one without `getColorDepth` (not a TTY) has no colour. */
	stream: { getColorDepth?: (env?: object) => number };
	/** The `--ascii` flag. */
	ascii?: boolean;
}

const FORCE_COLOR_DEPTH: Record<string, ColorDepth> = {
	"0": "none",
	"1": "16",
	"2": "256",
	"3": "truecolor",
};

function colorDepth({ env, stream }: CapsInput): ColorDepth {
	if (env.NO_COLOR) return "none";
	const forced =
		env.FORCE_COLOR === undefined
			? undefined
			: FORCE_COLOR_DEPTH[env.FORCE_COLOR];
	if (forced) return forced;
	const bits = stream.getColorDepth?.(env) ?? 1;
	if (bits >= 24) return "truecolor";
	if (bits >= 8) return "256";
	return bits >= 4 ? "16" : "none";
}

function isUnicode({ env, ascii }: CapsInput): boolean {
	if (ascii || env.TERM === "linux") return false;
	const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
	return !locale || /utf-?8/i.test(locale);
}

export function detectCaps(input: CapsInput): CapsResult {
	if (input.env.TERM === "dumb") return { ok: false, refused: "dumb-terminal" };
	return {
		ok: true,
		caps: { color: colorDepth(input), unicode: isUnicode(input) },
	};
}
