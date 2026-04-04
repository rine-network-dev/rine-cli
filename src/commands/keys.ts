import * as fs from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { withClient, withErrorHandler } from "../action.js";
import {
	type AgentKeysResponse,
	type AgentRead,
	type ListResponse,
	RineApiError,
	agentKeysExist,
	fetchAgents,
	fromBase64Url,
	generateAgentKeys,
	getAgentPublicKeys,
	loadAgentKeys,
	resolveAgent,
	resolveConfigDir,
	saveAgentKeys,
	toBase64Url,
} from "@rine-network/core";
import { printError, printJson, printMutationOk, printTable } from "../output.js";

interface KeyExport {
	agent_id: string;
	signing_private_key: string;
	encryption_private_key: string;
}

function getKeysDir(configDir: string, agentId: string): string {
	return join(configDir, "keys", agentId);
}

function backupKeys(configDir: string, agentId: string): void {
	const dir = getKeysDir(configDir, agentId);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	for (const name of ["signing.key", "encryption.key"]) {
		const src = join(dir, name);
		if (!fs.existsSync(src)) continue;
		// Remove older backups of this key, keep only the new one
		for (const f of fs.readdirSync(dir)) {
			if (f.startsWith(`${name}.bak.`)) {
				fs.unlinkSync(join(dir, f));
			}
		}
		fs.copyFileSync(src, join(dir, `${name}.bak.${ts}`));
	}
}

async function verifyServerKeys(
	client: { get: (url: string) => Promise<unknown> },
	agentId: string,
	expected: { signing_public_key: { x: string }; encryption_public_key: { x: string } },
): Promise<void> {
	const server = (await client.get(`/agents/${agentId}/keys`)) as AgentKeysResponse;
	if (
		server.signing_public_key.x !== expected.signing_public_key.x ||
		server.encryption_public_key.x !== expected.encryption_public_key.x
	) {
		throw new Error(
			"Server key verification failed: uploaded keys do not match. Old keys preserved locally.",
		);
	}
}

