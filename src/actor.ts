import {
	ACTING_AGENT_ENV,
	ACTOR_SURFACES,
	normalizeActor,
	singleActorValue,
} from "@rine-network/core";
import { type Command, Option } from "commander";
import type { GlobalOpts } from "./types.js";

/**
 * How the CLI spells the acting agent, in the one place it is spelled.
 *
 * `--agent` is declared per subcommand and never on the program: commander
 * resolves a parent's declared options against the whole argv before it
 * dispatches (`commander/lib/command.js:~1672-1693`), so a program-level
 * `--agent` would steal the flag from `onboard --agent-name`, `send` and
 * `group invite`. The retired spellings — the program's `--as` and
 * `send --from` — stay accepted and are the *same rung* as `--agent`, so two
 * of them that disagree refuse rather than one silently winning.
 *
 * The refusal text, the comparison and the normalisation all come from
 * `rine-core`; nothing here re-implements them, because the MCP server and both
 * SDKs have to print the same sentence.
 */

/** What `--agent` says in `--help` when a command has nothing to add. */
const ACTOR_DESCRIPTION = "which agent is acting (name, handle, or agent ID)";

/** How `--help` mentions the rung below the flag, wherever the flag appears. */
const ACTOR_ENV_HINT = `(env: ${ACTING_AGENT_ENV})`;

/**
 * Every actor spelling this process declared, and the label its refusal uses.
 *
 * Keyed by the `Option` object rather than by flag string because `webhook
 * list --agent` is a *filter* — the same flag, a different question — and a
 * name comparison cannot tell them apart.
 */
const ACTOR_FLAGS = new WeakMap<Option, string>();

/**
 * The actor flag, for a subcommand that needs to know who is acting.
 *
 * It deliberately carries no commander `.env()`. `RINE_AGENT` is rung 3 of the
 * ladder for *every* command that resolves an actor, including the many that
 * declare no flag at all, so it is read once where the ladder is climbed
 * (`acting-agent.ts`) rather than a second time here — a flag that filled
 * itself from the environment would then have to be told apart from one the
 * caller typed, or the conflict check would refuse a pairing the caller never
 * made. The help text still says where the value can come from.
 */
export function actorOption(description: string = ACTOR_DESCRIPTION): Option {
	const option = new Option(
		`${ACTOR_SURFACES.cli.canonical} <agent>`,
		`${description} ${ACTOR_ENV_HINT}`,
	);
	ACTOR_FLAGS.set(option, ACTOR_SURFACES.cli.canonical);
	return option;
}

/**
 * A retired spelling of the actor flag, still accepted.
 *
 * The *same rung* as `--agent`, which is what makes two of them that disagree
 * a refusal rather than a precedence rule.
 */
export function actorAliasOption(flags: string, description: string): Option {
	const option = new Option(flags, description);
	ACTOR_FLAGS.set(option, flags.split(" ")[0] ?? flags);
	return option;
}

function isCommand(value: unknown): value is Command {
	const candidate = value as Command | undefined;
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		typeof candidate.getOptionValue === "function" &&
		Array.isArray(candidate.options)
	);
}

/**
 * The command commander appended to the action's arguments, when there is one.
 *
 * `Command._actionHandler` pushes `this` last (`command.js:534-542`), but the
 * CLI's own tests call a wrapped action directly with plain objects, so the
 * last argument is only *usually* a command.
 */
export function commandOf(args: readonly unknown[]): Command | undefined {
	const last = args[args.length - 1];
	return isCommand(last) ? last : undefined;
}

/**
 * One spelling of the acting agent, as commander filled it in.
 *
 * `unknown`, not `string`: this is the raw option value, so `--agent ""` is an
 * empty string here and the program's `--as` is whatever `main.ts` collected.
 * Every value is normalised once, in {@link oneActorValue}, and nowhere else —
 * a per-option `argParser` would be a second place for empty to mean absent.
 */
interface ActorValue {
	flag: string;
	value: unknown;
}

/** Actor values this invocation typed, in declaration order. Env is not one. */
function typedActorValues(command: Command | undefined): ActorValue[] {
	if (command === undefined) return [];
	const typed: ActorValue[] = [];
	for (const option of command.options) {
		const flag = ACTOR_FLAGS.get(option);
		if (flag === undefined) continue;
		typed.push({ flag, value: command.getOptionValue(option.attributeName()) });
	}
	return typed;
}

/**
 * The one actor value this command line names, or a refusal naming both.
 *
 * Folded pairwise through `rine-core`'s comparison so the sentence a caller
 * reads is the same one every other surface prints, with this pair's spellings
 * in it.
 */
function oneActorValue(candidates: readonly ActorValue[]): string | undefined {
	let chosen: { flag: string; value: string } | undefined;
	for (const candidate of candidates) {
		const value = normalizeActor(candidate.value);
		if (value === undefined) continue;
		if (chosen === undefined) {
			chosen = { flag: candidate.flag, value };
			continue;
		}
		singleActorValue(chosen.value, value, {
			...ACTOR_SURFACES.cli,
			canonical: chosen.flag,
			alias: candidate.flag,
		});
	}
	return chosen?.value;
}

/**
 * Rung 1: the actor this command line names, by any of its spellings.
 *
 * `undefined` means nobody was named here, which is the ladder's cue to fall
 * through to `RINE_AGENT` and then to the org's only agent.
 */
export function namedActor(
	command: Command | undefined,
	gOpts: GlobalOpts,
): string | undefined {
	return oneActorValue([
		...typedActorValues(command),
		{ flag: ACTOR_SURFACES.cli.alias, value: gOpts.as },
	]);
}
