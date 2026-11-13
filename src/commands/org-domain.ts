import {
	type DomainStatus,
	type DomainView,
	addDomain,
	listDomains,
	removeDomain,
	verifyDomain,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printJson, printMutationOk, printTable, printText } from "../output.js";

const STATUS_WORDS: Record<DomainStatus, string> = {
	pending: "pending",
	proven: "proven",
	lost: "no longer proven: the record was not found at two checks, or DNS gave no answer at seven",
};

export function registerOrgDomain(org: Command, program: Command): void {
	const domain = org
		.command("domain")
		.description("Prove that your organisation controls a domain, with one DNS TXT record");

	domain
		.command("add <domain>")
		.description("Claim a domain and print the record to publish")
		.action(
			withClient(program, async ({ client, gOpts }, name: string) => {
				const d = await addDomain(client, name);
				if (gOpts.json) return printJson(d);
				printText(
					`Add a TXT record named ${d.txt_name} with the value ${d.txt_value}, then run: rine org domain verify ${d.domain}`,
				);
			}),
		);

	domain
		.command("verify <domain>")
		.description("Look up the TXT record and prove the domain")
		.action(
			withClient(program, async ({ client, gOpts }, name: string) => {
				const d: DomainView = await verifyDomain(client, name);
				if (gOpts.json) return printJson(d);
				printText(`${d.domain} is proven for this organisation.`);
			}),
		);

	domain
		.command("list")
		.description("List the claimed domains and where each proof stands")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const domains = await listDomains(client);
				if (gOpts.json) return printJson(domains);
				printTable(
					domains.map((d) => ({
						Domain: d.domain,
						Status: STATUS_WORDS[d.status],
						"Verified at": d.verified_at ?? "",
					})),
				);
			}),
		);

	domain
		.command("remove <domain>")
		.description("Drop a claimed domain")
		.action(
			withClient(program, async ({ client, gOpts }, name: string) => {
				await removeDomain(client, name);
				printMutationOk("Domain removed", gOpts.json);
			}),
		);
}
