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

// Haiku 5.5 is the fastest model and every step is a simple job. If a Haiku
// call errors, that step retries once on Sonnet 5.5.
const MODEL = process.env.WINE_BABE_MODEL || "claude-sonnet-5-5";
// Steps that need judgment (naming the wine and its site, choosing sources)
// run on Sonnet: in live tests Haiku often refused to name a wine from text.
const SMART_MODEL = process.env.WINE_BABE_SMART_MODEL || "claude-sonnet-5-5";
const BACKUP_MODEL = process.env.WINE_BABE_BACKUP_MODEL || "claude-sonnet-5-5";
// Reading an attached tech sheet is simple extraction, so it uses the fastest model.
const READ_MODEL = process.env.WINE_BABE_READ_MODEL || "claude-sonnet-5-5";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// Time budget (target: about 30s per scan).
const IDENTIFY_MS = Number(process.env.WINE_BABE_IDENTIFY_MS || 12000);
const LOOKUP_MS = Number(process.env.WINE_BABE_LOOKUP_MS || 20000);
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
// Items a tech sheet actually covers; the PDF read fills only these.
const SHEET_IDS = [
  "tech_sheet", "sugar_under_1g", "no_added_sugar", "zero_dosage", "calories", "carbs", "abv", "non_gmo",
  "gluten_free", "sulfites", "yeast", "vegan", "organic", "hand_harvested", "grape_variety", "vintage", "origin",
  "single_vineyard", "no_concentrates", "no_unnecessary_additives", "traditional_fermentation", "temp_controlled",
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
- A clear winery statement is enough for a pass (evidence "winery"): on the winery's site, its tech sheet, or its importer's page. Shop, retailer, review and marketplace pages do not count as evidence: if they are the only source, the item is "unknown". A certificate or certifier listing is "certified". Lab numbers on a tech sheet are "lab". A calculation is "estimate".
- status "pass" when a source supports it, "fail" when a source contradicts it (residual sugar above 6.7 g/L, egg white or casein fining, sugar added at dosage), "unknown" when you found nothing, "na" when it does not apply (zero_dosage for a still wine). Never guess a pass.
- scope: "this_wine" (source is about this exact wine), "producer" (winery wide statement, e.g. "all our wines are vegan", "150 ha certified SQNPI"), "related_wine" (a sister wine's tech sheet from the same producer; name it in the detail).
- as_of: date or year of the statement or document if shown, else "".
- detail: at most 15 words for a shopper, with the number or quoted wording when there is one.
- source_url: the page that supports it, or "".
- Return one check for every id listed. Be fast: stop as soon as you have the answers; do not research beyond your listed sources.`;

// Brand + wine name, without repeating the brand when the name already has it
// ("Terracotta" + "Terracotta Pinot Grigio" -> "Terracotta Pinot Grigio").
const brandAndName = (w) => {
  const prod = String(w.producer || "").trim(), name = String(w.name || "").trim();
  return !prod || name.toLowerCase().startsWith(prod.toLowerCase()) ? name : `${prod} ${name}`;
};

const wineLine = (w) =>
  `${w.producer} ${w.name}${w.vintage ? ` ${w.vintage}` : ""} (${[w.style, w.grapes, w.region, w.country].filter(Boolean).join(", ")})`;

const IDENTIFY_SYSTEM = `You identify wines for the Wine Babe app, fast.
From the label photo or text, identify producer, wine name, vintage, region, country, grapes and style (for sparkling, the dosage term on the label: Brut Nature, Pas Dosé, Dosaggio Zero, Extra Brut, Brut, Extra Dry...).
Then find the winery's official website and this wine's product page on it, with at most one web search. Be quick. Prefer the winery's own domain over shops.
A name without a vintage is fine: identify the wine and leave vintage "" (non vintage or latest).
No producer given (e.g. "Pinot Noir Rosé Single Fermentation"): use your web search on the exact name to find which winery makes it. If the results clearly point to one producer's wine, identify it with that producer. Only when several producers fit equally, set identified false and name the likely producers in note.
Never ask for a photo or more details. Otherwise only set identified false when the input is clearly not a wine or is unreadable, and explain in note. Unknown text fields are "".`;

const PDF_URLS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pdf_urls"],
  properties: { pdf_urls: { type: "array", items: { type: "string" } } },
};

// "<wine> nutrition facts" search: finds the winery's own spec / nutrition
// page and any figures it states. Figures only count when the source is the
// winery or its importer.
const NUTRITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages", "calories_5oz", "carbs_5oz", "sugar_g_5oz", "residual_sugar_g_l", "abv", "source_url", "source_kind"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["url", "kind"],
        properties: { url: { type: "string" }, kind: { type: "string", enum: ["winery", "importer", "retailer", "other"] } },
      },
    },
    calories_5oz: { type: ["number", "null"] },
    carbs_5oz: { type: ["number", "null"] },
    sugar_g_5oz: { type: ["number", "null"] },
    residual_sugar_g_l: { type: ["number", "null"] },
    abv: { type: ["number", "null"] },
    source_url: { type: "string" },
    source_kind: { type: "string", enum: ["winery", "importer", "retailer", "other", "none"] },
  },
};
const NUTRITION_SEARCH_SYSTEM = `You look up a wine's published nutrition facts and specs for the Wine Babe app, fast.
First run a web search with exactly the query you are given (the full wine name followed by "nutrition facts").
If those results don't state this wine's ABV, either search "<full wine name> ABV" or fetch one retailer listing for this exact wine (Total Wine, Spec's, Wine.com, Drizly and similar list "ABV" or "Alcohol %"), and take the ABV from it.
Return:
- pages: up to 4 result pages, the winery's own product / specs / nutrition page first, each tagged winery, importer, retailer or other.
- The figures given for THIS wine by the best source (winery first; otherwise importer, then any page in the results that states them for this wine, such as a wine site, nutrition database or retailer): calories, carbohydrates and sugar per 5 oz (148 ml) serving (convert other serving sizes), residual sugar in g/L if stated, ABV. Use null for anything not stated. Ranges count: use the midpoint for calories and carbs, the highest value for sugar.
- ABV is printed on almost every retail listing: always return it when any result states it for this wine (if listings differ, use the most common value).
- source_url and source_kind of the page the figures came from ("none" if no figures).`;

// Alcohol by volume from any listing: retail pages almost always state it,
// and with ABV the calories can be calculated.
const ABV_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["abv", "source_url"],
  properties: { abv: { type: "number" }, source_url: str },
};
const ABV_SYSTEM = `You find a wine's alcohol by volume (ABV) for the Wine Babe app, fast.
Run a web search with exactly the query you are given. Read the ABV for this exact wine from the results (retail listings such as Total Wine, Spec's, Wine.com, Drizly show "ABV" or "Alcohol %"). If the snippets don't show it, fetch one retail listing for this exact wine.
Return abv as a number (e.g. 13) and the source_url it came from. If listings differ, use the most common value. Return abv 0 and empty source_url if not found.`;

const SHEET_SEARCH_SYSTEM = `You find a wine's official technical sheet for the Wine Babe app, fast.
Run exactly one web search, with exactly the query you are given (the full wine name followed by "tech specs").
Return up to 5 URLs from the results that are this wine's tech sheet or spec page (PDFs first, then the winery's own spec page), best match for this exact wine first. Return an empty list if none.`;

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

const sheetPrompt = (w) => `You read a wine's attached technical sheet for the Wine Babe app. Wine: ${wineLine(w)}.
Use only the attached sheet. Read every line: residual sugar, ABV, total and free SO2, pH, acidity, GMO, allergens, vegan, fining, yeast, dosage, harvest, vineyard, grapes, origin.
Residual sugar may be labelled "sugars", "sugars (glucose + fructose)", "residual sugar", "RS", "zuccheri", "zuccheri residui", "sucres résiduels", "azúcar residual", "Restzucker". It may be given in g/L or as a percent (0.3% = 3 g/L).
For ANY range (sugar 2 - 3 g/L, SO2 130 - 145 mg/L), use the highest value and quote the range in the detail. Labels and values may be listed in separate blocks in the same order; match them by position.
If the sheet is for a sister wine of the same producer, use scope "related_wine" and say which wine.
Nutrition per 5 oz (148 ml): if calories or carbs are not printed, calculate them (alcohol g = 148 x ABV/100 x 0.789 x 7 kcal; carbs ~ sugar g + 0.5; sugar g = residual sugar g/L x 0.148) and mark those checks "estimate". Leave numbers null rather than invent them. nutrition.source = evidence behind the sugar number ("lab" when the sheet gives it).
tech_sheet: "pass" with evidence "lab" ONLY if the document gives laboratory analysis numbers (residual sugar, SO2, pH, acidity or similar). A brochure, tasting booklet or notes without analysis numbers is "unknown" with detail "Document found, but no lab analysis". zero_dosage: sparkling with no sugar added at dosage (Brut Nature, Pas Dosé, Dosaggio Zero, 0 g/L dosage); still wines "na".
tech_sheet_vintage: vintage the sheet covers if stated, else "".

${RULES}

Items:
${itemList(SHEET_IDS)}`;

const farmPrompt = (w, site) => `You check farming practices and certifications for the Wine Babe app. Wine: ${wineLine(w)}.
Winery website: ${site || "unknown"}.

Most reliable sources, in order, stop once you have the answers:
1. One web search for certifications by winery name with that country's certifiers, then fetch the single most useful result (the winery's sustainability page if it shows up). Italy: SQNPI, Equalitas, VIVA, biologico. France: HVE, Terra Vitis, AB. Spain: ecológico. USA: SIP Certified, LODI RULES, Napa Green, CCOF, CCSW. New Zealand: SWNZ. Germany: Ecovin, FairChoice. Organic: EU organic, USDA Organic, Demeter.
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

// ---------- professional critic ratings ----------
// Scores from wine critics and publications (Wine Enthusiast, Wine Spectator,
// James Suckling, Decanter, Vinous, Wine Advocate ...). Consumer apps are not
// critics, so Vivino and CellarTracker averages are left out.

const RATINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ratings"],
  properties: {
    ratings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["publication", "score", "scale", "vintage", "source_url"],
        properties: { publication: str, score: { type: "number" }, scale: { type: "number" }, vintage: str, source_url: str },
      },
    },
  },
};

