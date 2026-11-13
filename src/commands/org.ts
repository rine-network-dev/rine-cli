import type { Command } from "commander";
import { withClient } from "../action.js";
import type { OrgRead, WhoAmIRead } from "@rine-network/core";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";
import type { GlobalOpts } from "../types.js";
import { registerOrgBranch } from "./org-branch.js";
import { registerOrgDelegate } from "./org-delegate.js";
import { registerOrgEventsTail } from "./org-events-tail.js";
import { registerOrgCounterparties } from "./org-counterparties.js";
import { registerOrgDomain } from "./org-domain.js";
import { registerOrgExposure } from "./org-exposure.js";
import { registerOrgFreeze } from "./org-freeze.js";
import { registerOrgLogSettings } from "./org-log-settings.js";
import { registerOrgMetadataTail } from "./org-metadata-tail.js";
import { registerOrgRecover } from "./org-recover.js";
import { registerOrgRules } from "./org-rules.js";

function renderOrg(data: OrgRead, opts: GlobalOpts): void {
	if (opts.json) {
		printJson(data);
		return;
	}
	printTable([
		{
			ID: data.id,
			Name: data.name,
			"Contact Email": data.contact_email ?? "",
			Country: data.country_code ?? "",
			Created: data.created_at,
		},
	]);
}

export function registerOrg(program: Command): void {
	const org = program.command("org").description("Organisation management");

	registerOrgRecover(org, program);
	registerOrgBranch(org, program);
	registerOrgFreeze(org, program);
	registerOrgRules(org, program);
	registerOrgDelegate(org, program);
	registerOrgEventsTail(org, program);
	registerOrgMetadataTail(org, program);
	registerOrgCounterparties(org, program);
	registerOrgDomain(org, program);
	registerOrgExposure(org, program);
	registerOrgLogSettings(org, program);

	org
		.command("get")
		.description("Get organisation details")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const { org: data } = (await client.get("/whoami")) as WhoAmIRead;
				renderOrg(data, gOpts);
			}),
		);

	org
		.command("update")
		.description("Update organisation details")
		.option("--name <name>", "Organisation name")
		.option("--contact-email <email>", "Contact email address")
		.option("--country-code <cc>", "ISO country code (e.g. DE)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					opts: {
						name?: string;
						contactEmail?: string;
						countryCode?: string;
					},
				) => {
					const body: Record<string, string> = {};
					if (opts.name) body.name = opts.name;
					if (opts.contactEmail) body.contact_email = opts.contactEmail;
					if (opts.countryCode) body.country_code = opts.countryCode;
					if (Object.keys(body).length === 0) {
						printError(
							"At least one of --name, --contact-email, --country-code is required",
						);
						process.exitCode = 2;
						return;
					}
					await client.patch("/org", body);
					printMutationOk("Org updated", gOpts.json);
				},
			),
		);
}
