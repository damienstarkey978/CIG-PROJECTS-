// Wine Babe scan engine. Built for speed (target: under a minute).
//
//   1. Identify (one fast call): read the label, find the winery website and
//      the wine's product page.
//   2. Cache: if this wine was scanned before, return that result at once.
//   3. Three focused lookups run in parallel, each going straight to the most
//      reliable source for its items, with a hard time limit:
//        - techSheet:   the winery's own tech sheet PDF (sugar, ABV, SO2, GMO, dosage, additives)
//        - farming:     winery sustainability / about / news pages and certifier listings
//        - vegan:       winery statement, then Barnivore
//   4. Merge: for each checklist item keep the strongest finding.
//
// Used by server.js (Fly / local) and the Netlify functions.

const { CHECKLIST, ALL_ITEMS, EVIDENCE } = require("../public/checklist.js");

const MODEL = process.env.WINE_BABE_MODEL || "claude-sonnet-5-5";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const AGENT_TIME_LIMIT_MS = Number(process.env.WINE_BABE_AGENT_MS || 45000);
const CACHE_DAYS = 30;

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

// ---------- schemas ----------

// The API allows at most 16 union typed fields per schema, so only the
// nutrition numbers are nullable. Text fields use "" for unknown.
const num = { type: ["number", "null"] };
const str = { type: "string" };
const EVIDENCE_ENUM = ["lab", "certified", "winery", "estimate", "none"];

const checkSchema = (ids) => ({
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "evidence", "scope", "as_of", "detail", "source_url"],
  properties: {
    id: { type: "string", enum: ids },
    status: { type: "string", enum: ["pass", "fail", "unknown", "na"] },
    evidence: { type: "string", enum: EVIDENCE_ENUM },
    scope: { type: "string", enum: ["this_wine", "producer", "related_wine"] },
    as_of: str,
    detail: str,
    source_url: str,
  },
});

const SOURCES = {
  type: "array",
  items: { type: "object", additionalProperties: false, required: ["title", "url"], properties: { title: str, url: str } },
};

const IDENTIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["identified", "wine", "winery_website", "product_page_url", "note"],
  properties: {
    identified: { type: "boolean" },
    wine: {
      type: "object",
      additionalProperties: false,
      required: ["name", "producer", "vintage", "region", "country", "grapes", "style"],
      properties: { name: str, producer: str, vintage: str, region: str, country: str, grapes: str, style: str },
    },
    winery_website: str,
    product_page_url: str,
    note: str,
  },
};

const agentSchema = (ids, withNutrition) => {
  const props = { checks: { type: "array", items: checkSchema(ids) }, sources: SOURCES };
  const required = ["checks", "sources"];
  if (withNutrition) {
    props.nutrition = {
      type: "object",
      additionalProperties: false,
      required: ["abv", "residual_sugar_g_l", "calories_5oz", "carbs_5oz", "total_so2_mg_l", "free_so2_mg_l", "ph", "ta_g_l", "source"],
      properties: {
        abv: num, residual_sugar_g_l: num, calories_5oz: num, carbs_5oz: num,
        total_so2_mg_l: num, free_so2_mg_l: num, ph: num, ta_g_l: num,
        source: { type: "string", enum: EVIDENCE_ENUM },
      },
    };
    props.tech_sheet_url = str;
    props.tech_sheet_vintage = str;
    required.push("nutrition", "tech_sheet_url", "tech_sheet_vintage");
  }
  return { type: "object", additionalProperties: false, required, properties: props };
};

// ---------- which lookup owns which items ----------
// Items may appear in more than one lookup; the merge keeps the best finding.

const TECH_IDS = [
  "tech_sheet", "sugar_under_1g", "no_added_sugar", "zero_dosage", "calories", "carbs", "abv",
  "non_gmo", "no_artificial_flavors", "no_natural_flavors", "no_artificial_colors", "no_artificial_sweeteners",
  "gluten_free", "traditional_fermentation", "no_added_water", "no_unnecessary_additives", "sulfites", "yeast",
  "minimal_intervention", "no_concentrates", "temp_controlled", "origin", "single_vineyard", "grape_variety",
  "vintage", "traceability", "vegan", "organic", "hand_harvested",
];
const FARM_IDS = [
  "organic", "sustainable", "hand_harvested", "minimal_pesticide", "no_synthetic_herbicides", "biodiversity",
  "water_conservation", "regenerative", "estate_grown", "family_owned", "certifications", "non_gmo",
];
const VEGAN_IDS = ["vegan", "gluten_free", "heavy_metals"];

