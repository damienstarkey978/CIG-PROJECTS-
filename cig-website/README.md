# Custom Intelligence Group — Website

Static site (no build step). Sections: Hero, Services, Process, Industries, multi-step client onboarding form, FAQ, CTA, Footer.

## Structure
- `index.html` — main page
- `thank-you.html` — form success page (no-JS fallback)
- `css/style.css` — all styles
- `js/main.js` — mobile nav, UTM capture, visit tracking, form logic
- `images/cig-logo.png` — logo
- `netlify.toml` — Netlify config
- `industries/{logistics,accounting,insurance,construction,legal,property-management}/` — email-campaign landing pages
- `_redirects` — short `/go/{industry}` links that keep UTM tags

## Industry landing pages
Each page is plain-language: the pain, what we would build, and a 4-field form (`email-campaign-onboarding`) that takes about two minutes. Emails should link to the page with UTM tags, not to the homepage form.

Example:

`https://customintelligencegroup.com/industries/logistics/?utm_source=email&utm_medium=outbound&utm_campaign=jax-wave1&utm_content=durbin`

`utm_content` is the person slug. That is how we tell which email drove the visit.

Generate or refresh pages with:

```bash
python3 generate_industry_pages.py
```

## How we monitor email campaigns
After a Netlify deploy, two forms show up under **Netlify → Forms**:

1. `campaign-visit` — one row per email click that lands with `utm_source=email` (deduped per browser tab).
2. `email-campaign-onboarding` — the short form on industry pages.

Copy those counts into the Airtable **Campaigns** table (`Emails sent`, `Replies`, `Site visits`, `Form fills`). Rates calculate themselves. Match `utm_content` to the **Outreach** row and check **Clicked site** / **Form submitted**.

Scoreboard: Airtable base **CIG Jacksonville AI Outreach**, interface **Campaign monitor**.

Facebook Pixel `PageView` / `ViewContent` / `Lead` still fire on these pages.

## Local preview
Open `index.html` directly, or serve locally:

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080/industries/logistics/?utm_source=email&utm_medium=outbound&utm_campaign=jax-wave1&utm_content=test`.

## Deploying
See deployment instructions provided separately for connecting to Netlify and your GoDaddy domain, and for setting up form-submission email notifications. Turn on email notifications for both `campaign-visit` and `email-campaign-onboarding`.