const ratingsPrompt = (w) => `You find professional critic ratings for the Wine Babe app. Wine: ${wineLine(w)}.

One web search for this wine's critic scores (for example "<producer> <wine name> rating Wine Enthusiast Wine Spectator James Suckling Decanter Vinous"), then fetch the single most useful page (the winery's or importer's press / accolades page lists several at once).
Only professional critics and publications: Wine Enthusiast, Wine Spectator, Wine Advocate (Robert Parker), James Suckling, Decanter, Vinous, Jancis Robinson, Jeb Dunnuck, Tasting Panel, Wine & Spirits, Gambero Rosso, Falstaff, Bettane+Desseauve and similar. Do NOT include Vivino, CellarTracker, Wine-Searcher averages, shop staff picks or medals without a score.
Each rating: publication name, the numeric score exactly as published, scale (100, or 20 for Jancis Robinson style scores), the vintage it was given to ("NV" for non vintage, "" if unknown), and source_url of the page showing it.
Only this exact wine: a different cuvee, tier or appellation from the same producer is a different wine (Beaujolais vs Beaujolais-Villages, Chardonnay vs Reserve Chardonnay, Brut vs Brut Nature), so leave those out. One score per publication per vintage.
Only list scores you actually saw on a page. Never guess or round. Up to 8 ratings, the wine's own vintage first, then newest vintages. Return an empty list if you find none.`;

function cleanRatings(raw, wine) {
  const want = String(wine.vintage || "").trim();
  const seen = new Set();
  return (raw?.ratings || [])
    .map((x) => ({
      publication: String(x.publication || "").trim().slice(0, 60),
      score: Number(x.score),
      scale: Number(x.scale) === 20 ? 20 : 100,
      vintage: String(x.vintage || "").trim().slice(0, 8),
      source_url: /^https?:\/\//.test(x.source_url || "") ? x.source_url : "",
    }))
    .filter((x) => x.publication && !/vivino|cellartracker|wine-searcher/i.test(x.publication) && x.score > 0 && x.score <= x.scale && (x.scale === 20 || x.score >= 50))
    .filter((x) => { const k = `${x.publication.toLowerCase()}|${x.vintage}`; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => (b.vintage === want) - (a.vintage === want) || (parseInt(b.vintage) || 0) - (parseInt(a.vintage) || 0) || b.score / b.scale - a.score / a.scale)
    .slice(0, 8);
}

// ---------- winery tasting notes ----------
// The winery's (or its importer's) own description of how the wine tastes.
// Critic reviews are not used here; those belong to the ratings card.

const TASTING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "notes", "flavors", "pairings", "source", "source_url"],
  properties: {
    found: { type: "boolean" },
    notes: str,
    flavors: { type: "array", items: str },
    pairings: { type: "array", items: str },
    source: { type: "string", enum: ["winery", "importer", "none"] },
    source_url: str,
  },
};

const tastingPrompt = (w, site, page) => `You find the winery's own tasting notes for the Wine Babe app. Wine: ${wineLine(w)}.
Winery website: ${site || "unknown"}. Product page: ${page || "unknown"}.

Steps, stop as soon as you have notes:
1. Fetch the winery's product page for this exact wine (search "<producer> <wine name> tasting notes food pairing" if you don't have it).
2. If the winery page is blocked, missing or has no notes, search "<producer> <wine name> importer tasting notes" and use the official importer's or distributor's page for the wine (e.g. Kobrand for Louis Jadot, Taub for Kim Crawford imports).
Some sites block fetching: then use the text the search results show from the winery's or importer's own page, with that page as source_url. Don't fetch PDFs or shop pages. Don't give up after the first try: always do step 2 before returning found false.
Use only the producer's or importer's own description, never critic reviews, shops or blogs. Only this exact wine: a different cuvee or appellation (Beaujolais vs Beaujolais-Villages) is a different wine.
notes: the tasting notes in 1 to 3 short plain sentences, close to their own words (aroma, palate, finish). Max 350 characters. Leave food out of notes.
pairings: the foods the winery or importer recommends with this wine, as short items in their words (e.g. "hors d'oeuvres", "mild cheeses", "roast chicken"). Up to 8. Empty if they give none; never invent pairings.
flavors: up to 8 short flavor and aroma words taken from those notes (e.g. "strawberry", "black cherry", "pepper").
source: "winery" or "importer". source_url: the page you read. If you find nothing, found false, empty notes, flavors and pairings, source "none".`;

