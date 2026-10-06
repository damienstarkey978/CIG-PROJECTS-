// Starter wording for every text the system can send. New companies start with these in
// Settings so shadow reports show real wording; the owner can edit any of it, and live
// mode is a separate switch. Rules for this copy: sounds like a person at a small
// contractor, says who it is from, one ask per text, short enough for one or two
// messages, no links.
//
// Variables: {first_name} (dropped cleanly when unknown) and {business} (the company name).
// Subs messages also have {job}, {date} and {missing}.

export interface TemplateInfo {
  label: string;
  when: string;
  vars: string[];
  suggested: string;
}

export const TEMPLATE_KEYS = ["lead_callback", "ack_sub_vendor", "ack_client", "generic", "schedule_confirm", "paperwork_request"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_INFO = {
  lead_callback: {
    label: "New lead calls in",
    when: "Sent after a call from someone asking about new work.",
    vars: ["first_name", "business"],
    suggested: "Hi {first_name}, thanks for calling {business}. We got your message and someone from our team will call you back soon.",
  },
  ack_sub_vendor: {
    label: "A sub or vendor calls in",
    when: "Sent after a call from a sub or vendor.",
    vars: ["first_name", "business"],
    suggested: "Hi {first_name}, {business} here. We got your message and passed it along. We'll get back to you shortly.",
  },
  ack_client: {
    label: "A current client calls in",
    when: "Sent after a call from someone whose job we are doing.",
    vars: ["first_name", "business"],
    suggested: "Hi {first_name}, thanks for calling {business}. We passed your message to your project manager and they'll get back to you shortly.",
  },
  generic: {
    label: "Caller we couldn't sort",
    when: "Sent when the system isn't sure who called, so a person can look.",
    vars: ["first_name", "business"],
    suggested: "Hi {first_name}, thanks for calling {business}. We got your message and someone will get back to you shortly.",
  },
  schedule_confirm: {
    label: "Ask a sub to confirm they are on site",
    when: "Sent to a sub starting within 2 days. Replies of YES or NO update the schedule.",
    vars: ["first_name", "business", "job", "date"],
    suggested: "Hi {first_name}, {business} here. Are you still good to be at {job} {date}? Please reply YES or NO.",
  },
  paperwork_request: {
    label: "Ask a sub for missing paperwork",
    when: "Sent at most once a week to subs who are scheduled or have an open bill and are missing paperwork.",
    vars: ["first_name", "business", "missing"],
    suggested: "Hi {first_name}, {business} here. To keep your payments on track we still need your {missing}. Please text us a photo of it or email it to the office. Thanks!",
  },
} as const satisfies Record<TemplateKey, TemplateInfo>;

export const DEFAULT_TEMPLATES: Record<string, string> = Object.fromEntries(Object.entries(TEMPLATE_INFO).map(([k, v]) => [k, v.suggested]));
