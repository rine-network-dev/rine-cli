/**
 * Cell styles and their SGR encoding.
 *
 * A style names colours by palette role, never by value, so one table decides how each role looks
 * at every colour depth. Attributes (bold, faint, reverse) are not colours and survive `NO_COLOR`,
 * which is how the selection and the verdict words stay readable without any colour.
 */
import type { ColorDepth } from "./caps.js";

export const Role = {
	Accent: "accent",
	AccentHi: "accentHi",
	AccentDeep: "accentDeep",
	Dim: "dim",
	Ok: "ok",
	Warn: "warn",
	Bad: "bad",
	Info: "info",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export type Style = {
	readonly fg?: Role;
	readonly bg?: Role;
	readonly bold?: boolean;
	readonly faint?: boolean;
	readonly reverse?: boolean;
};

/** The terminal's own defaults: no colour, no attribute. */
export const PLAIN: Style = Object.freeze({});

type Tone = {
	readonly rgb: readonly [number, number, number];
	readonly index256: number;
	/** SGR foreground code at 16 colours; the background code is this plus 10. */
	readonly code16: number;
};

const TONES: Readonly<Record<Role, Tone>> = {
	// The brand: teal for the frame, its bright and deep steps for highlights and shade ramps, signal
	// gold for what needs a look, mint for what checks out. Ember and cream stay out of the terminal.
	accent: { rgb: [0, 224, 200], index256: 44, code16: 96 },
	accentHi: { rgb: [51, 245, 221], index256: 51, code16: 96 },
	accentDeep: { rgb: [0, 187, 168], index256: 37, code16: 36 },
	dim: { rgb: [107, 114, 128], index256: 244, code16: 90 },
	ok: { rgb: [138, 217, 188], index256: 115, code16: 92 },
	warn: { rgb: [255, 184, 20], index256: 214, code16: 33 },
	bad: { rgb: [247, 118, 142], index256: 204, code16: 91 },
	info: { rgb: [187, 154, 247], index256: 141, code16: 95 },
};

function colorParams(role: Role, layer: "fg" | "bg", depth: ColorDepth): string | null {
	if (depth === "none") return null;
	const tone = TONES[role];
	const base = layer === "fg" ? 0 : 10;
	if (depth === "16") return String(tone.code16 + base);
	const select = layer === "fg" ? 38 : 48;
	if (depth === "256") return `${select};5;${tone.index256}`;
	return `${select};2;${tone.rgb.join(";")}`;
}

/** Whether two styles are the same field by field. */
export function styleEquals(a: Style, b: Style): boolean {
	return (
		a === b ||
		(a.fg === b.fg &&
			a.bg === b.bg &&
			!a.bold === !b.bold &&
			!a.faint === !b.faint &&
			!a.reverse === !b.reverse)
	);
}

/**
 * The complete SGR sequence that sets `style` from a reset state; every sequence starts with a
 * reset.
 */
export function sgr(style: Style, depth: ColorDepth): string {
	const params = ["0"];
	if (style.bold) params.push("1");
	if (style.faint) params.push("2");
	if (style.reverse) params.push("7");
	const fg = style.fg === undefined ? null : colorParams(style.fg, "fg", depth);
	const bg = style.bg === undefined ? null : colorParams(style.bg, "bg", depth);
	if (fg) params.push(fg);
	if (bg) params.push(bg);
	return `\x1b[${params.join(";")}m`;
}
