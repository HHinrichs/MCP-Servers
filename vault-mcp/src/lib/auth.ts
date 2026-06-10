import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const expectedToken = process.env.MCP_BEARER_TOKEN;
if (!expectedToken) {
  throw new Error("MCP_BEARER_TOKEN must be set");
}

const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const expectedTokenBuf = Buffer.from(expectedToken);

function safeTokenEquals(provided: string): boolean {
  const buf = Buffer.from(provided);
  if (buf.length !== expectedTokenBuf.length) return false;
  return timingSafeEqual(buf, expectedTokenBuf);
}

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!safeTokenEquals(token)) {
    res.status(401).json({ error: "invalid bearer token" });
    return;
  }
  next();
}

// DNS-rebinding protection: if MCP_ALLOWED_ORIGINS is set, require Origin to be in
// the whitelist. Requests without Origin (CLI clients like Claude Code) are allowed,
// since they cannot be tricked by a malicious page.
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  if (!origin) {
    next();
    return;
  }
  if (allowedOrigins.length === 0) {
    next();
    return;
  }
  if (!allowedOrigins.includes(origin)) {
    res.status(403).json({ error: "origin not allowed" });
    return;
  }
  next();
}
