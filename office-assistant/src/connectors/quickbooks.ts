import crypto from "node:crypto";
import type { AccountingProvider, AcctBill, AcctInvoice, AcctLine } from "./types";

// QuickBooks Online adapter, READ ONLY. Built to Intuit's documented REST and OAuth 2.0
// APIs and unit tested against canned responses; it has not yet been run against a real
// Intuit sandbox or production company. Only query (GET) endpoints are used.

export interface QboSecrets {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  /** ms since epoch when accessToken stops working */
  expiresAt: number;
}

export interface QboApp {
  clientId: string;
  clientSecret: string;
  env: "sandbox" | "production";
}

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting"; // read access is governed by what the app calls, not the scope
const API = { production: "https://quickbooks.api.intuit.com", sandbox: "https://sandbox-quickbooks.api.intuit.com" };
const PAGE = 500;

export function qboAppFromEnv(): QboApp | null {
  const { QBO_CLIENT_ID: clientId, QBO_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, env: process.env.QBO_ENV === "production" ? "production" : "sandbox" };
}

// ---- connect flow ----

/** state = tenant slug, expiry, signature. Stops one company's callback being replayed for another. */
export function signState(slug: string, key: Buffer, now = Date.now()): string {
  const body = `${slug}.${now + 15 * 60_000}`;
  const sig = crypto.createHmac("sha256", key).update(body).digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${sig}`;
}

export function verifyState(state: string, key: Buffer, now = Date.now()): string | null {
  const [bodyB64, sig] = state.split(".");
  if (!bodyB64 || !sig) return null;
  const body = Buffer.from(bodyB64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", key).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const i = body.lastIndexOf(".");
  return Number(body.slice(i + 1)) > now ? body.slice(0, i) : null;
}

export function authorizeUrl(app: QboApp, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: app.clientId, response_type: "code", scope: SCOPE, redirect_uri: redirectUri, state });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(app: QboApp, form: Record<string, string>, fetchImpl: typeof fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw new Error(`QuickBooks token request failed: ${res.status} ${await res.text()}`);
  const j: any = await res.json();
  return { accessToken: j.access_token as string, refreshToken: j.refresh_token as string, expiresAt: Date.now() + (j.expires_in as number) * 1000 - 60_000 };
}

export async function exchangeCode(app: QboApp, code: string, redirectUri: string, realmId: string, fetchImpl: typeof fetch = fetch): Promise<QboSecrets> {
  const t = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, fetchImpl);
  return { realmId, ...t };
}

// ---- mapping (pure, tested) ----

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const dateOnly = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 10) : null);

export function mapBill(b: any): AcctBill {
  const lines: AcctLine[] = (b.Line ?? [])
    .filter((l: any) => l.DetailType === "AccountBasedExpenseLineDetail" || l.DetailType === "ItemBasedExpenseLineDetail")
    .map((l: any) => {
      const d = l.AccountBasedExpenseLineDetail ?? l.ItemBasedExpenseLineDetail ?? {};
      return { description: l.Description ?? null, amount: num(l.Amount), account: d.AccountRef?.name ?? d.ItemRef?.name ?? null, customerRef: d.CustomerRef?.name ?? null };
    });
  return {
    externalId: String(b.Id),
    vendorExternalId: b.VendorRef?.value ?? null,
    vendorName: b.VendorRef?.name ?? "Unknown vendor",
    txnDate: dateOnly(b.TxnDate),
    dueDate: dateOnly(b.DueDate),
    amount: num(b.TotalAmt),
    balance: num(b.Balance),
    docNumber: b.DocNumber ?? null,
    memo: b.PrivateNote ?? null,
    lines,
  };
}

export function mapInvoice(i: any): AcctInvoice {
  return {
    externalId: String(i.Id),
    customerExternalId: i.CustomerRef?.value ?? null,
    customerName: i.CustomerRef?.name ?? "Unknown customer",
    txnDate: dateOnly(i.TxnDate),
    dueDate: dateOnly(i.DueDate),
    amount: num(i.TotalAmt),
    balance: num(i.Balance),
    docNumber: i.DocNumber ?? null,
  };
}

// ---- client ----

export class QuickBooksOnline implements AccountingProvider {
  readonly name = "quickbooks";

  /** onTokens is called when a refresh produced new tokens; the caller must persist them (Intuit rotates refresh tokens). */
  constructor(
    private secrets: QboSecrets,
    private readonly app: QboApp,
    private readonly onTokens: (s: QboSecrets) => Promise<void>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.secrets.expiresAt > this.now()) return this.secrets.accessToken;
    const t = await tokenRequest(this.app, { grant_type: "refresh_token", refresh_token: this.secrets.refreshToken }, this.fetchImpl);
    this.secrets = { ...this.secrets, ...t };
    await this.onTokens(this.secrets);
    return t.accessToken;
  }

  private async query<T>(entity: string, where: string, map: (r: any) => T): Promise<T[]> {
    const out: T[] = [];
    for (let start = 1; ; start += PAGE) {
      const sql = `select * from ${entity} where ${where} startposition ${start} maxresults ${PAGE}`;
      const url = `${API[this.app.env]}/v3/company/${encodeURIComponent(this.secrets.realmId)}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
      const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.accessToken()}`, Accept: "application/json" } });
      if (!res.ok) throw new Error(`QuickBooks query failed: ${res.status} ${await res.text()}`);
      const rows: any[] = ((await res.json()) as any).QueryResponse?.[entity] ?? [];
      out.push(...rows.map(map));
      if (rows.length < PAGE) return out;
    }
  }

  listOpenBills() {
    return this.query("Bill", "Balance > '0'", mapBill);
  }

  listOpenInvoices() {
    return this.query("Invoice", "Balance > '0'", mapInvoice);
  }
}
