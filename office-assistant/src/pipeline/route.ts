import type { CallerType, Classification } from "../ai/classify";

export type ContactType = "prospect" | "client" | "sub" | "vendor" | "solicitor" | "other";

export interface RouteInput {
  classification: Classification;
  knownContactType: ContactType | null;
  confidenceThreshold: number;
}

export interface RouteDecision {
  callerType: CallerType;
  /** Contact to create when the number is not on file. */
  newContactType: ContactType | null;
  createLead: boolean;
  task: { type: string; title: string } | null;
  /** Key into tenant settings.templates; null means never text this caller. */
  followUpTemplate: string | null;
  alertOffice: boolean;
}

const KNOWN_TYPE_TO_CALLER: Record<ContactType, CallerType | null> = {
  prospect: "lead",
  client: "existing_client",
  sub: "sub_vendor",
  vendor: "sub_vendor",
  solicitor: "solicitor",
  other: null,
};

/** Pure routing. Known numbers win over the model; low confidence always goes to a person. */
export function decideRoute({ classification, knownContactType, confidenceThreshold }: RouteInput): RouteDecision {
  const fromContact = knownContactType ? KNOWN_TYPE_TO_CALLER[knownContactType] : null;
  let callerType: CallerType = fromContact ?? classification.caller_type;
  if (!fromContact && classification.confidence < confidenceThreshold) callerType = "unknown";

  const name = classification.caller_name ?? "Caller";
  switch (callerType) {
    case "lead":
      return {
        callerType,
        newContactType: "prospect",
        createLead: true,
        task: { type: "lead_callback", title: `Call back new lead: ${name}${classification.job_type ? `, ${classification.job_type}` : ""}` },
        followUpTemplate: "lead_callback",
        alertOffice: true,
      };
    case "sub_vendor":
      return {
        callerType,
        newContactType: null, // office decides whether an unknown number is a sub or a vendor
        createLead: false,
        task: { type: "sub_vendor_message", title: `Sub/vendor message from ${classification.company ?? name}` },
        followUpTemplate: "ack_sub_vendor",
        alertOffice: true,
      };
    case "existing_client":
      return {
        callerType,
        newContactType: null,
        createLead: false,
        task: { type: "client_message", title: `Client message from ${name}` },
        followUpTemplate: "ack_client",
        alertOffice: true,
      };
    case "solicitor":
      return {
        callerType,
        newContactType: "solicitor",
        createLead: false,
        task: null,
        followUpTemplate: null,
        alertOffice: false,
      };
    case "unknown":
      return {
        callerType,
        newContactType: null,
        createLead: false,
        task: { type: "review_call", title: `Review call from ${name}` },
        followUpTemplate: "generic",
        alertOffice: true,
      };
  }
}
