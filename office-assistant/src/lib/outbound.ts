import type { TelephonyProvider } from "../connectors/types";
import type { Tenant } from "../tenants";
import { db } from "./db";
import { log } from "./log";

export type Purpose = "follow_up" | "office_alert" | "shadow_report" | "sub_confirm" | "sub_paperwork";

/** Sends one text and records it. A failed send is logged, never retried: a duplicate text is worse than a missed one. */
export async function sendLogged(tenant: Tenant, tel: TelephonyProvider, interactionId: string | null, purpose: Purpose, from: string, to: string, body: string): Promise<boolean> {
  let providerId: string | null = null;
  let error: string | null = null;
  try {
    providerId = (await tel.sendSms(from, to, body)).id;
  } catch (err) {
    error = String(err);
    log.error("sms send failed", { tenant: tenant.slug, purpose, error });
  }
  await db().query(
    `INSERT INTO outbound_messages (tenant_id, interaction_id, purpose, to_phone, body, mode, provider_message_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenant.id, interactionId, purpose, to, body, tenant.settings.mode, providerId, error],
  );
  return !error;
}
