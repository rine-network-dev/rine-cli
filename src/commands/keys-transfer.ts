import * as fs from "node:fs";
import {
	agentKeysExist,
	agentKeysFromPrivate,
	fromBase64Url,
	isPathSafeId,
	loadAgentKeys,
	orgIdOfAgent,
	resolveConfigDir,
	saveAgentKeys,
	toBase64Url,
	validateSigningKey,
	validateEncryptionKey,
	writeAtomic,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient, withErrorHandler } from "../action.js";
import { actorOption } from "../actor.js";
import { printError, printJson, printMutationOk } from "../output.js";

const PQ_SEED_BYTES = 64;

interface KeyExport {
	agent_id: string;
	/** Written by export so a runtime that holds the file can pin its own org; import does not need it. */
	org_id?: string;
	signing_private_key: string;
	encryption_private_key: string;
	pq_encryption_seed: string;
	mls_private_key: string;
	key_gen: number;
}

/** The first reason an export file cannot be imported, or undefined when it can. */
function invalidReason(data: KeyExport): string | undefined {
	if (
		!data.agent_id ||
		!data.signing_private_key ||
		!data.encryption_private_key ||
		!data.pq_encryption_seed ||
		!data.mls_private_key ||
		data.key_gen === undefined
	) {
		return "Invalid key export file";
	}
	if (!isPathSafeId(data.agent_id)) return "Invalid key export file: bad agent_id";
	const checks: [string, () => void][] = [
		["signing key", () => validateSigningKey(fromBase64Url(data.signing_private_key))],
		["encryption key", () => validateEncryptionKey(fromBase64Url(data.encryption_private_key))],
		["MLS key", () => validateSigningKey(fromBase64Url(data.mls_private_key))],
		[
			"PQ encryption seed",
			() => {
				const n = fromBase64Url(data.pq_encryption_seed).length;
				if (n !== PQ_SEED_BYTES) throw new Error(`expected ${PQ_SEED_BYTES} bytes, got ${n}`);
			},
		],
		[
			"key generation",
			() => {
				if (!Number.isSafeInteger(data.key_gen) || data.key_gen < 0) {
					throw new Error("expected a non-negative integer");
				}
			},
		],
	];
	for (const [label, check] of checks) {
		try {
			check();
		} catch (err) {
			return `Invalid ${label}: ${(err as Error).message}`;
		}
	}
	return undefined;
}

export function registerKeysTransfer(keys: Command, program: Command): void {
	keys
		.command("export")
		.description("Export private keys to a file")
		.addOption(actorOption())
		.requiredOption("--output <file>", "Output file path")
		.action(
			withClient(
				program,
				async ({ gOpts, configDir, actingAgent }, opts: { agent?: string; output: string }) => {
					const agentId = await actingAgent();

					if (!agentKeysExist(configDir, agentId)) {
						printError(`No keys found for agent ${agentId}`);
						process.exitCode = 1;
						return;
					}

					const orgId = orgIdOfAgent(configDir, agentId);
					if (orgId === undefined) {
						printError(
							`Cannot tell which org agent ${agentId} belongs to: no profile in ${configDir} names it`,
						);
						process.exitCode = 1;
						return;
					}

					const agentKeys = loadAgentKeys(configDir, agentId);
					const exported: KeyExport = {
						agent_id: agentId,
						org_id: orgId,
						signing_private_key: toBase64Url(agentKeys.signing.privateKey),
						encryption_private_key: toBase64Url(agentKeys.encryption.privateKey),
						pq_encryption_seed: toBase64Url(agentKeys.pqEncryption.seed),
						mls_private_key: toBase64Url(agentKeys.mls.privateKey),
						key_gen: agentKeys.keyGen,
					};

					writeAtomic(opts.output, JSON.stringify(exported, null, 2));

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
				const data = JSON.parse(fs.readFileSync(opts.input, "utf-8")) as KeyExport;
				const reason = invalidReason(data);
				if (reason) {
					printError(reason);
					process.exitCode = 2;
					return;
				}

				saveAgentKeys(
					resolveConfigDir(),
					data.agent_id,
					agentKeysFromPrivate({
						signing: fromBase64Url(data.signing_private_key),
						encryption: fromBase64Url(data.encryption_private_key),
						pqSeed: fromBase64Url(data.pq_encryption_seed),
						mls: fromBase64Url(data.mls_private_key),
						keyGen: data.key_gen,
					}),
				);

				printMutationOk(`Keys imported for agent ${data.agent_id}`, gOpts.json);
			}),
		);
}
