import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { OrgEvent } from "@rine-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertRecord } from "../src/commands/tail-alert.js";
import {
	alertOutgoing,
	eventOutgoing,
	metadataOutgoing,
} from "../src/commands/tail-outgoing.js";
import {
	chooseSink,
	hecSink,
	otlpSink,
	parseOtlpHeaders,
} from "../src/commands/tail-sinks.js";
import {
	type Post,
	SinkRefusal,
	httpPost,
} from "../src/commands/tail-transport.js";
import { runTail } from "../src/commands/tail-run.js";
import fixtures from "./fixtures/tail-sink-payloads.json" with { type: "json" };
import { ORG, chain, harness, page, text } from "./tail-fixtures.js";

const envelope = fixtures.envelope as unknown as OrgEvent;

function recorder() {
	const posts: {
		url: string;
		headers: Record<string, string>;
		body: string;
	}[] = [];
	const post: Post = async (url, headers, body) => {
		posts.push({ url, headers, body });
	};
	return { posts, post };
}

describe("HEC", () => {
	it("test_hec_when_an_event_is_sent_then_the_post_matches_the_recorded_payload", async () => {
		const r = recorder();
		const sink = hecSink(
			"https://splunk.example:8088",
			"s3cret-token",
			text,
			r.post,
		);
		await sink.send([eventOutgoing(envelope), eventOutgoing(envelope)]);
		const [only] = r.posts;
		expect(only?.url).toBe(fixtures.hec.url);
		expect(only?.headers.Authorization).toBe(fixtures.hec.authorization);
		const expected = JSON.stringify({
			...fixtures.hec.line,
			event: envelope,
		});
		expect(only?.body).toBe(`${expected}\n${expected}`);
	});

	it("test_hec_when_an_alert_record_is_sent_then_it_has_the_alert_sourcetype_and_no_seq", async () => {
		const r = recorder();
		const sink = hecSink("https://splunk.example", "t", text, r.post);
		const record = alertRecord(
			{ code: 6, reason: "silenced", text: "x" },
			ORG,
			new Date("2026-11-09T10:00:00Z"),
		);
		await sink.send([alertOutgoing(record)]);
		const sent = JSON.parse(r.posts[0]?.body ?? "{}");
		expect(sent).toMatchObject({
			sourcetype: "rine:collector:alert",
			event: record,
			fields: { org_id: ORG, kind: "silenced", signal: "alert" },
		});
		expect(sent.fields.seq).toBeUndefined();
	});
});

describe("OTLP", () => {
	it("test_otlp_when_an_event_is_sent_then_the_post_matches_the_recorded_payload", async () => {
		const r = recorder();
		const sink = otlpSink(
			"https://otel.example:4318",
			"x-api-key=abc, other=1",
			text,
			r.post,
		);
		await sink.send([eventOutgoing(envelope)]);
		const [only] = r.posts;
		expect(only?.url).toBe(fixtures.otlp.url);
		expect(only?.headers).toMatchObject({
			"x-api-key": "abc",
			other: "1",
			"Content-Type": "application/json",
		});
		const body = JSON.parse(only?.body ?? "{}");
		const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
		expect(record).toEqual({
			...fixtures.otlp.record,
			body: { stringValue: JSON.stringify(envelope) },
		});
	});

	it("test_otlp_when_signals_differ_then_severity_follows_the_class", async () => {
		const r = recorder();
		const sink = otlpSink("https://otel.example", undefined, text, r.post);
		const summary = { ...envelope, kind: "counterparty.inbound_summary" };
		const plain = { ...envelope, kind: "agent.created" };
		await sink.send([
			eventOutgoing(summary as OrgEvent),
			eventOutgoing(plain as OrgEvent),
			alertOutgoing(
				alertRecord({ code: 4, reason: "chain_gap", text: "x" }, ORG),
			),
		]);
		const records = JSON.parse(r.posts[0]?.body ?? "{}").resourceLogs[0]
			.scopeLogs[0].logRecords;
		expect(
			records.map((x: { severityText: string }) => x.severityText),
		).toEqual(["INFO", "INFO", "ERROR"]);
	});

	it("test_otlp_headers_when_parsed_then_keys_and_values_are_split_on_the_first_equals", () => {
		expect(parseOtlpHeaders("a=1,b=x=y")).toEqual({ a: "1", b: "x=y" });
		expect(parseOtlpHeaders(undefined)).toEqual({});
	});

	it("test_metadata_when_a_row_is_sent_then_it_has_the_metadata_sourcetype", () => {
		const out = metadataOutgoing(
			{ seq: 3, chain_epoch: 1, created_at: "2026-11-09T10:00:00Z" } as never,
			ORG,
		);
		expect(out).toMatchObject({
			sourcetype: "rine:org_metadata",
			fields: { seq: 3, org_id: ORG },
		});
	});
});

