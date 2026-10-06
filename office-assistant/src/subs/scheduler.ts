import type { Deps } from "../pipeline/processCall";
import { db } from "../lib/db";
import { log } from "../lib/log";
import { getTenantById } from "../tenants";
import { runAutomation } from "./automation";

/** Runs the sub automation for every company that has a phone connected. One company failing never blocks the rest. */
export async function runAllTenants(deps: Pick<Deps, "telephony">, now = new Date()): Promise<void> {
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