function cleanTasting(raw) {
  if (!raw?.found || !/^https?:\/\//.test(raw.source_url || "")) return null;
  const notes = String(raw.notes || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const pairings = [...new Set((raw.pairings || []).map((f) => String(f).replace(/\s+/g, " ").trim()).filter((f) => f && f.length <= 60))].slice(0, 8);
  if (notes.length < 15 && !pairings.length) return null;
  const flavors = [...new Set((raw.flavors || []).map((f) => String(f).trim().toLowerCase()).filter((f) => f && f.length <= 30))].slice(0, 8);
  return { notes, flavors, pairings, source: raw.source === "importer" ? "importer" : "winery", source_url: raw.source_url };
}

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
  const timer = setTimeout(() => ctrl.abort(), 6000);
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

// ---------- server side tech sheet fetch ----------
// Fastest, most reliable path: read the product page's links ourselves, pick
// the PDF that best matches this wine, download it, and hand it to Claude as a
// document. No searching.

function isPublicHost(u) {
  const h = u.hostname.toLowerCase();
  return !(
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[")
  );
}

// Style words that tell sister wines apart. A PDF named with one of these that
// the wine itself does not have is probably a different wine (Brut Bio vs Brut
// Nature, Extra Dry vs Brut).
const STYLE_WORDS = [
  "brut", "nature", "extra", "dry", "sec", "demi", "doux", "dosaggio", "zero", "pas", "dose", "bio", "organic",
  "biologico", "rose", "rosato", "rosado", "millesimato", "frizzante", "riserva", "reserve", "reserva", "superiore",
  "classico", "rive", "cartizze", "blanc", "noir", "rosso", "bianco", "late", "harvest", "ice", "sweet", "moscato",
  "cuvee", "vineyard", "estate", "limited", "magnum", "half",
];

// Style words a file must carry when the wine's name has them (dosage,
// sweetness, colour). Words like "single" or "estate" are not required.
const REQUIRED_STYLE = new Set([
  "brut", "nature", "extra", "dry", "sec", "demi", "doux", "dosaggio", "zero", "pas", "dose", "rose", "rosato",
  "rosado", "frizzante", "riserva", "reserve", "reserva", "late", "harvest", "ice", "sweet",
]);

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// Ranks PDF candidates for this wine, best first. Drops award, price list and
// clearly mismatched files.
const TIER_WORDS = ["villages", "superieur", "superiore", "riserva", "reserva", "reserve", "gran", "grand", "premier", "cru", "classico", "rive", "cartizze"];

function rankPdfs(links, wine, siteUrl) {
  const nameNorm = norm(wine.name);
  const nameWords = nameNorm.split(" ").filter((w) => w.length > 2);
  // Style words the file must carry (from the wine name) and may carry (name or style).
  const requiredStyle = STYLE_WORDS.filter((w) => REQUIRED_STYLE.has(w) && nameNorm.split(" ").includes(w));
  const allowedStyle = new Set(norm(`${wine.name} ${wine.style}`).split(" "));
  const producerWords = norm(wine.producer).split(" ").filter((w) => w.length > 2);
  const year = /^\d{4}$/.test(String(wine.vintage || "")) ? String(wine.vintage) : "";
  let siteHost = "";
  try { siteHost = new URL(siteUrl).hostname.replace(/^www\./, ""); } catch {}
  const seen = new Set();
  return links
    .filter((l) => /\.pdf(\?|$)/i.test(l.url) && !seen.has(l.url) && seen.add(l.url))
    .map((l) => {
      let raw = l.url;
      try { raw = decodeURIComponent(l.url); } catch {}
      const fileName = raw.split("/").pop();
      const file = norm(`${fileName} ${l.text}`);
      const words = new Set(file.split(" "));
      const matched = nameWords.filter((w) => words.has(w)).length;
      const missingStyle = requiredStyle.filter((w) => !words.has(w)).length;
      const conflicts = STYLE_WORDS.filter((w) => words.has(w) && !allowedStyle.has(w)).length;
      let score = matched * 1.5 - (nameWords.length - matched) * 0.5 - conflicts * 2;
      if (producerWords.some((w) => words.has(w))) score += 1;
      if (/\b(en|eng|english)\b/.test(file)) score += 0.5;
      if (/\b(scheda|tecnica|technical|tech|sheet|fiche|ficha|ts|tn)\b/.test(file)) score += 0.5;
      const junk = /\b(award|awards|medal|gold|silver|bronze|decanter|trophy|press|menu|price|prices|listino|catalog|catalogue|brochure)\b/.test(file);
      try { if (siteHost && new URL(l.url).hostname.replace(/^www\./, "").endsWith(siteHost)) score += 1; } catch {}
      // Newer uploads first (WordPress keeps the upload year in the path).
      const upload = raw.match(/\/uploads\/(20\d{2})\//);
      if (upload) score += Math.min(1.5, Math.max(0, (Number(upload[1]) - 2018) * 0.2));
      const fileYears = fileName.match(/\b(19|20)\d{2}\b/g) || [];
      if (year && fileYears.includes(year)) score += 1;
      else if (year && fileYears.length) score -= 0.5;
      // A sheet for a higher tier of the same wine (Beaujolais-Villages,
      // Riserva, Grand Cru ...) is a different wine.
      const otherTier = TIER_WORDS.some((w) => words.has(w) && !nameNorm.split(" ").includes(w));
      return { ...l, score, matched, missingStyle, junk, otherTier };
    })
    // Must match at least half the name, carry every style word in the name
    // (Brut Nature, not Brut), and not look like an award or price list.
    .filter((l) => l.matched >= Math.max(1, Math.ceil(nameWords.length * 0.5)) && l.missingStyle === 0 && !l.junk && !l.otherTier && l.score > 0)
    .sort((a, b) => b.score - a.score);
}

function pickPdf(links, wine, siteUrl) {
  return rankPdfs(links, wine, siteUrl)[0] || null;
}

async function fetchPdf(url, ms = 8000) {
  let u;
  try { u = new URL(url); } catch { return { error: "bad url" }; }
  if (!/^https?:$/.test(u.protocol) || !isPublicHost(u)) return { error: "not a public url" };
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(ms), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; WineBabeScanner/1.0)" } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return { error: "too large" };
    if (buf.subarray(0, 4).toString() !== "%PDF") return { error: "not a PDF" };
    return { data: buf.toString("base64") };
  } catch (err) {
    return { error: err.name === "TimeoutError" || err.name === "AbortError" ? "timed out" : String(err.message || err) };
  }
}

// WordPress sites (very common for wineries) expose uploaded files through a
// public search API. Returns [{url, text}] PDF candidates, or [].
async function wpMediaSearch(origin, term) {
  const u = new URL("/wp-json/wp/v2/media", origin);
  u.searchParams.set("search", term);
  u.searchParams.set("mime_type", "application/pdf");
  u.searchParams.set("per_page", "20");
  u.searchParams.set("_fields", "source_url,title");
  if (!isPublicHost(u)) return [];
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(11000), headers: { "User-Agent": "Mozilla/5.0 (compatible; WineBabeScanner/1.0)", Accept: "application/json" } });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list)
      ? list.filter((m) => typeof m.source_url === "string").map((m) => ({ url: m.source_url, text: String(m.title?.rendered || "") }))
      : [];
  } catch {
    return [];
  }
}

// Search terms for the wine: its name without the producer, and the last two words.
function wineTerms(wine) {
  const prod = (wine.producer || "").toLowerCase().split(/\s+/);
  const words = (wine.name || "").split(/\s+/).filter((w) => w && !prod.includes(w.toLowerCase()));
  const terms = [words.join(" "), words.slice(-2).join(" ")].map((t) => t.trim()).filter(Boolean);
  return [...new Set(terms)];
}

// Pull the text out of a PDF (base64). Sending Claude plain text is far faster
// than sending the PDF itself, which is processed page by page as images.
// Visible text of a web page (for winery spec pages that are not PDFs).
async function pageText(url, ms = 7000) {
  let u;
  try { u = new URL(url); } catch { return ""; }
  if (!/^https?:$/.test(u.protocol) || !isPublicHost(u)) return "";
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(ms), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; WineBabeScanner/1.0)" } });
    if (!res.ok) return "";
    const html = (await res.text()).slice(0, 2_000_000);
    return html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 12000);
  } catch {
    return "";
  }
}

async function pdfText(base64) {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, "base64")));
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text || "").replace(/[ \t]+\n/g, "\n").slice(0, 15000);
  } catch (err) {
    console.error("[pdf text]", err.message);
    return "";
  }
}

// Tech sheet candidates from the fast routes: the product page links and the
// WordPress media search, run in parallel. No downloading here.
async function findTechCandidates(wine, pageUrl, siteUrl, diag = []) {
  let origin = "";
  try { origin = new URL(pageUrl || siteUrl).origin; } catch {}
  const t = Date.now();
  const timed = (label, p) => p.then((links) => { diag.push({ name: label, ms: Date.now() - t, outcome: `${links.filter((l) => /\.pdf/i.test(l.url)).length} pdf links` }); return links; });
  const lists = await Promise.all([
    pageUrl ? timed("sheet-page", findPageLinks(pageUrl).then((r) => r.links || [])) : Promise.resolve([]),
    ...(origin ? wineTerms(wine).map((term) => timed(`sheet-wp "${term}"`, wpMediaSearch(origin, term))) : []),
  ]);
  return lists.flat();
}

// ---------- certification check on the winery's own site ----------
// WordPress sites have a public site search. Look up the main certifier for
// the wine's country and read the page that mentions it. One request (plus one
// page) only: some winery sites block rapid repeat requests.

const CERTS_BY_COUNTRY = {
  italy: ["SQNPI", "Equalitas"], france: ["HVE", "Terra Vitis"], spain: ["Wineries for Climate Protection"],
  "united states": ["SIP Certified", "Lodi Rules"], usa: ["SIP Certified", "Lodi Rules"], us: ["SIP Certified", "Lodi Rules"],
  "new zealand": ["SWNZ"], australia: ["Sustainable Winegrowing Australia"], chile: ["Sustainable Wine of Chile"],
  "south africa": ["WIETA", "IPW"], germany: ["FairChoice"], austria: ["Nachhaltig Austria"], portugal: ["Sustainable Winegrowing"],
  argentina: ["Bodegas de Argentina sustentabilidad"],
};

