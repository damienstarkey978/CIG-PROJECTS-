const form = document.getElementById("club-form");
const email = document.getElementById("email");
const note = document.querySelector(".club__note");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const address = email.value.trim();
  if (!address) return;
  const subject = encodeURIComponent("Wine Babe Club");
  const body = encodeURIComponent(`Please add ${address} to the Wine Babe Club.`);
  window.location.href = `mailto:hello@winebabewine.com?subject=${subject}&body=${body}`;
  if (note) note.hidden = false;
});
