/* Wine Babe scanner front end. Needs checklist.js loaded first. */
(() => {
  const $ = (s) => document.querySelector(s);
  const screens = { home: $("#home"), scanning: $("#scanning"), result: $("#result") };
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
    } catch (err) {
      const box = document.createElement("div");
      box.className = "error-box";
      box.innerHTML = `${esc(err.message)}<div class="actions"><button class="btn" id="errBack">Try again</button></div>`;
      $("#feed").after(box);
      $("#scanTitle").textContent = "That didn't work";
      $("#errBack").onclick = () => { box.remove(); goHome(); };
    }
  }

  const onPhoto = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await shrink(file);
      scan({ image: dataUrl, mediaType: "image/jpeg" }, dataUrl);
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
  const VERIFIED_EVIDENCE = ["lab", "certified", "winery", "third_party"];
  const STANDARDS = [
    { id: "sugar_under_1g", pts: 20, critical: true, short: "sugar", name: "Less than 1 g sugar per 5 oz",
      rule: "Pass: verified sugar under 1 g per 5 oz (147.87 ml), from a lab sheet, the bottle or EU e-label, the winery, or a European copy of the EU label for the same vintage. Fail: verified 1 g or more." },
    { id: "no_added_sugar", pts: 15, critical: true, short: "no added sugar (ingredients)", name: "No added sugar",
      rule: "Pass: the producer explicitly states no sugar is added. Fail: verified dosage sugar or sugar / sweetener added to sweeten the wine. Neutral: sugar used and consumed during fermentation (tirage) and concentrated must with no stated purpose. Low residual sugar or zero dosage alone never passes." },
    { id: "no_artificial_flavors", pts: 15, critical: true, short: "no artificial flavors (ingredients)", name: "No artificial flavors",
      rule: "Pass: the producer states no flavourings are added. Fail: the ingredient list or producer shows a flavouring." },
    { id: "sulfites", pts: 10, short: "sulfite level", name: "Sulfite transparency",
      rule: "Pass: a verified source publishes the total sulfite level (mg/L). 'Contains sulphites' alone is a legal minimum and does not pass. No published level: not verified." },
    { id: "calories", pts: 10, short: "calories", name: "Calories per 5 oz",
      rule: `Pass: verified ${CALORIE_MAX} calories or less per 5 oz (bottle or EU label, winery, lab). Fail: verified over ${CALORIE_MAX}. Calculated estimates do not count.` },
    { id: "organic", pts: 10, short: "organic", name: "Organic grapes",
      rule: "Pass: organic certification (EU leaf, AB, control body code on the bottle, certifier) or the producer documents organic grapes. Fail: verified non-organic." },
    { id: "non_gmo", pts: 5, short: "non GMO", name: "Non GMO", rule: "Pass: the producer states non GMO (e.g. NO OGM on the tech sheet) or a certifier does." },
    { id: "vegan", pts: 5, short: "vegan", name: "Vegan friendly", rule: "Pass: the producer states no animal products (directly or via Barnivore). Fail: animal fining agents declared." },
    { id: "hand_harvested", pts: 5, short: "hand harvest", name: "Hand harvested grapes", rule: "Pass: the producer states the grapes are hand picked." },
    { id: "sustainable", pts: 5, short: "sustainable farming", name: "Sustainable farming", rule: "Pass: a sustainability certification or the producer's documented practices." },
  ];

  // Decide each standard: "pass", "fail" or "unverified", with the evidence used.
  function judgeStandards(byId, n, est) {
    return STANDARDS.map((s) => {
      const c = byId[s.id];
      const verified = c && (c.status === "pass" || c.status === "fail") && VERIFIED_EVIDENCE.includes(c.evidence);
      let state = verified ? c.status : "unverified";
      let basis = c?.detail || "";
      if (s.id === "calories") {
        const cal = n.calories_5oz;
        if (verified && cal != null && !est.calories) { state = cal <= CALORIE_MAX ? "pass" : "fail"; basis = `${Math.round(cal)} calories per 5 oz. ${c.detail || ""}`; }
        else { state = "unverified"; basis = cal != null ? `About ${Math.round(cal)} calories per 5 oz, an estimate only.` : "No verified calorie figure."; }
      }
      if (s.id === "sulfites") {
        const typicalSo2 = (n.typical?.fields || []).includes("so2");
        const so2Verified = n.total_so2_mg_l != null && !typicalSo2 && verified;
        state = so2Verified ? "pass" : "unverified";
        basis = so2Verified ? `Total sulfites ${Math.round(n.total_so2_mg_l)} mg/L published. ${c?.detail || ""}` : "No published total sulfite level.";
      }
      return { ...s, state, basis: String(basis).trim(), origin: c?.origin || "", url: c?.source_url || "", evidence: c?.evidence || "none" };
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
    if (n.calories_5oz == null && n.abv != null) {
      n.calories_5oz = SERVING_ML * (n.abv / 100) * 0.789 * 7 + (n.sugar_5oz || 0) * 4;
      est.calories = true;
    }
    if (n.carbs_5oz == null && n.sugar_5oz != null) {
      n.carbs_5oz = n.sugar_5oz + 0.5;
      est.carbs = true;
    }
    const byId = Object.fromEntries((data.checks || []).map((c) => [c.id, c]));
    const checks = ALL_ITEMS.map((i) => ({ ...i, ...(byId[i.id] || { status: "unknown", evidence: "none", detail: "Not checked.", source_url: null }) }));
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
    if (est.calories) fill("calories", `About ${Math.round(n.calories_5oz)} calories per 5 oz, calculated from the published alcohol and sugar.`);
    if (est.carbs) fill("carbs", `About ${n.carbs_5oz.toFixed(1)} g carbs per 5 oz, calculated from the published sugar.`);

    // WINE BABE SCORE (0-100): points only for VERIFIED passes against the
    // 10 standards, weighted. TRANSPARENCY (0-100%): how many of the 10 have
    // enough evidence to decide pass or fail. Unknown is never a pass and
    // never a fail.
    const top = checks.filter((c) => c.top).sort((a, b) => a.top - b.top);
    const std = judgeStandards(byId, n, est);
    const score = std.reduce((t, x) => t + (x.state === "pass" ? x.pts : 0), 0);
    const verifiedCount = std.filter((x) => x.state !== "unverified").length;
    const transparency = verifiedCount * 10;
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
    const savedNote = isNew ? "" : `<div class="saved-note">Saved scan${savedAt ? ` from ${new Date(savedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}. Rescan to get the latest results. <button type="button" class="btn small" id="rescan">Rescan for the latest</button></div>`;

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
          <span class="score-title">Wine Babe score</span>
          <button type="button" class="info-btn" aria-label="See the score breakdown" aria-expanded="false" aria-controls="scoreInfo">i</button>
        </div>
        <div class="score-info" id="scoreInfo" role="dialog" aria-label="Wine Babe score breakdown" hidden>
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
            <p class="verif"><b>Transparency: ${r.transparency}%</b> · ${r.knownCount} of 10 standards verified</p>
            <p class="tap-hint">Tap the score for the full breakdown.</p></div>
        </div>
      </div>

      <div class="card sugar">
        <div>
          <div class="lbl">Sugar per 5 oz</div>
          <div class="big">${sugar != null ? `${fmt(sugar, 1)}<small> g</small>` : n.sugar_below_5oz != null ? `&lt;${fmt(n.sugar_below_5oz, 1)}<small> g</small>` : "—"}</div>
        </div>
        <div>
          <div class="verdict ${sugar == null ? (n.sugar_below_5oz != null && n.sugar_below_5oz < 1 ? "ok" : "") : sugar < 1 ? "ok" : "no"}">
            ${sugar == null && n.sugar_below_5oz != null ? (n.sugar_below_5oz < 1 ? "Under 1 g. Skinny sip approved." : `Under ${fmt(n.sugar_below_5oz, 1)} g per glass`) : sugar == null ? "Unverified" : typ.includes("sugar") ? (sugar < 1 ? "Likely under 1 g per glass" : "Likely over 1 g per glass") : sugar < 1 ? "Under 1 g. Skinny sip approved." : "Over 1 g per glass"}
          </div>
          <div class="detail" style="font-size:.82rem;color:var(--muted)">
            ${data.eu_disclosure?.sugar ? `${esc(data.eu_disclosure.sugar.original)} (${esc(data.eu_disclosure.sugar.kind)})` : n.residual_sugar_g_l != null ? `${fmt(n.residual_sugar_g_l, 1)} g/L residual sugar` : n.sugar_below_g_l != null ? `Under ${fmt(n.sugar_below_g_l, 1)} g/L residual sugar` : ""}
            ${sugar == null && n.sugar_below_5oz == null ? (data.eu_disclosure?.applicable ? esc(sugarCheck?.detail || "Not yet verified — EU nutritional disclosure search completed.") : "The winery hasn't published a sugar figure we can verify.") : sugarCheck ? ` <span class="chip ${sugarCheck.evidence}">${EVIDENCE[sugarCheck.evidence].label}</span>` : ""}
          </div>
          ${sugarTiers}
          ${sugarProfileHtml(data.sugar_profile)}
        </div>
      </div>

      ${euCard(data.eu_disclosure)}

      <div class="stats">
        ${stat(n.calories_5oz != null ? fmt(n.calories_5oz, 0) : null, "", "Calories per 5 oz", r.est.calories || byId.calories?.evidence === "estimate" ? "estimate" : null)}
        ${stat(n.carbs_5oz != null ? fmt(n.carbs_5oz, 1) : null, "g", "Carbs per 5 oz", r.est.carbs || byId.carbs?.evidence === "estimate" ? "estimate" : null)}
        ${stat(n.abv != null ? fmt(n.abv, 1) : null, "%", "Alcohol (ABV)", typ.includes("abv") ? "typical" : null)}
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
        <h2>The Wine Babe top 10</h2>
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
      <p class="fine">The Wine Babe score shows how a wine measures up to the Wine Babe standards based on published information. It is not medical advice. Sulfite ratings are a Wine Babe comparison scale, not a regulatory classification. Results can vary by vintage.</p>
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
    if (!ing || !Array.isArray(ing.ingredients) || !ing.ingredients.length) return "";
    const typical = ing.source === "typical";
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
    if (!t) return "";
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

  // Wine Babe score info pop up: the ⓘ button toggles it; Got it, Escape or a tap outside closes it.
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
  // Which deploy this page is running, so updates are easy to confirm.
  const v = window.WB_VERSION;
  if (v && v.at) $("#appVersion").textContent = `Version ${v.ref} · updated ${new Date(v.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
})();
