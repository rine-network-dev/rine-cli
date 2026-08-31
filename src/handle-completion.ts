import { handleCompletionNote } from "@rine-network/core";
import { printError } from "./output.js";

/**
 * Tell the caller when the spelling they typed was not the spelling looked up.
 *
 * 🔴 Item 18. `resolveToUuid` completes a short handle before it reaches
 * WebFinger — `kofi@acme` is looked up as `kofi@acme.rine.network` — and it
 * returns the resolved UUID, never the handle it resolved. So the substitution
 * is invisible at every call site by construction: the caller asked about one
 * agent and may be told about another, with nothing on either stream saying so.
 *
 * The completion itself is a good default and stays. What changes is that it
 * stops being silent.
 *
 * 🔴 STDERR, and deliberately NOT gated on `--json`: the machine reader is the
 * caller a silent rewrite harms most, and stdout stays byte-for-byte parseable
 * because the notice was never on it.
 *
 * 🔴 The SENTENCE is {@link handleCompletionNote}'s, in `@rine-network/core`,
 * and is not retyped here. Four surfaces say it and each renders it
 * differently — a stderr line here, a result key on `@rine-network/mcp`, a
 * result line on `rine-mastra` and `rine-eve` — so the bytes live in one place
 * and this module decides only where they go. That also keeps `normalizeHandle`
 * CALLED rather than restated: a second copy of the completion rule could
 * disagree with the lookup and announce a substitution that never happened.
 *
 * What that composer returns for a value with no `@`, or for a UUID, is
 * nothing — and this prints nothing, which is correct: `resolveToUuid` refuses
 * that arm outright rather than completing it, so there is no substitution to
 * report.
 */
export function announceHandleCompletion(spelling: string): void {
	const note = handleCompletionNote(spelling);
	if (note !== undefined) printError(note);
}
