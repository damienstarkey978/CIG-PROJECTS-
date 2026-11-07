// Password gate in front of every page and API route.
import { gate, renewCookie } from "../../lib/auth.mjs";

export default async (req, context) => {
  const secret = Netlify.env.get("AUTH_SECRET");
  const res = await gate(req, secret);
  if (res) return res;
  const page = await context.next();
  const cookie = await renewCookie(req, secret);
  if (!cookie) return page;
  const out = new Response(page.body, page);
  out.headers.append("Set-Cookie", cookie);
  return out;
};

// Internal function calls (scan-start kicking the background job) skip the gate.
export const config = { path: "/*", excludedPath: ["/.netlify/*"] };
