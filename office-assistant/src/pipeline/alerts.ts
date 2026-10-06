import type { Classification } from "../ai/classify";
import type { AnsweredBy } from "../connectors/types";
import { prettyPhone } from "../lib/phone";
import type { RouteDecision } from "./route";

// Internal copy only: these go to office staff, never to callers.

const HEADLINE: Record<RouteDecision["callerType"], string> = {
  lead: "NEW LEAD",
  sub_vendor: "SUB/VENDOR",
  existing_client: "CLIENT",
  solicitor: "SOLICITOR (filtered)",
  unknown: "NEEDS REVIEW",
};

const HANDLED: Record<AnsweredBy, string> = {
  ai_agent: "AI agent answered",
  person: "answered in office",
  missed: "missed call",
};

export function officeAlert(d: RouteDecision, c: Classification, callerPhone: string | null, answeredBy: AnsweredBy): string {
  const who = [c.caller_name, c.company].filter(Boolean).join(", ");
  const details = [c.job_type, c.job_address, c.timeline && `timeline: ${c.timeline}`, c.budget_hint && `budget: ${c.budget_hint}`]
    .filter(Boolean)
    .join(" | ");
  return [
    `${HEADLINE[d.callerType]}${c.urgency === "urgent" ? " (URGENT)" : ""}: ${prettyPhone(callerPhone)}${who ? ` ${who}` : ""}`,
    c.office_summary,
    details,
    d.task ? `Next: ${d.task.title}` : "",
    `(${HANDLED[answeredBy]})`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function shadowReport(
  d: RouteDecision,
  c: Classification,
  callerPhone: string | null,
  answeredBy: AnsweredBy,
  followUpPreview: string | null,
): string {
  const would: string[] = [];
  if (d.createLead) would.push("create lead");
  if (d.newContactType) would.push(`save contact as ${d.newContactType}`);
  if (d.task) would.push("create task");
  if (d.alertOffice) would.push("alert office");
  const followUp = d.followUpTemplate
    ? followUpPreview
      ? `text caller: "${followUpPreview}"`
      : `text caller with "${d.followUpTemplate}" (no approved copy yet, would skip)`
    : "no text to caller";
  return [
    `[SHADOW] ${officeAlert(d, c, callerPhone, answeredBy)}`,
    `Model: ${c.caller_type} @ ${c.confidence.toFixed(2)}. ${c.reasoning}`,
    `Would: ${would.join(", ") || "nothing"}; ${followUp}`,
  ].join("\n");
}

export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1") // "Hi , thanks" becomes "Hi, thanks" when a name is unknown
    .trim();
}
