// Wine Babe scan engine: Claude reads the label, researches the web, fills the checklist.
// Used by server.js (Fly / local) and the Netlify functions.

const { CHECKLIST, ALL_ITEMS } = require("../public/checklist.js");

const MODEL = process.env.WINE_BABE_MODEL || "claude-opus-5-5";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// The SDK is ESM only, so load it with a dynamic import. A static require()
// cannot resolve it and the Netlify bundler left it out of the function.
let clientPromise = null;
function getClient() {
  if (!HAS_KEY) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import("@anthropic-ai/sdk").then((sdk) => {
      const Anthropic = sdk.default || sdk.Anthropic || sdk;
      return new Anthropic();
    });
  }
  return clientPromise;
}
// ---------- structured output schema ----------

const num = { type: ["number", "null"] };
const str = { type: ["string", "null"] };

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["identified", "wine", "nutrition", "checks", "summary", "sources"],
  properties: {
    identified: { type: "boolean", description: "False if the label could not be read or the wine could not be identified." },
    wine: {
      type: "object",
      additionalProperties: false,
      required: ["name", "producer", "vintage", "region", "country", "grapes", "style", "tech_sheet_url", "tech_sheet_vintage"],
      properties: {
        name: str, producer: str, vintage: str, region: str, country: str, grapes: str,
        style: str, tech_sheet_url: str,
        tech_sheet_vintage: { type: ["string", "null"], description: "Vintage the tech sheet covers, if it differs or is stated." },
      },
    },
    nutrition: {
      type: "object",
      additionalProperties: false,
      required: ["abv", "residual_sugar_g_l", "calories_5oz", "carbs_5oz", "total_so2_mg_l", "free_so2_mg_l", "ph", "ta_g_l", "source"],
      properties: {
        abv: num, residual_sugar_g_l: num, calories_5oz: num, carbs_5oz: num,
        total_so2_mg_l: num, free_so2_mg_l: num, ph: num, ta_g_l: num,
        source: { type: "string", enum: ["lab", "certified", "winery", "estimate", "none"] },
      },
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "evidence", "detail", "source_url"],
        properties: {
          id: { type: "string", enum: ALL_ITEMS.map((i) => i.id) },
          status: { type: "string", enum: ["pass", "fail", "unknown"] },
          evidence: { type: "string", enum: ["lab", "certified", "winery", "estimate", "none"] },
          detail: { type: "string" },
          source_url: str,
        },
      },
    },
    summary: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url"],
        properties: { title: { type: "string" }, url: { type: "string" } },
      },
    },
  },
};

const CHECKLIST_TEXT = CHECKLIST.map(
  (c) => `${c.title}\n` + c.items.map((i) => `  - ${i.id}: ${i.label}. ${i.ask}`).join("\n")
).join("\n");

const SYSTEM = `You are the research engine behind Wine Babe, an app that scans a wine bottle and reports how transparent and clean that wine is.

Your job:
1. Identify the exact wine from the label photo or text: producer, wine name, grape, region, country, vintage.
2. Search the web for the producer's technical sheet (tech sheet / fiche technique / scheda tecnica / ficha técnica), usually on the winery or importer site, often a PDF. Prefer the sheet for the scanned vintage. Fetch it and read the numbers.
3. Search for certifications and production practices: organic (USDA, EU organic, CCOF, Ecocert), biodynamic (Demeter), sustainable (SIP, LODI RULES, Equalitas, SWNZ, VIVA, B Corp), vegan (winery statements, Barnivore), non GMO, ownership (family owned), harvesting, fining agents, yeast, sulfites, additives, heavy metal testing.
4. Fill every checklist item below.

Rules for each check:
- status "pass" only when a source supports it. "fail" when a source contradicts it (for example residual sugar above 6.7 g/L, or egg white fining). "unknown" when you found nothing. Never guess a pass.
- evidence: "lab" = laboratory numbers on a tech sheet or lab report; "certified" = third party certification you found; "winery" = the producer or importer states it; "estimate" = you calculated it from other data; "none" = nothing found.
- detail: one short plain sentence a shopper can read, with the number when there is one.
- source_url: the page that supports it, or null.

Nutrition per 5 oz (148 ml): sugar g = residual sugar g/L x 0.148. If calories or carbs are not published, calculate them (alcohol g = 148 x ABV/100 x 0.789, 7 kcal/g; carbs ~ sugar + 0.5 g; 4 kcal/g) and set the related checks to evidence "estimate". Leave a nutrition number null rather than invent it. nutrition.source is the strongest evidence behind the sugar number.

If the tech sheet is for a different vintage than the bottle, say so in wine.tech_sheet_vintage and in the detail of affected checks, since sugar, ABV and practices change by vintage.

If the photo is not a wine label or is unreadable, set identified false, explain in summary, and mark all checks unknown.

summary: two or three friendly sentences for a shopper: what the wine is, how well documented it is, and the headline on sugar.

Checklist (use these exact ids, one check per id):
${CHECKLIST_TEXT}`;

