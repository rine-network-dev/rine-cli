/**
 * Where `tail` sends what it read: stdout, a Splunk HEC receiver or an OTLP/HTTP logs receiver.
 * A receiver that does not accept a batch throws `SinkRefusal`; its credentials come from the
 * environment and appear in no message, log or alert record.
 */
import { type Outgoing, Severity } from "./tail-outgoing.js";
import {
	type Post,
	type Sink,
	SinkConfigError,
	SinkEnv,
	SinkName,
	checkTransport,
	endpoint,
	httpPost,
} from "./tail-transport.js";
import type { TailText } from "./tail-text.js";

const HEC_PATH = "/services/collector/event";
const OTLP_PATH = "/v1/logs";

const hecEvent = (o: Outgoing) =>
	JSON.stringify({
		...(o.time === undefined ? {} : { time: Date.parse(o.time) / 1000 }),
		source: "rine",
		sourcetype: o.sourcetype,
		event: o.body,
		fields: o.fields,
	});

export function hecSink(
	address: string,
	token: string,
	text: TailText,
	post: Post = httpPost,
): Sink {
	const url = endpoint(checkTransport(address, SinkName.Hec, text), HEC_PATH);
	const headers = {
		Authorization: `Splunk ${token}`,
		"Content-Type": "application/json",
	};
	return {
		name: SinkName.Hec,
		send: (batch) => post(url, headers, batch.map(hecEvent).join("\n")),
	};
}

const SEVERITY_NUMBER: Record<Severity, number> = {
	[Severity.Info]: 9,
	[Severity.Warn]: 13,
	[Severity.Error]: 17,
};

const str = (key: string, value: string) => ({
	key,
	value: { stringValue: value },
});
const int = (key: string, value: number) => ({
	key,
	value: { intValue: String(value) },
});

function otlpRecord(o: Outgoing) {
	const nanos =
		o.time === undefined
			? undefined
			: String(BigInt(Date.parse(o.time)) * 1_000_000n);
	const { org_id, chain_epoch, seq, kind, signal } = o.fields;
	return {
		...(nanos === undefined ? {} : { timeUnixNano: nanos }),
		severityNumber: SEVERITY_NUMBER[o.severity],
		severityText: o.severity,
		body: { stringValue: JSON.stringify(o.body) },
		attributes: [
			...(org_id === undefined ? [] : [str("rine.org_id", org_id)]),
			...(chain_epoch === undefined
				? []
				: [int("rine.chain_epoch", chain_epoch)]),
			...(seq === undefined ? [] : [int("rine.seq", seq)]),
			str("rine.kind", kind),
			str("rine.signal", signal),
		],
	};
}

/** `k=v,k2=v2`, the form OTEL_EXPORTER_OTLP_HEADERS uses. */
export function parseOtlpHeaders(
	raw: string | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of (raw ?? "").split(",")) {
		const at = pair.indexOf("=");
		if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
	}
	return out;
}

export function otlpSink(
	address: string,
	rawHeaders: string | undefined,
	text: TailText,
	post: Post = httpPost,
): Sink {
	const url = endpoint(checkTransport(address, SinkName.Otlp, text), OTLP_PATH);
	const headers = {
		...parseOtlpHeaders(rawHeaders),
		"Content-Type": "application/json",
	};
	return {
		name: SinkName.Otlp,
		send: (batch) =>
			post(
				url,
				headers,
				JSON.stringify({
					resourceLogs: [
						{
							resource: { attributes: [str("service.name", "rine-tail")] },
							scopeLogs: [
								{
									scope: { name: "rine.org" },
									logRecords: batch.map(otlpRecord),
								},
							],
						},
					],
				}),
			),
	};
}

/** Standard output, one JSON line per record: the envelope, the row or the alert record. */
export function stdoutSink(write: (line: string) => void = console.log): Sink {
	return {
		name: SinkName.Stdout,
		send: async (batch) => {
			for (const o of batch) write(JSON.stringify(o.body));
		},
	};
}

export interface SinkChoice {
	hec?: string;
	otlp?: string;
	env: NodeJS.ProcessEnv;
	text: TailText;
	post?: Post;
}

/** The sink the flags name: `--hec`, `--otlp`, or stdout when neither is given. */
export function chooseSink(choice: SinkChoice): Sink {
	const { hec, otlp, env, text, post } = choice;
	if (hec !== undefined && otlp !== undefined)
		throw new SinkConfigError("Choose one of --hec and --otlp, not both.");
	if (hec !== undefined) {
		const token = env[SinkEnv.HecToken];
		if (!token)
			throw new SinkConfigError(
				`--hec needs the token in ${SinkEnv.HecToken}.`,
			);
		return hecSink(hec, token, text, post);
	}
	if (otlp !== undefined)
		return otlpSink(otlp, env[SinkEnv.OtlpHeaders], text, post);
	return stdoutSink();
}
