const lotList = document.getElementById("lot-list");
const emptyState = document.getElementById("empty");
const connStatus = document.getElementById("conn-status");
const sheetBackdrop = document.getElementById("sheet-backdrop");
const addBtn = document.getElementById("add-btn");
const cancelBtn = document.getElementById("cancel-btn");
const addForm = document.getElementById("add-form");
const modeSelect = document.getElementById("mode");
const snipeField = document.getElementById("snipe-seconds-field");

/** @type {Map<string, any>} */
const lots = new Map();

function openSheet() { sheetBackdrop.classList.remove("hidden"); }
function closeSheet() { sheetBackdrop.classList.add("hidden"); addForm.reset(); toggleSnipeField(); }

addBtn.addEventListener("click", openSheet);
cancelBtn.addEventListener("click", closeSheet);
sheetBackdrop.addEventListener("click", (e) => { if (e.target === sheetBackdrop) closeSheet(); });

function toggleSnipeField() {
  snipeField.classList.toggle("hidden", modeSelect.value !== "snipe");
}
modeSelect.addEventListener("change", toggleSnipeField);
toggleSnipeField();

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(addForm);
  const body = {
    url: fd.get("url"),
    label: fd.get("label"),
    maxBid: Number(fd.get("maxBid")),
    mode: fd.get("mode"),
    snipeSeconds: Number(fd.get("snipeSeconds")) || 8,
  };
  const res = await fetch("/api/lots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || "Failed to add lot.");
    return;
  }
  const lot = await res.json();
  upsertLot(lot);
  closeSheet();
});

function fmtMoney(n) {
  return n == null ? "—" : `$${Number(n).toFixed(2)}`;
}

function fmtCountdown(endTime) {
  if (!endTime) return "End time unknown yet";
  const ms = new Date(endTime).getTime() - Date.now();
  if (ms <= 0) return "Closing…";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m left` : m > 0 ? `${m}m ${sec}s left` : `${sec}s left`;
}

function render() {
  const all = [...lots.values()];
  emptyState.classList.toggle("hidden", all.length > 0);
  lotList.innerHTML = "";
  for (const lot of all) {
    lotList.appendChild(renderLotCard(lot));
  }
}

function renderLotCard(lot) {
  const el = document.createElement("div");
  el.className = "lot-card";

  const statusLabel = lot.paused ? "paused" : lot.status;
  el.innerHTML = `
    <div class="lot-card-top">
      <div>
        <div class="lot-label">${escapeHtml(lot.label)}</div>
        <a class="lot-link" href="${escapeAttr(lot.url)}" target="_blank" rel="noopener">open lot ↗</a>
      </div>
      <span class="badge badge-${statusLabel}">${statusLabel}</span>
    </div>
    <div class="lot-stats">
      <div>
        <div class="stat-label">Current bid</div>
        <div class="stat-value">${fmtMoney(lot.currentPrice)}</div>
      </div>
      <div>
        <div class="stat-label">Your max</div>
        <div class="stat-value">${fmtMoney(lot.maxBid)}</div>
      </div>
      <div>
        <div class="stat-label">Mode</div>
        <div class="stat-value" style="font-size:14px">${lot.mode}</div>
      </div>
    </div>
    <div class="lot-timer">${fmtCountdown(lot.endTime)}</div>
    <div class="lot-actions">
      <button data-action="pause">${lot.paused ? "Resume" : "Pause"}</button>
      <button data-action="remove" class="danger">Remove</button>
    </div>
    <div class="lot-log">${(lot.log || []).slice(0, 3).map((l) => escapeHtml(l.message)).join(" · ")}</div>
  `;

  el.querySelector('[data-action="pause"]').addEventListener("click", async () => {
    await fetch(`/api/lots/${lot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: !lot.paused }),
    });
  });

  el.querySelector('[data-action="remove"]').addEventListener("click", async () => {
    if (!confirm(`Stop watching "${lot.label}"?`)) return;
    await fetch(`/api/lots/${lot.id}`, { method: "DELETE" });
    lots.delete(lot.id);
    render();
  });

  return el;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function upsertLot(lot) {
  lots.set(lot.id, lot);
  render();
}

function connectWs() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => (connStatus.textContent = "Live");
  ws.onclose = () => {
    connStatus.textContent = "Disconnected — retrying…";
    setTimeout(connectWs, 2000);
  };
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "init") {
      lots.clear();
      for (const lot of msg.lots) lots.set(lot.id, lot);
      render();
    } else if (msg.type === "lot") {
      upsertLot(msg.lot);
    }
  };
}
connectWs();

// Keep countdowns ticking between server updates.
setInterval(render, 1000);