export function registerKeys(program: Command): void {
	const keys = program.command("keys").description("E2EE key management");

	keys
		.command("status")
		.description("Show E2EE key status for an agent")
		.option("--agent <id>", "Agent ID")
		.action(
			withClient(
				program,
				async ({ client, gOpts, configDir, apiUrl }, opts: { agent?: string }) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(apiUrl, agents, opts.agent, gOpts.as);

					// Find handle from agent list
					const agent = agents.find((a) => a.id === agentId);
					const handle = agent?.handle ?? "unknown";

					const hasLocal = agentKeysExist(configDir, agentId);

					let hasServer = false;
					let serverKeys: AgentKeysResponse | undefined;
					try {
						serverKeys = (await client.get(
							`/agents/${agentId}/keys`,
						)) as AgentKeysResponse;
						hasServer = true;
					} catch (err) {
						if (!(err instanceof RineApiError && err.status === 404)) {
							throw err;
						}
					}

					let sigFingerprint = "-";
					let encFingerprint = "-";

					if (hasLocal) {
						const agentKeys = loadAgentKeys(configDir, agentId);
						sigFingerprint = toBase64Url(agentKeys.signing.publicKey).slice(0, 8);
						encFingerprint = toBase64Url(
							agentKeys.encryption.publicKey,
						).slice(0, 8);
					} else if (serverKeys) {
						sigFingerprint = serverKeys.signing_public_key.x.slice(0, 8);
						encFingerprint =
							serverKeys.encryption_public_key.x.slice(0, 8);
					}

					const keysLabel = hasLocal && hasServer
						? "local + server"
						: hasLocal
							? "local only"
							: hasServer
								? "server only"
								: "none";

					if (gOpts.json) {
						printJson({
							agent_id: agentId,
							handle,
							local_keys: hasLocal,
							server_keys: hasServer,
							signing_fingerprint:
								sigFingerprint !== "-" ? sigFingerprint : null,
							encryption_fingerprint:
								encFingerprint !== "-" ? encFingerprint : null,
						});
					} else {
						printTable([
							{ Field: "Agent ID", Value: agentId },
							{ Field: "Handle", Value: handle },
							{ Field: "Local Keys", Value: hasLocal ? "yes" : "no" },
							{ Field: "Server Keys", Value: hasServer ? "yes" : "no" },
							{ Field: "Keys", Value: keysLabel },
							{
								Field: "Signing Fingerprint",
								Value: sigFingerprint,
							},
							{
								Field: "Encryption Fingerprint",
								Value: encFingerprint,
							},
						]);
					}
				},
			),
		);

	keys
		.command("generate")
		.description("Generate new E2EE keys for an agent")
		.option("--agent <id>", "Agent ID")
		.action(
			withClient(
				program,
				async ({ client, gOpts, configDir, apiUrl }, opts: { agent?: string }) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(apiUrl, agents, opts.agent, gOpts.as);

					if (agentKeysExist(configDir, agentId)) {
						printError(
							`Keys already exist for agent ${agentId}. Use 'rine keys rotate' to replace them.`,
						);
						process.exitCode = 1;
						return;
					}

					const agentKeys = generateAgentKeys();
					const pubKeys = getAgentPublicKeys(configDir, agentId, agentKeys);
					await client.post(`/agents/${agentId}/keys`, pubKeys);
					await verifyServerKeys(client, agentId, pubKeys);
					saveAgentKeys(configDir, agentId, agentKeys);

					printMutationOk(
						`E2EE keys generated for agent ${agentId}`,
						gOpts.json,
					);
				},
			),
		);

	keys
		.command("rotate")
		.description("Rotate E2EE keys for an agent")
		.option("--agent <id>", "Agent ID")
		.action(
			withClient(
				program,
				async ({ client, gOpts, configDir, apiUrl }, opts: { agent?: string }) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(apiUrl, agents, opts.agent, gOpts.as);

					if (agentKeysExist(configDir, agentId)) {
						backupKeys(configDir, agentId);
					}

					const agentKeys = generateAgentKeys();
					const pubKeys = getAgentPublicKeys(configDir, agentId, agentKeys);
					await client.post(`/agents/${agentId}/keys`, pubKeys);
					await verifyServerKeys(client, agentId, pubKeys);
					saveAgentKeys(configDir, agentId, agentKeys);

					printMutationOk(`E2EE keys rotated for agent ${agentId}`, gOpts.json);
				},
			),
		);

	keys
		.command("export")
		.description("Export private keys to a file")
		.option("--agent <id>", "Agent ID")
		.requiredOption("--output <file>", "Output file path")
		.action(
			withClient(
				program,
				async ({ client, gOpts, configDir, apiUrl }, opts: { agent?: string; output: string }) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(apiUrl, agents, opts.agent, gOpts.as);

					if (!agentKeysExist(configDir, agentId)) {
						printError(`No keys found for agent ${agentId}`);
						process.exitCode = 1;
						return;
					}

					const agentKeys = loadAgentKeys(configDir, agentId);
					const exported: KeyExport = {
						agent_id: agentId,
						signing_private_key: toBase64Url(agentKeys.signing.privateKey),
						encryption_private_key: toBase64Url(
							agentKeys.encryption.privateKey,
						),
					};

					fs.writeFileSync(opts.output, JSON.stringify(exported, null, 2));
					fs.chmodSync(opts.output, 0o600);

					if (gOpts.json) {
						printJson({ ok: true, path: opts.output });
					} else {
						console.log(`Keys exported to ${opts.output}`);
					}
				},
			),
		);

	keys
		.command("import")
		.description("Import private keys from a file")
		.requiredOption("--input <file>", "Input file path")
		.action(
			withErrorHandler(program, (gOpts, opts: { input: string }) => {
				const raw = fs.readFileSync(opts.input, "utf-8");
				const data = JSON.parse(raw) as KeyExport;

				if (
					!data.agent_id ||
					!data.signing_private_key ||
					!data.encryption_private_key
				) {
					printError("Invalid key export file");
					process.exitCode = 2;
					return;
				}

				// Validate key material before writing
				const sigBytes = fromBase64Url(data.signing_private_key);
				if (sigBytes.length !== 32) {
					printError(`Invalid signing key: expected 32 bytes, got ${sigBytes.length}`);
					process.exitCode = 2;
					return;
				}
				try {
					ed25519.getPublicKey(sigBytes);
				} catch {
					printError("Invalid signing key: not a valid Ed25519 private key");
					process.exitCode = 2;
					return;
				}

				const encBytes = fromBase64Url(data.encryption_private_key);
				if (encBytes.length !== 32) {
					printError(`Invalid encryption key: expected 32 bytes, got ${encBytes.length}`);
					process.exitCode = 2;
					return;
				}
				try {
					x25519.getPublicKey(encBytes);
				} catch {
					printError("Invalid encryption key: not a valid X25519 private key");
					process.exitCode = 2;
					return;
				}

				const configDir = resolveConfigDir();
				const dir = join(configDir, "keys", data.agent_id);
				fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

				const sigPath = join(dir, "signing.key");
				fs.writeFileSync(sigPath, data.signing_private_key, "utf-8");
				fs.chmodSync(sigPath, 0o600);

				const encPath = join(dir, "encryption.key");
				fs.writeFileSync(encPath, data.encryption_private_key, "utf-8");
				fs.chmodSync(encPath, 0o600);

				printMutationOk(`Keys imported for agent ${data.agent_id}`, gOpts.json);
			}),
		);
}
