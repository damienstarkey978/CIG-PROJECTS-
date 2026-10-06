# office-assistant

AI office assistant for small GC offices. Phase 1: Quo's Sona agent answers calls; this service takes over after hangup. It classifies the caller, writes records to the backbone database, creates tasks, and texts the office.

Architecture and open questions: [Phase 1 Architecture doc](https://claude.ai/code/artifact/94c81139-6bf7-4f99-8b07-cf67d51739e6).

## Plug in model

One app, many companies. Each company is a tenant, and everything outside the core is a connector picked per company in the web app (Connectors tab): phone, calendar, job software, accounting. The catalog lives in `src/connectors/registry.ts`; adding a provider is one manifest plus one adapter, and the pipeline never names a provider.

| Kind | Ready | Planned |
| --- | --- | --- |
| Phone and texting | Quo, Demo phone | Twilio |
| Calendar | | Google Calendar |
| Jobs and schedules | | CSV import, Buildertrend |
| Accounting | | QuickBooks Online, Xero |

## Web app and demo (no Quo needed)

```
ADMIN_TOKEN=pick-something-long npm run dev     # open http://localhost:8080
```

Sign in with `ADMIN_TOKEN`, Add company, Connectors, connect **Demo phone**, then the Demo tab runs practice calls through the whole pipeline. Without Anthropic credentials the app uses a crude offline keyword classifier (logged as a warning); set `ANTHROPIC_API_KEY` to use Claude. Simulated calls are refused on any company that has a real phone connected, so a demo can never text a real number.

## How it works

```
Quo webhook ──> POST /webhooks/quo/<tenant>
                 verify signature, dedupe on event id, store raw event,
                 upsert call, enqueue process_call            (one transaction)
work_queue ──> process_call
                 wait for transcript (or give up after 15 min)
                 known number on file?  -> that type wins
                 else Claude classifies -> below threshold = "unknown"
                 write contact / lead / task, mark processed   (one transaction)
                 shadow: one [SHADOW] report text to the shadow recipient
                 live:   follow up text (only if approved copy exists) + office alerts
```

| Path | What |
| --- | --- |
| `migrations/` | Backbone schema (tenants, contacts, subs, clients, jobs, leads, interactions, tasks, connectors, queue) |
| `src/connectors/` | Provider interfaces (`types.ts`) and the Quo adapter |
| `src/ai/classify.ts` | Prompt, output schema, Claude call |
| `src/pipeline/` | Ingest, routing rules (pure), alert text, the call pipeline |
| `src/lib/queue.ts` | Postgres backed work queue (no extra infra) |
| `scripts/` | Tenant setup, webhook registration, eval tools |

Texts to callers use only copy stored in `tenants.settings.templates` (`lead_callback`, `ack_sub_vendor`, `ack_client`, `generic`; placeholders `{first_name}`, `{company}`). No template means no text. Every text sent, or reported in shadow mode, is logged in `outbound_messages`.

## Local dev

```
npm install
cp .env.example .env          # fill DATABASE_URL and APP_ENCRYPTION_KEY
npm run migrate
npm test                      # pipeline tests need DATABASE_URL; they wipe that database
npm run dev
```

## Deploy and connect WCI (one time)

These need accounts and money, so they are not automated:

1. `fly apps create office-assistant` and `fly postgres create` (or Supabase); attach so `DATABASE_URL` is set.
2. `fly secrets set APP_ENCRYPTION_KEY=... ANTHROPIC_API_KEY=... PUBLIC_BASE_URL=https://office-assistant.fly.dev`
3. Run the "Deploy office-assistant to Fly.io" workflow (needs the `FLY_API_TOKEN` repo secret).
4. From a machine with the prod `DATABASE_URL`:
   ```
   QUO_API_KEY=... npm run tenant:create -- --slug wci --name "World Construction Inc." \
     --inbox PNEYAAmj7S --shadow-phone +1XXXXXXXXXX
   npm run quo:register-webhooks -- --slug wci
   ```
   `PNEYAAmj7S` is the WCI line (904) 717-1729. The tenant starts in shadow mode.
5. Turn on call recording and transcription for that line in Quo, with the recording disclosure (Florida is an all-party consent state).

## Eval (step 3)

```
npm run eval:pull -- --slug wci     # writes data/eval/calls.jsonl (gitignored, customer data)
# fill in "label" on each row
npm run eval:run                    # dry run: counts rows
npm run eval:run -- --yes           # one Claude call per labeled row; prints accuracy, confusion, leads lost to solicitor
```

Calls build up from shadow mode, so the set grows on its own. Agree on a target, especially zero real leads routed as solicitor, before switching a tenant to `"mode": "live"`.

## To verify against real Quo traffic

The Quo docs were not reachable while this was built. These are coded from the OpenPhone v1 API and flagged `VERIFY` in `src/connectors/quo.ts`:

- Signature header name (`openphone-signature`, `quo-signature` accepted) and format `hmac;1;<ts>;<digest>`.
- How a Sona-answered call shows up in `call.completed` (currently: answered with no teammate `userId`).
- Voicemail transcript field name on `call.completed`.
- REST base `https://api.openphone.com/v1` (override with `QUO_API_BASE`) and the webhook creation endpoints.

Raw payloads land in `webhook_events`, so the first real calls settle these.