const itemList = (ids) =>
  ALL_ITEMS.filter((i) => ids.includes(i.id)).map((i) => `- ${i.id}: ${i.label}. ${i.ask}`).join("\n");

// ---------- prompts ----------

const RULES = `Rules for each check:
- A clear winery statement is enough for a pass (evidence "winery"): on the winery's site, its tech sheet, or its importer's page. A certificate or certifier listing is "certified". Lab numbers on a tech sheet are "lab". A calculation is "estimate".
- status "pass" when a source supports it, "fail" when a source contradicts it (residual sugar above 6.7 g/L, egg white or casein fining, sugar added at dosage), "unknown" when you found nothing, "na" when it does not apply (zero_dosage for a still wine). Never guess a pass.
- scope: "this_wine" (source is about this exact wine), "producer" (winery wide statement, e.g. "all our wines are vegan", "150 ha certified SQNPI"), "related_wine" (a sister wine's tech sheet from the same producer; name it in the detail).
- as_of: date or year of the statement or document if shown, else "".
- detail: one short plain sentence for a shopper, with the number or quoted wording when there is one.
- source_url: the page that supports it, or "".
- Return one check for every id listed. Be fast: stop as soon as you have the answers; do not research beyond your listed sources.`;

const wineLine = (w) =>
  `${w.producer} ${w.name}${w.vintage ? ` ${w.vintage}` : ""} (${[w.style, w.grapes, w.region, w.country].filter(Boolean).join(", ")})`;

const IDENTIFY_SYSTEM = `You identify wines for the Wine Babe app, fast.
From the label photo or text, identify producer, wine name, vintage, region, country, grapes and style (for sparkling, the dosage term on the label: Brut Nature, Pas Dosé, Dosaggio Zero, Extra Brut, Brut, Extra Dry...).
Then find the winery's official website and this wine's product page on it, with at most two web searches. Prefer the winery's own domain over shops.
If the photo is not a wine label or is unreadable, set identified false and explain in note. Unknown text fields are "".`;

const techPrompt = (w, site, page) => `You read a wine's technical sheet for the Wine Babe app. Wine: ${wineLine(w)}.
Winery website: ${site || "unknown"}. Product page: ${page || "unknown"}.

Most reliable source: the winery's own tech sheet (PDF). Steps, in order, stop once you have it:
1. Call find_page_links on the product page (or the winery's products / downloads page) and web_fetch the PDF that matches this wine (match the name in the file name or link text; prefer English).
2. If that fails, one web search: "<producer> <wine> scheda tecnica OR technical sheet OR fiche technique pdf", then fetch the best PDF.
3. If there is no sheet for this exact wine, use a sister wine's sheet from the same producer (scope "related_wine"); winery wide lines like NO OGM / GMO free, allergens and fining usually appear on every sheet.
Read every line: residual sugar, ABV, total and free SO2 (if a range, use the highest value and quote the range), pH, acidity, GMO, allergens, vegan, fining, yeast, dosage, harvest, vineyard.

Nutrition per 5 oz (148 ml): if calories or carbs are not published, calculate them (alcohol g = 148 x ABV/100 x 0.789 x 7 kcal; carbs ~ sugar g + 0.5; sugar g = residual sugar g/L x 0.148) and mark those checks "estimate". Leave numbers null rather than invent them. nutrition.source = evidence behind the sugar number.
zero_dosage: sparkling with no sugar added at dosage (Brut Nature, Pas Dosé, Dosaggio Zero, or 0 g/L dosage); the label term alone is winery evidence. Still wines: "na".
no_added_sugar: any sugar, concentrate or sweetener added at any stage.
tech_sheet_vintage: vintage the sheet covers if stated, else "".

${RULES}

Items:
${itemList(TECH_IDS)}`;

const farmPrompt = (w, site) => `You check farming practices and certifications for the Wine Babe app. Wine: ${wineLine(w)}.
Winery website: ${site || "unknown"}.

Most reliable sources, in order, stop once you have the answers:
1. The winery's own sustainability / about / vineyards / news pages: fetch the website and the most relevant one or two pages.
2. One web search for certifications by winery name with that country's certifiers. Italy: SQNPI, Equalitas, VIVA, biologico. France: HVE, Terra Vitis, AB. Spain: ecológico. USA: SIP Certified, LODI RULES, Napa Green, CCOF, CCSW. New Zealand: SWNZ. Germany: Ecovin, FairChoice. Organic: EU organic, USDA Organic, Demeter.
A winery page or dated announcement that names a certification is "certified", scope "producer", with as_of the date.

${RULES}

Items:
${itemList(FARM_IDS)}`;

