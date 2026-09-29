import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  authorizationUrl,
  clearOidcCookies,
  clearOidcTransactionCookie,
  completeOidcLogin,
  getOidcClient,
  makeAuthorizationTransaction,
  setOidcSession,
  setOidcTransactionCookie,
} from "../lib/oidcSession";

const router: IRouter = Router();

function requireOidc(_req: Request, res: Response, next: NextFunction): void {
  if (process.env.AUTH_PROVIDER !== "oidc") {
    res.status(404).json({ error: "OIDC authentication is not enabled" });
    return;
  }
  next();
}

function frontendPath(path: string): string {
  const base = process.env.OIDC_APP_URL?.trim();
  if (!base) return path;
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OIDC_APP_URL must use HTTP or HTTPS");
  }
  const destination = new URL(path, "https://dentozone.invalid");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${destination.pathname}`;
  url.search = destination.search;
  url.hash = "";
  return url.toString();
}

router.get("/auth/config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ provider: process.env.AUTH_PROVIDER === "oidc" ? "oidc" : "clerk" });
});

router.get("/auth/login", requireOidc, async (_req, res, next) => {
  try {
    const transaction = makeAuthorizationTransaction();
    setOidcTransactionCookie(res, transaction.cookie);
    res.redirect(302, await authorizationUrl(transaction.cookie));
  } catch (error) {
    next(error);
  }
});

router.get("/auth/callback", requireOidc, async (req, res) => {
  try {
    const identity = await completeOidcLogin(req);
    clearOidcTransactionCookie(res);
    setOidcSession(res, identity);
    res.redirect(303, frontendPath("/dashboard"));
  } catch (error) {
    req.log?.warn({ err: error }, "OIDC authentication failed");
    clearOidcCookies(res);
    res.redirect(303, frontendPath("/sign-in?auth_error=login_failed"));
  }
});

router.post("/auth/logout", requireOidc, async (_req, res, next) => {
  try {
    const client = await getOidcClient();
    const appOrigin = new URL(process.env.OIDC_REDIRECT_URI!).origin;
    const redirectUrl = client.endSessionUrl({
      client_id: process.env.OIDC_CLIENT_ID!,
      post_logout_redirect_uri: `${appOrigin}/`,
    });
    clearOidcCookies(res);
    res.json({ redirectUrl });
  } catch (error) {
    next(error);
  }
});

export default router;