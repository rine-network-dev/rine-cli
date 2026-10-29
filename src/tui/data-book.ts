/**
 * What the poller has seen: each row's first verified result, the findings already told, and the
 * window to read next.
 */
import {
	findingKey,
	type ReadFinding,
	ReadGapReason,
	type ReadMessage,
	type ReadPage,
} from "@rine-network/core";
import { MAX_LOADED_ROWS } from "./state-data.js";

/** A poll reads this far behind the newest row it has seen. */
export const OVERLAP_MS = 30_000;
/**
 * A row dated further ahead than this is clamped, so one wrong clock cannot push the window past
 * real rows.
 */
export const FUTURE_CLAMP_MS = 60_000;

interface Known {
	/** The result that counts: the first verified one, or the latest gap. */
	message: ReadMessage;
	flagged: boolean;
}

export interface Absorbed {
	/**
	 * Messages the view has not seen in this form: new, a gap that opened or changed, a new
	 * equivocation.
	 */
	readonly changed: readonly ReadMessage[];
	/** Findings not told before. */
	readonly findings: readonly ReadFinding[];
}

/** A row whose sender could not be checked yet: a later verdict replaces it. */
const provisional = (message: ReadMessage): boolean =>
	message.verification === "unverifiable";

/** Drop the oldest entries until at most `MAX_LOADED_ROWS` remain; insertion order is age. */
function evictOldest(held: Map<string, unknown> | Set<string>): void {
	for (const key of held.keys()) {
		if (held.size <= MAX_LOADED_ROWS) return;
		held.delete(key);
	}
}

export class RowBook {
	readonly #known = new Map<string, Known>();
	readonly #findings = new Set<string>();
	#newestMicros: number | null = null;

	clear(): void {
		this.#known.clear();
		this.#findings.clear();
		this.#newestMicros = null;
	}

	/** A finding is told once per group, so equal gaps from two groups both reach the user. */
	absorb(page: ReadPage, nowMs: number): Absorbed {
		const changed: ReadMessage[] = [];
		const ceiling = (nowMs + FUTURE_CLAMP_MS) * 1000;
		for (const message of page.items) {
			const micros = Math.min(message.row.createdAtMicros, ceiling);
			this.#newestMicros = Math.max(this.#newestMicros ?? micros, micros);
			const shown = this.#fold(message);
			if (shown !== null) changed.push(shown);
		}
		const findings = page.findings.filter((finding) => {
			const key = findingKey(finding);
			if (this.#findings.has(key)) return false;
			this.#findings.add(key);
			return true;
		});
		evictOldest(this.#known);
		evictOldest(this.#findings);
		return { changed, findings };
	}

	/**
	 * The oldest instant a poll must cover: the overlap window, or further back for a row still
	 * waiting on keys.
	 */
	since(): string | undefined {
		if (this.#newestMicros === null) return undefined;
		const waiting = [...this.#known.values()]
			.filter(
				({ message }) => message.gap?.reason === ReadGapReason.KeysUnavailable,
			)
			.map(({ message }) => message.row.createdAtMicros);
		const from = waiting.reduce(
			(oldest, micros) => Math.min(oldest, micros),
			this.#newestMicros - OVERLAP_MS * 1000,
		);
		return new Date(Math.floor(from / 1000)).toISOString();
	}

	#fold(message: ReadMessage): ReadMessage | null {
		const known = this.#known.get(message.row.id);
		if (known === undefined) {
			this.#known.set(message.row.id, { message, flagged: false });
			return message;
		}
		if (known.message.gap !== null) {
			if (message.gap?.reason === known.message.gap.reason) return null;
			this.#known.set(message.row.id, { message, flagged: false });
			return message;
		}
		if (provisional(known.message) && !provisional(message)) {
			this.#known.set(message.row.id, { message, flagged: false });
			return message;
		}
		const unchanged = Buffer.compare(
			known.message.row.ciphertext,
			message.row.ciphertext,
		) === 0;
		if (known.flagged || unchanged) return null;
		known.flagged = true;
		return { ...known.message, equivocation: true };
	}
}
