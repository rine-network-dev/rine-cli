/**
 * Detect that the CLI runs inside an agent runtime, so a rule change can warn first.
 * Warn, never block: the command still runs. One table of markers; each is an environment
 * variable that runtime sets for the processes it starts (the OpenClaw and Hermes rigs and
 * Claude Code in `compose.openclaw.yml`, `compose.hermes.yml` and `compose.cc.yml`).
 */
import { printError } from "../output.js";

export const RUNTIME_MARKERS: readonly {
	runtime: string;
	vars: readonly string[];
}[] = [
	{ runtime: "Claude Code", vars: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] },
	{ runtime: "OpenClaw", vars: ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] },
	{ runtime: "Hermes", vars: ["HERMES_HOME", "HERMES_SESSION_KEY"] },
];

/** The warning printed before a rule change inside an agent runtime. */
export const RUNTIME_WARNING =
	"This looks like an agent's environment. Change rules from a machine that runs no agents: an agent with a shell here can read your organisation key.";

/** The runtime whose marker is set (non-empty) in `env`, or `undefined` in a plain shell. */
export function runtimeOf(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return RUNTIME_MARKERS.find((m) => m.vars.some((v) => env[v]))?.runtime;
}

/** Print the runtime warning on stderr when a runtime marker is set. */
export function warnInAgentRuntime(
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (runtimeOf(env) !== undefined) printError(RUNTIME_WARNING);
}