// ---------- Claude call ----------

async function runScan({ image, mediaType, query }, send) {
  const content = [];
  if (image) {
    content.push({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } });
    content.push({ type: "text", text: `Scan this wine label and complete the Wine Babe checklist.${query ? ` Extra info from the shopper: ${query}` : ""}` });
  } else {
    content.push({ type: "text", text: `Find this wine and complete the Wine Babe checklist: ${query}` });
  }

  const messages = [{ role: "user", content }];
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: 8 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 },
  ];

  const client = await getClient();
  let final;
  for (let turn = 0; turn < 5; turn++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      system: SYSTEM,
      tools,
      messages,
      output_config: { effort: "medium", format: { type: "json_schema", schema: RESULT_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    stream.on("streamEvent", (ev) => {
      if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") {
        send({ type: "status", text: ev.content_block.name === "web_fetch" ? "Reading a source" : "Searching the web" });
      }
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && block.input) {
        if (block.input.query) send({ type: "search", text: block.input.query });
        if (block.input.url) send({ type: "fetch", text: block.input.url });
      }
    });

    final = await stream.finalMessage();
    if (final.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: final.content });
    send({ type: "status", text: "Still digging" });
  }

  if (final.stop_reason === "refusal") throw new Error("This scan could not be completed. Try another photo.");
  const text = final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const start = text.indexOf("{");
  if (start < 0) throw new Error("No result came back. Try again.");
  return JSON.parse(text.slice(start));
}

// ---------- demo mode (no API key) ----------

function demoResult() {
  const pass = (id, evidence, detail) => ({ id, status: "pass", evidence, detail, source_url: null });
  const unk = (id) => ({ id, status: "unknown", evidence: "none", detail: "No public information found.", source_url: null });
  const known = {
    tech_sheet: pass("tech_sheet", "lab", "Tech sheet lists 2.1 g/L residual sugar."),
    sugar_under_1g: pass("sugar_under_1g", "lab", "About 0.3 g sugar per 5 oz."),
    no_added_sugar: pass("no_added_sugar", "winery", "Winery states no sugar or concentrate added."),
    calories: pass("calories", "estimate", "About 108 calories per 5 oz, calculated from ABV and sugar."),
    carbs: pass("carbs", "estimate", "About 0.8 g carbs per 5 oz, calculated."),
    abv: pass("abv", "lab", "12.5% ABV on the tech sheet."),
    vegan: pass("vegan", "winery", "Fined with pea protein, no animal products."),
    organic: pass("organic", "certified", "EU organic certified vineyards."),
    sustainable: pass("sustainable", "certified", "Equalitas sustainability certified."),
    hand_harvested: pass("hand_harvested", "winery", "Grapes picked by hand in September."),
    sulfites: pass("sulfites", "lab", "Total SO2 78 mg/L, free 22 mg/L. Sulfites added."),
    origin: pass("origin", "certified", "DOC Friuli, Italy."),
    grape_variety: pass("grape_variety", "winery", "100% Pinot Grigio."),
    vintage: pass("vintage", "winery", "2024 vintage."),
    family_owned: pass("family_owned", "winery", "Third generation family estate."),
  };
  return {
    demo: true,
    identified: true,
    wine: {
      name: "Sample Pinot Grigio (demo)", producer: "Demo Estate", vintage: "2024", region: "Friuli",
      country: "Italy", grapes: "Pinot Grigio", style: "Dry white", tech_sheet_url: null, tech_sheet_vintage: null,
    },
    nutrition: { abv: 12.5, residual_sugar_g_l: 2.1, calories_5oz: 108, carbs_5oz: 0.8, total_so2_mg_l: 78, free_so2_mg_l: 22, ph: 3.3, ta_g_l: 5.8, source: "lab" },
    checks: ALL_ITEMS.map((i) => known[i.id] || unk(i.id)),
    summary: "Demo result. Add an ANTHROPIC_API_KEY on the server to scan real bottles. This sample shows how a well documented dry white looks.",
    sources: [],
  };
}

async function runDemo(send) {
  const steps = [
    ["search", "Demo Estate Pinot Grigio 2024 technical sheet"],
    ["fetch", "demo-estate.example/tech-sheet.pdf"],
    ["search", "Demo Estate organic certification vegan"],
  ];
  for (const [type, text] of steps) {
    send({ type, text });
    await new Promise((r) => setTimeout(r, 700));
  }
  return demoResult();
}

module.exports = { runScan, runDemo, HAS_KEY };
