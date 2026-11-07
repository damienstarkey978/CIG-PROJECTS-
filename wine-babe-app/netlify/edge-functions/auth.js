// Password gate in front of every page and API route.
import { gate } from "../../lib/auth.mjs";

export default async (req, context) => {
  const res = await gate(req, Netlify.env.get("AUTH_SECRET"));
  return res || context.next();
};

// Internal function calls (scan-start kicking the background job) skip the gate.
export const config = { path: "/*", excludedPath: ["/.netlify/*"] };
