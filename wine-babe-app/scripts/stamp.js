// Netlify build step (runs on every deploy): writes public/version.js so the page can show which
// deploy it is running (commit and time). Locally the committed "dev" file is used.
const fs = require("fs");
const ref = (process.env.COMMIT_REF || "dev").slice(0, 7);
const at = new Date().toISOString();
fs.writeFileSync(__dirname + "/../public/version.js", `window.WB_VERSION = ${JSON.stringify({ ref, at })};\n`);
console.log("version", ref, at);
