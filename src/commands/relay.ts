/**
 * `rine relay`, the long-lived inbound webhook funnel daemon. This module
 * registers the command, builds the client (as stream.ts does, not through
 * withClient), resolves the acting agent and refuses to start without its
 * identity keys, then hands over to relay-loop.ts, which installs the SIGINT
 * handler and runs the reconnect loop. Each (re)connect runs four steps IN
 * ORDER: (1) cert provision/renew (relay-cert) → (2) control WS + mux tunnel →
 * (3) local TLS-terminating listener (relay-tier) → (4) per-request
 * verify/encrypt/post (rine-core's relay adapter). relay-hook resolves the
 * hook row, its secret and its A record; relay-reconnect classifies a dropped
 * tunnel and waits out the backoff; relay-lifecycle emits the lifecycle
 * events, which NEVER carry a body. None of these modules holds inline ACME,
 * mux framing or crypto: they call the rine-core funnel entry points.
 */

import {
	agentKeysExist,
	resolveApiUrl,
	resolveConfigDir,
} from "@rine-network/core";
import type { Command } from "commander";
import { createClient } from "../action.js";
import { actorLadder } from "../acting-agent.js";
import { actorOption, namedActor } from "../actor.js";
import { printError } from "../output.js";
import type { GlobalOpts } from "../types.js";
import type { RelayOpts } from "./relay-hook.js";
import { runRelayLoop } from "./relay-loop.js";

export function registerRelay(program: Command): void {
	program
		.command("relay")
		.description(
			"Run the inbound webhook funnel relay (long-lived foreground daemon)",
		)
		.addOption(actorOption())
		.option("--hook <name>", "Hook name to relay", "default")
		.option("--port <n>", "Local TLS listener port", "8443")
		.option("--secret-file <path>", "Read the HMAC secret from a file")
		.option("--secret-env <VAR>", "Read the HMAC secret from an env var")
		.option("--staging", "Use the Let's Encrypt staging CA (dev)")
		.option("--verbose", "Verbose reconnect logging")
		.action(async (opts: RelayOpts, command: Command) => {
			try {
				const gOpts = program.opts<GlobalOpts>();
				const configDir = resolveConfigDir();
				const apiUrl = resolveApiUrl();
				const { client, token } = await createClient(apiUrl, gOpts.profile);

				const { actingAgent } = actorLadder(namedActor(command, gOpts), client);
				const agentId = await actingAgent();

				if (!agentKeysExist(configDir, agentId)) {
					printError(
						`Agent identity keys not found under ${configDir}/keys/${agentId}/ — register first.`,
					);
					process.exitCode = 2;
					return;
				}

				await runRelayLoop({
					opts,
					gOpts,
					configDir,
					agentId,
					client,
					token,
				});
			} catch (err) {
				printError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		});
}
