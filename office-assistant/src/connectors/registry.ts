import { MockAccounting } from "./mockAccounting";
import { MockEmail } from "./mockEmail";
import { SmtpEmail } from "./smtp";
import { MockTelephony } from "./mock";
import { QuoClient, type QuoSecrets } from "./quo";
import type { AccountingProvider, EmailProvider, TelephonyProvider } from "./types";

// Every plug in a customer can pick, in one list. Adding a provider means adding
// a manifest here and an adapter next to it; the core never names a provider.

export type ConnectorKind = "telephony" | "calendar" | "jobs" | "accounting" | "email";

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
  /** Connected by signing in at the provider, not by typing keys. */
  oauth?: boolean;
  createTelephony?: (config: any, secrets: any) => TelephonyProvider;
  /** Only for providers needing no sign in. QuickBooks is built in tenants.ts so it can save refreshed tokens. */
  createAccounting?: () => AccountingProvider;
  createEmail?: (secrets: any) => EmailProvider;
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
    kind: "email",
    provider: "smtp",
    label: "Email (SMTP)",
    description: "Sends approved client emails from your own address. Works with Google Workspace (use an app password), Microsoft 365 and most business email.",
    status: "ready",
    fields: [
      { key: "host", label: "SMTP server", required: true, help: "e.g. smtp.gmail.com" },
      { key: "port", label: "Port", required: true, help: "587, or 465 for SSL" },
      { key: "user", label: "Login (usually the email address)", required: true },
      { key: "pass", label: "Password or app password", secret: true, required: true },
      { key: "fromEmail", label: "Send from", required: true, help: "e.g. office@yourcompany.com" },
      { key: "fromName", label: "Sender name", help: "Optional, e.g. Your Company" },
    ],
    createEmail: (secrets) => new SmtpEmail(secrets),
  },
  {
    kind: "email",
    provider: "demo_email",
    label: "Demo email",
    description: "Practice email. Nothing is actually sent.",
    status: "ready",
    fields: [],
    createEmail: () => new MockEmail(),
  },
  {
    kind: "email",
    provider: "gmail",
    label: "Gmail (sign in)",
    description: "Read the project manager's email and save drafts straight in your inbox.",
    status: "planned",
    fields: [],
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
    description: "Reads open bills and invoices, suggests jobs, flags missing paperwork, chases late invoices. Read only: it never pays anything or changes your books.",
    status: "ready",
    oauth: true,
    fields: [],
  },
  {
    kind: "accounting",
    provider: "demo_books",
    label: "Demo books",
    description: "Practice books with made up bills and invoices.",
    status: "ready",
    fields: [],
    createAccounting: () => new MockAccounting(),
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
  return MANIFESTS.map(({ createTelephony: _t, createAccounting: _a, createEmail: _e, ...m }) => m);
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
