import { handle } from "hono/vercel";
import { ensureApiAnythingEnv } from "../src/api-anything-env.js";
import { createApp } from "../src/app.js";

type FetchHandler = (req: Request) => Response | Promise<Response>;

let cachedHandler: FetchHandler | undefined;

function getHandler(): FetchHandler {
  ensureApiAnythingEnv();
  if (!cachedHandler) {
    cachedHandler = handle(createApp());
  }
  return cachedHandler;
}

const dispatch: FetchHandler = (req) => getHandler()(req);

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
export const PATCH = dispatch;
export const OPTIONS = dispatch;
export const HEAD = dispatch;
