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
// Reading an attached tech sheet is simple extraction, so it uses the fastest model.
const READ_MODEL = process.env.WINE_BABE_READ_MODEL || "claude-haiku-5-5";
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

const wineLine = (w) =>
  `${w.producer} ${w.name}${w.vintage ? ` ${w.vintage}` : ""} (${[w.style, w.grapes, w.region, w.country].filter(Boolean).join(", ")})`;

const IDENTIFY_SYSTEM = `You identify wines for the Wine Babe app, fast.
From the label photo or text, identify producer, wine name, vintage, region, country, grapes and style (for sparkling, the dosage term on the label: Brut Nature, Pas Dosé, Dosaggio Zero, Extra Brut, Brut, Extra Dry...).
Then find the winery's official website and this wine's product page on it, with at most one web search. Be quick. Prefer the winery's own domain over shops.
If the photo is not a wine label or is unreadable, set identified false and explain in note. Unknown text fields are "".`;

const PDF_URLS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pdf_urls"],
  properties: { pdf_urls: { type: "array", items: { type: "string" } } },
};

const SHEET_SEARCH_SYSTEM = `You find a wine's official technical sheet PDF for the Wine Babe app, fast.
Run exactly one web search, such as: <producer> <wine> tech sheet pdf. Wineries also call it a fact sheet, technical data, wine notes or tasting notes, and in their own language scheda tecnica, fiche technique, ficha técnica, Datenblatt. Prefer the winery's or importer's own site.
Return up to 5 direct PDF URLs from the results, best match for this exact wine first. Return an empty list if none.`;

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
  "cuvee", "single", "vineyard", "estate", "limited", "magnum", "half",
];

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

// Ranks PDF candidates for this wine, best first. Drops award, price list and
// clearly mismatched files.
function rankPdfs(links, wine, siteUrl) {
  const nameNorm = norm(wine.name);
  const nameWords = nameNorm.split(" ").filter((w) => w.length > 2);
  // Style words the file must carry (from the wine name) and may carry (name or style).
  const requiredStyle = STYLE_WORDS.filter((w) => nameNorm.split(" ").includes(w));
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
      return { ...l, score, matched, missingStyle, junk };
    })
    // Must match at least half the name, carry every style word in the name
    // (Brut Nature, not Brut), and not look like an award or price list.
    .filter((l) => l.matched >= Math.max(1, Math.ceil(nameWords.length * 0.5)) && l.missingStyle === 0 && !l.junk && l.score > 0)
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
    const res = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 (compatible; WineBabeScanner/1.0)", Accept: "application/json" } });
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
      const res = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0 (compatible; WineBabeScanner/1.0)", Accept: "application/json" } });
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
    if (!ctrl.signal.aborted) { console.error(`[${name}]`, err); note("error", err?.message || err); return null; }
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
const ENGINE_VERSION = "v3";
const cacheKey = (w) =>
  ENGINE_VERSION + "__" + [w.producer, w.name, w.vintage].map((x) => String(x || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).join("__");

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
    deadline: t0 + IDENTIFY_MS,
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
  const techLookup = async () => {
    const searched = runAgent({ diag,
      name: "sheet-search", system: SHEET_SEARCH_SYSTEM, schema: PDF_URLS_SCHEMA, send, deadline,
      content: ask(`Wine: ${wineLine(wine)}. Winery website: ${site || "unknown"}.`),
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    });
    // Gather candidates from all routes, rank them together, then download
    // the best ones in order until one works.
    const tFast = Date.now();
    const fast = await findTechCandidates(wine, page, site, diag);
    diag.push({ name: "sheet-fast", ms: Date.now() - tFast, outcome: `${fast.filter((l) => /\.pdf/i.test(l.url)).length} pdf links` });
    let ranked = rankPdfs(fast, wine, site);
    let searchPool = [];
    const fullName = norm(wine.name).split(" ").filter((w) => w.length > 2).length;
    if (!(ranked[0] && ranked[0].matched >= fullName)) {
      // No exact match from the fast routes: add the web search results.
      const found = await searched;
      const searchUrls = (found?.pdf_urls || []).filter((u) => /^https?:\/\//.test(u)).slice(0, 5);
      diag.push({ name: "sheet-search-urls", outcome: JSON.stringify(searchUrls).slice(0, 400) });
      ranked = rankPdfs([...fast, ...searchUrls.map((url) => ({ url, text: "" }))], wine, site);
      searchPool = searchUrls.filter((u) => /\.pdf(\?|$)/i.test(u));
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
      const ok = prodWords.some((w) => words.has(w)) && hits >= Math.ceil(nameWords.length * 0.5) && (!needYear || words.has(needYear));
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
        name: "sheet-search-2", system: SHEET_SEARCH_SYSTEM, schema: PDF_URLS_SCHEMA, send, deadline: deadline - 5000,
        content: ask(`Wine: ${wineLine(wine)}. Winery website: ${site || "unknown"}. A first search found nothing usable${searchPool.length ? ` (tried: ${searchPool.join(", ")})` : ""}. Use different wording this time, for example "${wine.producer} ${wine.name} fact sheet pdf"${host ? ` or site:${host} pdf` : ""}.`),
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      });
      const urls2 = (retry?.pdf_urls || []).filter((u) => /^https?:\/\//.test(u) && !searchPool.includes(u)).slice(0, 5);
      diag.push({ name: "sheet-search-2-urls", outcome: JSON.stringify(urls2).slice(0, 400) });
      if (urls2.length) sheet = await download(rankPdfs(urls2.map((url) => ({ url, text: "" })), wine, site), urls2.filter((u) => /\.pdf(\?|$)/i.test(u)));
    }
    if (!sheet) return null;
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

  const [tech, farm, vegan, cert] = await Promise.all([
    techLookup(),
    runAgent({ diag,
      name: "farm", system: farmPrompt(wine, site), schema: agentSchema(FARM_IDS, false), send, deadline,
      content: ask("Check farming and certifications and fill the items."), tools: webTools(1, 2),
    }),
    runAgent({ diag,
      name: "vegan", system: veganPrompt(wine, site), schema: agentSchema(VEGAN_IDS, false), send, deadline,
      content: ask("Check vegan status and fill the items."), tools: webTools(1, 1),
    }),
    certScan(site, wine.country, diag),
  ]);

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
        if (c.status === "pass" && c.scope === "this_wine") {
          c.scope = "related_wine";
          c.detail = `${sheetYear} sheet: ${c.detail}`;
        }
      }
    }
  }

  // 4. Merge.
  const best = {};
  for (const part of [tech, farm, vegan]) for (const c of part?.checks || []) best[c.id] = better(best[c.id], c);
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

  const result = {
    identified: true,
    wine: { ...wine, tech_sheet_url: tech?.tech_sheet_url || "", tech_sheet_vintage: tech?.tech_sheet_vintage || "" },
    nutrition,
    checks,
    summary: summarize(wine, checks, nutrition),
    sources,
    seconds: Math.round((Date.now() - t0) / 1000),
    debug: diag,
    partial: [tech, farm, vegan].some((p) => !p),
  };

  // Complete results are kept 30 days; partial ones (no tech sheet, or a
  // lookup ran out of time) for 1 day, so they get retried soon.
  if (cache) await cache.set(key, { cached_at: Date.now(), result }).catch(() => {});
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
