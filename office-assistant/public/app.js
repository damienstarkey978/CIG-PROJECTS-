// Plain JS single page app. All text goes through textContent so call transcripts
// and caller supplied names can never inject markup.
(() => {
  const $app = document.getElementById("app");
  let token = localStorage.getItem("office_token") || "";
  let meta = null;
  let me = null;
  let tenants = [];
  let slug = localStorage.getItem("office_tenant") || "";
  let tab = new URLSearchParams(location.search).get("connected") ? "connectors" : "inbox";

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
  function signOut() { token = ""; me = null; meta = null; localStorage.removeItem("office_token"); render(); }
  function loginView() {
    const email = h("input", { type: "email", placeholder: "Email", autocomplete: "username" });
    const pw = h("input", { type: "password", placeholder: "Password (or admin token)", autocomplete: "current-password" });
    const msg = h("div", {});
    const go = async () => {
      try {
        if (email.value.trim()) {
          const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.value.trim(), password: pw.value }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) return flash(msg, data.error || "Couldn't sign in", true);
          token = data.token;
        } else token = pw.value.trim();
        await api("/me"); localStorage.setItem("office_token", token); render();
      } catch (e) { flash(msg, e.message === "Signed out" ? "That didn't work." : e.message, true); }
    };
    pw.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    mount(h("div", { class: "login" }, h("h1", {}, "Office"), email, h("p", {}, pw), h("p", { class: "muted" }, "Operators: leave email empty and enter the admin token."), h("p", {}, h("button", { class: "btn", onclick: go }, "Sign in")), msg));
  }

  // ---- shell ----
  const TABS = [["inbox", "Inbox"], ["tasks", "Tasks"], ["leads", "Leads"], ["contacts", "Contacts"], ["schedule", "Schedule"], ["subs", "Subs"], ["texts", "Texts"], ["books", "Books"], ["settings", "Settings"], ["import", "Import"], ["connectors", "Connectors"], ["team", "Team"], ["demo", "Demo"]];
  const OWNER_ONLY = new Set(["settings", "import", "connectors", "team", "demo"]);
  const canAdmin = () => me && (me.role === "operator" || me.role === "owner");
  const visible = (id) => OWNER_ONLY.has(id) ? canAdmin() : (id === "books" || id === "subs") ? (canAdmin() || me.role === "office") : true;

  async function render() {
    if (!token) return loginView();
    try {
      me = me || await api("/me");
      meta = meta || await api("/meta");
      tenants = await api("/tenants");
    } catch (e) { return; }
    document.title = meta.product;
    if (!tenants.find((t) => t.slug === slug)) slug = tenants[0]?.slug || "";
    if (slug) localStorage.setItem("office_tenant", slug);

    const picker = me.role !== "operator" ? h("strong", {}, tenants[0]?.name) : h("select", { onchange: (e) => { slug = e.target.value; localStorage.setItem("office_tenant", slug); render(); } },
      tenants.map((t) => h("option", { value: t.slug, selected: t.slug === slug }, t.name)));
    const header = h("header", {}, h("h1", {}, meta.product), tenants.length ? picker : null,
      me.role === "operator" ? h("button", { class: "btn ghost", onclick: addCompanyView }, "Add company") : null,
      h("span", { class: "grow" }), h("span", { class: "muted" }, me.name), h("button", { class: "btn ghost", onclick: async () => { await api("/logout", { method: "POST" }).catch(() => {}); signOut(); } }, "Sign out"));
    if (!visible(tab)) tab = "inbox";
    const nav = h("nav", {}, TABS.filter(([id]) => visible(id)).map(([id, label]) => h("button", { class: id === tab ? "on" : "", onclick: () => { tab = id; render(); } }, label)));
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
      const chase = h("input", { type: "number", min: "1", max: "90", step: "1", value: s.chaseAfterDays || 14 });
      const outbound = h("input", { placeholder: "Business line texts go out from, e.g. (904) 555 0100", value: s.outboundNumber || "" });
      const phone = h("input", { placeholder: "Shadow report phone, e.g. (904) 555 0100", value: s.shadowRecipientPhone || "" });
      const labels = { lead_callback: "Text to new leads", ack_sub_vendor: "Text to subs and vendors", ack_client: "Text to clients", generic: "Text when unsure", schedule_confirm: "Text asking a sub to confirm they are on site (use {first_name}, {job}, {date})", paperwork_request: "Text asking a sub for paperwork (use {first_name}, {missing})" };
      const tpl = {};
      const tplFields = meta.templateKeys.map((k) => { tpl[k] = h("textarea", { rows: 2, maxlength: 320, placeholder: "Leave empty to send nothing" }); tpl[k].value = s.templates?.[k] || ""; return [h("label", {}, labels[k]), tpl[k]]; });
      const msg = h("div", {});
      const save = async () => {
        if (mode.value === "live" && s.mode !== "live" && !confirm("Live mode texts real callers and staff. Switch to live?")) return;
        try {
          await api(`/t/${slug}/settings`, { method: "PUT", body: { mode: mode.value, confidenceThreshold: Number(thr.value), chaseAfterDays: Number(chase.value) || undefined, outboundNumber: outbound.value || undefined, shadowRecipientPhone: phone.value || null, templates: Object.fromEntries(Object.entries(tpl).map(([k, el]) => [k, el.value])) } });
          flash(msg, "Saved.");
        } catch (e) { flash(msg, e.message, true); }
      };
      body.append(h("div", { class: "card" }, h("label", {}, "Mode"), mode, h("label", {}, "Minimum confidence before a call is sorted automatically (0.3 to 0.99). Below this it goes to a person."), thr, h("label", {}, "Days past due before an unpaid invoice gets a follow up task"), chase, h("label", {}, "Business line for texts to subs"), outbound, h("label", {}, "Shadow report phone"), phone,
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
          if (m.status === "ready" && m.oauth) {
            const msg = h("div", {});
            card.append(h("p", {}, h("button", { class: "btn", onclick: async () => {
              try { const out = await api(`/t/${slug}/connectors/${kind}/${m.provider}/authorize`); location.href = out.url; }
              catch (e) { flash(msg, e.message, true); }
            } }, mine ? "Reconnect" : "Connect with " + m.label)), msg);
          } else if (m.status === "ready") {
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

    async import(body) {
      body.append(h("div", { class: "card muted" }, "Load contacts, subs, vendors or jobs from a CSV or Excel file exported from Buildertrend, QuickBooks, a spreadsheet, anything. Column names are matched automatically. Preview first: nothing is saved until you press Import. Running it again never creates duplicates."));
      const kind = h("select", {}, [["contacts", "Contacts (clients, subs, vendors)"], ["jobs", "Jobs"]].map(([v, l]) => h("option", { value: v }, l)));
      const type = h("select", {}, [["sub", "Subs"], ["client", "Clients"], ["vendor", "Vendors"], ["other", "Mixed or unknown"]].map(([v, l]) => h("option", { value: v }, l)));
      const typeRow = h("div", {}, h("label", {}, "Everyone in this file is a"), type);
      kind.addEventListener("change", () => { typeRow.hidden = kind.value === "jobs"; });
      const file = h("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx" });
      const out = h("div", {});
      const fileBody = async (f, defaultType, dryRun) => {
        if (/\.xlsx$/i.test(f.name)) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return { xlsxBase64: btoa(bin), defaultType, dryRun };
        }
        return { csv: await f.text(), defaultType, dryRun };
      };
      const run = async (dryRun) => {
        out.replaceChildren();
        const f = file.files[0];
        if (!f) return out.append(h("div", { class: "err" }, "Choose a file first."));
        try {
          const r = await api(`/t/${slug}/import/${kind.value}`, { method: "POST", body: await fileBody(f, type.value, dryRun) });
          out.append(h("div", { class: "card" },
            h("b", {}, r.dryRun ? "Preview (nothing saved)" : "Imported"),
            h("div", {}, `${r.created} new, ${r.updated} updated, ${r.unchanged} already there, ${r.skipped} blank rows skipped`),
            h("div", { class: "muted" }, "Columns used: " + Object.entries(r.columns.recognized).filter(([, v]) => v).map(([k, v]) => `${v} as ${k}`).join(", ")),
            r.columns.ignored.length ? h("div", { class: "muted" }, "Ignored columns: " + r.columns.ignored.join(", ")) : null,
            ...r.warnings.slice(0, 20).map((w) => h("div", { class: "muted" }, w)),
            r.warnings.length > 20 ? h("div", { class: "muted" }, `...and ${r.warnings.length - 20} more warnings`) : null));
        } catch (e) { out.append(h("div", { class: "err" }, e.message)); }
      };
      body.append(h("div", { class: "card" }, h("label", {}, "What are you loading?"), kind, typeRow, h("label", {}, "File (CSV or Excel .xlsx)"), file,
        h("p", { class: "row" }, h("button", { class: "btn ghost", onclick: () => run(true) }, "Preview"), h("button", { class: "btn", onclick: () => run(false) }, "Import"))), out);
    },

    async books(body) {
      const d = await api(`/t/${slug}/books`);
      const usd = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
      if (!d.connected) return body.append(empty("No books connected yet. Open Connectors and connect QuickBooks (or Demo books to practice)."));
      const msg = h("div", {});
      body.append(h("div", { class: "card row" }, h("div", { class: "grow" }, h("b", {}, "Books: " + d.connected), h("div", { class: "muted" }, d.lastSync ? (d.lastSync.error ? "Last sync failed: " + d.lastSync.error : "Last synced " + fmtTime(d.lastSync.finished_at)) : "Not synced yet")),
        h("button", { class: "btn", onclick: async () => { try { const r = await api(`/t/${slug}/books/sync`, { method: "POST" }); flash(msg, `Synced ${r.bills} bills, ${r.invoices} invoices, ${r.tasksCreated} new task(s).`); setTimeout(render, 600); } catch (e) { flash(msg, e.message, true); } } }, "Sync now")), msg);
      body.append(h("div", { class: "card muted" }, "Read only. This never pays a bill, edits your books, or texts anyone. It lists what needs a person."));
      const ageCard = (title, t) => h("div", { class: "card" }, h("div", { class: "row" }, h("b", { class: "grow" }, title), h("b", {}, usd(t.total))),
        h("div", { class: "muted" }, [["Not due", t.current], ["1 to 30 late", t.d1_30], ["31 to 60", t.d31_60], ["61 to 90", t.d61_90], ["Over 90", t.d90_plus]].filter(([, v]) => v).map(([l, v]) => `${l} ${usd(v)}`).join(" · ") || "Nothing open"));
      body.append(ageCard("You owe (bills)", d.payable), ageCard("Owed to you (invoices)", d.receivable));
      if (d.held) body.append(h("div", { class: "card" }, h("b", {}, usd(d.held) + " of bills need paperwork before paying")));
      body.append(h("h3", {}, "Bills"));
      if (!d.bills.length) body.append(empty("No open bills."));
      for (const b of d.bills) body.append(h("div", { class: "card" }, h("div", { class: "row" }, h("b", { class: "grow" }, b.vendor), h("b", {}, usd(b.balance))),
        h("div", { class: "muted" }, [b.docNumber ? "#" + b.docNumber : "", b.dueDate ? (b.daysOverdue > 0 ? b.daysOverdue + " days late" : "due " + b.dueDate) : "no due date"].filter(Boolean).join(" · ")),
        b.job ? h("div", {}, "Looks like job: " + b.job, h("span", { class: "muted" }, " (" + b.jobNote + ")")) : h("div", { class: "muted" }, "Job not identified"),
        ...b.blockers.map((x) => h("div", { class: "chip unknown" }, x))));
      body.append(h("h3", {}, "Invoices"));
      if (!d.invoices.length) body.append(empty("No open invoices."));
      for (const i of d.invoices) body.append(h("div", { class: "card" }, h("div", { class: "row" }, h("b", { class: "grow" }, i.customer), h("b", {}, usd(i.balance))),
        h("div", { class: "muted" }, [i.docNumber ? "#" + i.docNumber : "", i.daysOverdue > 0 ? i.daysOverdue + " days late" : "due " + i.dueDate].filter(Boolean).join(" · ")), i.job ? h("div", {}, "Job: " + i.job) : null));
    },

    async schedule(body) {
      const [rows, look] = await Promise.all([api(`/t/${slug}/schedule`), api(`/t/${slug}/lookups`)]);
      const msg = h("div", {});
      if (canAdmin() || me.role === "office") {
        body.append(h("div", { class: "card row" }, h("div", { class: "grow muted" }, "Texts subs to confirm, asks for missing paperwork, and flags no shows. Runs by itself every 10 minutes between 9 and 5."),
          h("button", { class: "btn ghost", onclick: async () => { try { const r = await api(`/t/${slug}/automation/run`, { method: "POST" }); flash(msg, r.skipped ? "Skipped: " + r.skipped : `Done. ${r.confirmRequests} confirmation(s), ${r.paperworkRequests} paperwork request(s), ${r.escalations} escalation(s).`); setTimeout(render, 700); } catch (e) { flash(msg, e.message, true); } } }, "Run now")), msg);
      }
      const job = h("select", {}, h("option", { value: "" }, "Job..."), look.jobs.map((j) => h("option", { value: j.id }, j.name)));
      const sub = h("select", {}, h("option", { value: "" }, "Sub..."), look.subs.map((x) => h("option", { value: x.id }, x.name)));
      const scope = h("input", { placeholder: "What they are doing (optional)" });
      const start = h("input", { type: "date" });
      const addMsg = h("div", {});
      body.append(h("div", { class: "card" }, h("b", {}, "Add to schedule"), job, h("p", {}, sub), scope, h("label", {}, "Start date"), start,
        h("p", {}, h("button", { class: "btn", onclick: async () => { try { await api(`/t/${slug}/schedule`, { method: "POST", body: { jobId: job.value, subId: sub.value, scope: scope.value || undefined, startDate: start.value } }); render(); } catch (e) { flash(addMsg, e.message, true); } } }, "Add")), addMsg));
      if (!rows.length) return body.append(empty("Nothing scheduled yet."));
      const CHIP = { pending: "Not confirmed", confirmed: "Confirmed", declined: "Declined", no_response: "No answer" };
      for (const a of rows) body.append(h("div", { class: "card" }, h("div", { class: "row" }, h("b", { class: "grow" }, a.sub_name + " at " + a.job_name), h("span", { class: "chip " + (a.confirmation_status === "confirmed" ? "lead" : a.confirmation_status === "pending" ? "" : "unknown") }, CHIP[a.confirmation_status])),
        h("div", { class: "muted" }, a.start_date + (a.scope ? " · " + a.scope : "") + (a.confirm_reply ? " · replied: " + a.confirm_reply : "")),
        h("div", { class: "row" }, h("select", { style: "width:auto", onchange: async (e) => { await api(`/t/${slug}/schedule/${a.id}`, { method: "PATCH", body: { confirmationStatus: e.target.value } }); render(); } },
          Object.entries(CHIP).map(([v, l]) => h("option", { value: v, selected: v === a.confirmation_status }, l))),
          h("button", { class: "btn ghost", onclick: async () => { if (confirm("Remove this from the schedule?")) { await api(`/t/${slug}/schedule/${a.id}`, { method: "DELETE" }); render(); } } }, "Remove"))));
    },

    async subs(body) {
      const rows = await api(`/t/${slug}/subs`);
      const q = h("input", { placeholder: "Search subs", type: "search" });
      const list = h("div", {});
      const draw = () => {
        const term = q.value.trim().toLowerCase();
        list.replaceChildren();
        const shown = rows.filter((s) => !term || [s.company, s.name, s.phone, (s.trades || []).join(" ")].join(" ").toLowerCase().includes(term));
        if (!shown.length) list.append(empty("No subs match. Import them from the Import tab."));
        for (const s of shown.slice(0, 150)) {
          const w9 = h("input", { type: "checkbox", style: "width:auto", checked: s.w9OnFile });
          const coi = h("input", { type: "date", value: s.coiExpiresOn || "" });
          const lien = h("select", {}, [["", "Nothing needed"], ["needed", "Needed"], ["received", "Received"]].map(([v, l]) => h("option", { value: v, selected: (s.lienWaiverStatus || "") === v }, l)));
          const trades = h("input", { placeholder: "Trades, separated by commas", value: (s.trades || []).join(", ") });
          const msg = h("div", {});
          const form = h("div", { hidden: true }, h("label", { class: "row" }, w9, "W9 on file"), h("label", {}, "Insurance certificate expires"), coi, h("label", {}, "Lien waiver"), lien, h("label", {}, "Trades"), trades,
            h("p", {}, h("button", { class: "btn", onclick: async (e) => { e.stopPropagation(); try { await api(`/t/${slug}/subs/${s.id}`, { method: "PATCH", body: { w9OnFile: w9.checked, coiExpiresOn: coi.value || null, lienWaiverStatus: lien.value || null, trades: trades.value.split(",").map((x) => x.trim()).filter(Boolean) } }); flash(msg, "Saved."); setTimeout(render, 500); } catch (er) { flash(msg, er.message, true); } } }, "Save")), msg);
          form.addEventListener("click", (e) => e.stopPropagation());
          list.append(h("div", { class: "card", onclick: () => { form.hidden = !form.hidden; } },
            h("div", { class: "row" }, h("b", { class: "grow" }, s.company || s.name || "Unnamed"), s.upcoming ? h("span", { class: "chip" }, s.upcoming + " upcoming") : null),
            h("div", { class: "muted" }, [s.company && s.name ? s.name : "", s.phone ? fmtPhone(s.phone) : "no phone", (s.trades || []).join(", ")].filter(Boolean).join(" · ")),
            s.needs.length ? h("div", {}, s.needs.map((n) => h("span", { class: "chip unknown", style: "margin-right:4px" }, "Needs " + n))) : h("div", { class: "muted" }, "Paperwork complete"), form));
        }
        if (shown.length > 150) list.append(h("div", { class: "muted" }, `Showing 150 of ${shown.length}. Search to narrow.`));
      };
      q.addEventListener("input", draw);
      const missing = rows.filter((s) => s.needs.length).length;
      body.append(h("div", { class: "card muted" }, `${rows.length} subs, ${missing} missing or expiring paperwork. Tap a sub to update. The system only chases subs who are on the schedule or have an open bill.`), q, list);
      draw();
    },

    async team(body) {
      const rows = await api(`/t/${slug}/users`);
      const name = h("input", { placeholder: "Name" }), email = h("input", { type: "email", placeholder: "Email" }), phone = h("input", { placeholder: "Mobile (for alerts)" });
      const pw = h("input", { type: "password", placeholder: "Starting password (10+ characters)", autocomplete: "new-password" });
      const role = h("select", {}, [["owner", "Owner (everything)"], ["office", "Office (calls, tasks, leads)"], ["pm", "Project manager (calls, tasks, leads)"]].map(([v, l]) => h("option", { value: v }, l)));
      const msg = h("div", {});
      for (const u of rows) body.append(h("div", { class: "card row" }, h("div", { class: "grow" }, h("b", {}, u.name), h("span", { class: "chip" }, u.role), h("div", { class: "muted" }, [u.email, u.phone ? fmtPhone(u.phone) : "no mobile", u.last_login_at ? "last in " + fmtTime(u.last_login_at) : "never signed in"].join(" · "))),
        h("label", { class: "row muted" }, h("input", { type: "checkbox", style: "width:auto", checked: u.alerts_enabled, onchange: async (e) => { await api(`/t/${slug}/users/${u.id}`, { method: "PATCH", body: { alertsEnabled: e.target.checked } }); } }), "Gets alerts"),
        h("button", { class: "btn ghost", onclick: async () => { if (confirm("Remove " + u.name + "?")) { try { await api(`/t/${slug}/users/${u.id}`, { method: "DELETE" }); render(); } catch (e) { alert(e.message); } } } }, "Remove")));
      body.append(h("div", { class: "card" }, h("h3", {}, "Add a person"), name, h("p", {}, email), phone, h("p", {}, pw), role,
        h("p", {}, h("button", { class: "btn", onclick: async () => {
          try { await api(`/t/${slug}/users`, { method: "POST", body: { name: name.value, email: email.value, phone: phone.value || undefined, role: role.value, password: pw.value } }); render(); }
          catch (e) { flash(msg, e.message, true); }
        } }, "Add")), msg, h("p", { class: "muted" }, "People with a mobile and alerts on get a text for every call that needs attention, once the company is in live mode.")));
    },

    async demo(body) {
      body.append(h("div", { class: "card muted" }, "Run a practice call through the whole system. Needs the Demo phone connected, and only works on companies that have no real phone."));
      const msg = h("div", {});
      for (const s of meta.scenarios) body.append(h("div", { class: "card row" }, h("span", { class: "grow" }, s.label), h("button", { class: "btn", onclick: async () => {
        try { await api(`/t/${slug}/simulate`, { method: "POST", body: { scenario: s.id } }); flash(msg, "Call sent. Check the Inbox in a few seconds."); } catch (e) { flash(msg, e.message, true); }
      } }, "Run")));
      body.append(msg);
      const from = h("input", { placeholder: "Sub's phone, e.g. (904) 555 0133" }), text = h("input", { placeholder: "Text, e.g. need more tile at the Oak job" }), tmsg = h("div", {});
      body.append(h("div", { class: "card" }, h("b", {}, "Pretend a sub texted in"), from, h("p", {}, text),
        h("button", { class: "btn", onclick: async () => { try { await api(`/t/${slug}/simulate-text`, { method: "POST", body: { from: from.value, text: text.value } }); flash(tmsg, "Sent. Check Tasks in a few seconds."); } catch (e) { flash(tmsg, e.message, true); } } }, "Send"), tmsg));
    },
  };

  render();
})();
