/**
 * The bytes that turn the previous frame into the next one: changed cells only, with the shortest
 * cursor moves, in one synchronized-output block.
 *
 * Terminals disagree on the width of some clusters, so a cursor position that follows a non-ASCII
 * cluster is not trusted: the next jump after one is an absolute CUP, and cells put with
 * `putAnchored` (the verification column and the right border) are always placed by CUP and are
 * redrawn on any row where a non-ASCII cluster was drawn. A width error therefore cannot carry past
 * the cluster that caused it into those cells.
 */
import { type ColorDepth, SYNC_BEGIN, SYNC_END } from "./caps.js";
import { Cell, type Screen } from "./screen.js";
import { PLAIN, sgr, styleEquals } from "./style.js";

const CLEAR_ALL = "\x1b[2J";
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

function sameCell(a: Cell, b: Cell): boolean {
	return a.text === b.text && a.width === b.width && styleEquals(a.style, b.style);
}

class Emitter {
	private readonly parts: string[] = [];
	private readonly plain: string;
	private code: string;
	private x = -1;
	private y = -1;
	private untrusted = false;

	constructor(
		private readonly cols: number,
		private readonly depth: ColorDepth,
	) {
		this.plain = sgr(PLAIN, depth);
		this.code = this.plain;
	}

	raw(s: string): void {
		this.parts.push(s);
	}

	get length(): number {
		return this.parts.length;
	}

	/** Draw `cell` at (x, y); returns whether it holds a non-ASCII cluster. */
	draw(x: number, y: number, cell: Cell, anchored: boolean): boolean {
		if (this.y !== y || this.x !== x || anchored) this.moveTo(x, y, anchored);
		const code = sgr(cell.style, this.depth);
		if (code !== this.code) {
			this.parts.push(code);
			this.code = code;
		}
		this.parts.push(cell.text);
		this.x = x + cell.width;
		this.y = this.x >= this.cols ? -1 : y;
		const nonAscii = !ASCII_PRINTABLE.test(cell.text);
		if (nonAscii) this.untrusted = true;
		return nonAscii;
	}

	private moveTo(x: number, y: number, anchored: boolean): void {
		if (anchored || this.untrusted || this.y !== y) {
			this.parts.push(`\x1b[${y + 1};${x + 1}H`);
			this.untrusted = false;
		} else {
			this.parts.push(x - this.x === 1 ? "\x1b[C" : `\x1b[${x - this.x}C`);
		}
	}

	finish(): string {
		if (this.code !== this.plain) this.parts.push(this.plain);
		return this.parts.join("");
	}
}

/**
 * The output that makes the terminal show `next`. With no `prev`, or a `prev` of another size, the
 * whole screen is cleared and repainted. Returns "" when nothing changed.
 */
export function diffScreens(prev: Screen | null, next: Screen, depth: ColorDepth): string {
	const full = prev === null || prev.cols !== next.cols || prev.rows !== next.rows;
	const base = full ? null : prev;
	const out = new Emitter(next.cols, depth);
	if (full) out.raw(sgr(PLAIN, depth) + CLEAR_ALL);
	const blank = new Cell();
	for (let y = 0; y < next.rows; y++) {
		const drawn = new Set<number>();
		let nonAscii = false;
		for (let x = 0; x < next.cols; x++) {
			const cell = next.cell(x, y);
			if (cell.width === 0 || sameCell(cell, base ? base.cell(x, y) : blank)) continue;
			drawn.add(x);
			if (out.draw(x, y, cell, cell.anchored)) nonAscii = true;
		}
		if (!nonAscii) continue;
		for (let x = 0; x < next.cols; x++) {
			const cell = next.cell(x, y);
			if (cell.anchored && cell.width !== 0 && !drawn.has(x)) out.draw(x, y, cell, true);
		}
	}
	if (!full && out.length === 0) return "";
	return SYNC_BEGIN + out.finish() + SYNC_END;
}
