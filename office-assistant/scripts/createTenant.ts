// Creates or updates a tenant and its Quo connector.
//   QUO_API_KEY=... npm run tenant:create -- --slug wci --name "World Construction Inc." \
//     --inbox PNEYAAmj7S --shadow-phone +1XXXXXXXXXX
import { parseArgs } from "node:util";
import { closeDb, db, migrate } from "../src/lib/db";
import { toE164 } from "../src/lib/phone";
import { getConnector, saveConnector } from "../src/tenants";
import type { QuoSecrets } from "../src/connectors/quo";

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      name: { type: "string" },
      timezone: { type: "string", default: "America/New_York" },
      inbox: { type: "string", multiple: true }, // Quo phone number ids (PN...)
      "shadow-phone": { type: "string" },
    },
  });
  if (!values.slug || !values.name) throw new Error("--slug and --name are required");
  await migrate();

  const shadow = toE164(values["shadow-phone"]);
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO tenants (slug, name, timezone) VALUES ($1,$2,$3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone RETURNING id`,
    [values.slug, values.name, values.timezone],
  );
  const tenantId = rows[0].id;
  if (shadow) {
    await db().query(
      `UPDATE tenants SET settings = settings || jsonb_build_object('shadowRecipientPhone', $2::text) WHERE id = $1`,
      [tenantId, shadow],
    );
  }

  const existing = await getConnector<QuoSecrets>(tenantId, "telephony", "quo");
  const apiKey = process.env.QUO_API_KEY ?? existing?.secrets?.apiKey;
  if (!apiKey) throw new Error("Set QUO_API_KEY (Quo > Settings > API)");
  await saveConnector(
    tenantId,
    "telephony",
    "quo",
    { ...(existing?.config ?? {}), inboxPhoneNumberIds: values.inbox ?? existing?.config?.inboxPhoneNumberIds ?? [] },
    { apiKey, signingKeys: existing?.secrets?.signingKeys ?? [] },
  );
  console.log(`Tenant ${values.slug} ready (id ${tenantId}), mode shadow${shadow ? `, reports to ${shadow}` : ", no shadow recipient set"}`);
}

main().finally(closeDb);
