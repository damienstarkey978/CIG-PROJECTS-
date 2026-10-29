#!/bin/sh
set -eu
python3 /analytics.py &
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
