/**
 * The cell effects: the arithmetic of each (a pure function of elapsed time) and the few functions that
 * apply one to a drawn screen. Nothing here reads a clock or a random source, so a frame is a function
 * of its inputs; noise is a hash of the cell and the step. Effects only ever replace a cell with a
 * glyph from the fixed sets in `glyphs.ts` or restyle it, so text is shown whole or not at all.
 */
import { GLYPHS, NOISE, SHADES } from "./glyphs.js";
import type { Rect } from "./layout.js";
import type { Screen } from "./screen.js";
import { PLAIN, Role, type Style } from "./style.js";
import type { Run } from "./widgets/runs.js";

export const TICK_MS = 50;
const SHADE_STEP_MS = 60;
const CASCADE_MS = 300;
/** A new row's cascade: the last cell starts after `CASCADE_MS` and walks the three shades. */
export const SHIMMER_MS = CASCADE_MS + SHADE_STEP_MS * SHADES.length;
const LETTER_DELAY_MS = 130;
const LETTER_STEP_MS = 70;
export const REVEAL_MS = LETTER_DELAY_MS * 3 + LETTER_STEP_MS * 3;
export const DECODE_MS = 350;
/** The share of the text just behind the resolve front that glows. */
const DECODE_GLOW = 0.08;
export const SCAN_PASS_MS = 1500;
const SCAN_CELLS = 4;

const SHADE_ROLES: readonly Role[] = [Role.AccentDeep, Role.Accent, Role.AccentHi];

/**
 * How far cell `index` of `span` has come in a left-to-right cascade after `elapsedMs`: 0 not yet,
 * 1 to 3 the shades from light to dense, 4 settled.
 */
export function cascadeStage(index: number, span: number, elapsedMs: number): 0 | 1 | 2 | 3 | 4 {
	const delay = span <= 1 ? 0 : (index / (span - 1)) * CASCADE_MS;
	const t = elapsedMs - delay;
	if (t < 0) return 0;
	return Math.min(4, 1 + Math.floor(t / SHADE_STEP_MS)) as 1 | 2 | 3 | 4;
}

/** Whether the cell holds something to hide: a drawn cluster, not a blank or a wide glyph's tail. */
const inked = (screen: Screen, x: number, y: number): boolean => {
	const cell = screen.cell(x, y);
	return cell.width !== 0 && cell.text.trim() !== "";
};

/** Put one narrow glyph in a cell, blanking the tail if it held a wide cluster. */
function replace(screen: Screen, x: number, y: number, text: string, style: Style): void {
	const cell = screen.cell(x, y);
	if (cell.width === 2) screen.cell(x + 1, y).set(" ", 1, PLAIN, false);
	cell.set(text, 1, style, false);
}

/** A row that has just arrived, `elapsedMs` into its cascade: its text resolves left to right from the shades. */
export function shimmerRow(screen: Screen, x: number, y: number, width: number, elapsedMs: number): void {
	for (let i = 0; i < width; i++) {
		if (!inked(screen, x + i, y)) continue;
		const stage = cascadeStage(i, width, elapsedMs);
		if (stage === 4) continue;
		const { reverse } = screen.cell(x + i, y).style;
		const role = SHADE_ROLES[stage - 1];
		replace(
			screen,
			x + i,
			y,
			stage === 0 ? " " : (SHADES[stage - 1] as string),
			role === undefined ? { reverse } : { fg: role, reverse },
		);
	}
}

/** The flicker glyph of cell `index` at `step`; the same inputs always give the same glyph. */
export function noiseGlyph(index: number, step: number): string {
	let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(step + 1, 0x85ebca6b);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	return NOISE[(h >>> 0) % NOISE.length] as string;
}

/**
 * Text opening, `elapsedMs` in: a front crosses the inked cells of `rect` in reading order, whatever
 * their number; cells ahead of it flicker through noise, cells just behind it glow.
 */
export function decodeCells(screen: Screen, rect: Rect, elapsedMs: number): void {
	const inks: [number, number][] = [];
	for (let y = rect.y; y < rect.y + rect.h; y++)
		for (let x = rect.x; x < rect.x + rect.w; x++) if (inked(screen, x, y)) inks.push([x, y]);
	const progress = elapsedMs / DECODE_MS;
	const step = Math.floor(elapsedMs / TICK_MS);
	inks.forEach(([x, y], k) => {
		const place = k / inks.length;
		if (place >= progress) {
			replace(screen, x, y, noiseGlyph(k, step), { fg: Role.AccentDeep });
		} else if (progress - place < DECODE_GLOW) {
			const cell = screen.cell(x, y);
			cell.style = { ...cell.style, fg: Role.AccentHi };
		}
	});
}

/** The brand word as runs, `elapsedMs` into its reveal: each letter resolves from the dense shade, one after another. */
export function wordmark(word: string, elapsedMs: number | null): Run[] {
	return Array.from(word).map((letter, i) => {
		const step = elapsedMs === null
			? SHADES.length
			: Math.min(SHADES.length, Math.max(0, Math.floor((elapsedMs - i * LETTER_DELAY_MS) / LETTER_STEP_MS)));
		return step === SHADES.length
			? { text: letter, style: { fg: Role.AccentHi, bold: true } }
			: { text: SHADES[SHADES.length - 1 - step] as string, style: { fg: SHADE_ROLES[step] } };
	});
}

/** The first column of the scan segment `phase` (0 to 1) through a pass over `cols` columns. */
export const scanStart = (phase: number, cols: number): number =>
	Math.floor(phase * (cols + SCAN_CELLS)) - SCAN_CELLS;

/** Light the segment on the top border: only plain border cells change, so the title and badge stay. */
export function drawScan(screen: Screen, start: number): void {
	for (let x = Math.max(1, start); x < Math.min(start + SCAN_CELLS, screen.cols - 1); x++) {
		const cell = screen.cell(x, 0);
		if (cell.text === GLYPHS.lineH.unicode) {
			cell.set(GLYPHS.heavy.unicode, 1, { fg: Role.AccentHi, bold: true }, false);
		}
	}
}
