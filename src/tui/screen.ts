/**
 * The cell buffer every widget draws into.
 *
 * `put` is the single choke point between text and the terminal: it replaces any control character
 * that reached it with U+FFFD and counts it, so a string that escaped the scrub still cannot move
 * the cursor or start an escape sequence. A wide cluster fills its own cell and a continuation cell
 * after it; overwriting either half blanks the other, so the buffer never holds half a character.
 */
import { clusterWidth, graphemes } from "@rine-network/core";
import { PLAIN, type Style } from "./style.js";

const CONTROLS = /\p{Cc}/gu;
const REPLACEMENT = "\uFFFD";

export class Cell {
	/** The cluster drawn here; empty for the continuation half of a wide cluster. */
	text = " ";
	/** 2 for the lead of a wide cluster, 0 for its continuation, 1 otherwise. */
	width: 0 | 1 | 2 = 1;
	style: Style = PLAIN;
	/**
	 * Drawn with an absolute cursor move, and redrawn on any row where the terminal may have
	 * mis-measured a cluster.
	 */
	anchored = false;

	set(text: string, width: 0 | 1 | 2, style: Style, anchored: boolean): void {
		this.text = text;
		this.width = width;
		this.style = style;
		this.anchored = anchored;
	}
}

export class Screen {
	readonly cells: Cell[];
	/** How many control characters `put` has replaced. */
	controlsRefused = 0;

	constructor(
		readonly cols: number,
		readonly rows: number,
	) {
		this.cells = Array.from({ length: cols * rows }, () => new Cell());
	}

	cell(x: number, y: number): Cell {
		return this.cells[y * this.cols + x] as Cell;
	}

	/** Blank every cell to the terminal's default style. */
	clear(): void {
		for (const c of this.cells) c.set(" ", 1, PLAIN, false);
	}

	/**
	 * Draw `text` from (x, y), clipped to the screen; returns the column after the last cluster.
	 */
	put(x: number, y: number, text: string, style: Style = PLAIN): number {
		return this.write(x, y, text, style, false);
	}

	/**
	 * As `put`, for cells that are always positioned with an absolute cursor move (verification
	 * column, right border).
	 */
	putAnchored(x: number, y: number, text: string, style: Style = PLAIN): number {
		return this.write(x, y, text, style, true);
	}

	private write(x: number, y: number, text: string, style: Style, anchored: boolean): number {
		let col = x;
		if (y < 0 || y >= this.rows) return col;
		const clean = text.replace(CONTROLS, () => {
			this.controlsRefused++;
			return REPLACEMENT;
		});
		for (const cluster of graphemes(clean)) {
			const width = clusterWidth(cluster);
			if (width === 0) continue;
			if (col >= this.cols) break;
			if (col < 0) {
				if (col + width > 0) this.setCell(0, y, " ", 1, style, anchored);
			} else if (col + width > this.cols) {
				break;
			} else {
				this.setCell(col, y, cluster, width, style, anchored);
				if (width === 2) this.setCell(col + 1, y, "", 0, style, anchored);
			}
			col += width;
		}
		return col;
	}

	private setCell(
		x: number,
		y: number,
		text: string,
		width: 0 | 1 | 2,
		style: Style,
		anchored: boolean,
	): void {
		const target = this.cell(x, y);
		if (target.width === 0 && x > 0) this.cell(x - 1, y).set(" ", 1, target.style, false);
		if (target.width === 2 && x + 1 < this.cols) {
			this.cell(x + 1, y).set(" ", 1, target.style, false);
		}
		target.set(text, width, style, anchored);
	}
}
