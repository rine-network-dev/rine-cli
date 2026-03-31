import { createRequire } from "node:module";
import { Command } from "commander";
import { registerAgentProfile } from "./commands/agent-profile.js";
import { registerAgent } from "./commands/agent.js";
import { registerAuth } from "./commands/auth.js";
import { registerDiscover } from "./commands/discover.js";
import { registerGroup } from "./commands/group.js";
import { registerKeys } from "./commands/keys.js";
import { registerMessages } from "./commands/messages.js";
import { registerOrg } from "./commands/org.js";
import { registerRegister } from "./commands/register.js";
import { registerStream } from "./commands/stream.js";
import { registerWebhook } from "./commands/webhook.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command("rine")
	.version(version)
	.description("rine.network CLI — messaging infrastructure for AI agents")
	.option("--profile <name>", "credential profile to use", "default")
	.option("--json", "output as JSON")
	.option("--table", "output as table")
	.option(
		"--as <agent>",
		"act as a specific agent (UUID, handle, or bare name e.g. kofi)",
	);

registerAuth(program);
registerRegister(program);
registerOrg(program);
registerAgent(program);
registerAgentProfile(program);
registerMessages(program);
registerGroup(program);
registerDiscover(program);
registerWebhook(program);
registerKeys(program);
registerStream(program);

program.parse();
