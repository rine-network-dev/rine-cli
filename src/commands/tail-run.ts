/** Runs the page loop beside the head watch and turns what ends them into a message, a record and an exit code. */
import { TailExit, type TailStop, alertRecord } from "./tail-alert.js";
import { type TailRun, runPages } from "./tail-loop.js";
import { type TailProgress, watchHead } from "./tail-head.js";
import { alertOutgoing } from "./tail-outgoing.js";
import { SinkRefusal } from "./tail-transport.js";

/** Collects until stopped or ended; returns the process exit code. */
export async function runTail<T>(run: TailRun<T>): Promise<number> {
	const inner = new AbortController();
	const stopInner = () => inner.abort();
	if (run.signal.aborted) return 0;
	run.signal.addEventListener("abort", stopInner, { once: true });
	const progress: TailProgress = {
		lastSeq: run.position?.seq ?? run.afterSeq,
		chainEpoch: run.position?.chain_epoch,
		caughtUp: false,
		sinkBlocked: false,
	};
	let ended: TailStop | undefined;
	const settle = async (work: Promise<TailStop | undefined>) => {
		const stop = await work;
		ended ??= stop;
		inner.abort();
	};
	try {
		await Promise.all([
			settle(runPages(run, progress, inner.signal)),
			settle(
				run.head === undefined
					? new Promise<undefined>((resolve) =>
							inner.signal.addEventListener("abort", () => resolve(undefined)),
						)
					: watchHead(run.head, progress, inner.signal, run.text),
			),
		]);
	} finally {
		run.signal.removeEventListener("abort", stopInner);
		inner.abort();
	}
	if (ended === undefined) return 0;
	run.log(ended.text);
	if (ended.code !== TailExit.SinkDown) {
		try {
			await run.sink.send([alertOutgoing(alertRecord(ended, run.orgId))]);
		} catch (err) {
			if (!(err instanceof SinkRefusal)) throw err;
		}
	}
	return ended.code;
}
