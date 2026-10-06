// Plain JS single page app. All text goes through textContent so call transcripts
// and caller supplied names can never inject markup.
(() => {
  const $app = document.getElementById("app");
  let token = localStorage.getItem("office_token") || "";
  let meta = null;
  let tenants = [];
  let slug = localStorage.getItem("office_tenant") || "";
  let tab = "inbox";

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const mount = (...nodes) => { $app.replaceChildren(...nodes); };

  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, {
      method: opts.method || "GET",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { token = ""; localStorage.removeItem("office_token"); render(); throw new Error("Signed out"); }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const fmtTime = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const fmtPhone = (p) => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || ""); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (p || "unknown"); };
  const TYPE_LABEL = { lead: "Lead", sub_vendor: "Sub / vendor", existing_client: "Client", solicitor: "Solicitor", unknown: "Needs review" };
  const typeChip = (t) => h("span", { class: "chip " + (t || "") }, TYPE_LABEL[t] || "Not sorted yet");
  const flash = (el, msg, bad) => { el.textContent = msg; el.className = bad ? "err" : "okmsg"; };

  // ---- login ----
  function loginView() {
    const input = h("input", { type: "password", placeholder: "Access token", autocomplete: "current-password" });
    const msg = h("div", { class: "muted" });
    const go = async () => {
      token = input.value.trim();
      try { await api("/meta"); localStorage.setItem("office_token", token); render(); }
      catch (e) { flash(msg, e.message === "Signed out" ? "That token didn't work." : e.message, true); }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    mount(h("div", { class: "login" }, h("h1", {}, "Office"), h("p", { class: "muted" }, "Enter your access token."), input, h("p", {}, h("button", { class: "btn", onclick: go }, "Sign in")), msg));
  }

  // ---- shell ----
  const TABS = [["inbox", "Inbox"], ["tasks", "Tasks"], ["leads", "Leads"], ["contacts", "Contacts"], ["texts", "Texts"], ["settings", "Settings"], ["connectors", "Connectors"], ["demo", "Demo"]];

  async function render() {
    if (!token) return loginView();
    try {
      meta = meta || await api("/meta");
      tenants = await api("/tenants");
    } catch (e) { return; }
    document.title = meta.product;
    if (!tenants.find((t) => t.slug === slug)) slug = tenants[0]?.slug || "";
    if (slug) localStorage.setItem("office_tenant", slug);

    const picker = h("select", { onchange: (e) => { slug = e.target.value; localStorage.setItem("office_tenant", slug); render(); } },
      tenants.map((t) => h("option", { value: t.slug, selected: t.slug === slug }, t.name)));
    const header = h("header", {}, h("h1", {}, meta.product), tenants.length ? picker : null,
      h("button", { class: "btn ghost", onclick: addCompanyView }, "Add company"),
      h("span", { class: "grow" }), h("button", { class: "btn ghost", onclick: () => { token = ""; localStorage.removeItem("office_token"); render(); } }, "Sign out"));
    const nav = h("nav", {}, TABS.map(([id, label]) => h("button", { class: id === tab ? "on" : "", onclick: () => { tab = id; render(); } }, label)));
    const body = h("main", {});
    mount(header, nav, body);
    if (!slug) { body.append(h("div", { class: "card" }, "No companies yet. Use Add company to create one.")); return; }
    try { await VIEWS[tab](body); } catch (e) { body.append(h("div", { class: "card err" }, e.message)); }
  }

  function addCompanyView() {
    const name = h("input", { placeholder: "Company name" });
    const short = h("input", { placeholder: "short_name (letters, numbers, underscores)" });
    const msg = h("div", {});
    const save = async () => {
      try {
        const out = await api("/tenants", { method: "POST", body: { name: name.value, slug: short.value } });
        slug = out.slug; tab = "connectors"; render();
      } catch (e) { flash(msg, e.message, true); }
    };
    mount(h("main", {}, h("h2", {}, "Add company"), h("label", {}, "Name"), name, h("label", {}, "Short name"), short,
      h("p", { class: "row" }, h("button", { class: "btn", onclick: save }, "Create"), h("button", { class: "btn ghost", onclick: render }, "Cancel")), msg));
  }

  const empty = (what) => h("div", { class: "card muted" }, what);

  // ---- views ----
  const VIEWS = {
    async inbox(body) {
      const [sum, rows] = await Promise.all([api(`/t/${slug}/summary`), api(`/t/${slug}/interactions`)]);
      body.append(h("div", { class: "stats" },
        [["Calls", sum.calls], ["Open tasks", sum.open_tasks], ["Open leads", sum.open_leads], ["Contacts", sum.contacts]].map(([l, n]) => h("div", { class: "card" }, h("b", {}, n), h("span", { class: "muted" }, l)))));
      if (sum.tenant.mode === "shadow") body.append(h("div", { class: "card muted" }, "Shadow mode: nothing is texted to callers. Only a report goes to the shadow number."));
      if (!rows.length) return body.append(empty("No calls yet."));
      for (const i of rows) {
        const lines = (i.transcript || []).map((l) => (l.identifier && l.identifier === i.from_phone ? "Caller: " : "Agent: ") + l.text).join("\n");
        const detail = h("div", { class: "transcript", hidden: true }, i.reasoning ? "Why: " + i.reasoning + "\n\n" : "", lines || i.voicemail_transcript || i.body || "No transcript.");
        body.append(h("div", { class: "card", onclick: () => { detail.hidden = !detail.hidden; } },
          h("div", { class: "row" }, h("b", { class: "grow" }, i.contact_name || fmtPhone(i.from_phone)),
            i.channel === "sms" ? h("span", { class: "chip" }, "Text") : typeChip(i.caller_type), h("span", { class: "muted" }, fmtTime(i.created_at))),
          h("div", {}, i.summary || i.body || (i.processed_at ? "" : "Waiting for the transcript...")),
          h("div", { class: "muted" }, [i.handled_by === "ai_agent" ? "AI agent answered" : i.handled_by === "person" ? "Answered in office" : i.handled_by === "missed" ? "Missed" : "", i.confidence != null ? Math.round(i.confidence * 100) + "% sure" : ""].filter(Boolean).join(" · ")),
          detail));
      }
    },

    async tasks(body) {
      const rows = await api(`/t/${slug}/tasks`);
      if (!rows.length) return body.append(empty("Nothing open. Nice."));
      for (const k of rows) {
        body.append(h("div", { class: "card row" }, h("div", { class: "grow" }, h("b", {}, k.title), h("div", {}, k.body), h("div", { class: "muted" }, fmtPhone(k.from_phone) + " · " + fmtTime(k.created_at))),
          h("button", { class: "btn ghost", onclick: async () => { await api(`/t/${slug}/tasks/${k.id}`, { method: "PATCH", body: { status: "done" } }); render(); } }, "Done")));
      }
    },

    async leads(body) {
      const rows = await api(`/t/${slug}/leads`);
      if (!rows.length) return body.append(empty("No leads yet."));
      for (const l of rows) body.append(h("div", { class: "card" }, h("div", { class: "row" }, h("b", { class: "grow" }, l.name || fmtPhone(l.phone)), h("span", { class: "chip" }, l.status)),
        h("div", {}, [l.job_type, l.address, l.timeline].filter(Boolean).join(" · ") || "No details captured"), h("div", { class: "muted" }, fmtPhone(l.phone) + " · " + fmtTime(l.created_at))));
    },

    async contacts(body) {
      const rows = await api(`/t/${slug}/contacts`);
      if (!rows.length) return body.append(empty("No contacts yet. They appear as calls come in."));
      for (const c of rows) body.append(h("div", { class: "card row" }, h("div", { class: "grow" }, h("b", {}, [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed"), c.company ? " · " + c.company : "", h("div", { class: "muted" }, (c.phones || []).map(fmtPhone).join(", "))), h("span", { class: "chip" }, c.type)));
    },

    async texts(body) {
      const rows = await api(`/t/${slug}/outbound`);
      if (!rows.length) return body.append(empty("No texts sent or drafted yet."));
      for (const m of rows) body.append(h("div", { class: "card" }, h("div", { class: "row" }, h("b", { class: "grow" }, m.purpose.replace("_", " ") + " to " + fmtPhone(m.to_phone)), h("span", { class: "chip " + (m.mode === "live" ? "live" : "") }, m.mode), h("span", { class: "muted" }, fmtTime(m.created_at))),
        h("div", { class: "transcript" }, m.body), m.error ? h("div", { class: "err" }, m.error) : null));
    },

    async settings(body) {
      const s = await api(`/t/${slug}/settings`);
      const mode = h("select", {}, ["shadow", "live"].map((m) => h("option", { value: m, selected: s.mode === m }, m === "shadow" ? "Shadow (only you get reports)" : "Live (callers and staff get texts)")));
      const thr = h("input", { type: "number", min: "0.3", max: "0.99", step: "0.05", value: s.confidenceThreshold });
      const phone = h("input", { placeholder: "Shadow report phone, e.g. (904) 555 0100", value: s.shadowRecipientPhone || "" });
      const labels = { lead_callback: "Text to new leads", ack_sub_vendor: "Text to subs and vendors", ack_client: "Text to clients", generic: "Text when unsure" };
      const tpl = {};
      const tplFields = meta.templateKeys.map((k) => { tpl[k] = h("textarea", { rows: 2, maxlength: 320, placeholder: "Leave empty to send nothing" }); tpl[k].value = s.templates?.[k] || ""; return [h("label", {}, labels[k]), tpl[k]]; });
      const msg = h("div", {});
      const save = async () => {
        if (mode.value === "live" && s.mode !== "live" && !confirm("Live mode texts real callers and staff. Switch to live?")) return;
        try {
          await api(`/t/${slug}/settings`, { method: "PUT", body: { mode: mode.value, confidenceThreshold: Number(thr.value), shadowRecipientPhone: phone.value || null, templates: Object.fromEntries(Object.entries(tpl).map(([k, el]) => [k, el.value])) } });
          flash(msg, "Saved.");
        } catch (e) { flash(msg, e.message, true); }
      };
      body.append(h("div", { class: "card" }, h("label", {}, "Mode"), mode, h("label", {}, "Minimum confidence before a call is sorted automatically (0.3 to 0.99). Below this it goes to a person."), thr, h("label", {}, "Shadow report phone"), phone,
        h("h3", {}, "Text messages to callers"), h("p", { class: "muted" }, "Use {first_name} and {company} if you like. A caller only gets a text if the box has words in it."), tplFields,
        h("p", {}, h("button", { class: "btn", onclick: save }, "Save")), msg));
    },

    async connectors(body) {
      const have = await api(`/t/${slug}/connectors`);
      for (const kind of ["telephony", "calendar", "jobs", "accounting"]) {
        const kindLabel = { telephony: "Phone and texting", calendar: "Calendar", jobs: "Jobs and schedules", accounting: "Accounting" }[kind];
        body.append(h("h3", {}, kindLabel));
        for (const m of meta.connectors.filter((c) => c.kind === kind)) {
          const mine = have.find((c) => c.kind === kind && c.provider === m.provider);
          const card = h("div", { class: "card" });
          card.append(h("div", { class: "row" }, h("b", { class: "grow" }, m.label), h("span", { class: "chip " + (mine ? "lead" : "") }, mine ? "Connected" : m.status === "ready" ? "Not connected" : "Coming soon")), h("div", { class: "muted" }, m.description));
          if (m.status === "ready") {
            const inputs = {};
            const msg = h("div", {});
            for (const f of m.fields) {
              inputs[f.key] = h("input", { type: f.secret ? "password" : "text", placeholder: f.secret && mine?.secretsSet.includes(f.key) ? "Saved. Type to replace." : (f.help || ""), value: !f.secret && mine?.config?.[f.key] ? [].concat(mine.config[f.key]).join(", ") : "" });
              card.append(h("label", {}, f.label + (f.required ? " *" : "")), inputs[f.key]);
            }
            card.append(h("p", {}, h("button", { class: "btn", onclick: async () => {
              try { await api(`/t/${slug}/connectors/${kind}/${m.provider}`, { method: "PUT", body: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) }); render(); }
              catch (e) { flash(msg, e.message, true); }
            } }, mine ? "Update" : "Connect")), msg);
          }
          body.append(card);
        }
      }
    },

    async demo(body) {
      body.append(h("div", { class: "card muted" }, "Run a practice call through the whole system. Needs the Demo phone connected, and only works on companies that have no real phone."));
      const msg = h("div", {});
      for (const s of meta.scenarios) body.append(h("div", { class: "card row" }, h("span", { class: "grow" }, s.label), h("button", { class: "btn", onclick: async () => {
        try { await api(`/t/${slug}/simulate`, { method: "POST", body: { scenario: s.id } }); flash(msg, "Call sent. Check the Inbox in a few seconds."); } catch (e) { flash(msg, e.message, true); }
      } }, "Run")));
      body.append(msg);
    },
  };

  render();
})();
