import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OrgEvent, RineApiError } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GENESIS_HASH,
	loadPosition,
	savePosition,
} from "../src/commands/org-events-chain.js";
import { runTail } from "../src/commands/tail-run.js";
import { TailExit } from "../src/commands/tail-alert.js";
import {
	ORG,
	chain,
	event,
	forkError,
	harness,
	page,
	text,
} from "./tail-fixtures.js";

const lastBody = (bodies: Record<string, unknown>[]) =>
	bodies.at(-1) as Record<string, unknown>;

describe("runTail: the chain", () => {
	it("test_tail_when_chain_is_intact_then_delivers_each_envelope_and_saves_after_the_sink_accepts", async () => {
		const events = chain(3);
		const h = harness([page(events), page([])]);
		expect(await runTail(h.run)).toBe(0);
		expect(h.bodies()).toEqual(events);
		expect(h.order).toEqual(["send:3", "save:3"]);
		expect(h.saved[0]).toEqual({
			seq: 3,
			hash: events[2]?.hash,
			chain_epoch: 1,
		});
		expect(h.asked).toEqual([
			{ after: 0, epoch: undefined },
			{ after: 3, epoch: 1 },
		]);
	});

	it("test_tail_when_an_event_is_skipped_then_exit_4_with_the_gap_text_an_alert_record_and_nothing_after_it", async () => {
		const [e1, , e3] = chain(3) as [OrgEvent, OrgEvent, OrgEvent];
		const h = harness([page([e1, e3])]);
		expect(await runTail(h.run)).toBe(TailExit.Chain);
		expect(h.logs).toEqual([
			"rine org events tail: event 3 does not follow the last event received. The log has a gap or has changed; investigate before restarting.",
		]);
		expect(h.bodies()[0]).toEqual(e1);
		expect(h.bodies()).toHaveLength(2);
		expect(lastBody(h.bodies())).toMatchObject({
			schema: "rine.collector_alert.v1",
			reason: "chain_gap",
			exit_code: 4,
			org_id: ORG,
		});
	});

	it("test_tail_when_the_log_forks_then_exit_4_with_the_gap_text", async () => {
		const h = harness([page([...chain(1), event(2, "f".repeat(64))])]);
		expect(await runTail(h.run)).toBe(4);
		expect(h.logs[0]).toContain(
			"event 2 does not follow the last event received",
		);
	});

	it("test_tail_when_a_body_changed_but_the_hash_is_the_original_then_exit_4_with_the_hash_text", async () => {
		const [e1, e2] = chain(2) as [OrgEvent, OrgEvent];
		const tampered = { ...e2, detail: { n: 99 } };
		const h = harness([page([e1, tampered])]);
		expect(await runTail(h.run)).toBe(4);
		expect(h.logs).toEqual([
			"rine org events tail: event 2 does not match its hash. The log has changed; investigate before restarting.",
		]);
		expect(lastBody(h.bodies())).toMatchObject({ reason: "chain_hash" });
	});

	it("test_tail_when_the_first_event_does_not_start_at_genesis_then_exit_4", async () => {
		const h = harness([page([event(1, "a".repeat(64))])]);
		expect(await runTail(h.run)).toBe(4);
		expect(h.bodies().filter((b) => b.schema === "rine.org_event.v1")).toEqual(
			[],
		);
	});

	it("test_tail_when_resumed_from_state_then_asks_after_it_and_requires_the_next_to_attach", async () => {
		const events = chain(4);
		const position = { seq: 2, hash: events[1]?.hash as string };
		const ok = harness([page(events.slice(2)), page([])], { position });
		expect(await runTail(ok.run)).toBe(0);
		expect(ok.asked[0]).toEqual({ after: 2, epoch: undefined });
		expect(ok.saved.map((p) => p.seq)).toEqual([4]);

		const bad = harness([page([event(3, "e".repeat(64))])], { position });
		expect(await runTail(bad.run)).toBe(4);
	});

	it("test_tail_when_started_after_seq_without_state_then_checks_the_seq_but_not_prev_hash", async () => {
		const events = chain(3);
		const ok = harness([page(events.slice(2)), page([])], { afterSeq: 2 });
		expect(await runTail(ok.run)).toBe(0);
		const skip = harness([page(events.slice(2))], { afterSeq: 1 });
		expect(await runTail(skip.run)).toBe(4);
	});

	it("test_tail_when_the_state_file_has_no_epoch_then_it_is_accepted_and_completed_from_the_first_page", async () => {
		const events = chain(3);
		const position = { seq: 1, hash: events[0]?.hash as string };
		const h = harness([page(events.slice(1)), page([])], { position });
		expect(await runTail(h.run)).toBe(0);
		expect(h.asked.map((a) => a.epoch)).toEqual([undefined, 1]);
		expect(h.saved.at(-1)?.chain_epoch).toBe(1);
	});
});

