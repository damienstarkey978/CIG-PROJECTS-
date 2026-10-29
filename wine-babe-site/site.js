const form = document.getElementById("club-form");
const email = document.getElementById("email");
const note = document.querySelector(".club__note");

try {
  const key = "wb_vid";
  let vid = localStorage.getItem(key);
  if (!vid) {
    vid = crypto.randomUUID();
    localStorage.setItem(key, vid);
  }
  const payload = JSON.stringify({
    path: location.pathname,
    ref: document.referrer.slice(0, 300),
    vid,
  });
  const blob = new Blob([payload], { type: "application/json" });
  if (!navigator.sendBeacon?.("/collect", blob)) {
    fetch("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }
} catch {
  // Counting should never affect the page.
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const address = email.value.trim();
  if (!address) return;
  const subject = encodeURIComponent("Wine Babe Club");
  const body = encodeURIComponent(`Please add ${address} to the Wine Babe Club.`);
  window.location.href = `mailto:hello@winebabewine.com?subject=${subject}&body=${body}`;
  if (note) note.hidden = false;
});
