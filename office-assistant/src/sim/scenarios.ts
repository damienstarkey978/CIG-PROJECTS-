// Made up calls for demos and tests. Names, numbers and addresses are fictional.

export interface Scenario {
  id: string;
  label: string;
  from: string;
  answeredBy: "ai_agent" | "missed";
  /** Caller lines only matter to the classifier; agent lines give it context. */
  lines: { who: "caller" | "agent"; text: string }[];
  voicemail?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "lead_bathroom",
    label: "New lead: bathroom remodel",
    from: "+19045550111",
    answeredBy: "ai_agent",
    lines: [
      { who: "agent", text: "Thanks for calling. How can I help?" },
      { who: "caller", text: "Hi, this is Jane Smith. We want to redo our master bathroom and add a walk in shower. We'd like to start next spring." },
      { who: "agent", text: "Happy to get that to the team. What's the address?" },
      { who: "caller", text: "It's 4410 Riverside Ave. Can someone call me back with an estimate?" },
    ],
  },
  {
    id: "lead_roof_voicemail",
    label: "Missed call: roof quote voicemail",
    from: "+19045550122",
    answeredBy: "missed",
    lines: [],
    voicemail: "Hi, this is Tom Alvarez. A tree took out part of my roof and it's leaking. I need a quote as soon as possible. Please call me back.",
  },
  {
    id: "sub_lien_waiver",
    label: "Sub: lien waiver and schedule",
    from: "+19045550133",
    answeredBy: "ai_agent",
    lines: [
      { who: "agent", text: "Thanks for calling. How can I help?" },
      { who: "caller", text: "It's Mike with Coastal Tile. My crew is on site Thursday at the Hendricks job, and I still need the lien waiver signed for the last draw before I can send my invoice." },
    ],
  },
  {
    id: "solicitor_seo",
    label: "Solicitor: SEO pitch",
    from: "+19045550144",
    answeredBy: "ai_agent",
    lines: [
      { who: "agent", text: "Thanks for calling. How can I help?" },
      { who: "caller", text: "Hi, this is Kyle with BuildLeads Pro. We help contractors get more booked jobs through Google ads and SEO. Is the owner available?" },
    ],
  },
  {
    id: "client_change_order",
    label: "Client: question about their job",
    from: "+19045550155",
    answeredBy: "ai_agent",
    lines: [
      { who: "agent", text: "Thanks for calling. How can I help?" },
      { who: "caller", text: "This is Dana Brooks. You're working on our kitchen and I wanted to ask when will the countertops go in, and whether the change order for the backsplash is approved." },
    ],
  },
  {
    id: "unclear",
    label: "Unclear: silence and a short hello",
    from: "+19045550166",
    answeredBy: "ai_agent",
    lines: [
      { who: "agent", text: "Thanks for calling. How can I help?" },
      { who: "caller", text: "Hello? Uh, is this the right number? Never mind." },
    ],
  },
  {
    id: "missed_hangup",
    label: "Missed call, no message",
    from: "+19045550177",
    answeredBy: "missed",
    lines: [],
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
