/* Wine Babe scanner front end. Needs checklist.js loaded first. */
(() => {
  const $ = (s) => document.querySelector(s);
  const screens = { home: $("#home"), scanning: $("#scanning"), result: $("#result"), toppours: $("#toppours") };
  const HISTORY_KEY = "winebabe.history.v1";
  const SERVING_ML = 147.87; // 5 oz

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
  const fmt = (n, d = 1) => (n == null || isNaN(n) ? null : Number(n).toFixed(d).replace(/\.0$/, ""));

  function show(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle("is-active", k === name));
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  // ---------- history ----------
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
  }
  function saveHistory(entry) {
    try {
      const list = [entry, ...loadHistory().filter((e) => e.key !== entry.key)].slice(0, 20);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {}
  }
  function renderRecent() {
    const list = loadHistory();
    $("#recent").hidden = !list.length;
    $("#recentList").innerHTML = list
      .map(
        (e, i) => `<li><button data-i="${i}">
          <span class="mini-score">${(() => { try { return enrich(e.data).score ?? "—"; } catch { return "—"; } })()}</span>
          <span><span class="r-name">${esc(e.data.wine.name || "Unknown wine")}</span><br />
          <span class="r-sub">${esc([e.data.wine.producer, e.data.wine.vintage].filter(Boolean).join(" · "))}</span></span>
        </button></li>`
      )
      .join("");
  }
  // ---------- Top Pours (shared top 10) ----------
  function renderTopPours(list) {
    const items = Array.isArray(list) ? list : [];
    $("#topPoursBtn").textContent = items.length ? `Top Pours (${items.length})` : "Top Pours";
    $("#topPoursEmpty").hidden = items.length > 0;
    $("#topPoursList").innerHTML = items
      .map((e, i) => `<li><button data-tp="${esc(e.id)}" data-q="${esc([e.wine.producer, e.wine.name, e.wine.vintage].filter(Boolean).join(" "))}">
          <span class="tp-rank">${i + 1}</span>
          <span class="tp-wine"><span class="r-name">${esc(e.wine.name || "Unknown wine")}</span><br />
          <span class="r-sub">${esc([e.wine.producer, e.wine.vintage].filter(Boolean).join(" · "))}</span></span>
          <span class="mini-score">${esc(String(e.score))}</span>
        </button></li>`)
      .join("");
  }
  async function loadTopPours() {
    try { const r = await fetch("/api/top-pours", { cache: "no-store" }); if (r.ok) renderTopPours((await r.json()).list); } catch {}
  }
  // After a scan: send it in. The server reads the stored scan itself and
  // keeps it only if it scores 90+ without "Additional Verification Required".
  async function submitTopPour(id, data) {
    try {
      const r = enrich(data);
      if (!id || r.score == null || r.score < 90 || /additional verification/i.test(r.tier)) return;
      const res = await fetch("/api/top-pours", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, score: r.score, tier: r.tier }) });
      if (!res.ok) return;
      const out = await res.json();
      renderTopPours(out.list);
      if (out.added) {
        const rank = out.list.findIndex((e) => e.id === id) + 1;
        const note = document.createElement("div");
        note.className = "tp-added";
        note.textContent = `Added to Top Pours at #${rank}`;
        const res0 = $("#result");
        res0.insertBefore(note, res0.firstChild);
      }
    } catch {}
  }
  $("#topPoursBtn").addEventListener("click", () => { show("toppours"); loadTopPours(); });
  $("#topPoursBack").addEventListener("click", () => show("home"));
  $("#topPoursList").addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-tp]");
    if (!b) return;
    try {
      const r = await fetch(`/api/scan-status/${encodeURIComponent(b.dataset.tp)}`, { cache: "no-store" });
      const job = r.ok ? await r.json() : null;
      if (job && job.result) return renderResult(job.result, false, job.at);
    } catch {}
    if (b.dataset.q) scan({ query: b.dataset.q }, null);
  });

  $("#recentList").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-i]");
    if (b) { const e = loadHistory()[+b.dataset.i]; renderResult(e.data, false, e.at); }
  });

  // ---------- image prep ----------
  // Larger photos keep small back-label QR codes decodable.
  function shrink(file, max = 2400) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.9));
      };
      img.onerror = () => reject(new Error("Could not read that photo."));
      img.src = url;
    });
  }

  // ---------- scanning ----------
  const ICON = { status: "✨", search: "🔎", fetch: "📄" };
  function feed(type, text) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${ICON[type] || "•"}</span><span>${esc(text)}</span>`;
    $("#feed").appendChild(li);
    if (type === "status") $("#scanTitle").textContent = text;
    if (type === "search") $("#scanTitle").textContent = "Searching the web";
    if (type === "fetch") $("#scanTitle").textContent = "Reading the tech sheet";
  }

  async function scan(payload, previewSrc) {
    $("#feed").innerHTML = "";
    $("#scanTitle").textContent = "Reading the label";
    const prev = $("#preview");
    prev.hidden = !previewSrc;
    if (previewSrc) prev.src = previewSrc;
    show("scanning");

    try {
      const res = await fetch("/api/scan-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { location.href = "/login"; return; }
      const start = await res.json().catch(() => ({}));
      if (!res.ok || !start.id) throw new Error(start.error || "The scanner is not reachable right now.");

      // Poll for progress until the job is done (under a minute, cap at 3).
      let seen = 0, misses = 0, job = null;
      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await fetch(`/api/scan-status/${start.id}`, { cache: "no-store" }).catch(() => null);
        if (!s || !s.ok) {
          if (++misses > 8) throw new Error("Lost touch with the scanner. Try again.");
          continue;
        }
        misses = 0;
        job = await s.json();
        (job.events || []).slice(seen).forEach((e) => feed(e.type, e.text));
        seen = Math.max(seen, (job.events || []).length);
        if (job.done) break;
      }
      if (!job || !job.done) throw new Error("The scan took too long. Try again.");
      if (job.error) throw new Error(job.error);
      if (!job.result) throw new Error("No result came back. Try again.");
      renderResult(job.result, true);
      submitTopPour(start.id, job.result);
    } catch (err) {
      const box = document.createElement("div");
      box.className = "error-box";
      box.innerHTML = `${esc(err.message)}<div class="actions"><button class="btn" id="errBack">Try again</button></div>`;
      $("#feed").after(box);
      $("#scanTitle").textContent = "That didn't work";
      $("#errBack").onclick = () => { box.remove(); goHome(); };
    }
  }

  // Front photo first, then offer the back label (ingredients, nutrition,
  // claims and the QR code are often there).
  const pickFile = (capture) => new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    if (capture) inp.setAttribute("capture", "environment");
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
  const askBack = () => new Promise((resolve) => {
    const d = document.createElement("div");
    d.className = "back-ask";
    d.innerHTML = `<div class="back-ask__card" role="dialog" aria-modal="true" aria-label="Add the back label">
      <p class="back-ask__title">Got the front label</p>
      <p class="back-ask__text">Add the back label too? Nutrition, ingredients, claims and the QR code are usually there.</p>
      <button type="button" class="btn" data-a="camera">Take back label photo</button>
      <button type="button" class="btn ghost" data-a="library">Choose from photos</button>
      <button type="button" class="btn link" data-a="skip">Skip, scan the front only</button></div>`;
    document.body.appendChild(d);
    d.addEventListener("click", async (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (!a) return;
      d.remove();
      resolve(a === "skip" ? null : await pickFile(a === "camera"));
    });
  });
  const onPhoto = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const front = await shrink(file, 2000);
      const backFile = await askBack();
      const back = backFile ? await shrink(backFile, 2000) : null;
      scan(back ? { image: front, image2: back, mediaType: "image/jpeg" } : { image: front, mediaType: "image/jpeg" }, front);
    } catch (err) {
      alert(err.message);
    }
  };
  // Camera (Scan label) and photo library (upload) use the same scan.
  $("#photo").addEventListener("change", onPhoto);
  $("#photoLib").addEventListener("change", onPhoto);

  $("#searchForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = $("#query").value.trim();
    if (q) scan({ query: q }, null);
  });

  // ---------- scoring ----------
  // Sugar in winemaking: what was used during fermentation, added as dosage,
  // or added to sweeten, kept apart from the sugar left in the bottle.
  function sugarProfileHtml(p) {
    if (!p) return "";
    const LABEL = {
      used: "Used during fermentation (neutral)", none: "None added", added: "Added", none_stated: "None added (producer statement)",
      not_verified: "Not verified", not_applicable: "Not applicable", reported: "Reported by a shop (not verified)",
    };
    const line = (name, x) => {
      if (!x) return "";
      const url = safeUrl(x.url);
      return `<li class="sp sp--${x.status}"><span class="sp__name">${name}</span><span class="sp__val">${esc(LABEL[x.status] || x.status)}${x.amount_g_l != null ? ` · ${fmt(x.amount_g_l, 1)} g/L` : ""}</span>
        ${x.detail && x.status !== "not_applicable" ? `<span class="sp__detail">${esc(x.detail)}${x.origin ? ` · ${esc(x.origin)}` : ""}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">Source</a>` : ""}</span>` : ""}</li>`;
    };
    return `<div class="sugar-profile"><div class="sp__title">Sugar in winemaking</div><ul>
      ${line("Sugar Used During Fermentation", p.fermentation)}
      ${p.sparkling ? line("Dosage sugar", p.dosage) : ""}
      ${line("Added sweetening", p.sweetening)}
      ${p.concentrate ? `<li class="sp sp--note"><span class="sp__name">Concentrated grape must</span><span class="sp__val">Listed, purpose not stated</span><span class="sp__detail">${esc(p.concentrate.detail)}</span></li>` : ""}
    </ul><p class="sp__foot">Sugar left in the bottle (above) is scored separately. Sugar consumed during fermentation is neutral.</p></div>`;
  }

  // ---------- WINE BABE standards ----------
  // Published thresholds. Weights total 100.
  const CALORIE_MAX = 100; // kcal per 5 oz, the "Under 100 Calories" Wine Babe standard
  const VERIFIED_EVIDENCE = ["lab", "certified", "winery", "third_party", "retailer"];
  // The Wine Babe score: 11 standards, 100 points, in priority order.
  const STANDARDS = [
    { id: "sugar_under_1g", pts: 80, critical: true, short: "sugar", name: "1 gram or less of sugar per 5 oz, publicly verified",
      rule: "Pass: verified sugar of 1 g or less per 5 oz (147.87 ml), from a lab sheet, the bottle or EU label, the winery, or a verified store or distributor listing. Fail: verified more than 1 g." },
    { id: "ingredient_transparency", pts: 5, short: "ingredient list", name: "Full ingredient list published",
      rule: "Pass: a full ingredient list for this wine is published (winery, importer, the bottle's e-label, the European label, or a store listing). No list found: not verified." },
    { id: "calories", pts: 2, short: "calories", name: "Calories per 5 oz publicly disclosed",
      rule: "Pass: a calorie figure is published (bottle or EU label, winery, lab, store listing), whatever the amount. Calculated estimates are shown but do not count." },
    { id: "no_artificial_flavors", pts: 2, critical: true, short: "no added flavors (ingredients)", name: "No added natural or artificial flavors",
      rule: "Pass: the published ingredient list shows no natural or artificial flavors, or the producer states none are added. Fail: a flavoring is listed." },
    { id: "no_added_sugar", pts: 2, critical: true, short: "no added sugar (ingredients)", name: "No added sugar",
      rule: "Pass: an explicit statement that no sugar is added. Fail: verified dosage or sweetening. Sugar used during fermentation is neutral; low sugar or zero dosage alone never passes." },
    { id: "sulfites", pts: 2, short: "sulfite level", name: "Sulfite transparency",
      rule: "Pass: a verified source publishes the total sulfite level (mg/L). 'Contains sulfites' alone is a legal minimum and does not pass." },
    { id: "vegan", pts: 2, short: "vegan", name: "Vegan friendly", rule: "Pass: the producer or the label states no animal products (directly or via Barnivore). Fail: animal fining agents declared." },
    { id: "farming", from: ["sustainable", "organic"], pts: 1, short: "sustainable or organic farming", name: "Sustainable or organic farming practices",
      rule: "Pass: sustainable farming or organic farming, either one, by certification or the producer's documented practices." },
    { id: "certified_organic", from: "organic", pts: 1, short: "certified organic", name: "Certified organic",
      rule: "Pass: an organic certification (USDA Organic, EU organic leaf, AB, CCOF, a control body code on the bottle, or a named certifier). Documented organic practices without a certificate do not count here." },
    { id: "hand_harvested", pts: 1, short: "hand harvest", name: "Hand harvested grapes", rule: "Pass: the producer states the grapes are picked by hand. Manual harvest (harvested manually, vendemmia manuale, vendange manuelle) is the same thing." },
    { id: "non_gmo", pts: 2, short: "non GMO", name: "Non GMO", rule: "Pass: the producer, the label or a certifier states non GMO (e.g. NO OGM on the tech sheet)." },
  ];

  // Decide each standard: "pass", "fail" or "unverified", with the evidence used.
  function judgeStandards(byId, n, est) {
    const isVerified = (c) => c && (c.status === "pass" || c.status === "fail") && VERIFIED_EVIDENCE.includes(c.evidence);
    return STANDARDS.map((s) => {
      let c = byId[s.id];
      let state, basis;
      if (s.id === "sugar_disclosed") {
        c = byId.sugar_under_1g;
        const shown = isVerified(c);
        state = shown ? "pass" : "unverified";
        basis = shown ? `Sugar figure published. ${c.detail || ""}` : "No published sugar figure.";
      } else if (s.id === "calories") {
        const cal = n.calories_5oz;
        if (isVerified(c) && cal != null && !est.calories) { state = "pass"; basis = `${Math.round(cal)} calories per 5 oz, published. ${c.detail || ""}`; }
        else { state = "unverified"; basis = cal != null ? `About ${Math.round(cal)} calories per 5 oz, calculated from verified alcohol and sugar. Calculated figures earn no points.` : "No published calorie figure."; }
      } else if (s.id === "sulfites") {
        const ok = n.total_so2_mg_l != null && isVerified(c);
        state = ok ? "pass" : "unverified";
        basis = ok ? `Total sulfites ${Math.round(n.total_so2_mg_l)} mg/L published. ${c?.detail || ""}` : "No published total sulfite level.";
      } else if (s.id === "farming") {
        const sus = byId.sustainable, org = byId.organic;
        const passing = [sus, org].find((x) => isVerified(x) && x.status === "pass");
        if (passing) { c = passing; state = "pass"; basis = `${passing === sus ? "Sustainable" : "Organic"} farming. ${passing.detail || ""}`; }
        else if (isVerified(sus) && isVerified(org)) { c = sus; state = "fail"; basis = "Verified as neither sustainable nor organic."; }
        else { c = sus || org; state = "unverified"; basis = "No sustainable or organic farming information found."; }
      } else if (s.id === "certified_organic") {
        c = byId.organic;
        const certified = isVerified(c) && c.status === "pass" && (c.evidence === "certified" || /certif|usda|euroleaf|organic leaf|\bAB\b|agriculture biologique|ccof|ecocert|demeter|[A-Z]{2}-BIO-\d|organic seal|control body/i.test(`${c.detail} ${c.origin || ""}`));
        state = certified ? "pass" : isVerified(c) && c.status === "fail" ? "fail" : "unverified";
        basis = certified ? c.detail : isVerified(c) && c.status === "pass" ? "Organic practices documented, but no organic certificate found." : c?.detail || "No organic certification found.";
      } else if (s.id === "sugar_under_1g" && isVerified(c) && (n.sugar_5oz != null || n.sugar_below_5oz != null)) {
        // 1 gram or less per 5 oz passes (rounded to 0.01 g).
        const g = n.sugar_5oz != null ? Math.round(n.sugar_5oz * 100) / 100 : null;
        state = g != null ? (g <= 1 ? "pass" : "fail") : n.sugar_below_5oz <= 1.0001 ? "pass" : c.status;
        basis = c.detail || "";
      } else {
        state = isVerified(c) ? c.status : "unverified";
        basis = c?.detail || "";
      }
      return { ...s, state, basis: String(basis || "").trim(), origin: c?.origin || "", url: c?.source_url || "", evidence: state === "unverified" ? "none" : c?.evidence || "none", scope: c?.scope };
    });
  }

  function enrich(data) {
    const n = { ...data.nutrition };
    const est = {};
    // Sugar is only shown when verified (lab sheet, winery or importer).
    // Estimates and typical values are dropped and shown as Unverified.
    const sc = (data.checks || []).find((c) => c.id === "sugar_under_1g");
    const sugarVerified = sc && (sc.status === "pass" || sc.status === "fail") && ["lab", "winery", "certified", "third_party"].includes(sc.evidence);
    if (!sugarVerified) { n.residual_sugar_g_l = null; n.sugar_below_g_l = null; }
    // EU labels round small amounts: "under 0.5 g per 100 ml" is shown as an upper bound.
    if (n.residual_sugar_g_l == null && n.sugar_below_g_l != null) n.sugar_below_5oz = (n.sugar_below_g_l * SERVING_ML) / 1000;
    if (n.residual_sugar_g_l != null) n.sugar_5oz = (n.residual_sugar_g_l * SERVING_ML) / 1000;
    // Only verified figures are shown: typical values and estimates are
    // dropped (also from results saved before this rule) and shown as
    // Not verified.
    const VERIFIED = ["lab", "certified", "winery", "third_party", "retailer"];
    const typFields = (n.typical && n.typical.fields) || [];
    if (typFields.includes("abv")) n.abv = null;
    if (typFields.includes("so2")) { n.total_so2_mg_l = null; n.free_so2_mg_l = null; }
    n.typical = null;
    const rawById = Object.fromEntries((data.checks || []).map((c) => [c.id, c]));
    if (!VERIFIED.includes(rawById.calories?.evidence)) n.calories_5oz = null;
    if (!VERIFIED.includes(rawById.carbs?.evidence)) n.carbs_5oz = null;
    const NOT_VERIFIED = "Not verified: no published figure from the winery, the bottle or another verified source.";
    const cleaned = (data.checks || []).map((c) => (c.evidence === "estimate" || c.evidence === "typical")
      ? { ...c, status: "unknown", evidence: "none", detail: NOT_VERIFIED, origin: "No source found yet", source_url: "" }
      : c);
    const byId = Object.fromEntries(cleaned.map((c) => [c.id, c]));
    // #8 No added natural or artificial flavors: a published ingredient list
    // (winery, importer or the bottle's e-label) with no flavoring on it is a
    // pass; a flavoring on it is a fail; no list keeps the producer's own
    // statement or stays Not verified.
    {
      const ing = data.ingredients || {};
      const eu = data.eu_disclosure || {};
      const fromIng = ["winery", "importer", "elabel", "retailer"].includes(ing.source) && (ing.ingredients || []).length;
      const list = fromIng ? ing.ingredients : (eu.ingredients || []);
      if (list.length) {
        const who0 = fromIng ? ({ winery: "the winery", importer: "the importer", elabel: "the bottle's e-label", retailer: (() => { try { return new URL(ing.source_url).hostname.replace(/^www\./, ""); } catch { return "a retailer"; } })() })[ing.source] : "the European label";
        byId.ingredient_transparency = { id: "ingredient_transparency", status: "pass", evidence: fromIng && ing.source === "retailer" ? "retailer" : fromIng || (eu.source && eu.source.verified_elabel) ? "winery" : "third_party", scope: "this_wine",
          detail: `Full ingredient list published by ${who0}: ${list.join(", ")}.`, origin: `Ingredient list from ${who0}`, source_url: fromIng ? ing.source_url || "" : eu.source_url || "" };
        const url = fromIng ? ing.source_url || "" : eu.source_url || "";
        let shop = "";
        try { shop = new URL(ing.source_url || "").hostname.replace(/^www\./, ""); } catch {}
        const who = fromIng ? ({ winery: "the winery", importer: "the importer", elabel: "the bottle's e-label", retailer: shop || "a retailer" })[ing.source] : "the European label";
        const flav = list.filter((x) => /flavou?r|aroma(?!tic)|ar[oô]me|aromi|saborizante|aromastoff/i.test(x));
        const res = flav.length
          ? { status: "fail", evidence: "winery", detail: `Ingredient list from ${who} includes ${flav.join(", ")}.` }
          : { status: "pass", evidence: "winery", detail: `Ingredient list from ${who} shows no added natural or artificial flavors.` };
        // A European shop copy of the label (not the official e-label) is third party.
        if (!fromIng && !(eu.source && eu.source.verified_elabel)) res.evidence = "third_party";
        if (fromIng && ing.source === "retailer") res.evidence = "retailer";
        for (const id of ["no_artificial_flavors", "no_natural_flavors"]) {
          const cur = byId[id];
          if (cur && cur.status === "fail" && VERIFIED.includes(cur.evidence)) continue;
          byId[id] = { ...(cur || {}), id, scope: "this_wine", ...res, origin: `Ingredient list from ${who}`, source_url: url };
        }
      }
    }
    const checks = ALL_ITEMS.map((i) => ({ ...i, ...(byId[i.id] || { status: "unknown", evidence: "none", detail: "Not verified.", source_url: null }) }));
    if (!sugarVerified) {
      const c = checks.find((x) => x.id === "sugar_under_1g");
      if (c) Object.assign(c, { status: "unknown", evidence: "none", detail: "Unverified: no published sugar figure for this wine." });
    }
    // Calories and carbs worked out here from published ABV and sugar count as
    // an estimate, matching the Estimate tag shown on the stat cards.
    const fill = (id, text) => {
      const c = checks.find((x) => x.id === id);
      if (c && c.status === "unknown") Object.assign(c, { status: "pass", evidence: "estimate", scope: "this_wine", detail: text });
    };
    // Calories not published: calculate them from verified ABV and verified
    // sugar only. Shown as "Calculated", earns no points. Carbs and
    // ingredients are never calculated.
    if (n.calories_5oz == null && n.abv != null && n.residual_sugar_g_l != null && sugarVerified) {
      const sugarG = (n.residual_sugar_g_l * SERVING_ML) / 1000;
      n.calories_5oz = Math.round(SERVING_ML * (n.abv / 100) * 0.789 * 7 + sugarG * 4);
      est.calories = true;
      const c = checks.find((x) => x.id === "calories");
      const from = sc.evidence === "third_party" ? "the European label" : "the winery's tech sheet";
      if (c) Object.assign(c, { status: "pass", evidence: "calculated", scope: "this_wine",
        detail: `About ${n.calories_5oz} calories per 5 oz, calculated from ${from}: ${n.abv}% alcohol and ${n.residual_sugar_g_l} g/L sugar. Calculated, not published, so it earns no points.`,
        origin: `Calculated from ${from}`, source_url: sc.source_url || "" });
    }

    // WINE BABE SCORE (0-100): points only for VERIFIED passes against the
    // scored standards (the 11 Wine Babe standards), weighted. TRANSPARENCY (0-100%): how many of them have
    // enough evidence to decide pass or fail. Unknown is never a pass and
    // never a fail.
    const std = judgeStandards(byId, n, est);
    // The list shown on the result: the 12 scored standards, in order.
    const top = std.map((x, i) => ({ id: x.id, label: x.name, top: i + 1, status: x.state === "unverified" ? "unknown" : x.state,
      evidence: x.evidence, detail: x.basis || "Not verified.", origin: x.state === "unverified" ? "No source found yet" : x.origin, source_url: x.url, scope: x.scope }));
    const score = std.reduce((t, x) => t + (x.state === "pass" ? x.pts : 0), 0);
    const verifiedCount = std.filter((x) => x.state !== "unverified").length;
    const transparency = Math.round((verifiedCount / STANDARDS.length) * 100);
    const unverifiedCritical = std.filter((x) => x.critical && x.state === "unverified");
    let tier, blurb;
    if (unverifiedCritical.length) {
      tier = "Additional Verification Required";
      blurb = `Missing verified ${unverifiedCritical.map((x) => x.short).join(", ").replace(/, ([^,]*)$/, " and $1")}. The score only counts what has been verified.`;
    } else if (score >= 80) { tier = "Excellent Choice"; blurb = "Meets the Wine Babe standards, with verified evidence."; }
    else if (score >= 60) { tier = "Good Choice"; blurb = "Meets most Wine Babe standards, with verified evidence."; }
    else if (score >= 40) { tier = "Mixed"; blurb = "Meets some verified Wine Babe standards and misses others."; }
    else { tier = "Does not meet Wine Babe standards"; blurb = "Verified evidence shows it misses key standards."; }
    const known = std.filter((x) => x.state !== "unverified");
    const applicable = std;
    const verification = transparency;
    return { n, est, checks, score, top, tier, blurb, knownCount: known.length, applicableCount: applicable.length, verification, transparency, std };
  }

  // ---------- sulfites ----------
  // Wine Babe comparison scale on total SO2 (mg/L). Not a regulatory classification.
  const SO2_SCALE = [
    { max: 20, label: "Very low", short: "0–20", color: "#3f9d5c" },
    { max: 75, label: "Low", short: "21–75", color: "#7bb661" },
    { max: 125, label: "Moderate", short: "76–125", color: "#e2b93b" },
    { max: 200, label: "High", short: "126–200", color: "#e08a3c" },
    { max: Infinity, label: "Very high", short: "200+", color: "#c9493f" },
  ];
  function sulfiteRating(mgL) {
    if (mgL == null || isNaN(mgL)) return null;
    const band = SO2_SCALE.find((b) => mgL <= b.max);
    return { ...band, perGlass: (mgL * SERVING_ML) / 1000 };
  }

  // ---------- result ----------
  const MARK = { pass: "✓", fail: "✕", unknown: "?", na: "–" };

  function checkRow(c, showNum) {
    const url = safeUrl(c.source_url);
    return `<li class="check">
      <span class="dot ${c.status}" aria-label="${c.status}">${MARK[c.status] || "?"}</span>
      <div class="body">
        <div class="name">${showNum ? `<span class="num">${c.top}</span>` : ""}${esc(c.label)}
          ${c.status === "na" ? `<span class="chip none">Not applicable</span>` : `<span class="chip ${c.evidence}">${esc(EVIDENCE[c.evidence]?.label || "Not verified")}</span>`}
          ${SCOPE[c.scope] ? `<span class="chip scope">${SCOPE[c.scope]}</span>` : ""}</div>
        <div class="detail">${esc(c.detail)}${c.as_of ? ` <span class="asof">(${esc(c.as_of)})</span>` : ""}${c.origin || url ? `<div class="origin">${c.origin ? `From: ${esc(c.origin)}` : ""}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">Source</a>` : ""}</div>` : ""}</div>
      </div>
    </li>`;
  }

  // EU nutrition disclosure: search status and, when found, the verified
  // sugar figure with its original value, source and vintage.
  function euCard(eu) {
    if (!eu || !eu.applicable) return "";
    const done = eu.status === "completed";
    const src = eu.source;
    const url = src && safeUrl(src.url);
    const link = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(src.host)}</a>` : "";
    const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : "");
    const s = eu.sugar;
    const found = s || eu.calories || eu.carbs || (eu.ingredients || []).length;
    const qrNote = eu.qr && eu.qr.type === "undecoded"
      ? `<p class="eu__qrmsg">QR code detected — unable to decode. The nutrition information may still exist behind it; try a closer, sharper photo of the QR code.</p>`
      : eu.qr && eu.qr.type !== "nutrition"
      ? `<p class="eu__note">The bottle's QR code leads to ${eu.qr.type === "environmental" ? "a recycling / environmental page" : eu.qr.type === "marketing" ? "a winery marketing page" : "a page we couldn't read"}, not the nutritional e-label.</p>` : "";
    return `<div class="card eu">
      <div class="eu__head"><span class="lbl">EU Nutrition Search</span><span class="eu__status ${done ? "ok" : "warn"}">${done ? "Completed" : "Additional Verification Required"}</span></div>
      ${found && src ? `<div class="eu__src ${src.verified_elabel ? "verified" : ""}">${src.verified_elabel ? "✓ Verified European E-Label" : esc(src.type)}</div>` : ""}
      ${found ? `<dl class="eu__facts">
          ${s ? row("Sugar per 5 oz", `${s.upper_bound ? "Under " : ""}${fmt(s.per_5oz, 2)} g ${esc(s.kind)} <span class="eu__orig">(${esc(s.original)})</span>`) : row("Sugar", "Not on this source")}
          ${eu.carbs ? row("Carbs per 5 oz", `${fmt(eu.carbs.per_5oz, 1)} g <span class="eu__orig">(${esc(eu.carbs.original)} / 100 ml)</span>`) : ""}
          ${eu.calories ? row("Calories per 5 oz", `${fmt(eu.calories.per_5oz, 0)} <span class="eu__orig">(${esc(eu.calories.original)} / 100 ml)</span>`) : ""}
          ${eu.abv != null ? row("Alcohol", `${fmt(eu.abv, 1)}%`) : ""}
          ${(eu.ingredients || []).length ? row("Ingredients", esc(eu.ingredients.join(", "))) : ""}
          ${(eu.additives || []).length ? row("Additives", esc(eu.additives.join(", "))) : ""}
          ${(eu.allergens || []).length ? row("Allergens", esc(eu.allergens.join(", "))) : ""}
          ${row("Source", `${esc(src?.type || "")}${link ? ` · ${link}` : ""}`)}
          ${row("Vintage", src?.vintage_verified ? `${esc(src.vintage || "Matches this bottle")} ✓` : esc(src?.vintage ? `${src.vintage} (not this bottle's vintage)` : "Not shown on source"))}
          ${eu.calories?.origin ? row("Calories from", esc(eu.calories.origin)) : ""}
        </dl>`
        : `<p class="eu__none">${esc(eu.message || "European nutritional information not located online.")}</p>
           <label class="btn ghost eu__qr" for="photo">Upload a photo of the bottle's QR code</label>`}
      ${qrNote}
      <p class="eu__note">${esc(eu.note || "")}${eu.checked?.length ? ` Checked: ${esc(eu.checked.slice(0, 8).join(", "))}.` : ""}</p>
    </div>`;
  }


  function renderResult(data, isNew, savedAt) {
    // Not identified: no score or checklist, just what happened and what to try.
    if (!data.identified) {
      screens.result.innerHTML = `
        <div class="wine-head"><h1>We couldn't pin down this wine</h1></div>
        <div class="card summary"><p>${esc(data.summary || "We couldn't identify this wine.")}</p>
          <p style="margin-top:.6rem">Try again with the winery name first, for example <b>Le Contesse Pinot Noir Rosé</b>, or snap the front label.</p></div>
        <div class="actions">
          <label class="btn" for="photo">Scan a label</label>
          <button class="btn ghost" id="backHome">Search again</button>
        </div>`;
      $("#backHome").onclick = goHome;
      show("result");
      return;
    }
    const r = enrich(data);
    const w = data.wine || {};
    const n = r.n;
    if (isNew && data.identified) {
      saveHistory({ key: [w.producer, w.name, w.vintage].join("|").toLowerCase(), score: r.score, data, at: Date.now() });
    }

    const sugar = n.sugar_5oz;
    const typ = (n.typical && n.typical.fields) || [];
    const sugarCheck = r.checks.find((c) => c.id === "sugar_under_1g");
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    const tier = (id, label) => {
      const c = byId[id];
      return c && c.status === "pass"
        ? `<div class="tierline">✓ ${label} <span class="chip ${c.evidence}">${EVIDENCE[c.evidence].label}</span></div>` : "";
    };
    const sugarTiers = tier("zero_dosage", "Zero dosage") + tier("no_added_sugar", "No sugar added");
    const sulfite = n.total_so2_mg_l != null ? `${fmt(n.total_so2_mg_l, 0)}` : null;
    const so2 = sulfiteRating(n.total_so2_mg_l);
    const circ = 2 * Math.PI * 42;
    const vintageNote =
      w.tech_sheet_vintage && w.vintage && w.tech_sheet_vintage !== w.vintage
        ? `<p class="notice">Tech sheet is for the ${esc(w.tech_sheet_vintage)} vintage. Numbers can change year to year.</p>`
        : "";

    const stat = (v, unit, k, ev) =>
      `<div class="stat"><div class="v">${v == null ? "—" : esc(v) + (unit ? ` <small>${unit}</small>` : "")}</div>
       <div class="k">${k}</div>${ev ? `<div class="e"><span class="chip ${ev}">${EVIDENCE[ev].label}</span></div>` : ""}</div>`;

    const sources = (data.sources || []).map((s) => ({ ...s, url: safeUrl(s.url) })).filter((s) => s.url);
    const techUrl = safeUrl(w.tech_sheet_url);
    const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const rescanBtn = `<button type="button" class="btn small" id="rescan">Rescan for new info</button>`;
    const b = data.brain || {};
    const savedNote = !isNew
      ? `<div class="saved-note">Saved scan${savedAt ? ` from ${when(savedAt)}` : ""}. Rescan to look for anything new. ${rescanBtn}</div>`
      : data.cached
      ? `<div class="saved-note">Pulled from our shared wine brain${b.updated_at ? `, last researched ${when(b.updated_at)}` : ""}${b.scans > 1 ? ` (researched ${b.scans} times)` : ""}. Rescan to look for anything new. ${rescanBtn}</div>`
      : b.rescan
      ? `<div class="saved-note">${b.added ? `Rescan found ${b.added} new fact${b.added === 1 ? "" : "s"}, added to the shared wine brain.` : "Rescan done. Nothing new found this time; everything already known is kept."}</div>`
      : "";

    screens.result.innerHTML = `
      <div class="wine-head">
        ${data.demo ? `<span class="demo-tag">Demo</span>` : ""}
        ${w.producer ? `<p class="producer">${esc(w.producer)}</p>` : ""}
        <h1>${esc(w.name || (data.identified ? "Unnamed wine" : "We couldn't read that label"))}</h1>
        <p class="meta">${esc([w.vintage, w.grapes, [w.region, w.country].filter(Boolean).join(", ")].filter(Boolean).join(" · "))}</p>
      </div>

      ${savedNote}
      <div class="card score">
        <div class="score-head">
          <span class="score-title">Transparency Scanner<span class="score-slogan">Know what's in your glass</span></span>
          <button type="button" class="info-btn" aria-label="See the score breakdown" aria-expanded="false" aria-controls="scoreInfo">i</button>
        </div>
        <div class="score-info" id="scoreInfo" role="dialog" aria-label="Transparency Scanner breakdown" hidden>
          <p><b>Score breakdown</b> · ${r.score} / 100 points · Transparency ${r.transparency}%</p>
          <ul class="std-list">
            ${r.std.map((x) => `<li class="std ${x.state}">
              <div class="std__top"><span class="std__mark">${x.state === "pass" ? "✓" : x.state === "fail" ? "✕" : "?"}</span>
                <span class="std__name">${esc(x.name)}</span>
                <span class="std__pts">${x.state === "pass" ? x.pts : 0} / ${x.pts}</span></div>
              <div class="std__state">${x.state === "pass" ? "Verified pass" : x.state === "fail" ? "Verified fail" : "Not verified (no points, not a failure)"}</div>
              ${x.basis ? `<div class="std__basis">${esc(x.basis)}${x.origin ? ` · ${esc(x.origin)}` : ""}${safeUrl(x.url) ? ` · <a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener">Source</a>` : ""}</div>` : ""}
              <div class="std__rule">${esc(x.rule)}</div>
            </li>`).join("")}
          </ul>
          <p class="std__foot">Points are only awarded for verified evidence. "Not verified" means the information could not be found yet, not that the wine fails. Scores update when new verified information (EU QR code, winery site, tech sheet, certification) is found.</p>
          <button type="button" class="info-close">Got it</button>
        </div>
        <div class="score-body">
          <button type="button" class="ring info-btn" aria-label="See the score breakdown" aria-controls="scoreInfo">
            <svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="42" /><circle class="fg" cx="50" cy="50" r="42"
              stroke-dasharray="${circ}" stroke-dashoffset="${circ}" data-to="${circ * (1 - (r.score ?? 0) / 100)}" /></svg>
            <b>${r.score}</b>
          </button>
          <div><p class="tier">${esc(r.tier)}</p><p>${esc(r.blurb)}</p>
            <p class="verif"><b>Transparency: ${r.transparency}%</b> · ${r.knownCount} of ${r.applicableCount} standards verified</p>
            <p class="tap-hint">Tap the score for the full breakdown.</p></div>
        </div>
      </div>

      <div class="card sugar">
        <div>
          <div class="lbl">Sugar per 5 oz</div>
          <div class="big">${sugar != null ? `${fmt(sugar, 1)}<small> g</small>` : n.sugar_below_5oz != null ? `&lt;${fmt(n.sugar_below_5oz, 1)}<small> g</small>` : "—"}</div>
        </div>
        <div>
          <div class="verdict ${sugar == null ? (n.sugar_below_5oz != null && n.sugar_below_5oz <= 1.0001 ? "ok" : "") : Math.round(sugar * 100) / 100 <= 1 ? "ok" : "no"}">
            ${sugar == null && n.sugar_below_5oz != null ? (n.sugar_below_5oz <= 1.0001 ? "1 g or less. Skinny sip approved." : `Under ${fmt(n.sugar_below_5oz, 1)} g per glass`) : sugar == null ? "Unverified" : typ.includes("sugar") ? (sugar < 1 ? "Likely under 1 g per glass" : "Likely over 1 g per glass") : Math.round(sugar * 100) / 100 <= 1 ? "1 g or less. Skinny sip approved." : "Over 1 g per glass"}
          </div>
          <div class="detail" style="font-size:.82rem;color:var(--muted)">
            ${data.eu_disclosure?.sugar ? `${esc(data.eu_disclosure.sugar.original)} (${esc(data.eu_disclosure.sugar.kind)})` : n.residual_sugar_g_l != null ? `${fmt(n.residual_sugar_g_l, 1)} g/L residual sugar` : n.sugar_below_g_l != null ? `Under ${fmt(n.sugar_below_g_l, 1)} g/L residual sugar` : ""}
            ${sugar == null && n.sugar_below_5oz == null ? (data.eu_disclosure?.applicable ? esc(sugarCheck?.detail || "Not yet verified — EU nutritional disclosure search completed.") : "The winery hasn't published a sugar figure we can verify.") : sugarCheck ? ` <span class="chip ${sugarCheck.evidence}">${EVIDENCE[sugarCheck.evidence].label}</span>` : ""}
          </div>
          ${sugarTiers}

        </div>
      </div>

      ${euCard(data.eu_disclosure)}

      <div class="stats">
        ${stat(n.calories_5oz != null ? fmt(n.calories_5oz, 0) : null, "", "Calories per 5 oz", r.est.calories ? "calculated" : n.calories_5oz != null ? "verified" : null)}
        ${stat(n.carbs_5oz != null ? fmt(n.carbs_5oz, 1) : null, "g", "Carbs per 5 oz", n.carbs_5oz != null ? "verified" : null)}
        ${stat(n.abv != null ? fmt(n.abv, 1) : null, "%", "Alcohol (ABV)", n.abv != null ? "verified" : null)}
      </div>
      ${typ.length ? `<p class="typical-note">This wine doesn't publish full specs, so ${typ.map((f) => ({ sugar: "sugar", abv: "alcohol", so2: "sulfites" })[f]).join(", ").replace(/, ([^,]*)$/, " and $1")} ${typ.length > 1 ? "are" : "is"} typical for a ${esc(n.typical.style)} and calories and carbs are worked out from those. Treat them as estimates.</p>` : ""}

      <div class="card so2">
        <div class="so2__top">
          <div>
            <div class="lbl">Sulfites</div>
            <div class="so2__val">${sulfite == null ? "?" : `${sulfite} <small>mg/L</small>`}</div>
            <div class="so2__sub">${typ.includes("so2") ? `<span class="chip typical">Typical for type</span> ` : ""}${so2 ? `About ${fmt(so2.perGlass, 0)} mg per 5 oz glass` : "No published sulfite level found"}${n.free_so2_mg_l != null ? ` · free ${fmt(n.free_so2_mg_l, 0)} mg/L` : ""}</div>
          </div>
          ${so2 ? `<span class="so2__pill" style="--c:${so2.color}">${so2.label}</span>` : ""}
        </div>
        <div class="so2__scale" aria-hidden="true">
          ${SO2_SCALE.map((b) => `<span style="--c:${b.color}" class="${so2 && so2.label === b.label ? "on" : ""}"><i></i>${b.short}</span>`).join("")}
        </div>
      </div>

      <div class="block">
        <h2>The Wine Babe 11</h2>
        <div class="card"><ul class="checks">${r.top.map((c) => checkRow(c, true)).join("")}</ul></div>
      </div>

      ${ingredientsCard(data.ingredients)}

      ${ratingsCard(data.ratings, w.vintage)}

      ${tastingCard(data.tasting, data.ratings)}

      <div class="card summary"><p>${esc(data.summary)}</p>${vintageNote}
        ${techUrl ? `<p style="margin-top:.6rem"><a href="${esc(techUrl)}" target="_blank" rel="noopener">Open the tech sheet</a></p>` : ""}
      </div>

      <div class="block">
        <h2>Full checklist</h2>
        ${CHECKLIST.map((cat) => {
          const items = r.checks.filter((c) => c.category === cat.id);
          const ok = items.filter((c) => c.status === "pass").length;
          const total = items.filter((c) => c.status !== "na").length;
          return `<details class="cat"><summary><span>${cat.icon}</span>${esc(cat.title)}<span class="count">${ok}/${total}</span></summary>
            <ul class="checks">${items.map((c) => checkRow(c, false)).join("")}</ul></details>`;
        }).join("")}
        <div class="legend">${Object.entries(EVIDENCE).map(([k, v]) => `<span class="chip ${k}">${v.label}</span>`).join("")}</div>
      </div>

      ${sources.length ? `<div class="block"><h2>Sources</h2><ol class="sources">${sources
        .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a></li>`)
        .join("")}</ol></div>` : ""}

      <div class="actions">
        <label class="btn" for="photo">Scan another bottle</label>
        <button class="btn ghost" id="backHome">Home</button>
      </div>
      <p class="fine">The Transparency Scanner shows how a wine measures up to our standards based on published information. It is not medical advice. Sulfite ratings are a Wine Babe comparison scale, not a regulatory classification. Results can vary by vintage.</p>
    `;
    $("#backHome").onclick = goHome;
    const rb = $("#rescan");
    if (rb) rb.onclick = () => scan({ query: [w.producer, w.name, w.vintage].filter(Boolean).join(" "), fresh: true }, null);
    show("result");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const fg = screens.result.querySelector(".ring .fg");
        if (fg) fg.style.strokeDashoffset = fg.dataset.to;
      })
    );
  }

  // Ingredient list: published (e-label, winery, importer) or typical for the style.
  function ingredientsCard(ing) {
    if (!ing) return "";
    // Typical lists are never shown: only a published list, or Not verified.
    if (ing.source === "typical" || ing.source === "none" || !Array.isArray(ing.ingredients) || !ing.ingredients.length) {
      return `<div class="card ingredients"><div class="lbl">Ingredients <span class="chip none">Not verified</span></div>
        <p class="ing-src">No ingredient list from the winery, the bottle's e-label or the importer was found yet.</p></div>`;
    }
    const typical = false;
    let host = "";
    try { host = ing.source_url ? new URL(ing.source_url).hostname.replace(/^www\./, "") : ""; } catch {}
    const from = { winery: "the winery", importer: "the importer", elabel: "the bottle's e-label", retailer: "a retailer listing" }[ing.source] || "";
    return `<div class="card ingredients">
      <div class="lbl">Ingredients ${typical ? `<span class="chip typical">Typical for type</span>` : ""}</div>
      <ul class="ing-list">${ing.ingredients.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <p class="ing-src">${typical
        ? `No ingredient list is published for this wine, so these are typical for a ${esc(ing.style || "wine of this type")}.`
        : `Listed by ${from}${host ? `: <a href="${esc(ing.source_url)}" target="_blank" rel="noopener">${esc(host)}</a>` : ""}.`}</p>
    </div>`;
  }

  // Professional critic ratings (Wine Enthusiast, Wine Spectator, Decanter ...).
  // Older results have no ratings field, so the card is skipped for them.
  function ratingsCard(ratings, vintage) {
    if (!Array.isArray(ratings) || !ratings.length) return "";
    const want = String(vintage || "").trim();
    const rows = ratings.map((x) => {
      const other = want && /^\d{4}$/.test(want) && x.vintage && x.vintage !== want;
      const pub = x.source_url ? `<a href="${esc(x.source_url)}" target="_blank" rel="noopener">${esc(x.publication)}</a>` : esc(x.publication);
      return `<li${other ? ' class="other"' : ""}>
        <span class="r-vin">${esc(x.vintage || "–")}</span>
        <span class="r-pub">${pub}${other ? ' <small>other vintage</small>' : ""}</span>
        <span class="r-score"><span aria-hidden="true">★</span> ${esc(fmt(x.score, 1))}<small>/${x.scale}</small></span>
      </li>`;
    }).join("");
    return `<div class="card ratings">
      <div class="lbl">Professional ratings</div>
      ${ratings.length
        ? `<ul class="rating-list">${rows}</ul><p class="r-note">Scores from wine critics, not shoppers. A score is for the vintage shown; other vintages can differ.</p>`
        : `<p class="r-none">No professional critic ratings found for this wine.</p>`}
    </div>`;
  }

  // Winery tasting notes. Older results have neither ratings nor tasting, so skip the card for them.
  function tastingCard(t, ratings) {
    if (t === undefined && !Array.isArray(ratings)) return "";
    if (!t || t.source === "typical" || t.source === "none") {
      return `<div class="card tasting"><div class="lbl">Tasting notes <span class="chip none">Not verified</span></div>
        <p class="t-src">The winery and importer haven't published tasting notes for this wine.</p></div>`;
    }
    let host = "";
    try { host = t.source_url ? new URL(t.source_url).hostname.replace(/^www\./, "") : ""; } catch {}
    return `<div class="card tasting">
      <div class="lbl">${t.source === "typical" ? `Typical tasting notes${t.style ? ` for a ${esc(t.style)}` : ""}` : `Tasting notes from the ${t.source === "importer" ? "importer" : "winery"}`}</div>
      ${t.source === "typical" ? `<p class="t-src">The winery hasn't published notes, so these describe a typical wine of this type.</p>` : ""}
      ${t.flavors?.length ? `<div class="t-flavors">${t.flavors.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
      ${t.notes ? `<p class="t-notes">${esc(t.notes)}</p>` : ""}
      ${t.pairings?.length ? `<div class="t-pair"><div class="t-pair-h">🍽️ Pairs well with</div><ul>${t.pairings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      ${host ? `<p class="t-src">Source: <a href="${esc(t.source_url)}" target="_blank" rel="noopener">${esc(host)}</a></p>` : ""}
    </div>`;
  }

  function goHome() {
    renderRecent();
    show("home");
  }

  $("#homeBtn").addEventListener("click", goHome);

  // Transparency Scanner info pop up: the ⓘ button toggles it; Got it, Escape or a tap outside closes it.
  const scoreInfo = (open) => {
    const box = screens.result.querySelector(".score-info");
    const btn = screens.result.querySelector(".info-btn");
    if (!box || !btn) return;
    box.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  screens.result.addEventListener("click", (ev) => {
    if (ev.target.closest(".info-btn")) {
      scoreInfo(screens.result.querySelector(".score-info")?.hidden);
    } else if (ev.target.closest(".info-close") || !ev.target.closest(".score-info")) {
      scoreInfo(false);
    }
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") scoreInfo(false); });

  fetch("/api/health").then((r) => r.json()).then((h) => { $("#demoNote").hidden = h.live; }).catch(() => {});
  renderRecent();
  loadTopPours();
  // Which deploy this page is running, so updates are easy to confirm.
  const v = window.WB_VERSION;
  if (v && v.at) $("#appVersion").textContent = `Version ${v.ref} · updated ${new Date(v.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;

  // Always run the latest version: ask the server which version is live and
  // reload when this page is older. Checked on open, when the app comes back
  // to the screen, and every few minutes. Never during a scan.
  async function checkForUpdate() {
    if (!v || !v.ref || v.ref === "dev" || screens.scanning.classList.contains("is-active")) return;
    try {
      const txt = await (await fetch(`/version.js?check=${Date.now()}`, { cache: "no-store" })).text();
      const live = (txt.match(/"ref":"([^"]+)"/) || [])[1];
      if (live && live !== v.ref && !screens.scanning.classList.contains("is-active")) location.reload();
    } catch {}
  }
  checkForUpdate();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
  setInterval(checkForUpdate, 5 * 60 * 1000);
})();
