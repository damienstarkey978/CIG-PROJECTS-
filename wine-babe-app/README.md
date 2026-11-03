# Wine Babe Scanner

Scan a wine label (or type a wine name). The server sends it to Claude, which reads the label, searches the web for the winery's tech sheet and certifications, and fills out the Wine Babe Transparency & Quality Checklist. The app shows sugar per 5 oz, calories, carbs, ABV, sulfites, the top 10 priorities, the full checklist with an evidence level per claim (Lab report, Certified, Winery declared, Estimate, Not verified), sources, and a documentation score.

## Run locally

    npm install
    ANTHROPIC_API_KEY=sk-ant-... npm start
    # open http://localhost:8080

Without a key it runs in demo mode with a sample result.

## Files

- `lib/scan.js`: the Claude scan engine; `lib/jobs.js`: job helpers
- `server.js`: Node server for local / Fly (same API as Netlify)
- `netlify/functions/`: Netlify version of the API
- `public/checklist.js`: the checklist, shared by server and app. Edit items here.
- `public/app.js`, `public/app.css`, `public/index.html`: the web app (installable as a PWA)

## Deploy (Netlify)

New site from Git, repo `damienstarkey978/CIG-PROJECTS-`, base directory `wine-babe-app`. `netlify.toml` sets publish `public` and functions `netlify/functions`. Add env var `ANTHROPIC_API_KEY`. Scans run in a background function and progress is stored in Netlify Blobs; the app polls `/api/scan-status/:id`.

## Deploy (Fly.io, alternative)

Push to `main` with changes in `wine-babe-app/**`. The workflow `.github/workflows/wine-babe-app-deploy.yml` creates the Fly app `wine-babe-app` if needed, sets `ANTHROPIC_API_KEY` from the GitHub secret of the same name, and deploys.

## iOS / Android later

Wrap this web app with Capacitor (`@capacitor/ios`, `@capacitor/android`) and swap the file input for the native camera plugin.
