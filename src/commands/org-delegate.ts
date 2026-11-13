import {
	DelegateScope,
	type DelegateView,
	UUID_RE,
	addProfileIfAbsent,
	createDelegate,
	getProfile,
	listDelegates,
	newDelegateKey,
	revokeDelegate,
	saveDelegateSeed,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { printJson, printTable, printText } from "../output.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

interface CreateOpts {
	name: string;
	scope: string;
	publicKey?: string;
}

/** A 32-byte Ed25519 public key, base64url without padding. */
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

function parseScopes(list: string): DelegateScope[] {
	const known = Object.values(DelegateScope);
	const scopes = list.split(",").map((s) => s.trim());
	const bad = scopes.filter((s) => !known.some((k) => k === s));
	if (scopes.length === 0 || bad.length > 0) {
		throw new Error(
			`Unknown scope '${bad[0] ?? list}'. Scopes: ${known.join(", ")}.`,
		);
	}
	return [...new Set(scopes)] as DelegateScope[];
}

const created = (d: DelegateView) =>
	`Delegated key '${d.name}' created (${d.id}) with scopes: ${d.scopes.join(", ")}.`;

/** Registers a key the caller holds elsewhere: no seed is saved and no profile is added. */
async function createWithKey(
	ctx: ActionContext,
	opts: CreateOpts,
	publicKey: string,
): Promise<void> {
	if (!PUBLIC_KEY_RE.test(publicKey))
		throw new Error(
			"--public-key must be a 32-byte Ed25519 public key in base64url, 43 characters.",
		);
	const delegate = await createDelegate(
		ctx.client,
		opts.name,
		parseScopes(opts.scope),
		publicKey,
	);
	if (ctx.gOpts.json) printJson(delegate);
	else printText(created(delegate));
}

async function create(ctx: ActionContext, opts: CreateOpts): Promise<void> {
	const { client, gOpts, configDir, ownerDir, auth } = ctx;
	if (!NAME_RE.test(opts.name)) {
		throw new Error(
			"--name must be lowercase letters, digits and dashes, at most 32 characters.",
		);
	}
	if (opts.publicKey !== undefined)
		return createWithKey(ctx, opts, opts.publicKey);
	const scopes = parseScopes(opts.scope);
	const orgId = auth?.orgId;
	if (orgId === undefined)
		throw new Error("Sign in as the organisation to create a delegated key.");
	if (getProfile(configDir, opts.name) ?? getProfile(ownerDir, opts.name)) {
		throw new Error(`A profile named '${opts.name}' already exists.`);
	}
	const key = newDelegateKey();
	const delegate = await createDelegate(
		client,
		opts.name,
		scopes,
		key.publicKey,
	);
	try {
		saveDelegateSeed(configDir, delegate.id, key.seed);
		addProfileIfAbsent(configDir, opts.name, {
			org_id: orgId,
			principal: `delegate:${delegate.id}`,
		});
	} catch (err) {
		await revokeDelegate(client, delegate.id).catch(() => undefined);
		throw err;
	}
	if (gOpts.json) {
		printJson({ ...delegate, profile: opts.name });
		return;
	}
	printText(created(delegate));
	printText(
		`Its private key is in this config directory; use it with --profile ${opts.name}.`,
	);
}

function row(d: DelegateView): Record<string, unknown> {
	return {
		Name: d.name,
		ID: d.id,
		Scopes: d.scopes.join(","),
		Created: d.created_at,
		Revoked: d.revoked_at ?? "",
	};
}

async function revoke(ctx: ActionContext, ref: string): Promise<void> {
	let id = ref;
	if (!UUID_RE.test(ref)) {
		const hits = (await listDelegates(ctx.client)).filter(
			(d) => d.name === ref && d.revoked_at === null,
		);
		if (hits.length !== 1)
			throw new Error(`No live delegated key is named '${ref}'. Use its ID.`);
		id = (hits[0] as DelegateView).id;
	}
	await revokeDelegate(ctx.client, id);
	if (ctx.gOpts.json) printJson({ id, revoked: true });
	else
		printText(
			`Delegated key ${id} revoked. Its next request is refused; tokens it already holds stop working with it.`,
		);
}

export function registerOrgDelegate(org: Command, program: Command): void {
	const delegate = org
		.command("delegate")
		.description("Delegated keys that may suspend, freeze or read events");

	delegate
		.command("create")
		.description(
			"Create a delegated key and a profile of the same name that signs with it",
		)
		.requiredOption("--name <name>", "Key and profile name")
		.requiredOption(
			"--scope <scopes>",
			"Comma-separated: events:read, metadata:read, suspend, freeze, resume, counterparty:write, policy:write",
		)
		.option(
			"--public-key <base64url>",
			"Register this public key instead of generating one; no private key or profile is kept here",
		)
		.action(withClient(program, create));

	delegate
		.command("list")
		.description("List delegated keys")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const all = await listDelegates(client);
				if (gOpts.json) printJson(all);
				else printTable(all.map(row));
			}),
		);

	delegate
		.command("revoke <name-or-id>")
		.description("Revoke a delegated key")
		.action(withClient(program, revoke));
}
