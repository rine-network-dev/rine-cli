/** What every sink shares: its name, the refusals, and the HTTP transport rules. */
import type { Outgoing } from "./tail-outgoing.js";
import type { TailText } from "./tail-text.js";

export const SinkName = { Stdout: "stdout", Hec: "HEC", Otlp: "OTLP" } as const;
export type SinkName = (typeof SinkName)[keyof typeof SinkName];

/** The environment variables that carry a receiver's credentials. */
export const SinkEnv = {
	HecToken: "RINE_HEC_TOKEN",
	OtlpHeaders: "RINE_OTLP_HEADERS",
} as const;

export const BATCH_SIZE = 100;
const SEND_TIMEOUT_MS = 20_000;

/** The receiver did not accept the batch; `status` is safe to print. */
export class SinkRefusal extends Error {
	constructor(readonly status: string) {
		super(`sink refused: ${status}`);
	}
}

/** The flags or environment name a receiver that cannot be used. */
export class SinkConfigError extends Error {}

export interface Sink {
	name: SinkName;
	send(batch: Outgoing[]): Promise<void>;
}

export type Post = (
	url: string,
	headers: Record<string, string>,
	body: string,
) => Promise<void>;

/** A POST that treats anything but a 2xx as a refusal and says nothing of the request. */
export const httpPost: Post = async (url, headers, body) => {
	let status: number;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		status = res.status;
		await res.arrayBuffer().catch(() => undefined);
	} catch {
		throw new SinkRefusal("unreachable");
	}
	if (status < 200 || status >= 300) throw new SinkRefusal(`HTTP ${status}`);
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Throws the https-needed text unless `address` is https, or http to this machine. */
export function checkTransport(
	address: string,
	name: SinkName,
	text: TailText,
): URL {
	const refusal = new SinkConfigError(text.plainHttp(name.toLowerCase()));
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw refusal;
	}
	const local = LOOPBACK.has(url.hostname) || /^127\./.test(url.hostname);
	if (url.protocol === "https:" || (url.protocol === "http:" && local))
		return url;
	throw refusal;
}

export function endpoint(url: URL, path: string): string {
	const out = new URL(url);
	if (!out.pathname.endsWith(path))
		out.pathname = `${out.pathname.replace(/\/$/, "")}${path}`;
	return out.toString();
}