describe("runTail: refusals and retries", () => {
	it.each([
		["a 401", new RineApiError(401, "no", undefined, "invalid_token")],
		["a 403", new RineApiError(403, "no", undefined, "AuthorizationError")],
		[
			"a refused mint",
			new RineApiError(400, "revoked", undefined, "invalid_client"),
		],
	])(
		"test_tail_when_%s_then_exit_3_with_the_credential_text_and_an_alert_record",
		async (_n, err) => {
			const h = harness([err]);
			expect(await runTail(h.run)).toBe(TailExit.Auth);
			expect(h.logs).toEqual([text.auth]);
			expect(lastBody(h.bodies())).toMatchObject({
				reason: "auth_refused",
				exit_code: 3,
				message: text.auth,
			});
		},
	);

	it("test_tail_when_the_network_fails_then_says_so_backs_off_and_carries_on", async () => {
		vi.useFakeTimers();
		try {
			const events = chain(1);
			const h = harness([
				new TypeError("fetch failed"),
				new RineApiError(503, "down"),
				page(events),
				page([]),
			]);
			const done = runTail(h.run);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await done).toBe(0);
			expect(h.logs).toEqual([
				"rine org events tail: fetch failed; retrying in 1 s",
				expect.stringMatching(/retrying in 2 s$/),
			]);
			expect(h.bodies()).toEqual(events);
		} finally {
			vi.useRealTimers();
		}
	});

	it("test_tail_when_the_server_refuses_with_another_4xx_then_it_throws_instead_of_looping", async () => {
		const h = harness([new RineApiError(404, "gone")]);
		await expect(runTail(h.run)).rejects.toThrow("gone");
	});
});

describe("runTail: a restored server", () => {
	const base = chain(3);
	const forkHash = base[2]?.hash as string;

	it("test_tail_when_the_epoch_changed_and_events_are_held_past_the_fork_then_exit_5_with_the_range", async () => {
		const position = { seq: 5, hash: "b".repeat(64), chain_epoch: 1 };
		const h = harness([forkError(2, 3, forkHash)], { position });
		expect(await runTail(h.run)).toBe(TailExit.Fork);
		expect(h.logs).toEqual([text.fork(1, 2, 3)]);
		expect(lastBody(h.bodies())).toMatchObject({
			reason: "fork",
			exit_code: 5,
			old_epoch: 1,
			new_epoch: 2,
			fork_after_seq: 3,
			range: { from: 4, to: 5 },
		});
	});

	it("test_tail_when_the_epoch_changed_and_nothing_is_held_past_the_fork_then_exit_5_with_the_nothing_held_text_and_an_empty_range", async () => {
		const position = {
			seq: 2,
			hash: base[1]?.hash as string,
			chain_epoch: 1,
		};
		const h = harness([forkError(2, 3, forkHash)], { position });
		expect(await runTail(h.run)).toBe(TailExit.Fork);
		expect(h.logs).toEqual([text.forkNothingHeld(1, 2, 3)]);
		expect(lastBody(h.bodies())).toMatchObject({
			reason: "fork",
			range: null,
		});
	});

	it("test_tail_when_the_new_epoch_is_accepted_then_resumes_after_the_fork_point_and_the_next_event_must_attach_to_its_hash", async () => {
		const position = { seq: 5, hash: "b".repeat(64), chain_epoch: 1 };
		const first = event(4, forkHash, { chain_epoch: 2 });
		const second = event(5, first.hash, { chain_epoch: 2 });
		const h = harness(
			[
				forkError(2, 3, forkHash),
				page([first, second], undefined, 2),
				page([], undefined, 2),
			],
			{ position, acceptEpoch: 2 },
		);
		expect(await runTail(h.run)).toBe(0);
		expect(h.asked.slice(0, 2)).toEqual([
			{ after: 5, epoch: 1 },
			{ after: 3, epoch: 2 },
		]);
		expect(h.saved.at(-1)).toMatchObject({ seq: 5, chain_epoch: 2 });

		const wrong = harness(
			[
				forkError(2, 3, forkHash),
				page([event(4, "e".repeat(64))], undefined, 2),
			],
			{ position, acceptEpoch: 2 },
		);
		expect(await runTail(wrong.run)).toBe(TailExit.Chain);
	});

	it("test_tail_when_a_position_sits_on_the_fork_point_with_another_hash_then_exit_4_even_with_the_epoch_accepted", async () => {
		const position = { seq: 3, hash: "a".repeat(64), chain_epoch: 1 };
		const h = harness([forkError(2, 3, forkHash)], {
			position,
			acceptEpoch: 2,
		});
		expect(await runTail(h.run)).toBe(TailExit.Chain);
		expect(h.logs).toEqual([text.gap(4)]);
	});

	it("test_tail_when_another_epoch_is_accepted_then_it_still_stops", async () => {
		const position = { seq: 5, hash: "b".repeat(64), chain_epoch: 1 };
		const h = harness([forkError(3, 3, forkHash)], {
			position,
			acceptEpoch: 2,
		});
		expect(await runTail(h.run)).toBe(TailExit.Fork);
	});
});

