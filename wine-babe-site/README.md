# Wine Babe site

Static one-pager for [wine-babe](https://wine-babe.fly.dev) on Fly.io.

## Deploy

Do not paste a Fly token into chat.

- **Normal path:** push this folder (or `.github/workflows/wine-babe-deploy.yml`) to GitHub. Actions runs `flyctl deploy --remote-only` with `secrets.FLY_API_TOKEN`.
- **Manual:** `gh workflow run "Deploy wine-babe to Fly.io" --repo damienstarkey978/CIG-PROJECTS-`
- **New Cursor Cloud Agent VMs only:** add the same token as a Cursor Cloud Agents secret named `FLY_API_TOKEN`, then `flyctl deploy --remote-only` from `wine-babe/`. Existing VMs do not receive newly added secrets.
