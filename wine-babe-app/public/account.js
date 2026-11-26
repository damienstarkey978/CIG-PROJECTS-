/* Accounts, free scan count and Share feedback. Loaded before app.js, which
   calls window.WB_ACCOUNT when a scan starts or needs an account. */
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let state = { account: null, team: false, allowance: null };

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  // ---------- header + free scan line ----------
  function paint() {
    const btn = $("#acctBtn");
    if (btn) btn.textContent = state.account ? "Account" : state.team ? "Team" : "Sign in";
    const note = $("#freeNote");
    const a = state.allowance;
    if (!note) return;
    if (!state.account && !state.team && a && a.freeScans) {
      const n = a.ok ? a.freeRemaining : 0;
      note.innerHTML = n > 0
        ? `${n} free scan${n === 1 ? "" : "s"} left. <button type="button" class="linkish" data-open="signup">Create a free account</button>`
        : `Create a free account to keep scanning. <button type="button" class="linkish" data-open="signup">Sign up</button>`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  async function refresh() {
    try { state = await api("/api/account"); } catch { /* offline or old server: leave as is */ }
    paint();
  }

  // ---------- sheets ----------
  function sheet(id, title, html) {
    let d = document.getElementById(id);
    if (!d) {
      d = document.createElement("dialog");
      d.id = id;
      d.className = "sheet";
      document.body.append(d);
      d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); });
    }
    d.innerHTML = `<div class="sheet__body"><div class="sheet__head"><h2>${esc(title)}</h2><button type="button" class="sheet__x" aria-label="Close">×</button></div>${html}</div>`;
    $(".sheet__x", d).onclick = () => d.close();
    if (!d.open) d.showModal();
    return d;
  }
  const busy = (form, on) => form.querySelectorAll("button, input, textarea").forEach((el) => { el.disabled = on; });
  const err = (form, msg) => { const p = $(".sheet__err", form); p.textContent = msg || ""; p.hidden = !msg; };
  const errLine = '<p class="sheet__err" role="alert" hidden></p>';

  function openSignup(reason = "") {
    const d = sheet("acctSheet", "Create a free account", `
      ${reason ? `<p class="sheet__lead">${esc(reason)}</p>` : '<p class="sheet__lead">Free, and it keeps your scans going.</p>'}
      <form class="sheet__form" novalidate>
        <label>Name<input name="name" autocomplete="name" required maxlength="80" /></label>
        <label>Email<input name="email" type="email" autocomplete="email" inputmode="email" required /></label>
        <label>Phone <span class="opt">(optional)</span><input name="phone" type="tel" autocomplete="tel" inputmode="tel" /></label>
        ${errLine}
        <button class="btn" type="submit">Create account</button>
        <p class="sheet__alt">Already have one? <button type="button" class="linkish" data-open="signin">Sign in</button></p>
        <p class="sheet__fine">By signing up you agree to our <a href="/privacy" target="_blank">privacy policy</a>.</p>
      </form>`);
    const f = $("form", d);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      err(f); busy(f, true);
      try {
        state = await api("/api/account/signup", Object.fromEntries(new FormData(f)));
        paint();
        showAccount("You're all set. Happy scanning!");
      } catch (e) { err(f, e.message); busy(f, false); }
    };
    $("[name=name]", f).focus();
  }

  function openSignin(email = "") {
    const d = sheet("acctSheet", "Sign in", `
      <p class="sheet__lead">We'll email you a 6 digit code. No password needed.</p>
      <form class="sheet__form" novalidate>
        <label>Email<input name="email" type="email" autocomplete="email" inputmode="email" required value="${esc(email)}" /></label>
        ${errLine}
        <button class="btn" type="submit">Email me a code</button>
        <p class="sheet__alt">New here? <button type="button" class="linkish" data-open="signup">Create a free account</button></p>
      </form>`);
    const f = $("form", d);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      err(f); busy(f, true);
      const addr = $("[name=email]", f).value.trim();
      try {
        await api("/api/account/code", { email: addr });
        openCode(addr);
      } catch (e) { err(f, e.message); busy(f, false); }
    };
    $("[name=email]", f).focus();
  }

  function openCode(email) {
    const d = sheet("acctSheet", "Enter your code", `
      <p class="sheet__lead">If ${esc(email)} has an account, a code is on its way. Check spam if you don't see it.</p>
      <form class="sheet__form" novalidate>
        <label>Code<input name="code" autocomplete="one-time-code" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" required maxlength="40" /></label>
        ${errLine}
        <button class="btn" type="submit">Sign in</button>
        <p class="sheet__alt"><button type="button" class="linkish" data-back>Use a different email</button></p>
      </form>`);
    const f = $("form", d);
    $("[data-back]", f).onclick = () => openSignin(email);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      err(f); busy(f, true);
      try {
        state = await api("/api/account/verify", { email, code: $("[name=code]", f).value });
        paint();
        showAccount("You're signed in.");
      } catch (e) { err(f, e.message); busy(f, false); }
    };
    $("[name=code]", f).focus();
  }

  function showAccount(flash = "") {
    if (!state.account) return state.team ? teamSheet() : openSignin();
    const a = state.account, al = state.allowance || {};
    const d = sheet("acctSheet", "Your account", `
      ${flash ? `<p class="sheet__ok">${esc(flash)}</p>` : ""}
      <dl class="sheet__dl"><dt>Name</dt><dd>${esc(a.name)}</dd><dt>Email</dt><dd>${esc(a.email)}</dd>${a.phone ? `<dt>Phone</dt><dd>${esc(a.phone)}</dd>` : ""}
      ${al.dailyLimit ? `<dt>Scans today</dt><dd>${al.usedToday || 0} of ${al.dailyLimit}</dd>` : ""}</dl>
      <div class="sheet__form">
        ${errLine}
        <button class="btn ghost" type="button" data-signout>Sign out</button>
        <button class="btn danger-link" type="button" data-delete>Delete my account</button>
      </div>`);
    const f = $(".sheet__form", d);
    $("[data-signout]", d).onclick = async () => {
      busy(f, true);
      try { state = await api("/api/account/signout", {}); paint(); d.close(); } catch (e) { err(f, e.message); busy(f, false); }
    };
    $("[data-delete]", d).onclick = () => confirmDelete();
  }

  function confirmDelete() {
    const d = sheet("acctSheet", "Delete your account?", `
      <p class="sheet__lead">This removes your name, email and phone for good. Feedback you sent stays, without your name on it.</p>
      <div class="sheet__form">
        ${errLine}
        <button class="btn danger" type="button" data-yes>Delete for good</button>
        <button class="btn ghost" type="button" data-no>Keep my account</button>
      </div>`);
    const f = $(".sheet__form", d);
    $("[data-no]", d).onclick = () => showAccount();
    $("[data-yes]", d).onclick = async () => {
      busy(f, true);
      try {
        state = await api("/api/account/delete", {});
        paint();
        sheet("acctSheet", "Account deleted", '<p class="sheet__lead">Your account is gone. Thanks for trying Wine Babe.</p>');
      } catch (e) { err(f, e.message); busy(f, false); }
    };
  }

  function teamSheet() {
    sheet("acctSheet", "Team login", `<p class="sheet__lead">You're signed in with the team password, so scans aren't limited.</p>
      <div class="sheet__form"><a class="btn ghost" href="/admin/users">Users</a><a class="btn ghost" href="/admin">Feedback and costs</a><a class="btn ghost" href="/logout">Sign out of team</a></div>`);
  }

  // ---------- Share feedback ----------
  function openFeedback() {
    const v = window.WB_VERSION || {};
    const d = sheet("fbSheet", "Share feedback", `
      <p class="sheet__lead">Found a bug or have an idea? We read every one.</p>
      <form class="sheet__form" novalidate>
        <div class="seg" role="radiogroup" aria-label="Kind of feedback">
          <label><input type="radio" name="type" value="bug" /> Bug</label>
          <label><input type="radio" name="type" value="idea" checked /> Idea</label>
          <label><input type="radio" name="type" value="other" /> Other</label>
        </div>
        <label>Tell us more<textarea name="text" rows="5" maxlength="4000" required></textarea></label>
        ${state.account ? "" : '<label>Your email <span class="opt">(optional, so we can reply)</span><input name="email" type="email" autocomplete="email" inputmode="email" /></label>'}
        <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off" /></label>
        ${errLine}
        <button class="btn" type="submit">Send</button>
      </form>`);
    const f = $("form", d);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      err(f); busy(f, true);
      const body = Object.fromEntries(new FormData(f));
      body.appVersion = v.ref || "";
      body.platform = /iPhone|iPad|iPod/.test(navigator.userAgent) ? (window.Capacitor ? "iOS app" : "iOS web") : /Android/.test(navigator.userAgent) ? "Android web" : "Web";
      body.screen = document.querySelector(".screen.is-active")?.id || "";
      try {
        await api("/api/feedback", body);
        sheet("fbSheet", "Thank you!", '<p class="sheet__lead">Got it. Thanks for helping make Wine Babe better.</p>');
      } catch (e) { err(f, e.message); busy(f, false); }
    };
    $("textarea", f).focus();
  }

  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-open]");
    if (!t) return;
    ev.preventDefault();
    ({ signup: () => openSignup(), signin: () => openSignin(), account: () => showAccount(), feedback: openFeedback })[t.dataset.open]?.();
  });

  window.WB_ACCOUNT = {
    refresh,
    needAccount(reason) { openSignup(reason); },
    setAllowance(a) { if (a) { state.allowance = a; paint(); } },
  };
  refresh();
})();
