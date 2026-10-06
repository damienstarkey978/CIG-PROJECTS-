import { MockTelephony } from "./mock";
import { QuoClient, type QuoSecrets } from "./quo";
import type { TelephonyProvider } from "./types";

// Every plug in a customer can pick, in one list. Adding a provider means adding
// a manifest here and an adapter next to it; the core never names a provider.

export type ConnectorKind = "telephony" | "calendar" | "jobs" | "accounting";

export interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}

export interface ConnectorManifest {
  kind: ConnectorKind;
  provider: string;
  label: string;
  description: string;
  /** ready: usable now. planned: shows in the catalog but cannot be connected yet. */
  status: "ready" | "planned";
  fields: FieldSpec[];
  /** Only for telephony adapters today. */
  createTelephony?: (config: any, secrets: any) => TelephonyProvider;
}

export const MANIFESTS: ConnectorManifest[] = [
  {
    kind: "telephony",
    provider: "quo",
    label: "Quo",
    description: "Business phone and texting. Sona answers calls; this app handles everything after.",
    status: "ready",
    fields: [
      { key: "apiKey", label: "Quo API key", secret: true, required: true, help: "Quo, Settings, API" },
      { key: "inboxPhoneNumberIds", label: "Quo line IDs (PN...)", help: "Comma separated" },
    ],
    createTelephony: (_config, secrets: QuoSecrets) => new QuoClient(secrets),
  },
  {
    kind: "telephony",
    provider: "mock",
    label: "Demo phone",
    description: "Practice phone line. Calls come from the simulator and no real texts are sent.",
    status: "ready",
    fields: [],
    createTelephony: () => new MockTelephony(),
  },
  {
    kind: "calendar",
    provider: "google",
    label: "Google Calendar",
    description: "Book estimate visits straight onto a calendar.",
    status: "planned",
    fields: [],
  },
  {
    kind: "jobs",
    provider: "csv",
    label: "CSV import",
    description: "Load jobs, subs and contacts from any software's export. Use the Import tab.",
    status: "ready",
    fields: [],
  },
  {
    kind: "jobs",
    provider: "buildertrend",
    label: "Buildertrend",
    description: "Jobs, schedules and subs from Buildertrend.",
    status: "planned",
    fields: [],
  },
  {
    kind: "accounting",
    provider: "quickbooks",
    label: "QuickBooks Online",
    description: "Bill coding, receipts, AP and AR, payroll prep. Prepares and flags only.",
    status: "planned",
    fields: [],
  },
  {
    kind: "accounting",
    provider: "xero",
    label: "Xero",
    description: "Same bookkeeping prep for shops on Xero.",
    status: "planned",
    fields: [],
  },
];

export function findManifest(kind: string, provider: string): ConnectorManifest | undefined {
  return MANIFESTS.find((m) => m.kind === kind && m.provider === provider);
}

/** What the UI may show: manifests without factory functions. */
export function publicCatalog() {
  return MANIFESTS.map(({ createTelephony: _f, ...m }) => m);
}

/** Splits submitted values into non secret config and secrets, and checks required fields. */
export function splitFields(m: ConnectorManifest, values: Record<string, unknown>, existingSecrets: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = { ...existingSecrets };
  for (const f of m.fields) {
    const v = values[f.key];
    const blank = v === undefined || v === null || v === "";
    if (f.secret) {
      if (!blank) secrets[f.key] = v;
      if (f.required && secrets[f.key] === undefined) throw new Error(`${f.label} is required`);
    } else {
      if (!blank) config[f.key] = v;
      if (f.required && config[f.key] === undefined) throw new Error(`${f.label} is required`);
    }
  }
  return { config, secrets };
}
