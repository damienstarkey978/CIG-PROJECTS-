import { db } from "./lib/db";
import { decryptJson, encryptJson } from "./lib/crypto";
import { findManifest } from "./connectors/registry";
import { QuickBooksOnline, qboAppFromEnv, type QboSecrets } from "./connectors/quickbooks";
import type { AccountingProvider, EmailProvider, TelephonyProvider } from "./connectors/types";

export interface TenantSettings {
  mode: "shadow" | "live";
  shadowRecipientPhone?: string;
  confidenceThreshold: number;
  /** Days past due before an unpaid invoice gets a follow up task. */
  chaseAfterDays?: number;
  /** The line (E.164) that texts to subs are sent from. */
  outboundNumber?: string;
  /** Client progress emails. cc is added to every one, every time. */
  weeklyUpdates?: { cc?: string[]; closing?: string; signature?: string; senders?: string[]; inboundTokenHash?: string };
  /** The Friday plans and permitting report. */
  permitReport?: { enabled?: boolean; to?: string[]; signature?: string };
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

/** Whichever telephony connector the tenant has connected; the core never names a provider. */
export async function telephonyFor(tenantId: string): Promise<TelephonyProvider> {
  const { rows } = await db().query<{ provider: string; config: any; secrets_enc: string | null }>(
    "SELECT provider, config, secrets_enc FROM connector_accounts WHERE tenant_id = $1 AND kind = 'telephony' ORDER BY created_at LIMIT 1",
    [tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Tenant ${tenantId} has no telephony connector`);
  const manifest = findManifest("telephony", row.provider);
  if (!manifest?.createTelephony) throw new Error(`Unknown telephony provider ${row.provider}`);
  return manifest.createTelephony(row.config, row.secrets_enc ? decryptJson(row.secrets_enc) : {});
}

/** The tenant's books connection, or null when none is connected. */
export async function accountingFor(tenantId: string): Promise<AccountingProvider | null> {
  const { rows } = await db().query<{ provider: string; config: any; secrets_enc: string | null }>(
    "SELECT provider, config, secrets_enc FROM connector_accounts WHERE tenant_id = $1 AND kind = 'accounting' ORDER BY created_at LIMIT 1",
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.provider === "quickbooks") {
    const app = qboAppFromEnv();
    if (!app) throw new Error("QuickBooks isn't set up on this server (QBO_CLIENT_ID and QBO_CLIENT_SECRET)");
    if (!row.secrets_enc) throw new Error("QuickBooks isn't connected yet");
    return new QuickBooksOnline(decryptJson<QboSecrets>(row.secrets_enc), app, (secrets) => saveConnector(tenantId, "accounting", "quickbooks", row.config, secrets));
  }
  const manifest = findManifest("accounting", row.provider);
  if (!manifest?.createAccounting) throw new Error(`Unknown accounting provider ${row.provider}`);
  return manifest.createAccounting();
}

/** The tenant's outgoing email connection, or null when none is connected. */
export async function emailFor(tenantId: string): Promise<EmailProvider | null> {
  const { rows } = await db().query<{ provider: string; secrets_enc: string | null }>(
    "SELECT provider, secrets_enc FROM connector_accounts WHERE tenant_id = $1 AND kind = 'email' ORDER BY created_at LIMIT 1", [tenantId]);
  const row = rows[0];
  if (!row) return null;
  const manifest = findManifest("email", row.provider);
  if (!manifest?.createEmail) throw new Error(`Unknown email provider ${row.provider}`);
  return manifest.createEmail(row.secrets_enc ? decryptJson(row.secrets_enc) : {});
}
