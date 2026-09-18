import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { config } from "../bot/config";

const COOKIE_NAME = "hibid_sniper_session";
const sessions = new Set<string>();

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

const LOGIN_PAGE = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>HiBid Sniper</title>
<style>
  body{margin:0;background:#0b0f14;color:#e8edf3;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
       display:flex;align-items:center;justify-content:center;height:100vh}
  form{background:#151b23;border:1px solid #232c38;border-radius:16px;padding:24px;width:280px}
  h1{font-size:16px;margin:0 0 16px}
  input{width:100%;box-sizing:border-box;background:#0b0f14;border:1px solid #232c38;border-radius:10px;
        padding:10px 12px;color:#e8edf3;font-size:14px;margin-bottom:12px}
  button{width:100%;border:none;border-radius:10px;padding:12px;background:#3d8bfd;color:white;font-weight:700}
  p{color:#e5484d;font-size:13px;margin:0 0 12px;display:none}
</style></head>
<body>
  <form id="f">
    <h1>Enter dashboard password</h1>
    <p id="err">Wrong password.</p>
    <input type="password" name="password" autofocus required />
    <button type="submit">Unlock</button>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = new FormData(e.target).get('password');
      const res = await fetch('/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ password }) });
      if (res.ok) location.reload();
      else document.getElementById('err').style.display = 'block';
    });
  </script>
</body></html>`;

function isAuthorizedCookie(cookieHeader: string | undefined): boolean {
  if (!config.dashboardPassword) return true; // no password set, gate disabled
  const token = parseCookies(cookieHeader)[COOKIE_NAME];
  return !!token && sessions.has(token);
}

/** Used by the WebSocket upgrade handler, which never goes through Express middleware. */
export function isAuthorizedRequest(req: { headers: { cookie?: string } }): boolean {
  return isAuthorizedCookie(req.headers.cookie);
}

export function passwordGate(req: Request, res: Response, next: NextFunction) {
  if (!config.dashboardPassword) return next();
  if (req.path === "/login" || req.path === "/api/health") return next();
  if (isAuthorizedCookie(req.headers.cookie)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.status(401).type("html").send(LOGIN_PAGE);
}

export function handleLogin(req: Request, res: Response) {
  const { password } = req.body ?? {};
  if (!config.dashboardPassword || password !== config.dashboardPassword) {
    return res.status(401).json({ error: "wrong password" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.add(token);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.status(204).end();
}
