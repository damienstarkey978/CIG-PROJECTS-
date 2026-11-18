// Accounts: name + email (phone optional). No passwords: a new device signs in
// with a 6 digit code sent by email.
//   GET  /api/account            -> { account, allowance, team }
//   POST /api/account/signup     { name, email, phone? }
//   POST /api/account/code       { email }
//   POST /api/account/verify     { email, code }
//   POST /api/account/signout
//   POST /api/account/delete
import {
  AppError, createAccount, deleteAccount, publicAccount, accountCookie, clearAccountCookie,
  scanAllowance, normEmail, validEmail, findByEmail, issueCode, checkCode, isReviewEmail, reviewSignIn,
} from "../../lib/accounts.mjs";
import { scrubAccountFeedback } from "../../lib/feedback.mjs";
import { sendEmail, emailConfigured } from "../../lib/email.mjs";
import { stores, whoIs, json } from "../../lib/who.mjs";

export default async (req) => {
  const s = stores();
  const who = await whoIs(req, s);
  const cookies = [...who.setCookies];
  const action = new URL(req.url).pathname.replace(/^\/api\/account\/?/, "");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const state = async (account) => ({
    account: publicAccount(account),
    team: Boolean(who.team),
    allowance: await scanAllowance(s.usage, { team: who.team, accountId: account?.id || null, deviceId: who.deviceId, ipHash: who.ipHash }),
  });

  try {
    if (req.method === "GET" && action === "") return json(await state(who.account), { cookies });
    if (req.method !== "POST") return json({ error: "Not found" }, { status: 404 });

    if (action === "signup") {
      const account = await createAccount(s.accounts, body, { deviceId: who.deviceId });
      cookies.push(await accountCookie(who.key, account.id));
      return json(await state(account), { cookies });
    }
    if (action === "code") {
      const email = normEmail(body.email);
      if (!validEmail(email)) throw new AppError(400, "bad_email", "Enter a valid email address.");
      if (isReviewEmail(email)) return json({ ok: true }, { cookies }); // App Review: fixed code, no email
      if (!emailConfigured()) throw new AppError(503, "email_off", "Signing in by email isn't ready yet. Please try again soon.");
      const account = await findByEmail(s.accounts, email);
      if (account) {
        const code = await issueCode(s.accounts, email);
        const mail = await sendEmail({
          to: email,
          subject: `Your Wine Babe Scanner code: ${code}`,
          text: `Your sign in code is ${code}\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.`,
        });
        if (!mail.sent) throw new AppError(502, "email_failed", "We couldn't send the code just now. Please try again.");
      }
      // Same answer either way, so this can't be used to check who has an account.
      return json({ ok: true }, { cookies });
    }
    if (action === "verify") {
      const email = normEmail(body.email);
      if (isReviewEmail(email)) {
        const account = await reviewSignIn(s.accounts, email, body.code);
        cookies.push(await accountCookie(who.key, account.id));
        return json(await state(account), { cookies });
      }
      await checkCode(s.accounts, email, body.code);
      const account = await findByEmail(s.accounts, email);
      if (!account) throw new AppError(400, "code_wrong", "That code isn't right. Check the email and try again.");
      cookies.push(await accountCookie(who.key, account.id));
      return json(await state(account), { cookies });
    }
    if (action === "signout") {
      cookies.push(clearAccountCookie());
      return json(await state(null), { cookies });
    }
    if (action === "delete") {
      if (!who.account) throw new AppError(401, "signed_out", "You're not signed in.");
      await deleteAccount(s.accounts, s.usage, who.account.id);
      await scrubAccountFeedback(s.feedback, who.account.id);
      cookies.push(clearAccountCookie());
      return json({ ...(await state(null)), deleted: true }, { cookies });
    }
    return json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    if (err instanceof AppError) return json({ error: err.message, code: err.code }, { status: err.status, cookies });
    console.error("[account]", err);
    return json({ error: "Something went wrong. Please try again." }, { status: 500, cookies });
  }
};

export const config = { path: ["/api/account", "/api/account/*"] };
