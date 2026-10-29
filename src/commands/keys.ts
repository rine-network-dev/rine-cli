import * as fs from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
	type AgentKeysResponse,
	RineApiError,
	agentKeysExist,
	loadAgentKeys,
	rotateAgentWithSeats,
	toBase64Url,
} from "@rine-network/core";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printJson, printTable } from "../output.js";
import { printRotationReport } from "./keys-rotate-report.js";
import { registerKeysTransfer } from "./keys-transfer.js";

function backupKeys(configDir: string, agentId: string): void {
	const dir = join(configDir, "keys", agentId);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	for (const name of ["signing.key", "encryption.key", "pq_encryption.key"]) {
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

/** The server must hold the public keys the rotation just saved locally. */
async function verifyServerKeys(
	client: { get: (url: string) => Promise<unknown> },
	configDir: string,
	agentId: string,
): Promise<void> {
	const local = loadAgentKeys(configDir, agentId);
	const server = (await client.get(`/agents/${agentId}/keys`)) as AgentKeysResponse;
	if (
		server.signing_public_key.x !== toBase64Url(local.signing.publicKey) ||
		server.encryption_public_key.x !== toBase64Url(local.encryption.publicKey) ||
		server.pq_encryption_public_key?.x !== toBase64Url(local.pqEncryption.publicKey)
	) {
		throw new Error(
			"Server key verification failed: the server's keys do not match the rotated keys. Old keys preserved locally as .bak files.",
		);
	}
}

export function registerKeys(program: Command): void {
	const keys = program.command("keys").description("E2EE key management");

	keys
		.command("status")
		.description("Show E2EE key status for an agent")
		.addOption(actorOption())
		.action(
			withClient(
				program,
				async ({ client, gOpts, configDir,  actingAgent, agents }) => {
					const agentId = await actingAgent();

					// Find handle from agent list
					const agent = (await agents()).find((a) => a.id === agentId);
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
					let pqFingerprint = "-";

					if (hasLocal) {
						const agentKeys = loadAgentKeys(configDir, agentId);
						sigFingerprint = toBase64Url(agentKeys.signing.publicKey).slice(0, 8);
						encFingerprint = toBase64Url(
							agentKeys.encryption.publicKey,
						).slice(0, 8);
						if (agentKeys.pqEncryption) {
							pqFingerprint = toBase64Url(
								agentKeys.pqEncryption.publicKey,
							).slice(0, 8);
						}
					} else if (serverKeys) {
						sigFingerprint = serverKeys.signing_public_key.x.slice(0, 8);
						encFingerprint =
							serverKeys.encryption_public_key.x.slice(0, 8);
						if (serverKeys.pq_encryption_public_key) {
							pqFingerprint =
								serverKeys.pq_encryption_public_key.x.slice(0, 8);
						}
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
							pq_encryption_fingerprint:
								pqFingerprint !== "-" ? pqFingerprint : null,
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
							{
								Field: "PQ Encryption Fingerprint",
								Value: pqFingerprint,
							},
						]);
					}
				},
			),
		);

	keys
		.command("rotate")
		.description("Rotate E2EE keys for an agent")
		.addOption(actorOption())
		.action(
			withClient(
				program,
				async ({ client, gOpts, configDir, ownerDir, actingAgent }) => {
					const agentId = await actingAgent();

					if (agentKeysExist(configDir, agentId)) {
						backupKeys(configDir, agentId);
					}

					const report = await rotateAgentWithSeats(
						client,
						{ configDir, ownerDir },
						agentId,
					);
					await verifyServerKeys(client, configDir, agentId);

					printRotationReport(agentId, report, gOpts.json);
				},
			),
		);

	registerKeysTransfer(keys, program);
}

