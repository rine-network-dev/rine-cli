import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	type JcsJson,
	type OrgEvent,
	type RetentionFloor,
	jcsCanonicalize,
	writeAtomic,
} from "@rine-network/core";

/** The `prev_hash` of an org's first event. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * The last event a tail verified: where the next one must attach. `chain_epoch` is the epoch the
 * collector read it under; a state file written before epochs existed has none and is completed
 * from the first page.
 */
export interface ChainPosition {
	seq: number;
	hash: string;
	chain_epoch?: number;
}

/** Events a retention pass removed between the collector's position and the first event it got. */
export interface PrunedRange {
	from: number;
	to: number;
}

/** One verified event: the position it leaves, and the pruned range it jumped over, if any. */
export interface ChainStep {
	position: ChainPosition;
	pruned?: PrunedRange;
}

export const ChainFault = { Hash: "hash", Break: "break" } as const;
export type ChainFault = (typeof ChainFault)[keyof typeof ChainFault];

/** The log changed or has a gap. Carries the event it was found at. */
export class ChainBreak extends Error {
	constructor(
		readonly fault: ChainFault,
		readonly seq: number,
	) {
		super(`chain ${fault} at event ${seq}`);
	}
}

/** SHA-256 hex over the RFC 8785 form of the envelope without its `hash`. */
export function eventHash(event: OrgEvent): string {
	const { hash: _hash, ...body } = event;
	return createHash("sha256")
		.update(jcsCanonicalize(body as JcsJson), "utf-8")
		.digest("hex");
}

/**
 * The range a retention pass removed, when `event` is the first one after it: the floor's hash is
 * its `prev_hash` and it directly follows the floor. Undefined when it attaches where it should.
 */
function prunedBefore(
	event: OrgEvent,
	lastSeq: number,
	floor: RetentionFloor | null | undefined,
): PrunedRange | undefined {
	if (floor == null || lastSeq >= floor.seq) return undefined;
	if (event.seq !== floor.seq + 1 || event.prev_hash !== floor.hash)
		return undefined;
	return { from: lastSeq + 1, to: floor.seq };
}

/**
 * Checks one event against what came before it, recomputing its hash from the body.
 * `afterSeq` is where the page started, so a position-less resume still catches a gap.
 * `floor` explains a jump: the retained hash a retention pass left at the end of the removed range.
 */
export function verifyEvent(
	event: OrgEvent,
	previous: ChainPosition | undefined,
	afterSeq: number,
	floor?: RetentionFloor | null,
): ChainStep {
	if (eventHash(event) !== event.hash) {
		throw new ChainBreak(ChainFault.Hash, event.seq);
	}
	const lastSeq = previous?.seq ?? afterSeq;
	const position = { seq: event.seq, hash: event.hash };
	const pruned = prunedBefore(event, lastSeq, floor);
	if (pruned !== undefined) return { position, pruned };
	if (event.seq !== lastSeq + 1)
		throw new ChainBreak(ChainFault.Break, event.seq);
	const expected =
		previous?.hash ?? (afterSeq === 0 ? GENESIS_HASH : undefined);
	if (expected !== undefined && event.prev_hash !== expected) {
		throw new ChainBreak(ChainFault.Break, event.seq);
	}
	return { position };
}

/** The position saved by an earlier run, or undefined when there is no usable state file. */
export function loadPosition(file: string): ChainPosition | undefined {
	if (!fs.existsSync(file)) return undefined;
	const parsed = JSON.parse(
		fs.readFileSync(file, "utf-8"),
	) as Partial<ChainPosition>;
	if (!Number.isSafeInteger(parsed.seq) || typeof parsed.hash !== "string") {
		throw new Error(
			`State file ${file} is not a tail state; remove it to start again.`,
		);
	}
	return {
		seq: parsed.seq as number,
		hash: parsed.hash,
		...(Number.isSafeInteger(parsed.chain_epoch)
			? { chain_epoch: parsed.chain_epoch as number }
			: {}),
	};
}

export function savePosition(file: string, position: ChainPosition): void {
	writeAtomic(file, `${JSON.stringify(position)}\n`);
}
