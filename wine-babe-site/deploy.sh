#!/bin/sh
# Local/VM fallback. Prefer GitHub Actions (see README.md).
# Needs FLY_API_TOKEN in the environment (GitHub Actions secret, or Cursor
# Cloud Agents secret on a NEW VM). Never paste a token into chat.
set -eu
export PATH="${HOME}/.fly/bin:${PATH}"

if [ -z "${FLY_API_TOKEN:-}" ]; then
  echo "FLY_API_TOKEN is not set. Deploy by pushing to GitHub or running:" >&2
  echo "  gh workflow run \"Deploy wine-babe to Fly.io\" --repo damienstarkey978/CIG-PROJECTS-" >&2
  echo "Do not paste a Fly token into chat." >&2
  exit 1
fi

APP="wine-babe"
cd "$(dirname "$0")"
flyctl deploy --remote-only -a "$APP"
echo "Preview: https://${APP}.fly.dev"