describe("runTail: retention", () => {
	const floorHash = "d".repeat(64);
	const floor = { chain_epoch: 1, seq: 10, hash: floorHash };
	const afterFloor = () => {
		const first = event(11, floorHash);
		return [first, event(12, first.hash)];
	};

	it("test_tail_when_it_starts_fresh_and_the_first_event_follows_the_retained_hash_then_prints_the_pruning_text_and_carries_on", async () => {
		const events = afterFloor();
		const h = harness([page(events, floor), page([])]);
		expect(await runTail(h.run)).toBe(0);
		expect(h.logs).toEqual([text.pruned(10)]);
		expect(h.bodies()).toEqual(events);
		expect(h.saved.at(-1)?.seq).toBe(12);
	});

	it("test_tail_when_a_saved_position_is_below_the_floor_then_prints_the_unread_text_sends_the_alert_record_and_carries_on", async () => {
		const events = afterFloor();
		const position = { seq: 4, hash: "b".repeat(64), chain_epoch: 1 };
		const h = harness([page(events, floor), page([])], { position });
		expect(await runTail(h.run)).toBe(0);
		expect(h.logs).toEqual([text.prunedUnread(5, 10)]);
		expect(h.bodies()[0]).toMatchObject({
			schema: "rine.collector_alert.v1",
			reason: "pruned_unread",
			exit_code: null,
			range: { from: 5, to: 10 },
		});
		expect(h.bodies().slice(1)).toEqual(events);
	});

	it("test_tail_when_the_jump_is_not_the_retained_hash_then_exit_4_with_the_gap_text", async () => {
		const wrongHash = harness([page([event(11, "c".repeat(64))], floor)]);
		expect(await runTail(wrongHash.run)).toBe(TailExit.Chain);
		expect(wrongHash.logs).toEqual([text.gap(11)]);

		const noFloor = harness([page([event(11, floorHash)], null)]);
		expect(await runTail(noFloor.run)).toBe(TailExit.Chain);

		const farther = harness([page([event(12, floorHash)], floor)]);
		expect(await runTail(farther.run)).toBe(TailExit.Chain);
	});
});

describe("runTail: the sink", () => {
	it("test_tail_when_many_events_are_ready_then_sends_at_most_100_per_batch_and_saves_after_each", async () => {
		const events = chain(150);
		const h = harness([page(events), page([])]);
		expect(await runTail(h.run)).toBe(0);
		expect(h.order).toEqual(["send:100", "save:100", "send:50", "save:150"]);
		expect(h.bodies()).toEqual(events);
	});

	it("test_tail_when_the_receiver_answers_503_then_200_then_nothing_is_lost_nothing_repeats_and_the_position_waits_for_the_acceptance", async () => {
		vi.useFakeTimers();
		try {
			const events = chain(2);
			const h = harness([page(events), page([])], {}, (call) =>
				call === 0 ? "HTTP 503" : undefined,
			);
			const done = runTail(h.run);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await done).toBe(0);
			expect(h.logs).toEqual([text.sinkRefused("HEC", "HTTP 503", 1)]);
			expect(h.bodies()).toEqual(events);
			expect(h.order).toEqual(["send:2", "save:2"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("tail state file", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(join(tmpdir(), "rine-tail-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("test_state_when_saved_then_loads_back_and_a_missing_file_is_no_position", () => {
		const file = join(dir, "state.json");
		expect(loadPosition(file)).toBeUndefined();
		savePosition(file, { seq: 5, hash: "ab", chain_epoch: 2 });
		expect(loadPosition(file)).toEqual({ seq: 5, hash: "ab", chain_epoch: 2 });
	});

	it("test_state_when_written_before_epochs_existed_then_loads_without_one", () => {
		const file = join(dir, "state.json");
		fs.writeFileSync(file, `{"seq":5,"hash":"ab"}\n`);
		expect(loadPosition(file)).toEqual({ seq: 5, hash: "ab" });
	});

	it("test_state_when_not_a_tail_state_then_refuses_rather_than_starting_over", () => {
		const file = join(dir, "state.json");
		fs.writeFileSync(file, '{"seq":"x"}');
		expect(() => loadPosition(file)).toThrow(/not a tail state/);
		expect(GENESIS_HASH).toHaveLength(64);
	});
});
