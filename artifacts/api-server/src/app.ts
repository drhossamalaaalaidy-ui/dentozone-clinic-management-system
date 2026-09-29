import express, { type Express } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import authRouter from "./routes/auth";
import { logger } from "./lib/logger";
import { csrfIsValid, getOidcSession } from "./lib/oidcSession";

const app: Express = express();
const authProvider = process.env.AUTH_PROVIDER ?? "clerk";
const storageProvider = process.env.STORAGE_PROVIDER ?? "replit";
if (authProvider !== "clerk" && authProvider !== "oidc") {
  throw new Error("AUTH_PROVIDER must be either clerk or oidc");
}
if (storageProvider !== "replit" && storageProvider !== "s3") {
  throw new Error("STORAGE_PROVIDER must be either replit or s3");
}
if (authProvider === "oidc" && storageProvider !== "s3") {
  throw new Error("Portable OIDC deployment requires STORAGE_PROVIDER=s3");
}
if (authProvider === "oidc") {
  for (const key of [
    "DATABASE_URL", "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET",
    "OIDC_REDIRECT_URI", "OIDC_SESSION_SECRET",
  ]) {
    if (!process.env[key]?.trim()) throw new Error(`Portable authentication requires ${key}`);
  }
  const sessionSecret = process.env.OIDC_SESSION_SECRET!;
  if (Buffer.byteLength(sessionSecret) < 32) throw new Error("OIDC_SESSION_SECRET must contain at least 32 bytes");
  for (const key of ["OIDC_ISSUER_URL", "OIDC_REDIRECT_URI"]) {
    const url = new URL(process.env[key]!);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error(`${key} must use HTTPS in production`);
    }
  }
}
if (storageProvider === "s3") {
  for (const key of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
    if (!process.env[key]?.trim()) throw new Error(`Portable document storage requires ${key}`);
  }
  if (process.env.NODE_ENV === "production" && new URL(process.env.S3_ENDPOINT!).protocol !== "https:") {
    throw new Error("S3_ENDPOINT must use HTTPS in production");
  }
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
if (authProvider === "clerk") {
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
}
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (authProvider === "clerk") {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

// Clinic writes are same-origin JSON requests. Avoid credentialed wildcard CORS
// and reject cross-site form submissions before they reach patient data routes.
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get("origin");
  const requestHost = authProvider === "clerk"
    ? getClerkProxyHost(req)
    : req.get("host");
  if (authProvider === "oidc" && !origin) {
    res.status(403).json({ error: "Same-origin writes require an Origin header" });
    return;
  }
  if (origin) {
    try {
      if (new URL(origin).host !== requestHost) {
        res.status(403).json({ error: "Cross-site writes are not allowed" });
        return;
      }
    } catch {
      res.status(403).json({ error: "Invalid request origin" });
      return;
    }
  }
  if (authProvider === "oidc") {
    const session = getOidcSession(req);
    if (session && !csrfIsValid(req, session)) {
      res.status(403).json({ error: "CSRF token is missing or invalid" });
      return;
    }
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "JSON content type required" });
    return;
  }
  next();
});

app.use("/api", authRouter);
app.use("/api", router);

// A single portable image can serve the already-built web app and API at one
// origin. Replit development keeps its existing separate web workflow.
if (process.env.SERVE_STATIC === "true") {
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dentozone/dist/public");
  if (!existsSync(path.join(publicDir, "index.html"))) {
    throw new Error(`Built web app not found in ${publicDir}`);
  }
  app.use(express.static(publicDir, { index: false, maxAge: "1h" }));
  app.get(/.*/, (req, res) => {
    if (req.path.startsWith("/api/") || req.path === "/api") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export default app;