async function certScan(siteUrl, country, diag) {
  let origin = "";
  try { origin = new URL(siteUrl).origin; } catch { return null; }
  const term = (CERTS_BY_COUNTRY[String(country || "").toLowerCase().trim()] || [])[0];
  if (!term || !isPublicHost(new URL(origin))) return null;
  const t = Date.now();
  const strip = (html) => String(html || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");
  try {
    // Pages first, then posts: the API returns the page text, so no page load
    // is needed (and anti bot screens on the pages themselves do not matter).
    for (const type of ["pages", "posts"]) {
      const u = new URL(`/wp-json/wp/v2/${type}`, origin);
      u.searchParams.set("search", term);
      u.searchParams.set("per_page", "5");
      u.searchParams.set("_fields", "link,content");
      const res = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Mozilla/5.0 (compatible; WineBabeScanner/1.0)", Accept: "application/json" } });
      const hits = res.ok ? await res.json().catch(() => null) : null;
      if (!Array.isArray(hits) || !hits.length) continue;
      const ordered = [...hits.filter((h) => /\/en\//.test(h.link)), ...hits.filter((h) => !/\/en\//.test(h.link))];
      for (const h of ordered) {
        const text = strip(h.content?.rendered);
        const i = text.toLowerCase().indexOf(term.toLowerCase());
        if (i < 0) continue;
        const snippet = text.slice(Math.max(0, i - 120), i + term.length + 120).trim();
        diag.push({ name: `cert "${term}"`, ms: Date.now() - t, outcome: `found on ${h.link}` });
        return { term, url: h.link, snippet };
      }
    }
    diag.push({ name: `cert "${term}"`, ms: Date.now() - t, outcome: "no hits" });
    return null;
  } catch (err) {
    diag.push({ name: `cert "${term}"`, ms: Date.now() - t, outcome: `error ${err.name}: ${String(err.cause?.code || err.message || "").slice(0, 80)}` });
    return null;
  }
}

// ---------- Barnivore (vegan) ----------
// Barnivore company pages are plain HTML: status (Vegan / Not Vegan / Some),
// date checked, and the company's own reply. Read them in code, not by model.

const URL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["url"],
  properties: { url: { type: "string" } },
};
const BARNIVORE_FIND_SYSTEM = `Find the producer's company page on barnivore.com, fast. Run exactly one web search: barnivore <producer>. Return the barnivore.com page url for that producer (paths like /wine/1234/name or /products/1234-name), or "" if there is none.`;

async function readBarnivore(url) {
  let u;
  try { u = new URL(url); } catch { return { error: "bad url" }; }
  if (!/(^|\.)barnivore\.com$/.test(u.hostname)) return { error: "not barnivore" };
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0 (compatible; WineBabeScanner/1.0)" } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = (await res.text())
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ");
    const head = text.slice(0, 1500);
    const status = /\bNot Vegan\b/i.test(head) ? "fail" : /\bSome\b[^.]{0,40}\bvegan\b/i.test(head) || /\bUnknown\b/.test(head) ? "unknown" : /\bVegan\b/.test(head) ? "pass" : "unknown";
    const checked = (head.match(/Checked[^()]{0,40}\(([^)]+)\)/) || [])[1] || "";
    // The company's reply: take the sentence that explains the status
    // (fining agent, animal products, "not vegan"), not a polite opening.
    const reply = text.match(/(?:email|letter|phone|message)\s*\(([^)]+)\)\s*"([^"]{10,2000})"/i) || [];
    const sentences = String(reply[2] || "").split(/(?<=[.!?])\s+/);
    const key = /vegan|animal|casein|milk|egg|albumin|gelatin|isinglass|fish|chitosan|pea|bentonite|fining|protein/i;
    const quote = (sentences.find((x) => key.test(x)) || sentences[0] || "").slice(0, 240);
    return { status, as_of: reply[1] || checked, quote, url: u.href };
  } catch (err) {
    return { error: err.name };
  }
}

// ---------- one Claude call with tools, under a deadline ----------
// At the deadline the call is cut and, if earlier turns gathered anything, a
// quick no-tools follow up turns what was found into the JSON answer.

