import express from "express";
import { claudeClassifier } from "./ai/classify";
import { config } from "./config";
import { db, migrate } from "./lib/db";
import { log } from "./lib/log";
import { startWorker } from "./lib/queue";
import { ingestEvent } from "./pipeline/ingest";
import { handlers, type Deps } from "./pipeline/processCall";
import { getTenantBySlug, telephonyFor } from "./tenants";

export function buildApp(deps: Pick<Deps, "telephony">) {
  const app = express();

  app.get("/health", async (_req, res) => {
    await db().query("SELECT 1");
    res.json({ ok: true });
  });

  // One URL per tenant: /webhooks/quo/<tenant slug>
  app.post("/webhooks/quo/:tenant", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
    try {
      const tenant = await getTenantBySlug(String(req.params.tenant));
      if (!tenant) return void res.status(404).end();
      const tel = await deps.telephony(tenant.id);
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !tel.verifyWebhook(raw, req.headers)) {
        log.warn("rejected webhook signature", { tenant: tenant.slug });
        return void res.status(401).end();
      }
      const evt = tel.parseWebhook(raw);
      const fresh = await ingestEvent(tenant.id, tel.name, evt, JSON.parse(raw.toString("utf8")));
      log.info("webhook", { tenant: tenant.slug, type: evt.type, eventId: evt.eventId, duplicate: !fresh });
      res.status(200).json({ ok: true });
    } catch (err) {
      log.error("webhook failed", { error: String(err) });
      res.status(500).end(); // provider retries; dedupe makes that safe
    }
  });

  return app;
}

async function main() {
  const applied = await migrate();
  if (applied.length) log.info("migrations applied", { applied });
  const deps: Deps = { telephony: telephonyFor, classify: claudeClassifier() };
  startWorker(handlers(deps), config.workerPollMs);
  buildApp(deps).listen(config.port, () => log.info("listening", { port: config.port }));
}

if (require.main === module) {
  main().catch((err) => {
    log.error("fatal", { error: String(err) });
    process.exit(1);
  });
}
