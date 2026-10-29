/**
 * The poller: reads the org feed on a cadence and tells the view what changed. One implementation serves the
 * interactive app and the line feed. It reads the newest page first, then re-reads a window that overlaps the last
 * one, so rows committed late are caught, and it keeps a row's first verified result.
 */
import type { ActivityQuery, ReadMessage, ReadPage } from "@rine-network/core";
import { RowBook } from "./data-book.js";
import { classifyFailure } from "./data-failure.js";
import {
	type DataEvent,
	type DataFilter,
	NO_FILTER,
	type PollerOptions,
	type Resume,
} from "./data-types.js";
import { FeedErrorCode, PageKind } from "./feed-schema.js";

export const PAGE_LIMIT = 100;
export const MAX_POLL_PAGES = 3;
export const DEFAULT_POLL_S = 5;

export class Poller {
	readonly #options: PollerOptions;
	readonly #now: () => number;
	readonly #pollS: number;
	readonly #book = new RowBook();
	#filter: DataFilter;
	#resume: Resume | null = null;
	#follow = true;
	#stopped = false;
	/** True until the newest page of the current slice has been read. */
	#unloaded = true;
	#rateLimitedS = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(options: PollerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#pollS = options.pollS ?? DEFAULT_POLL_S;
		this.#filter = options.filter ?? NO_FILTER;
	}

	/** Forget what was loaded, read the newest page, then poll on the cadence while following. */
	start(): Promise<void> {
		return this.#enqueue(() => this.#initial());
	}

	/** Stop for good, after the read in flight. */
	async stop(): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#timer);
		await this.#tail;
	}

	/** Following polls on the cadence; paused, only `start` and `poll` read. */
	setFollow(follow: boolean): void {
		this.#follow = follow;
		if (follow) this.#schedule(0);
		else clearTimeout(this.#timer);
	}

	/** One poll now. */
	poll(): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		return this.#enqueue(() => this.#poll());
	}

	/** Reading under a filter starts from the newest page of that slice. */
	setFilter(filter: DataFilter): Promise<void> {
		this.#filter = filter;
		return this.start();
	}

	/** The page before `cursor`. */
	older(cursor: string): Promise<void> {
		return this.#enqueue(() =>
			this.#guarded(async () => {
				const page = await this.#read({ cursor, limit: PAGE_LIMIT });
				this.#emitPage(PageKind.Older, page, this.#absorb(page));
			}),
		);
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.#tail.then(task);
		this.#tail = run.catch(() => undefined);
		return run;
	}

	#read(query: ActivityQuery): Promise<ReadPage> {
		return this.#options.reader.read({
			...query,
			...(this.#filter.agentId === null ? {} : { agent: this.#filter.agentId }),
			...(this.#filter.groupId === null
				? {}
				: { groupId: this.#filter.groupId }),
		});
	}

	#initial(): Promise<void> {
		this.#unloaded = true;
		return this.#guarded(async () => {
			const page = await this.#read({ limit: PAGE_LIMIT });
			this.#book.clear();
			this.#resume = null;
			this.#unloaded = false;
			this.#emitPage(PageKind.Initial, page, this.#absorb(page));
		});
	}

	async #poll(): Promise<void> {
		const wait = this.#bucketWaitMs();
		if (wait > 0) return this.#schedule(wait);
		if (this.#unloaded) return this.#initial();
		await this.#guarded(async () => {
			let next: Resume = this.#resume ?? {
				since: this.#book.since(),
				cursor: null,
			};
			let count = 0;
			for (let pages = 0; pages < MAX_POLL_PAGES; pages++) {
				if (pages > 0 && this.#bucketWaitMs() > 0) break;
				this.#resume = next;
				const page = await this.#read({ ...next, limit: PAGE_LIMIT });
				const rows = this.#absorb(page);
				count += rows.length;
				if (rows.length > 0)
					this.#emit({ type: "rows", kind: PageKind.Poll, rows });
				next = { since: next.since, cursor: page.nextCursor };
				this.#resume = page.nextCursor === null ? null : next;
				if (page.nextCursor === null) break;
			}
			this.#emit({
				type: "page",
				kind: PageKind.Poll,
				count,
				olderCursor: null,
			});
		});
	}

	/** An empty bucket postpones a poll to when a token is back. */
	#bucketWaitMs(): number {
		return this.#options.bucket?.msUntilToken() ?? 0;
	}

	/** Fold a page into what is known; returns the messages the view has not seen in this form. */
	#absorb(page: ReadPage): readonly ReadMessage[] {
		const seen = this.#book.absorb(page, this.#now());
		for (const finding of seen.findings) this.#emit({ type: "finding", finding });
		return seen.changed;
	}

	#emitPage(kind: PageKind, page: ReadPage, rows: readonly ReadMessage[]): void {
		this.#emit({
			type: "page",
			kind,
			count: rows.length,
			olderCursor: page.nextCursor,
		});
		this.#emit({ type: "rows", kind, rows });
	}

	#emit(event: DataEvent): void {
		this.#options.emit(event);
	}

	async #guarded(task: () => Promise<void>): Promise<void> {
		try {
			await task();
		} catch (err) {
			this.#failed(err);
			return;
		}
		this.#rateLimitedS = 0;
		this.#schedule(this.#pollS * 1000);
	}

	/** Report a failure the poller can wait out and plan the retry; anything else is a defect and propagates. */
	#failed(err: unknown): void {
		const { code, retryS } = classifyFailure(err, this.#pollS, this.#rateLimitedS);
		this.#emit({ type: "error", code, retryS });
		if (retryS === null) {
			this.#stopped = true;
			clearTimeout(this.#timer);
			return;
		}
		if (code === FeedErrorCode.RateLimited) this.#rateLimitedS = retryS;
		this.#schedule(retryS * 1000);
	}

	#schedule(ms: number): void {
		clearTimeout(this.#timer);
		if (this.#stopped || !this.#follow) return;
		this.#timer = setTimeout(() => {
			void this.poll();
		}, ms);
	}
}
