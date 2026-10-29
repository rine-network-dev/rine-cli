/**
 * Every non-ASCII glyph the view draws, each with the ASCII stand-in used when the terminal cannot show
 * it (`--ascii`, `TERM=linux`, a non-UTF-8 locale). Widgets ask this table; none holds a glyph of its own.
 */

interface Pair {
	readonly unicode: string;
	readonly ascii: string;
}

const pair = (unicode: string, ascii: string): Pair => ({ unicode, ascii });

export const GLYPHS = {
	brand: pair("◆", "*"),
	ellipsis: pair("…", "~"),
	dot: pair("·", "-"),
	arrow: pair("→", ">"),
	alert: pair("▲", "!"),
	boxTopLeft: pair("╭", "+"),
	boxTopRight: pair("╮", "+"),
	boxBottomLeft: pair("╰", "+"),
	boxBottomRight: pair("╯", "+"),
	lineH: pair("─", "-"),
	lineV: pair("│", "|"),
	teeLeft: pair("├", "+"),
	teeRight: pair("┤", "+"),
	teeTop: pair("┬", "+"),
	scrollThumb: pair("█", "#"),
	gutter: pair("┃ ", "| "),
	railMarker: pair("▸", ">"),
	selectionBar: pair("▌", ">"),
	heavy: pair("━", "="),
	fadeMid: pair("╌", "-"),
	fadeEnd: pair("┄", "-"),
	paused: pair("◌", "o"),
	verified: pair("✓", "+"),
	invalid: pair("✗", "x"),
	unverifiable: pair("?", "?"),
	gap: pair("!", "!"),
	equivocation: pair("≠", "#"),
} as const satisfies Record<string, Pair>;

export type GlyphName = keyof typeof GLYPHS;

export function glyph(name: GlyphName, unicode: boolean): string {
	return unicode ? GLYPHS[name].unicode : GLYPHS[name].ascii;
}

/** The dim dot that joins parts of one line, with a space either side. */
export const dotJoint = (unicode: boolean): string => ` ${glyph("dot", unicode)} `;

interface Frames {
	readonly unicode: readonly string[];
	readonly ascii: readonly string[];
}

/** Animated marks: the loading spinner and the live dot's pulse. */
export const SPINNER: Frames = {
	unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	ascii: ["|", "/", "-", "\\"],
};
export const PULSE: Frames = { unicode: ["●", "◉", "○", "◉"], ascii: ["*"] };

/** The frame of `frames` at `step`, wrapping. */
export function frameAt(frames: Frames, unicode: boolean, step: number): string {
	const set = unicode ? frames.unicode : frames.ascii;
	return set[step % set.length] as string;
}

/**
 * The shade ramp the cell effects draw with, lightest first. Effects run only on a unicode terminal,
 * so these have no ASCII stand-in.
 */
export const SHADES = ["░", "▒", "▓"] as const;

/** What an unresolved cell flickers through while text decodes: shades and single braille dots. */
export const NOISE: readonly string[] = [
	...SHADES,
	"⠁",
	"⠂",
	"⠄",
	"⡀",
	"⢀",
	"⠠",
	"⠐",
	"⠈",
];
