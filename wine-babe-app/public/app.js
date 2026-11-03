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
          <span class="mini-score">${e.score}</span>
          <span><span class="r-name">${esc(e.data.wine.name || "Unknown wine")}</span><br />
          <span class="r-sub">${esc([e.data.wine.producer, e.data.wine.vintage].filter(Boolean).join(" · "))}</span></span>
        </button></li>`
      )
      .join("");
  }
  $("#recentList").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-i]");
    if (b) renderResult(loadHistory()[+b.dataset.i].data, false);
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

      // Poll for progress until the job is done (a few minutes, cap at 8).
      let seen = 0, misses = 0, job = null;
      const deadline = Date.now() + 8 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
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

    // Documentation score: evidence weight on passes, top 10 count double.
    let got = 0, max = 0;
    for (const c of checks) {
      if (c.status === "na") continue;
      const w = c.top ? 2 : 1;
      max += w;
      if (c.status === "pass") got += w * (EVIDENCE[c.evidence]?.weight ?? 0);
    }
    const score = Math.round((100 * got) / max);
    const top = checks.filter((c) => c.top).sort((a, b) => a.top - b.top);
    const strong = top.filter((c) => c.status === "pass" && (c.evidence === "lab" || c.evidence === "certified")).length;
    const backed = top.filter((c) => c.status === "pass" && c.evidence !== "none").length;
    let tier, blurb;
    if (strong >= 6) { tier = "Fully verified"; blurb = "Independent testing and certifications back most of what matters."; }
    else if (backed >= 5) { tier = "Winery verified"; blurb = "Supporting documentation comes straight from the producer."; }
    else { tier = "Not verified"; blurb = "Not enough public information to confirm the key claims."; }
    return { n, est, checks, score, top, tier, blurb };
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

  function renderResult(data, isNew) {
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

    screens.result.innerHTML = `
      <div class="wine-head">
        ${data.demo ? `<span class="demo-tag">Demo</span>` : ""}
        ${w.producer ? `<p class="producer">${esc(w.producer)}</p>` : ""}
        <h1>${esc(w.name || (data.identified ? "Unnamed wine" : "We couldn't read that label"))}</h1>
        <p class="meta">${esc([w.vintage, w.grapes, [w.region, w.country].filter(Boolean).join(", ")].filter(Boolean).join(" · "))}</p>
      </div>

      <div class="card score">
        <div class="ring">
          <svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="42" /><circle class="fg" cx="50" cy="50" r="42"
            stroke-dasharray="${circ}" stroke-dashoffset="${circ}" data-to="${circ * (1 - r.score / 100)}" /></svg>
          <b>${r.score}</b>
        </div>
        <div><p class="tier">${r.tier}</p><p>${r.blurb}</p></div>
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
      <p class="fine">The score measures how well documented a wine is, not how healthy it is. Sulfite ratings are a Wine Babe comparison scale, not a regulatory classification. Results can vary by vintage.</p>
    `;
    $("#backHome").onclick = goHome;
    show("result");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const fg = screens.result.querySelector(".ring .fg");
        if (fg) fg.style.strokeDashoffset = fg.dataset.to;
      })
    );
  }

  function goHome() {
    renderRecent();
    show("home");
  }

  $("#homeBtn").addEventListener("click", goHome);

  fetch("/api/health").then((r) => r.json()).then((h) => { $("#demoNote").hidden = h.live; }).catch(() => {});
  renderRecent();
})();
