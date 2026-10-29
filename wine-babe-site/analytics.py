#!/usr/bin/env python3
"""Private visitor counts for the Wine Babe site.

Browsers send one page view to /collect. /stats is a password-protected
summary. Nothing here is shown on the public pages.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DB_PATH = os.environ.get("STATS_DB", "/data/visits.sqlite")
STATS_USER = os.environ.get("STATS_USER", "winebabe")
STATS_PASSWORD = os.environ.get("STATS_PASSWORD", "")
HOST = "127.0.0.1"
PORT = 8081

PATH_RE = re.compile(r"^/[A-Za-z0-9/_.-]{0,180}$")
VID_RE = re.compile(r"^[A-Za-z0-9-]{8,80}$")

_db_lock = threading.Lock()


def connect():
    folder = os.path.dirname(DB_PATH)
    if folder:
        os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS views (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            day TEXT NOT NULL,
            path TEXT NOT NULL,
            vid_hash TEXT NOT NULL,
            referrer TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_views_day ON views(day)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_views_vid_ts ON views(vid_hash, ts)")
    return conn


def today():
    return datetime.now(ET).date()


def clean_referrer(value):
    if not isinstance(value, str):
        return ""
    value = value.strip().replace("\n", " ").replace("\r", "")
    return value[:300]


def record(path, vid, referrer):
    now = datetime.now(ET)
    vid_hash = hashlib.sha256(vid.encode()).hexdigest()
    ts = int(now.timestamp())
    hour_ago = ts - 3600
    with _db_lock:
        conn = connect()
        try:
            recent = conn.execute(
                "SELECT COUNT(*) FROM views WHERE vid_hash = ? AND ts >= ?",
                (vid_hash, hour_ago),
            ).fetchone()[0]
            if recent >= 60:
                return
            conn.execute(
                "INSERT INTO views (ts, day, path, vid_hash, referrer) VALUES (?, ?, ?, ?, ?)",
                (ts, now.date().isoformat(), path, vid_hash, referrer or None),
            )
            conn.commit()
        finally:
            conn.close()


def summary():
    start_today = today()
    windows = {
        "Today": start_today.isoformat(),
        "Last 7 days": (start_today - timedelta(days=6)).isoformat(),
        "Last 14 days": (start_today - timedelta(days=13)).isoformat(),
        "All time": "1970-01-01",
    }
    with _db_lock:
        conn = connect()
        try:
            cards = []
            for label, start in windows.items():
                row = conn.execute(
                    """
                    SELECT COUNT(*), COUNT(DISTINCT vid_hash)
                    FROM views WHERE day >= ?
                    """,
                    (start,),
                ).fetchone()
                cards.append((label, row[0], row[1]))
            days = conn.execute(
                """
                SELECT day, COUNT(*), COUNT(DISTINCT vid_hash)
                FROM views
                WHERE day >= ?
                GROUP BY day
                ORDER BY day DESC
                """,
                (windows["Last 14 days"],),
            ).fetchall()
            pages = conn.execute(
                """
                SELECT path, COUNT(*), COUNT(DISTINCT vid_hash)
                FROM views
                WHERE day >= ?
                GROUP BY path
                ORDER BY COUNT(*) DESC
                LIMIT 12
                """,
                (windows["Last 14 days"],),
            ).fetchall()
        finally:
            conn.close()
    return cards, days, pages


def esc(value):
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def page():
    cards, days, pages = summary()
    card_html = "".join(
        f"<section><h2>{esc(label)}</h2><p><strong>{views}</strong> page views</p>"
        f"<p><strong>{visitors}</strong> visitors</p></section>"
        for label, views, visitors in cards
    )
    day_rows = "".join(
        f"<tr><td>{esc(day)}</td><td>{views}</td><td>{visitors}</td></tr>"
        for day, views, visitors in days
    ) or "<tr><td colspan='3'>No visits yet.</td></tr>"
    page_rows = "".join(
        f"<tr><td>{esc(path)}</td><td>{views}</td><td>{visitors}</td></tr>"
        for path, views, visitors in pages
    ) or "<tr><td colspan='3'>No visits yet.</td></tr>"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Wine Babe visitors</title>
  <style>
    body {{ margin: 0; font: 16px/1.45 Georgia, serif; background: #f3ebe3; color: #241c16; }}
    main {{ width: min(46rem, calc(100% - 2rem)); margin: 2rem auto 3rem; }}
    h1 {{ font-weight: 600; font-size: 2rem; margin: 0 0 0.4rem; }}
    .note {{ color: #6d6258; margin: 0 0 1.5rem; }}
    .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.8rem; }}
    section {{ background: #fffaf6; padding: 0.9rem 1rem; }}
    h2 {{ font-size: 0.95rem; margin: 0 0 0.4rem; }}
    p {{ margin: 0.15rem 0; }}
    table {{ width: 100%; border-collapse: collapse; background: #fffaf6; margin-top: 0.6rem; }}
    th, td {{ text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid #eadfd4; }}
    h3 {{ margin: 1.6rem 0 0.2rem; }}
  </style>
</head>
<body>
  <main>
    <h1>Wine Babe visitors</h1>
    <p class="note">Times are Eastern. A visitor is one browser. Refreshing the site counts as another page view, not another visitor. Dates run through today.</p>
    <div class="cards">{card_html}</div>
    <h3>Last 14 days</h3>
    <table>
      <thead><tr><th>Day</th><th>Page views</th><th>Visitors</th></tr></thead>
      <tbody>{day_rows}</tbody>
    </table>
    <h3>Pages, last 14 days</h3>
    <table>
      <thead><tr><th>Page</th><th>Page views</th><th>Visitors</th></tr></thead>
      <tbody>{page_rows}</tbody>
    </table>
  </main>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _send(self, status, body=b"", content_type="text/plain; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex")
        if extra:
            for key, value in extra:
                self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _authorized(self):
        if not STATS_PASSWORD:
            return False
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:], validate=True).decode()
        except (ValueError, UnicodeDecodeError):
            return False
        user, sep, password = decoded.partition(":")
        if not sep:
            return False
        return secrets.compare_digest(user, STATS_USER) and secrets.compare_digest(password, STATS_PASSWORD)

    def do_GET(self):
        path = urlparse(self.path).path
        if path != "/stats":
            self._send(404, b"Not found")
            return
        if not self._authorized():
            self._send(401, b"Sign in required", extra=[("WWW-Authenticate", 'Basic realm="Wine Babe visitors"')])
            return
        body = page().encode()
        self._send(200, body, "text/html; charset=utf-8")

    def do_POST(self):
        if urlparse(self.path).path != "/collect":
            self._send(404, b"Not found")
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 2048:
            self._send(204)
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send(204)
            return
        path = payload.get("path")
        vid = payload.get("vid")
        if not isinstance(path, str) or not PATH_RE.match(path) or path.startswith("/stats"):
            self._send(204)
            return
        if not isinstance(vid, str) or not VID_RE.match(vid):
            self._send(204)
            return
        try:
            record(path, vid, clean_referrer(payload.get("ref")))
        except sqlite3.Error:
            pass
        self._send(204)


def main():
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
