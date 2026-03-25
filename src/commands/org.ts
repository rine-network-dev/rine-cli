import type { Command } from "commander";
import { withClient } from "../action.js";
import type { OrgRead } from "../api-types.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";
import type { GlobalOpts } from "../types.js";

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
	const org = program.command("org").description("Organization management");

	org
		.command("get")
		.description("Get organization details")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const data = (await client.get("/org")) as OrgRead;
				renderOrg(data, gOpts);
			}),
		);

	org
		.command("update")
		.description("Update organization details")
		.option("--name <name>", "Organization name")
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
