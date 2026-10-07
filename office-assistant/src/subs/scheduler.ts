import type { Deps } from "../pipeline/processCall";
import { db } from "../lib/db";
import { log } from "../lib/log";
import { getTenantById } from "../tenants";
import { runPermitNudges } from "../permits/nudges";
import { runPermitReportTick } from "../updates/permitReport";
import { runAutomation } from "./automation";

/** Runs the sub automation for every company that has a phone connected. One company failing never blocks the rest. */
export async function runAllTenants(deps: Pick<Deps, "telephony">, now = new Date()): Promise<void> {
  // Permit and inspection reminders are internal tasks only, so they run for every company, any hour.
  const all = await db().query<{ id: string; timezone: string }>("SELECT id, timezone FROM tenants");
  for (const t of all.rows) {
    try {
      await runPermitNudges(t.id, t.timezone, now);
      await runPermitReportTick(await getTenantById(t.id), now);
    } catch (err) { log.error("permit nudges failed", { tenant: t.id, error: String(err) }); }
  }

  const { rows } = await db().query<{ id: string }>("SELECT DISTINCT tenant_id AS id FROM connector_accounts WHERE kind = 'telephony'");
  for (const r of rows) {
    try {
      const tenant = await getTenantById(r.id);
      const out = await runAutomation(tenant, await deps.telephony(r.id), { now });
      if (!out.skipped && (out.confirmRequests || out.escalations || out.paperworkRequests)) log.info("sub automation", { tenant: tenant.slug, ...out });
    } catch (err) {
      log.error("sub automation failed", { tenant: r.id, error: String(err) });
    }
  }
}