describe("transport rules", () => {
	it.each([
		["hec", "http://splunk.example:8088"],
		["otlp", "http://otel.example:4318"],
	])(
		"test_%s_when_plain_http_to_another_machine_then_refused_with_the_https_text",
		(flag, url) => {
			const make = () =>
				flag === "hec"
					? chooseSink({ hec: url, env: { RINE_HEC_TOKEN: "t" }, text })
					: chooseSink({ otlp: url, env: {}, text });
			expect(make).toThrow(
				`rine org events tail: --${flag} needs an https:// address unless the receiver runs on this machine.`,
			);
		},
	);

	it.each([
		"http://127.0.0.1:8088",
		"http://localhost:8088",
		"http://[::1]:8088",
		"https://x.example",
	])("test_hec_when_the_address_is_%s_then_accepted", (url) => {
		expect(() =>
			chooseSink({ hec: url, env: { RINE_HEC_TOKEN: "t" }, text }),
		).not.toThrow();
	});

	it("test_sink_choice_when_both_flags_or_no_token_then_refused_and_no_flag_means_stdout", () => {
		expect(() =>
			chooseSink({ hec: "https://a", otlp: "https://b", env: {}, text }),
		).toThrow(/not both/);
		expect(() => chooseSink({ hec: "https://a", env: {}, text })).toThrow(
			/RINE_HEC_TOKEN/,
		);
		expect(chooseSink({ env: {}, text }).name).toBe("stdout");
	});

	it("test_post_when_the_receiver_answers_503_then_200_then_refusal_then_success", async () => {
		const answers = [503, 200];
		const seen: (string | undefined)[] = [];
		const server = http.createServer((req, res) => {
			seen.push(req.headers.authorization);
			res.statusCode = answers.shift() ?? 200;
			res.end();
		});
		await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
		try {
			await expect(
				httpPost(url, { Authorization: "Splunk t" }, "{}"),
			).rejects.toEqual(new SinkRefusal("HTTP 503"));
			await httpPost(url, { Authorization: "Splunk t" }, "{}");
			expect(seen).toEqual(["Splunk t", "Splunk t"]);
			server.close();
			await expect(httpPost(url, {}, "{}")).rejects.toEqual(
				new SinkRefusal("unreachable"),
			);
		} finally {
			server.close();
		}
	});
});

describe("credentials stay out of sight", () => {
	afterEach(() => vi.useRealTimers());

	it("test_tail_when_the_token_comes_from_the_environment_then_it_is_in_no_log_message_alert_record_or_refusal", async () => {
		vi.useFakeTimers();
		const token = "tok-9f3a-very-secret";
		const sunk: string[] = [];
		const post: Post = async (url, headers, body) => {
			sunk.push(url, body);
			expect(headers.Authorization).toBe(`Splunk ${token}`);
			throw new SinkRefusal("HTTP 503");
		};
		const sink = chooseSink({
			hec: "https://splunk.example",
			env: { RINE_HEC_TOKEN: token },
			text,
			post,
		});
		const h = harness([page(chain(1)), page([])], { sink, giveUpMs: 5000 });
		const done = runTail(h.run);
		await vi.advanceTimersByTimeAsync(60_000);
		await done;
		expect(h.logs.length).toBeGreaterThan(0);
		expect(JSON.stringify([h.logs, sunk])).not.toContain(token);
		expect(process.argv.join(" ")).not.toContain(token);
	});
});
