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
  function shrink(file, max = 1600) {
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
        resolve(c.toDataURL("image/jpeg", 0.85));
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

  $("#photo").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await shrink(file);
      scan({ image: dataUrl, mediaType: "image/jpeg" }, dataUrl);
    } catch (err) {
      alert(err.message);
    }
  });

  $("#searchForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = $("#query").value.trim();
    if (q) scan({ query: q }, null);
  });

  // ---------- scoring ----------
  function enrich(data) {
    const n = { ...data.nutrition };
    const est = {};
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
    // Calories and carbs worked out here from published ABV and sugar count as
    // an estimate, matching the Estimate tag shown on the stat cards.
    const fill = (id, text) => {
      const c = checks.find((x) => x.id === id);
      if (c && c.status === "unknown") Object.assign(c, { status: "pass", evidence: "estimate", scope: "this_wine", detail: text });
    };
    if (est.calories) fill("calories", `About ${Math.round(n.calories_5oz)} calories per 5 oz, calculated from the published alcohol and sugar.`);
    if (est.carbs) fill("carbs", `About ${n.carbs_5oz.toFixed(1)} g carbs per 5 oz, calculated from the published sugar.`);

    // Wine Babe score: how well the wine meets the Wine Babe top 10, judged on
    // what is actually known. 70% is how the known items measure up (a pass
    // counts by how solid its source is, a fail counts zero), 30% is how many
    // of the applicable top 10 are known at all. Items nobody publishes don't
    // drag a good wine down to zero.
    const top = checks.filter((c) => c.top).sort((a, b) => a.top - b.top);
    const POINTS = { lab: 1, certified: 1, winery: 0.9, estimate: 0.7 };
    const applicable = top.filter((c) => c.status !== "na");
    const known = applicable.filter((c) => c.status === "pass" || c.status === "fail");
    let score = null;
    if (known.length) {
      const quality = known.reduce((t, c) => t + (c.status === "pass" ? POINTS[c.evidence] ?? 0.5 : 0), 0) / known.length;
      const coverage = known.length / applicable.length;
      score = Math.round(100 * (0.7 * quality + 0.3 * coverage));
    }
    let tier, blurb;
    if (known.length < 3) { tier = "Not enough info yet"; blurb = "Too little is published about this wine to score it fairly."; }
    else if (score >= 80) { tier = "Wine Babe approved"; blurb = "Meets the Wine Babe standards, backed by solid sources."; }
    else if (score >= 60) { tier = "Good choice"; blurb = "Meets most of the Wine Babe standards that could be checked."; }
    else if (score >= 40) { tier = "Mixed"; blurb = "Meets some Wine Babe standards and misses others."; }
    else { tier = "Doesn't measure up"; blurb = "Misses key Wine Babe standards."; }
    return { n, est, checks, score, top, tier, blurb, knownCount: known.length, applicableCount: applicable.length };
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
        <div class="detail">${esc(c.detail)}${c.as_of ? ` <span class="asof">(${esc(c.as_of)})</span>` : ""}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">Source</a>` : ""}</div>
      </div>
    </li>`;
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
          <button type="button" class="info-btn" aria-label="What is the Wine Babe score?" aria-expanded="false" aria-controls="scoreInfo">i</button>
        </div>
        <div class="score-info" id="scoreInfo" role="dialog" aria-label="About the Wine Babe score" hidden>
          <p><b>What the Wine Babe score means</b></p>
          <p>The score, from 0 to 100, shows how well this wine meets the Wine Babe top 10: low sugar, no added sugar, non GMO, vegan, organic, no artificial flavors, hand harvested, sustainable, sulfite transparency and calories.</p>
          <p>Most of the score (70%) is how the items we could check measure up:</p>
          <ul>
            <li>Meets it, with a lab report or certification: full credit</li>
            <li>Meets it, per the winery: nearly full credit</li>
            <li>Meets it, by our estimate: most of the credit</li>
            <li>Doesn't meet it (for example over 1 g sugar per glass): no credit</li>
          </ul>
          <p>The rest (30%) is how much of the top 10 we could check. Items that don't apply, like dosage on a still wine, are left out. If fewer than 3 items can be checked, we say so instead of guessing.</p>
          <p>This wine: ${r.knownCount} of ${r.applicableCount} top 10 items checked.</p>
          <button type="button" class="info-close">Got it</button>
        </div>
        <div class="score-body">
          <div class="ring">
            <svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="42" /><circle class="fg" cx="50" cy="50" r="42"
              stroke-dasharray="${circ}" stroke-dashoffset="${circ}" data-to="${circ * (1 - (r.score ?? 0) / 100)}" /></svg>
            <b>${r.score ?? "—"}</b>
          </div>
          <div><p class="tier">${r.tier}</p><p>${r.blurb}</p></div>
        </div>
      </div>

      <div class="card sugar">
        <div>
          <div class="lbl">Sugar per 5 oz</div>
          <div class="big">${sugar == null ? "?" : fmt(sugar, 1)}<small> g</small></div>
        </div>
        <div>
          <div class="verdict ${sugar == null ? "" : sugar < 1 ? "ok" : "no"}">
            ${sugar == null ? "No lab number found" : sugar < 1 ? "Under 1 g. Skinny sip approved." : "Over 1 g per glass"}
          </div>
          <div class="detail" style="font-size:.82rem;color:var(--muted)">
            ${n.residual_sugar_g_l != null ? `${fmt(n.residual_sugar_g_l, 1)} g/L residual sugar` : ""}
            ${sugarCheck ? ` <span class="chip ${sugarCheck.evidence}">${EVIDENCE[sugarCheck.evidence].label}</span>` : ""}
          </div>
          ${sugarTiers}
        </div>
      </div>

      <div class="stats">
        ${stat(n.calories_5oz != null ? fmt(n.calories_5oz, 0) : null, "", "Calories per 5 oz", r.est.calories ? "estimate" : null)}
        ${stat(n.carbs_5oz != null ? fmt(n.carbs_5oz, 1) : null, "g", "Carbs per 5 oz", r.est.carbs ? "estimate" : null)}
        ${stat(n.abv != null ? fmt(n.abv, 1) : null, "%", "Alcohol (ABV)")}
      </div>

      <div class="card so2">
        <div class="so2__top">
          <div>
            <div class="lbl">Sulfites</div>
            <div class="so2__val">${sulfite == null ? "?" : `${sulfite} <small>mg/L</small>`}</div>
            <div class="so2__sub">${so2 ? `About ${fmt(so2.perGlass, 0)} mg per 5 oz glass` : "No published sulfite level found"}${n.free_so2_mg_l != null ? ` · free ${fmt(n.free_so2_mg_l, 0)} mg/L` : ""}</div>
          </div>
          ${so2 ? `<span class="so2__pill" style="--c:${so2.color}">${so2.label}</span>` : ""}
        </div>
        <div class="so2__scale" aria-hidden="true">
          ${SO2_SCALE.map((b) => `<span style="--c:${b.color}" class="${so2 && so2.label === b.label ? "on" : ""}"><i></i>${b.short}</span>`).join("")}
        </div>
      </div>

      ${ratingsCard(data.ratings, w.vintage)}

      ${tastingCard(data.tasting, data.ratings)}

      <div class="card summary"><p>${esc(data.summary)}</p>${vintageNote}
        ${techUrl ? `<p style="margin-top:.6rem"><a href="${esc(techUrl)}" target="_blank" rel="noopener">Open the tech sheet</a></p>` : ""}
      </div>

      <div class="block">
        <h2>The Wine Babe top 10</h2>
        <div class="card"><ul class="checks">${r.top.map((c) => checkRow(c, true)).join("")}</ul></div>
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

  // Professional critic ratings (Wine Enthusiast, Wine Spectator, Decanter ...).
  // Older results have no ratings field, so the card is skipped for them.
  function ratingsCard(ratings, vintage) {
    if (!Array.isArray(ratings)) return "";
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
    if (!t) return `<div class="card tasting"><div class="lbl">Tasting notes</div><p class="t-none">The winery hasn't published tasting notes for this wine.</p></div>`;
    let host = "";
    try { host = t.source_url ? new URL(t.source_url).hostname.replace(/^www\./, "") : ""; } catch {}
    return `<div class="card tasting">
      <div class="lbl">Tasting notes from the ${t.source === "importer" ? "importer" : "winery"}</div>
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