const veganPrompt = (w, site) => `You check vegan status for the Wine Babe app. Wine: ${wineLine(w)}.
Winery website: ${site || "unknown"}.

Most reliable sources, in order, stop once you have the answer:
1. Barnivore (barnivore.com): one web search "barnivore <producer>" and fetch the producer's entry; it quotes the winery's own reply and date. That is evidence "winery", scope "producer", as_of the date.
2. If not on Barnivore: one search for the winery's own vegan statement (site or importer).
gluten_free: only pass if a source states it. heavy_metals: only pass if lab results for lead / arsenic / cadmium are published; otherwise "unknown".

${RULES}

Items:
${itemList(VEGAN_IDS)}`;

// ---------- custom tool: find document links on a page ----------
// web_fetch returns page text, not its links, so PDF tech sheets linked from
// a product page are easy to miss. This tool reads the raw HTML and returns
// the PDF and download links so Claude can web_fetch them next.

const LINK_WORDS = /(\.pdf\b|scheda|tecnic|technical|tech[-_ ]?sheet|fiche|ficha|datasheet|download|allegat|wp-content\/uploads)/i;

async function findPageLinks(url) {
  let u;
  try { u = new URL(url); } catch { return { error: "Invalid URL" }; }
  if (!/^https?:$/.test(u.protocol)) return { error: "Only http(s) URLs" };
  // Public sites only: never let a page steer this fetch at internal hosts.
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[")
  ) return { error: "Only public websites" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(u, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WineBabeScanner/1.0)", Accept: "text/html,*/*" },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const html = (await res.text()).slice(0, 3_000_000);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
    const seen = new Set();
    const links = [];
    const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && links.length < 40) {
      let href;
      try { href = new URL(m[1].trim(), res.url).href; } catch { continue; }
      const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!/^https?:/.test(href) || seen.has(href)) continue;
      if (!LINK_WORDS.test(href) && !LINK_WORDS.test(text)) continue;
      seen.add(href);
      links.push({ url: href, text });
    }
    // Bare PDF URLs in scripts or data attributes.
    for (const pm of html.matchAll(/https?:\/\/[^"'\s<>()]+?\.pdf/gi)) {
      if (links.length >= 40) break;
      if (!seen.has(pm[0])) { seen.add(pm[0]); links.push({ url: pm[0], text: "" }); }
    }
    return { page: res.url, title: title.trim(), links };
  } catch (err) {
    return { error: err.name === "AbortError" ? "Timed out" : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const FIND_LINKS_TOOL = {
  name: "find_page_links",
  description:
    "Read a web page's HTML and list its PDF, tech sheet and download links (url + link text). Use it on the winery's product or downloads page to find the tech sheet PDF, then web_fetch the PDF url it returns.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: { url: { type: "string", description: "Full http(s) URL of the page to inspect." } },
  },
  strict: true,
};

// ---------- one Claude call with tools, under a time limit ----------

async function runAgent({ name, system, content, schema, tools, effort = "low", send }) {
  const client = await getClient();
  const messages = [{ role: "user", content }];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AGENT_TIME_LIMIT_MS);
  let linkCalls = 0;
  try {
    for (let turn = 0; turn < 8; turn++) {
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 16000,
          system,
          tools,
          messages,
          output_config: { effort, format: { type: "json_schema", schema } },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: ctrl.signal }
      );
      stream.on("contentBlock", (block) => {
        if (block.type === "server_tool_use" && block.input) {
          if (block.input.query) send({ type: "search", text: block.input.query });
          if (block.input.url) send({ type: "fetch", text: block.input.url });
        }
      });
      const msg = await stream.finalMessage();

      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }
      if (msg.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: msg.content });
        const calls = msg.content.filter((b) => b.type === "tool_use");
        const results = await Promise.all(
          calls.map(async (call) => {
            if (call.name !== FIND_LINKS_TOOL.name || typeof call.input?.url !== "string" || ++linkCalls > 3) {
              return { type: "tool_result", tool_use_id: call.id, is_error: true, content: "Not available. Use what you have." };
            }
            send({ type: "status", text: "Opening the tech sheet" });
            const out = await findPageLinks(call.input.url);
            return { type: "tool_result", tool_use_id: call.id, is_error: Boolean(out.error), content: JSON.stringify(out) };
          })
        );
        messages.push({ role: "user", content: results });
        continue;
      }
      if (msg.stop_reason === "refusal") return null;
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const start = text.indexOf("{");
      return start < 0 ? null : JSON.parse(text.slice(start));
    }
    return null;
  } catch (err) {
    console.error(`[${name}]`, ctrl.signal.aborted ? "time limit reached" : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- merge ----------

const STATUS_RANK = { pass: 3, fail: 3, na: 2, unknown: 0 };
function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ra = STATUS_RANK[a.status] ?? 0, rb = STATUS_RANK[b.status] ?? 0;
  if (ra !== rb) return ra > rb ? a : b;
  const wa = EVIDENCE[a.evidence]?.weight ?? 0, wb = EVIDENCE[b.evidence]?.weight ?? 0;
  if (wa !== wb) return wa > wb ? a : b;
  if ((a.scope === "this_wine") !== (b.scope === "this_wine")) return a.scope === "this_wine" ? a : b;
  return a;
}

function summarize(wine, checks, nutrition) {
  const top = ALL_ITEMS.filter((i) => i.top);
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  const ok = top.filter((i) => byId[i.id]?.status === "pass").length;
  const rs = nutrition.residual_sugar_g_l;
  const sugar =
    rs == null ? "We could not find a published sugar number."
    : rs * 0.148 < 1 ? `It has about ${(rs * 0.148).toFixed(1)} g of sugar per 5 oz glass, under the 1 g mark.`
    : `It has about ${(rs * 0.148).toFixed(1)} g of sugar per 5 oz glass, over the 1 g mark.`;
  return `${[wine.producer, wine.name].filter(Boolean).join(" ")}${wine.vintage ? ` ${wine.vintage}` : ""}: ${ok} of the Wine Babe top 10 are backed by a source. ${sugar}`;
}

const EMPTY_NUTRITION = { abv: null, residual_sugar_g_l: null, calories_5oz: null, carbs_5oz: null, total_so2_mg_l: null, free_so2_mg_l: null, ph: null, ta_g_l: null, source: "none" };

const cacheKey = (w) =>
  [w.producer, w.name, w.vintage].map((x) => String(x || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).join("__");

// ---------- main ----------

async function runScan({ image, mediaType, query }, send, cache) {
  const t0 = Date.now();

  // 1. Identify.
  const idContent = [];
  if (image) idContent.push({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } });
  idContent.push({ type: "text", text: image ? `Identify this wine.${query ? ` Shopper note: ${query}` : ""}` : `Identify this wine: ${query}` });
  const id = await runAgent({
    name: "identify",
    system: IDENTIFY_SYSTEM,
    content: idContent,
    schema: IDENTIFY_SCHEMA,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
    send,
  });
  if (!id) throw new Error("Could not read that label. Try a clearer photo or type the wine name.");
  if (!id.identified) {
    return {
      identified: false,
      wine: { ...id.wine, tech_sheet_url: "", tech_sheet_vintage: "" },
      nutrition: EMPTY_NUTRITION,
      checks: [],
      summary: id.note || "We couldn't identify this wine. Try a clearer photo of the front label, or type the name.",
      sources: [],
    };
  }
  const wine = id.wine;
  send({ type: "status", text: `Found ${[wine.producer, wine.name].filter(Boolean).join(" ")}` });

  // 2. Cache.
  const key = cacheKey(wine);
  if (cache && key.replace(/_/g, "")) {
    const hit = await cache.get(key).catch(() => null);
    if (hit && Date.now() - (hit.cached_at || 0) < CACHE_DAYS * 864e5) {
      send({ type: "status", text: "Already checked this wine" });
      return { ...hit.result, cached: true };
    }
  }

  // 3. Parallel lookups.
  send({ type: "status", text: "Checking the tech sheet, farming and vegan status" });
  const site = id.winery_website, page = id.product_page_url;
  const ask = (text) => [{ type: "text", text }];
  const [tech, farm, vegan] = await Promise.all([
    runAgent({
      name: "tech", system: techPrompt(wine, site, page), content: ask("Read the tech sheet and fill the items."),
      schema: agentSchema(TECH_IDS, true), send,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 2 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
        FIND_LINKS_TOOL,
      ],
    }),
    runAgent({
      name: "farm", system: farmPrompt(wine, site), content: ask("Check farming and certifications and fill the items."),
      schema: agentSchema(FARM_IDS, false), send,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 2 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
      ],
    }),
    runAgent({
      name: "vegan", system: veganPrompt(wine, site), content: ask("Check vegan status and fill the items."),
      schema: agentSchema(VEGAN_IDS, false), send,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 2 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2 },
      ],
    }),
  ]);

  // 4. Merge.
  const best = {};
  for (const part of [tech, farm, vegan]) for (const c of part?.checks || []) best[c.id] = better(best[c.id], c);
  const checks = ALL_ITEMS.map(
    (i) => best[i.id] || { id: i.id, status: "unknown", evidence: "none", scope: "this_wine", as_of: "", detail: "No public information found.", source_url: "" }
  );
  const nutrition = tech?.nutrition || EMPTY_NUTRITION;
  const seen = new Set();
  const sources = [tech, farm, vegan]
    .flatMap((p) => p?.sources || [])
    .filter((s) => s.url && !seen.has(s.url) && seen.add(s.url))
    .slice(0, 12);

  const result = {
    identified: true,
    wine: { ...wine, tech_sheet_url: tech?.tech_sheet_url || "", tech_sheet_vintage: tech?.tech_sheet_vintage || "" },
    nutrition,
    checks,
    summary: summarize(wine, checks, nutrition),
    sources,
    seconds: Math.round((Date.now() - t0) / 1000),
    partial: [tech, farm, vegan].some((p) => !p),
  };

  // Only cache complete results, so a timed out lookup gets retried next time.
  if (cache && !result.partial) await cache.set(key, { cached_at: Date.now(), result }).catch(() => {});
  return result;
}

// ---------- demo mode (no API key) ----------

function demoResult() {
  const pass = (id, evidence, detail, scope = "this_wine", as_of = "") => ({ id, status: "pass", evidence, scope, as_of, detail, source_url: null });
  const unk = (id) => ({ id, status: "unknown", evidence: "none", scope: "this_wine", as_of: "", detail: "No public information found.", source_url: null });
  const known = {
    tech_sheet: pass("tech_sheet", "lab", "Tech sheet lists 2.1 g/L residual sugar."),
    sugar_under_1g: pass("sugar_under_1g", "lab", "About 0.3 g sugar per 5 oz."),
    no_added_sugar: pass("no_added_sugar", "winery", "Winery states no sugar or concentrate added."),
    calories: pass("calories", "estimate", "About 108 calories per 5 oz, calculated from ABV and sugar."),
    carbs: pass("carbs", "estimate", "About 0.8 g carbs per 5 oz, calculated."),
    abv: pass("abv", "lab", "12.5% ABV on the tech sheet."),
    vegan: pass("vegan", "winery", "Winery states no animal proteins are used in any of its wines.", "producer", "March 2020"),
    non_gmo: pass("non_gmo", "winery", 'Tech sheet says "NO OGM": not derived from GMOs.', "related_wine", "Extra Dry sheet"),
    zero_dosage: pass("zero_dosage", "winery", "Brut Nature: no sugar added at dosage."),
    organic: pass("organic", "certified", "EU organic certified vineyards."),
    sustainable: pass("sustainable", "certified", "Equalitas sustainability certified."),
    hand_harvested: pass("hand_harvested", "winery", "Grapes picked by hand in September."),
    sulfites: pass("sulfites", "lab", "Total SO2 78 mg/L, free 22 mg/L. Sulfites added."),
    origin: pass("origin", "certified", "Prosecco DOC Treviso, Italy."),
    grape_variety: pass("grape_variety", "winery", "100% Glera."),
    vintage: pass("vintage", "winery", "2024 vintage."),
    family_owned: pass("family_owned", "winery", "Third generation family estate."),
  };
  return {
    demo: true,
    identified: true,
    wine: {
      name: "Sample Prosecco Brut Nature (demo)", producer: "Demo Estate", vintage: "2024", region: "Treviso",
      country: "Italy", grapes: "Glera", style: "Sparkling, Brut Nature", tech_sheet_url: null, tech_sheet_vintage: null,
    },
    nutrition: { abv: 12.5, residual_sugar_g_l: 2.1, calories_5oz: 108, carbs_5oz: 0.8, total_so2_mg_l: 78, free_so2_mg_l: 22, ph: 3.3, ta_g_l: 5.8, source: "lab" },
    checks: ALL_ITEMS.map((i) => known[i.id] || unk(i.id)),
    summary: "Demo result. Add an ANTHROPIC_API_KEY on the server to scan real bottles. This sample shows how a well documented sparkling wine looks.",
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
