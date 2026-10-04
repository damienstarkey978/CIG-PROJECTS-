# Wine Babe site

Edit files in this folder, then push to `main`. The GitHub Action deploys automatically to the Fly app `wine-babe`.

The workflow is `.github/workflows/wine-babe-deploy.yml`. It runs on a push to `main` that changes `wine-babe-site/**`, and on manual dispatch. It uses the repository secret `FLY_API_TOKEN`.
