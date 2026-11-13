/** The words `tail` prints, exact. */

export const EVENTS_TAIL = "rine org events tail";
export const METADATA_TAIL = "rine org metadata tail";

/** The text of one tail command; `command` is the prefix every line starts with. */
export function tailText(command: string) {
	const p = `${command}:`;
	return {
		retry: (what: string, seconds: number) =>
			`${p} ${what}; retrying in ${seconds} s`,
		auth: `${p} the server refused this credential. The organisation may be erased, the key revoked or the credential expired; check which before restarting.`,
		gap: (seq: number) =>
			`${p} event ${seq} does not follow the last event received. The log has a gap or has changed; investigate before restarting.`,
		hash: (seq: number) =>
			`${p} event ${seq} does not match its hash. The log has changed; investigate before restarting.`,
		fork: (old: number, current: number, forkSeq: number) =>
			`${p} the log moved from chain epoch ${old} to ${current}, so the server was restored from a backup. Events after event ${forkSeq} that this collector already holds are no longer on the server; keep them, investigate, then restart with --accept-epoch ${current}.`,
		forkNothingHeld: (old: number, current: number, forkSeq: number) =>
			`${p} the log moved from chain epoch ${old} to ${current}, so the server was restored from a backup. This collector holds no event after event ${forkSeq}, so its copy lost nothing; restart with --accept-epoch ${current}.`,
		silenced: (seconds: number) =>
			`${p} the server has not answered a signed head check for ${seconds} s. The log may be silenced; investigate before restarting.`,
		headInvalid: `${p} the server's head check failed verification. The log may be silenced or replayed; investigate before restarting.`,
		stalled: (seconds: number) =>
			`${p} events have waited ${seconds} s to enter the log. Recording has stalled; investigate before restarting.`,
		truncated: (seq: number, last: number) =>
			`${p} the log now ends at event ${seq}, before the last event received (${last}). The log was truncated; investigate before restarting.`,
		withheld: (seq: number, seconds: number) =>
			`${p} the server reports event ${seq} but has not returned it for ${seconds} s. The log may be withheld; investigate before restarting.`,
		pruned: (seq: number) =>
			`${p} events up to ${seq} were removed at the end of their retention period; the chain continues from the retained hash.`,
		sinkRefused: (sink: string, status: string, seconds: number) =>
			`${p} the ${sink} receiver did not accept the events (${status}); retrying in ${seconds} s`,
		plainHttp: (sink: string) =>
			`${p} --${sink} needs an https:// address unless the receiver runs on this machine.`,
		noHead: `${p} this server does not offer a signed head check, so silence cannot be detected. Upgrade the server before collecting.`,
		prunedUnread: (from: number, to: number) =>
			`${p} events ${from} to ${to} were removed at the end of their retention period before this collector read them. They are missing from this collector's copy.`,
		sinkDown: (sink: string, seconds: number) =>
			`${p} the ${sink} receiver has refused every batch for ${seconds} s. The server is answering; fix the receiver, then restart. Events are kept on the server until their retention period ends.`,
	};
}
export type TailText = ReturnType<typeof tailText>;