async function runAgent({ name, system, content, schema, tools = [], effort = "low", send, deadline, model = MODEL, diag = [] }) {
  const started = Date.now();
  const note = (outcome, error) => diag.push({ name, model, ms: Date.now() - started, outcome, ...(error ? { error: String(error).slice(0, 300) } : {}) });
  const client = await getClient();
  const messages = [{ role: "user", content }];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
  let linkCalls = 0;

  const call = (extra = {}, signal) => {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 16000,
        system,
        messages,
        ...(tools.length ? { tools } : {}),
        output_config: { effort, format: { type: "json_schema", schema } },
        // Speed: no thinking. Sonnet 5.5 turns it off with between_tools; Haiku 5.5 with disabled.
        thinking: model.includes("haiku") ? { type: "disabled" } : { type: "between_tools" },
        // Server side refusal fallbacks are not offered for Haiku.
        ...(model.includes("haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
        ...extra,
      },
      signal ? { signal } : undefined
    );
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && block.input) {
        if (block.input.query) send({ type: "search", text: block.input.query });
        if (block.input.url) send({ type: "fetch", text: block.input.url });
      }
    });
    return stream.finalMessage();
  };
  const parse = (msg) => {
    if (!msg) { note("no message"); return null; }
    if (msg.stop_reason === "refusal") { note("refusal"); return null; }
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const start = text.indexOf("{");
    try {
      const out = start < 0 ? null : JSON.parse(text.slice(start));
      note(out ? "ok" : `no json (stop ${msg.stop_reason})`);
      return out;
    } catch (e) { note(`bad json (stop ${msg.stop_reason})`, e.message); return null; }
  };

  try {
    for (let turn = 0; turn < 8; turn++) {
      const msg = await call({}, ctrl.signal);
      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }
      if (msg.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: msg.content });
        const calls = msg.content.filter((b) => b.type === "tool_use");
        const results = await Promise.all(
          calls.map(async (c) => {
            if (c.name !== FIND_LINKS_TOOL.name || typeof c.input?.url !== "string" || ++linkCalls > 2) {
              return { type: "tool_result", tool_use_id: c.id, is_error: true, content: "Not available. Use what you have." };
            }
            const out = await findPageLinks(c.input.url);
            return { type: "tool_result", tool_use_id: c.id, is_error: Boolean(out.error), content: JSON.stringify(out) };
          })
        );
        messages.push({ role: "user", content: results });
        continue;
      }
      return parse(msg);
    }
    return null;
  } catch (err) {
    if (!ctrl.signal.aborted) {
      console.error(`[${name}]`, err);
      note("error", err?.message || err);
      // Retry once on the backup model if there is time left.
      if (model !== BACKUP_MODEL && deadline - Date.now() > 5000) {
        clearTimeout(timer);
        return runAgent({ name: `${name}@backup`, system, content, schema, tools, effort, send, deadline, model: BACKUP_MODEL, diag });
      }
      return null;
    }
    console.error(`[${name}] deadline reached`);
    if (messages.length < 3) { note("deadline, nothing gathered"); return null; }
    try {
      messages.push({ role: "user", content: [{ type: "text", text: "Time is up. Using only what you found so far, return the JSON answer now. Mark anything not yet confirmed as unknown." }] });
      return parse(await call({ tool_choice: { type: "none" } }, AbortSignal.timeout(6000)));
    } catch (e) {
      console.error(`[${name}] wrap up failed`, e.message);
      note("deadline, wrap up failed", e.message);
      return null;
    }
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

// Bump when scan logic changes, so results from older versions are not reused.
const ENGINE_VERSION = "v30";
// The identify step can name the same wine slightly differently between runs
// ("Prosecco Treviso Brut Nature" vs "Prosecco Treviso DOC Brut Nature"), so
// the key drops appellation words, sorts the rest, and treats NV as no vintage.
const KEY_NOISE = new Set(["doc", "docg", "igt", "igp", "aoc", "aop", "do", "doca", "dop", "ava", "spumante", "vino", "wine", "wines", "the", "and", "di", "de", "del", "della"]);
const keyWords = (x) => [...new Set(norm(x).split(" ").filter((t) => t && !KEY_NOISE.has(t)))].sort().join("-");
const cacheKey = (w) => {
  const vintage = /^(19|20)\d{2}$/.test(String(w.vintage || "").trim()) ? String(w.vintage).trim() : "nv";
  return `${ENGINE_VERSION}__${keyWords(w.producer)}__${keyWords(w.name)}__${vintage}`;
};

// ---------- main ----------

async function runScan({ image, mediaType, query, fresh }, send, cache) {
  const t0 = Date.now();
  const diag = [];

  // 1. Identify.
  const idContent = [];
  if (image) idContent.push({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } });
  idContent.push({ type: "text", text: image ? `Identify this wine.${query ? ` Shopper note: ${query}` : ""}` : `Identify this wine: ${query}` });
  const id = await runAgent({ diag,
    name: "identify",
    system: IDENTIFY_SYSTEM,
    content: idContent,
    schema: IDENTIFY_SCHEMA,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    send,
    model: SMART_MODEL, deadline: t0 + IDENTIFY_MS,
  });
  if (!id) throw new Error("Could not read that label. Try a clearer photo or type the wine name.");
  // Second try when it gave up without a producer: force a web search and
  // accept a brand (store and private label wines like "Terracotta") as producer.
  if (!id.identified && !(id.wine?.producer || "").trim()) {
    const retry = await runAgent({ diag,
      name: "identify-retry",
      system: IDENTIFY_SYSTEM + `
This is a second try: you MUST run a web search for the exact wine name first. If the name is a brand rather than a winery (store and private label wines, e.g. "Terracotta Pinot Grigio"), use the brand as producer, or the bottler named on retail pages. Also find the brand's own website and this wine's page on it (e.g. terracottawines.com/our-wines/pinot-grigio) for winery_website and product_page_url. Set identified true whenever the search shows a real wine with this name; identified false only if nothing matches.`,
      content: idContent,
      schema: IDENTIFY_SCHEMA,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      send,
      model: SMART_MODEL, deadline: Date.now() + IDENTIFY_MS,
    });
    if (retry?.identified) Object.assign(id, retry);
  }
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
  if (cache && !fresh && key.replace(/_/g, "")) {
    const hit = await cache.get(key).catch(() => null);
    const ttlDays = hit?.result?.partial ? 1 : CACHE_DAYS;
    if (hit && Date.now() - (hit.cached_at || 0) < ttlDays * 864e5) {
      send({ type: "status", text: "Already checked this wine" });
      return { ...hit.result, cached: true };
    }
  }

  // 3. Parallel lookups.
  send({ type: "status", text: "Checking the tech sheet, farming and vegan status" });
  const site = id.winery_website, page = id.product_page_url;
  const ask = (text) => [{ type: "text", text }];
  const deadline = Date.now() + LOOKUP_MS;
  const webTools = (searches, fetches) => [
    { type: "web_search_20250305", name: "web_search", max_uses: searches },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: fetches },
  ];

  // Tech sheet: three routes at once. Fast routes (product page links and
  // the WordPress media search) need no AI; a one search lookup for the PDF
  // runs alongside in case the fast routes find nothing.
  let producerOrigin = "";
  // Started up front so it runs alongside everything else.
  const nutritionSearch = runAgent({ diag,
    name: "nutrition-search", model: SMART_MODEL, system: NUTRITION_SEARCH_SYSTEM, schema: NUTRITION_SCHEMA, send, deadline: deadline - 4000,
    content: ask(`Wine: ${wineLine(wine)}. Winery website: ${site || "unknown"}. Search exactly: ${brandAndName(wine)} nutrition facts`),
    tools: webTools(2, 1),
  });

  const abvLookup = runAgent({ diag,
    name: "abv-search", model: SMART_MODEL, system: ABV_SYSTEM, schema: ABV_SCHEMA, send, deadline: deadline - 4000,
    content: ask(`Wine: ${wineLine(wine)}. Search exactly: ${brandAndName(wine)} ABV`),
    tools: webTools(1, 1),
  }).catch(() => null);

  const techLookup = async () => {
    const searched = runAgent({ diag,
      name: "sheet-search", model: SMART_MODEL, system: SHEET_SEARCH_SYSTEM, schema: PDF_URLS_SCHEMA, send, deadline,
      content: ask(`Wine: ${wineLine(wine)}. Winery website: ${site || "unknown"}. Search exactly: ${brandAndName(wine)} tech specs`),
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    });
    // Gather candidates from all routes, rank them together, then download
    // the best ones in order until one works.
    const tFast = Date.now();
    const fast = await findTechCandidates(wine, page, site, diag);
    diag.push({ name: "sheet-fast", ms: Date.now() - tFast, outcome: `${fast.filter((l) => /\.pdf/i.test(l.url)).length} pdf links` });
    let ranked = rankPdfs(fast, wine, site);
    let searchPool = [];
    let searchSeen = [];
    const fullName = norm(wine.name).split(" ").filter((w) => w.length > 2).length;
    if (!(ranked[0] && ranked[0].matched >= fullName)) {
      // No exact match from the fast routes: add the web search results.
      const found = await searched;
      const searchUrls = (found?.pdf_urls || []).filter((u) => /^https?:\/\//.test(u)).slice(0, 5);
      diag.push({ name: "sheet-search-urls", outcome: JSON.stringify(searchUrls).slice(0, 400) });
      searchSeen = searchUrls;
      // No winery site from identify: if a search result is on the producer's
      // own domain, run the fast routes on that domain too.
      let extra = [];
      if (!page && !site) {
        const prod = norm(wine.producer).split(" ").filter((w) => w.length > 3);
        const own = searchUrls.find((u) => { try { const h = new URL(u).hostname.toLowerCase(); return prod.some((w) => h.includes(w)); } catch { return false; } });
        if (own) {
          const origin = new URL(own).origin;
          producerOrigin = origin;
          extra = await findTechCandidates(wine, null, origin, diag);
          diag.push({ name: "sheet-fast-producer-domain", outcome: `${origin}: ${extra.filter((l) => /\.pdf/i.test(l.url)).length} pdf links` });
        }
      }
      ranked = rankPdfs([...fast, ...extra, ...searchUrls.map((url) => ({ url, text: "" }))], wine, site || (extra.length ? extra[0].url : ""));
      // Only truly unnamed files (no wine words in the file name) get a text
      // check; named files were judged by the ranking rules already.
      searchPool = searchUrls.filter((u) => {
        if (!/\.pdf(\?|$)/i.test(u)) return false;
        let f = u.split("/").pop();
        try { f = decodeURIComponent(f); } catch {}
        const fw = new Set(norm(f).split(" "));
        return !norm(wine.name).split(" ").filter((w) => w.length > 2).some((w) => fw.has(w));
      });
    }
    diag.push({ name: "sheet-ranked", outcome: JSON.stringify(ranked.slice(0, 3).map((r) => `${r.score.toFixed(1)} ${r.url}`)).slice(0, 600) });
    // Download the best ranked PDFs in order; for unhelpfully named search
    // results (e.g. 394499-untitled.pdf), keep one whose text names the wine.
    const nameWords = norm(wine.name).split(" ").filter((w) => w.length > 2);
    const prodWords = norm(wine.producer).split(" ").filter((w) => w.length > 2);
    const year = /^\d{4}$/.test(String(wine.vintage || "")) ? String(wine.vintage) : "";
    const textMatch = async (url, needYear) => {
      if (Date.now() > deadline - 6000) return null;
      send({ type: "fetch", text: url });
      const got = await fetchPdf(url, 6000);
      if (!got.data) { diag.push({ name: "sheet-download", outcome: `${got.error}: ${url}`.slice(0, 300) }); return null; }
      const textNorm = norm(await pdfText(got.data));
      const words = new Set(textNorm.split(" "));
      const hits = nameWords.filter((w) => words.has(w)).length;
      const styleNeeded = STYLE_WORDS.filter((w) => REQUIRED_STYLE.has(w) && norm(wine.name).split(" ").includes(w));
      const ok = prodWords.some((w) => words.has(w)) && hits >= Math.ceil(nameWords.length * 0.5) &&
        styleNeeded.every((w) => words.has(w)) && (!needYear || words.has(needYear));
      diag.push({ name: "sheet-text-check", outcome: `${ok ? "match" : "no match"} (${hits}/${nameWords.length}${needYear ? `, vintage ${needYear}` : ""}): ${url}`.slice(0, 300) });
      return ok ? { url, data: got.data } : null;
    };
    const download = async (rankedList, pool) => {
      const tried = new Set(rankedList.slice(0, 3).map((c) => c.url));
      const unranked = pool.filter((u) => !tried.has(u)).slice(0, 2);
      // Top pick is named for a different vintage: first look for an unnamed
      // file whose text has the right vintage.
      const top = rankedList[0];
      let topName = top ? top.url.split("/").pop() : "";
      try { topName = decodeURIComponent(topName); } catch {}
      const topYears = topName.match(/\b(19|20)\d{2}\b/g) || [];
      if (year && top && topYears.length && !topYears.includes(year)) {
        for (const url of unranked) {
          const hit = await textMatch(url, year);
          if (hit) return hit;
        }
      }
      for (const c of rankedList.slice(0, 3)) {
        if (Date.now() > deadline - 4000) return null;
        send({ type: "fetch", text: c.url });
        const got = await fetchPdf(c.url, 6000);
        if (got.data) return { url: c.url, data: got.data };
        diag.push({ name: "sheet-download", outcome: `${got.error}: ${c.url}`.slice(0, 300) });
      }
      for (const url of unranked) {
        const hit = await textMatch(url, "");
        if (hit) return hit;
      }
      return null;
    };
    let sheet = await download(ranked, searchPool);

    // Nothing usable and time left: one more search with different wording.
    if (!sheet && Date.now() < deadline - 10000) {
      let host = "";
      try { host = new URL(site).hostname.replace(/^www\./, ""); } catch {}
      const retry = await runAgent({ diag,
        name: "sheet-search-2", model: SMART_MODEL, system: SHEET_SEARCH_SYSTEM, schema: PDF_URLS_SCHEMA, send, deadline: deadline - 5000,
        content: ask(`Wine: ${wineLine(wine)}. Winery website: ${site || "unknown"}. A first search found nothing usable${searchSeen.length ? ` (already tried: ${searchSeen.join(", ")})` : ""}. Use different wording this time, for example "${wine.producer} ${wine.name} fact sheet pdf"${host ? ` or site:${host} pdf` : ""}.`),
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      });
      const urls2 = (retry?.pdf_urls || []).filter((u) => /^https?:\/\//.test(u) && !searchSeen.includes(u)).slice(0, 5);
      diag.push({ name: "sheet-search-2-urls", outcome: JSON.stringify(urls2).slice(0, 400) });
      if (urls2.length) sheet = await download(rankPdfs(urls2.map((url) => ({ url, text: "" })), wine, site), urls2.filter((u) => /\.pdf(\?|$)/i.test(u)));
    }
    // The winery page the tasting lookup found often links the tech sheet PDF
    // (e.g. terracottawines.com/our-wines/pinot-grigio -> DOWNLOAD PDF).
    if (!sheet) {
      const t = cleanTasting(await tastingLookup);
      if (t?.source_url) {
        const tp = await findPageLinks(t.source_url).catch(() => ({ error: "failed" }));
        const links = tp.error ? [] : tp.links || [];
        const ranked2 = rankPdfs(links, wine, t.source_url);
        diag.push({ name: "sheet-tasting-page", outcome: `${links.length} links, ${ranked2.length} ranked: ${t.source_url}`.slice(0, 300) });
        if (ranked2.length) sheet = await download(ranked2, []);
      }
    }
    if (!sheet) {
      // No PDF: read the winery's (or importer's) own spec page instead.
      const ns = await nutritionSearch;
      // Spec pages from the "tech specs" search on the producer's own domain
      // come first, then winery / importer pages from the nutrition search.
      const prodW = norm(wine.producer).split(" ").filter((w) => w.length > 3);
      const onProducerSite = (u) => {
        try {
          const h = new URL(u).hostname.toLowerCase();
          return prodW.some((w) => h.includes(w)) || (site && h.endsWith(new URL(site).hostname.replace(/^www\./, "")));
        } catch { return false; }
      };
      const ownSpec = searchSeen
        .filter((u) => !/\.pdf(\?|$)/i.test(u))
        .find((u) => { try { const h = new URL(u).hostname.toLowerCase(); return prodW.some((w) => h.includes(w)) || (site && h.endsWith(new URL(site).hostname.replace(/^www\./, ""))); } catch { return false; } });
      const specPage = (ownSpec && { url: ownSpec, kind: "winery" })
        || (ns?.pages || []).find((p) => p.kind === "winery" && onProducerSite(p.url))
        || (ns?.pages || []).find((p) => p.kind === "importer");
      if (!specPage) return null;
      send({ type: "fetch", text: specPage.url });
      const text = await pageText(specPage.url);
      diag.push({ name: "spec-page", outcome: `${text.length} chars (${specPage.kind}): ${specPage.url}`.slice(0, 300) });
      if (text.length < 300) return null;
      // A homepage or a page that does not name the wine is not its spec page.
      let path = "/";
      try { path = new URL(specPage.url).pathname; } catch {}
      const specWords = new Set(norm(text).split(" "));
      const specHits = norm(wine.name).split(" ").filter((w) => w.length > 2 && specWords.has(w)).length;
      const needHits = Math.ceil(norm(wine.name).split(" ").filter((w) => w.length > 2).length * 0.6);
      if (path === "/" || path === "" || specHits < needHits) {
        diag.push({ name: "spec-page-rejected", outcome: `${path === "/" ? "homepage" : `names ${specHits}/${needHits} wine words`}: ${specPage.url}`.slice(0, 300) });
        return null;
      }
      send({ type: "status", text: "Reading the winery's spec page" });
      return runAgent({ diag,
        name: "tech-page", system: sheetPrompt(wine), schema: agentSchema(SHEET_IDS, true), send,
        model: READ_MODEL, deadline: Math.max(deadline, Date.now() + 9000),
        content: [{ type: "text", text: `Text of the ${specPage.kind}'s page for this wine at ${specPage.url} (not a lab sheet: use evidence "winery" for stated figures, not "lab"). Only use figures that are clearly for this wine.\n\n<page>\n${text}\n</page>\n\nFill the items. tech_sheet_url is "" unless the page is a technical sheet.` }],
      });
    }
    send({ type: "status", text: "Reading the tech sheet" });
    const text = await pdfText(sheet.data);
    diag.push({ name: "sheet-text", outcome: `${text.length} chars` });
    const content = text.length >= 200
      ? [{ type: "text", text: `Text extracted from the winery's tech sheet at ${sheet.url}. Labels and values may sit in separate columns; match them in order.\n\n<tech_sheet>\n${text}\n</tech_sheet>\n\nFill the items. tech_sheet_url is ${sheet.url}.` }]
      : [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: sheet.data } },
          { type: "text", text: `This is the winery's tech sheet, from ${sheet.url}. Read it and fill the items. tech_sheet_url is that url.` },
        ];
    return runAgent({ diag,
      name: "tech", system: sheetPrompt(wine), schema: agentSchema(SHEET_IDS, true), send, content,
      model: READ_MODEL, deadline: Math.max(deadline, Date.now() + 10000),
    });
  };

  const barnivoreLookup = async () => {
    const found = await runAgent({ diag,
      name: "barnivore-find", system: BARNIVORE_FIND_SYSTEM, schema: URL_SCHEMA, send, deadline: deadline - 6000,
      content: ask(`Producer: ${wine.producer}. Country: ${wine.country || "unknown"}.`),
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    });
    if (!found?.url) return null;
    const bv = await readBarnivore(found.url);
    diag.push({ name: "barnivore", outcome: bv.error ? `${bv.error}: ${found.url}` : `${bv.status} (${bv.as_of}): ${found.url}` });
    return bv.error || bv.status === "unknown" ? null : bv;
  };

  // Second pass when the first finds nothing: many winery sites block
  // fetching, but the importer usually publishes the same notes.
  const tastingLookup = (async () => {
    const first = await runAgent({ diag,
      name: "tasting", model: SMART_MODEL, system: tastingPrompt(wine, site, page), schema: TASTING_SCHEMA, send, deadline,
      content: ask("Find the winery's tasting notes and food pairings for this wine."), tools: webTools(2, 2),
    }).catch(() => null);
    if (cleanTasting(first) || Date.now() > deadline - 6000) return first;
    return runAgent({ diag,
      name: "tasting-importer", model: SMART_MODEL, system: tastingPrompt(wine, "", ""), schema: TASTING_SCHEMA, send, deadline: deadline + 4000,
      content: ask(`The winery's own site gave nothing. Search "${[wine.producer, wine.name].filter(Boolean).join(" ")} importer tasting notes food pairing" and use the official importer's or distributor's page for this exact wine.`),
      tools: webTools(2, 2),
    }).catch(() => null);
  })();

  const ratingsLookup = runAgent({ diag,
    name: "ratings", model: SMART_MODEL, system: ratingsPrompt(wine), schema: RATINGS_SCHEMA, send, deadline,
    content: ask("Find this wine's professional critic ratings."), tools: webTools(1, 1),
  }).catch(() => null);

  let [tech, farm, vegan, cert, barnivore] = await Promise.all([
    techLookup(),
    runAgent({ diag,
      name: "farm", model: SMART_MODEL, system: farmPrompt(wine, site), schema: agentSchema(FARM_IDS, false), send, deadline,
      content: ask("Check farming and certifications and fill the items."), tools: webTools(1, 2),
    }),
    runAgent({ diag,
      name: "vegan", system: veganPrompt(wine, site), schema: agentSchema(VEGAN_IDS, false), send, deadline,
      content: ask("Check vegan status and fill the items."), tools: webTools(1, 1),
    }),
    certScan(site, wine.country, diag),
    barnivoreLookup(),
  ]);
  // Rescue path found the winery's domain: run the certification check there.
  if (!cert && !site && producerOrigin) cert = await certScan(producerOrigin, wine.country, diag);

  // A sheet whose sugar is impossible for the wine's style is the wrong wine
  // (e.g. a Brut sheet at 10 g/L for a Brut Nature, which is 3 g/L at most).
  if (tech?.nutrition?.residual_sugar_g_l != null) {
    const styleText = norm(`${wine.name} ${wine.style}`);
    const maxSugar = /\b(nature|pas dose|dosaggio zero|zero dosage|non dose|brut zero)\b/.test(styleText) ? 3
      : /\bextra brut\b/.test(styleText) ? 6 : null;
    if (maxSugar != null && tech.nutrition.residual_sugar_g_l > maxSugar + 0.5) {
      diag.push({ name: "sheet-rejected", outcome: `sugar ${tech.nutrition.residual_sugar_g_l} g/L impossible for this style (max ${maxSugar}): ${tech.tech_sheet_url}` });
      tech = null;
    }
  }

  // Tech sheet sanity: a sheet with analysis numbers is a lab sheet, and a
  // sheet for another vintage is marked as such on every item it supports.
  if (tech) {
    const n = tech.nutrition || {};
    const hasNumbers = [n.residual_sugar_g_l, n.total_so2_mg_l, n.ph, n.ta_g_l].some((v) => v != null);
    const ts = (tech.checks || []).find((c) => c.id === "tech_sheet");
    if (hasNumbers && ts && ts.status !== "pass") Object.assign(ts, { status: "pass", evidence: "lab", detail: "Tech sheet with lab analysis numbers." });
    const sheetYear = String(tech.tech_sheet_vintage || "").match(/(19|20)\d{2}/)?.[0];
    const wineYear = String(wine.vintage || "").match(/(19|20)\d{2}/)?.[0];
    if (sheetYear && wineYear && sheetYear !== wineYear) {
      for (const c of tech.checks || []) {
        if (c.status !== "unknown" && c.status !== "na" && c.scope === "this_wine") {
          c.scope = "related_wine";
          c.detail = `${sheetYear} sheet: ${c.detail}`;
        }
      }
    }
  }

  // 4. Merge.
  const best = {};
  for (const part of [tech, farm, vegan]) for (const c of part?.checks || []) best[c.id] = better(best[c.id], c);
  if (barnivore) {
    const detail = barnivore.quote
      ? `Barnivore, winery's reply: "${barnivore.quote.length > 220 ? barnivore.quote.slice(0, 217).replace(/\s+\S*$/, "") + "..." : barnivore.quote}"`
      : `Barnivore lists the producer as ${barnivore.status === "pass" ? "vegan" : "not vegan"}.`;
    best.vegan = { id: "vegan", status: barnivore.status, evidence: "winery", scope: "producer", as_of: barnivore.as_of, detail, source_url: barnivore.url };
  }
  if (cert) {
    const detail = cert.snippet ? `Winery site: "...${cert.snippet.split(" ").slice(0, 20).join(" ")}..."` : `The winery's site names ${cert.term} certification.`;
    for (const id of ["sustainable", "certifications"]) {
      // A mention on the winery's own site is the winery's statement, not
      // proof of a certificate, so it counts as "winery", not "certified".
      const mine = { id, status: "pass", evidence: "winery", scope: "producer", as_of: "", detail, source_url: cert.url };
      // The winery's own site beats any non certified finding from elsewhere.
      if (!(best[id]?.status === "pass" && best[id]?.evidence === "certified")) best[id] = mine;
    }
  }
  // Sugar per glass is computed here, not left to the model's wording.
  // Fill gaps from the nutrition search, only when the figures come from the
  // winery or its importer.
  const ns = await nutritionSearch;
  if (ns && (ns.source_kind === "winery" || ns.source_kind === "importer") && ns.source_url) {
    if (!tech) tech = { checks: [], sources: [], nutrition: { ...EMPTY_NUTRITION }, tech_sheet_url: "", tech_sheet_vintage: "" };
    tech.nutrition = tech.nutrition || { ...EMPTY_NUTRITION };
    const n = tech.nutrition;
    const filled = [];
    if (n.calories_5oz == null && ns.calories_5oz != null) { n.calories_5oz = ns.calories_5oz; filled.push("calories"); }
    if (n.carbs_5oz == null && ns.carbs_5oz != null) { n.carbs_5oz = ns.carbs_5oz; filled.push("carbs"); }
    if (n.abv == null && ns.abv != null) n.abv = ns.abv;
    if (n.residual_sugar_g_l == null) {
      const rsl = ns.residual_sugar_g_l ?? (ns.sugar_g_5oz != null ? Math.round((ns.sugar_g_5oz / 0.148) * 10) / 10 : null);
      if (rsl != null) { n.residual_sugar_g_l = rsl; if (n.source === "none") n.source = "winery"; filled.push("sugar"); }
    }
    const via = ns.source_kind === "importer" ? " (importer)" : "";
    const add = (id, detail) => {
      const c = { id, status: "pass", evidence: "winery", scope: "this_wine", as_of: "", detail, source_url: ns.source_url };
      best[id] = better(best[id], c);
    };
    if (filled.includes("calories")) add("calories", `${ns.calories_5oz} calories per 5 oz, stated by the ${ns.source_kind}${via ? "" : ""}.`);
    if (filled.includes("carbs")) add("carbs", `${ns.carbs_5oz} g carbs per 5 oz, stated by the ${ns.source_kind}.`);
    diag.push({ name: "nutrition-facts", outcome: `${ns.source_kind}: ${filled.join(", ") || "nothing new"} from ${ns.source_url}`.slice(0, 300) });
  } else if (ns && (ns.calories_5oz != null || ns.carbs_5oz != null || ns.sugar_g_5oz != null || ns.residual_sugar_g_l != null || ns.abv != null)) {
    // Figures from any other page in the "nutrition facts" results are shown,
    // labeled as estimates. Values outside sane ranges for wine are dropped.
    const sane = (v, lo, hi) => (v != null && v >= lo && v <= hi ? v : null);
    ns.calories_5oz = sane(ns.calories_5oz, 50, 300);
    ns.carbs_5oz = sane(ns.carbs_5oz, 0, 25);
    ns.sugar_g_5oz = sane(ns.sugar_g_5oz, 0, 25);
    ns.residual_sugar_g_l = sane(ns.residual_sugar_g_l, 0, 200);
    ns.abv = sane(ns.abv, 4, 22);
    // With published ABV (tech sheet or winery), calories and carbs are
    // calculated below from the real figures; don't let a third party
    // estimate override that.
    if (tech?.nutrition?.abv != null) { ns.calories_5oz = null; ns.carbs_5oz = null; }
    // Estimates only from wine databases and nutrition databases, not from
    // menus or random aggregators.
    // Not from the winery: show the figures, clearly labeled as estimates.
    if (!tech) tech = { checks: [], sources: [], nutrition: { ...EMPTY_NUTRITION }, tech_sheet_url: "", tech_sheet_vintage: "" };
    tech.nutrition = tech.nutrition || { ...EMPTY_NUTRITION };
    const n = tech.nutrition;
    let host = "web search";
    try { host = new URL(ns.source_url).hostname.replace(/^www\./, ""); } catch {}
    const filled = [];
    if (n.calories_5oz == null && ns.calories_5oz != null) { n.calories_5oz = ns.calories_5oz; filled.push("calories"); }
    if (n.carbs_5oz == null && ns.carbs_5oz != null) { n.carbs_5oz = ns.carbs_5oz; filled.push("carbs"); }
    if (n.abv == null && ns.abv != null) n.abv = ns.abv;
    if (n.residual_sugar_g_l == null) {
      const rsl = ns.residual_sugar_g_l ?? (ns.sugar_g_5oz != null ? Math.round((ns.sugar_g_5oz / 0.148) * 10) / 10 : null);
      if (rsl != null) { n.residual_sugar_g_l = rsl; n.source = "estimate"; filled.push("sugar"); }
    }
    const add = (id, detail) => {
      best[id] = better(best[id], { id, status: "pass", evidence: "estimate", scope: "this_wine", as_of: "", detail, source_url: ns.source_url || "" });
    };
    if (filled.includes("calories")) add("calories", `About ${ns.calories_5oz} calories per 5 oz (estimate via ${host}).`);
    if (filled.includes("carbs")) add("carbs", `About ${ns.carbs_5oz} g carbs per 5 oz (estimate via ${host}).`);
    diag.push({ name: "nutrition-facts", outcome: `estimate from ${host}: ${filled.join(", ") || "nothing new"}`.slice(0, 300) });
  }
  // ABV still missing: take it from the ABV lookup (retail listings).
  {
    const a = await abvLookup;
    if (a && a.abv >= 4 && a.abv <= 22) {
      if (!tech) tech = { checks: [], sources: [], nutrition: { ...EMPTY_NUTRITION }, tech_sheet_url: "", tech_sheet_vintage: "" };
      tech.nutrition = tech.nutrition || { ...EMPTY_NUTRITION };
      if (tech.nutrition.abv == null) {
        tech.nutrition.abv = a.abv;
        diag.push({ name: "abv", outcome: `${a.abv}% from ${a.source_url}`.slice(0, 200) });
      }
    } else diag.push({ name: "abv", outcome: "not found" });
  }
  // Calories and carbs not published: calculate them from ABV and sugar.
  {
    const n = tech?.nutrition;
    if (n && n.abv != null) {
      const sugarG = n.residual_sugar_g_l != null ? n.residual_sugar_g_l * 0.148 : null;
      // A published figure (winery or lab) wins; anything the model worked out
      // itself is replaced by the standard formula, so numbers are consistent.
      const stated = (c) => c?.status === "pass" && (c.evidence === "winery" || c.evidence === "lab");
      if (!stated(best.calories)) { n.calories_5oz = null; delete best.calories; }
      if (!stated(best.carbs)) { n.carbs_5oz = null; delete best.carbs; }
      if (n.calories_5oz == null) {
        n.calories_5oz = Math.round(148 * (n.abv / 100) * 0.789 * 7 + (sugarG || 0) * 4);
        if (!(best.calories?.status === "pass")) best.calories = { id: "calories", status: "pass", evidence: "estimate", scope: "this_wine", as_of: "", detail: `About ${n.calories_5oz} calories per 5 oz, calculated from ${n.abv}% ABV${sugarG != null ? ` and ${n.residual_sugar_g_l} g/L sugar` : ""}.`, source_url: tech.tech_sheet_url || "" };
      }
      if (n.carbs_5oz == null && sugarG != null) {
        n.carbs_5oz = Math.round((sugarG + 0.5) * 10) / 10;
        if (!(best.carbs?.status === "pass")) best.carbs = { id: "carbs", status: "pass", evidence: "estimate", scope: "this_wine", as_of: "", detail: `About ${n.carbs_5oz} g carbs per 5 oz, calculated from ${n.residual_sugar_g_l} g/L sugar.`, source_url: tech.tech_sheet_url || "" };
      }
    }
  }
  const rs = (tech?.nutrition || {}).residual_sugar_g_l;
  if (rs != null) {
    const perGlass = (rs * 0.148).toFixed(1);
    const base = best.sugar_under_1g?.status === "pass" || best.sugar_under_1g?.status === "fail"
      ? best.sugar_under_1g
      : { id: "sugar_under_1g", evidence: tech.nutrition.source === "none" ? "lab" : tech.nutrition.source, scope: "this_wine", as_of: "", source_url: tech.tech_sheet_url || "" };
    best.sugar_under_1g = {
      ...base,
      status: rs * 0.148 < 1 ? "pass" : "fail",
      detail: `About ${perGlass} g sugar per 5 oz glass (${rs} g/L residual sugar).${base.scope === "related_wine" ? " From another vintage's sheet." : ""}`,
    };
  }
  // Honest sourcing: a "winery" statement found on another site (importer,
  // shop) names that site in the detail.
  const ownHosts = [site, producerOrigin, cert?.url].map((u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean);
  const prodWordsAll = norm(wine.producer).split(" ").filter((w) => w.length > 3);
  for (const c of Object.values(best)) {
    if (c.evidence !== "winery" || !c.source_url) continue;
    let host = "";
    try { host = new URL(c.source_url).hostname.replace(/^www\./, ""); } catch { continue; }
    const own = ownHosts.some((h) => host.endsWith(h)) || prodWordsAll.some((w) => host.includes(w)) || /barnivore\.com$/.test(host);
    if (!own && !c.detail.includes(host)) c.detail = `${c.detail} (via ${host})`;
  }

  // The label's dosage term is the winery's own statement of zero dosage.
  const labelText = norm(`${wine.name} ${wine.style}`);
  const zeroTerm = labelText.match(/\b(brut nature|pas dose|dosaggio zero|zero dosage|non dose|brut zero|dosage zero)\b/);
  if (zeroTerm && best.zero_dosage?.status !== "fail" && best.zero_dosage?.status !== "pass") {
    best.zero_dosage = { id: "zero_dosage", status: "pass", evidence: "winery", scope: "this_wine", as_of: "", detail: `Label says "${zeroTerm[1].replace(/\b\w/g, (c) => c.toUpperCase())}": no sugar added at dosage.`, source_url: "" };
  }
  // Zero dosage only applies to sparkling wine.
  const sparkling = /sparkl|spumante|champagne|cava|cr[eé]mant|prosecco|franciacorta|sekt|brut|p[eé]tillant|frizzante|mousseux|espumoso/i.test(`${wine.style} ${wine.name}`);
  if (!sparkling && (!best.zero_dosage || best.zero_dosage.status === "unknown")) {
    best.zero_dosage = { id: "zero_dosage", status: "na", evidence: "none", scope: "this_wine", as_of: "", detail: "Still wine, so dosage does not apply.", source_url: "" };
  }
  const checks = ALL_ITEMS.map(
    (i) => best[i.id] || { id: i.id, status: "unknown", evidence: "none", scope: "this_wine", as_of: "", detail: "No public information found.", source_url: "" }
  );
  const nutrition = tech?.nutrition || EMPTY_NUTRITION;
  const seen = new Set();
  const sources = [tech, farm, vegan]
    .flatMap((p) => p?.sources || [])
    .filter((s) => s.url && !seen.has(s.url) && seen.add(s.url))
    .slice(0, 12);

  const ratings = cleanRatings(await ratingsLookup, wine);
  const tasting = cleanTasting(await tastingLookup);
  diag.push({ name: "tasting-found", outcome: tasting ? `${tasting.source}: ${tasting.source_url}` : "none" });
  diag.push({ name: "ratings-found", outcome: String(ratings.length) });

  const result = {
    identified: true,
    wine: { ...wine, tech_sheet_url: tech?.tech_sheet_url || "", tech_sheet_vintage: tech?.tech_sheet_vintage || "" },
    nutrition,
    checks,
    ratings,
    tasting,
    summary: summarize(wine, checks, nutrition),
    sources,
    seconds: Math.round((Date.now() - t0) / 1000),
    debug: diag,
    partial: [tech, farm, vegan].some((p) => !p),
  };

  // Complete results are kept 30 days; partial ones (no tech sheet, or a
  // lookup ran out of time) for 1 day, so they get retried soon.
  // A thin result (fewer than 4 of the top 10 known) is not cached: lookups
  // vary run to run, so the next scan gets a fresh try instead of a stored
  // empty answer.
  const knownTop = ALL_ITEMS.filter((i) => i.top).filter((i) => checks.some((c) => c.id === i.id && (c.status === "pass" || c.status === "fail"))).length;
  diag.push({ name: "cache", outcome: knownTop >= 4 ? `stored (${knownTop}/10 known)` : `skipped, thin result (${knownTop}/10 known)` });
  if (cache && knownTop >= 4) await cache.set(key, { cached_at: Date.now(), result }).catch(() => {});
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
    tasting: { notes: "Pale straw with fine bubbles. Crisp green apple and white flowers, with a dry, mineral finish.", flavors: ["green apple", "white flowers", "citrus", "mineral"], pairings: ["oysters", "sushi", "fried appetizers"], source: "winery", source_url: "" },
    ratings: [
      { publication: "Wine Enthusiast", score: 91, scale: 100, vintage: "2024", source_url: "" },
      { publication: "James Suckling", score: 90, scale: 100, vintage: "2023", source_url: "" },
      { publication: "Decanter", score: 88, scale: 100, vintage: "2022", source_url: "" },
    ],
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
