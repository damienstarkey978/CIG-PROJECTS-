// Registers this service's webhooks on a tenant's Quo inboxes and stores the signing keys.
//   npm run quo:register-webhooks -- --slug wci
import { parseArgs } from "node:util";
import { config } from "../src/config";
import { QuoClient, type QuoSecrets } from "../src/connectors/quo";
import { closeDb } from "../src/lib/db";
import { getConnector, getTenantBySlug, saveConnector } from "../src/tenants";

const HOOKS = [
  { kind: "calls", events: ["call.completed"] },
  { kind: "call-transcripts", events: ["call.transcript.completed"] },
  { kind: "call-summaries", events: ["call.summary.completed"] },
  { kind: "messages", events: ["message.received"] },
] as const;

async function main() {
  const { values } = parseArgs({ options: { slug: { type: "string" } } });
  const tenant = values.slug ? await getTenantBySlug(values.slug) : null;
  if (!tenant) throw new Error("Unknown --slug");
  const conn = await getConnector<QuoSecrets>(tenant.id, "telephony", "quo");
  if (!conn?.secrets) throw new Error("Run tenant:create first");
  const inboxes: string[] = conn.config.inboxPhoneNumberIds ?? [];
  if (!inboxes.length) throw new Error("Tenant has no inboxPhoneNumberIds; rerun tenant:create with --inbox");

  const url = `${config.publicBaseUrl()}/webhooks/quo/${tenant.slug}`;
  const quo = new QuoClient(conn.secrets);
  const keys = new Set(conn.secrets.signingKeys);
  const webhookIds: string[] = conn.config.webhookIds ?? [];
  for (const h of HOOKS) {
    const created = await quo.createWebhook(h.kind, url, [...h.events], inboxes, `office-assistant ${tenant.slug} ${h.kind}`);
    keys.add(created.key);
    webhookIds.push(created.id);
    console.log(`Registered ${h.kind} -> ${url} (${created.id})`);
  }
  await saveConnector(tenant.id, "telephony", "quo", { ...conn.config, webhookIds }, { ...conn.secrets, signingKeys: [...keys] });
}

main().finally(closeDb);
