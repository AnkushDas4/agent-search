import os from "node:os";
import path from "node:path";

export const APP_VERSION = "1.0.0";

export function isVercelRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

export function getSearchApiKey(): string | undefined {
  const value = process.env.SEARCH_API_KEY?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function getPort(): number {
  const parsed = Number.parseInt(process.env.PORT ?? "8787", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : 8787;
}

export function getHost(): string {
  return process.env.HOST?.trim() || "0.0.0.0";
}

export function getCacheTtlMs(): number {
  const parsed = Number.parseInt(process.env.CACHE_TTL_MS ?? "900000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 900_000;
}

export function getCacheMaxEntries(): number {
  const parsed = Number.parseInt(process.env.CACHE_MAX_ENTRIES ?? "256", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 256;
}

export function getDefaultPersistentCacheDir(): string | undefined {
  if (isVercelRuntime()) {
    return undefined;
  }
  const explicit = process.env.CACHE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), "data", "cache");
}

export function getTempDir(subpath: string): string {
  const base = isVercelRuntime() ? "/tmp" : os.tmpdir();
  return path.join(base, subpath);
}

export function allowLocalhostFetch(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ALLOW_LOCALHOST_FETCH ?? "");
}
