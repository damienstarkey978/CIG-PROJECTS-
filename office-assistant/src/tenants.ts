import { db } from "./lib/db";
import { decryptJson, encryptJson } from "./lib/crypto";
import { QuoClient, type QuoSecrets } from "./connectors/quo";
import type { TelephonyProvider } from "./connectors/types";

export interface TenantSettings {
  mode: "shadow" | "live";
  shadowRecipientPhone?: string;
  confidenceThreshold: number;
  // Approved follow up copy keyed by template name. Missing key = no text is sent.
  templates: Record<string, string>;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  settings: TenantSettings;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const { rows } = await db().query<Tenant>("SELECT id, slug, name, timezone, settings FROM tenants WHERE slug = $1", [slug]);
  return rows[0] ?? null;
}

export async function getTenantById(id: string): Promise<Tenant> {
  const { rows } = await db().query<Tenant>("SELECT id, slug, name, timezone, settings FROM tenants WHERE id = $1", [id]);
  if (!rows[0]) throw new Error(`Unknown tenant ${id}`);
  return rows[0];
}

export async function getConnector<TSecrets>(tenantId: string, kind: string, provider: string) {
  const { rows } = await db().query<{ config: any; secrets_enc: string | null }>(
    "SELECT config, secrets_enc FROM connector_accounts WHERE tenant_id = $1 AND kind = $2 AND provider = $3",
    [tenantId, kind, provider],
  );
  if (!rows[0]) return null;
  return {
    config: rows[0].config,
    secrets: rows[0].secrets_enc ? decryptJson<TSecrets>(rows[0].secrets_enc) : null,
  };
}

export async function saveConnector(tenantId: string, kind: string, provider: string, cfg: unknown, secrets: unknown) {
  await db().query(
    `INSERT INTO connector_accounts (tenant_id, kind, provider, config, secrets_enc)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, kind, provider) DO UPDATE SET config = EXCLUDED.config, secrets_enc = EXCLUDED.secrets_enc`,
    [tenantId, kind, provider, JSON.stringify(cfg), encryptJson(secrets)],
  );
}

/** Phase 1 has one telephony provider; this is the seam where Twilio would slot in. */
export async function telephonyFor(tenantId: string): Promise<TelephonyProvider> {
  const conn = await getConnector<QuoSecrets>(tenantId, "telephony", "quo");
  if (!conn?.secrets) throw new Error(`Tenant ${tenantId} has no Quo connector`);
  return new QuoClient(conn.secrets);
}
