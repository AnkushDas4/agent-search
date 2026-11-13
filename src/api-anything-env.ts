import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTempDir, isVercelRuntime } from "./config.js";

let lastSyncedHome: string | undefined;

function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "1", "utf8");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function resolveRepoSitesDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "sites"),
    path.resolve(here, "../sites"),
    path.resolve(here, "../../sites"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

/**
 * Ensures `api-anything` never attempts writes outside `/tmp` on Vercel and always
 * sees our committed `./sites/*.json` specs regardless of runtime environment.
 */
export function ensureApiAnythingEnv(): { home: string; sitesDir: string | undefined; synced: string[] } {
  if (!process.env.API_ANYTHING_LOCAL_ONLY) {
    process.env.API_ANYTHING_LOCAL_ONLY = "1";
  }

  let home = process.env.API_ANYTHING_HOME?.trim();
  const managedHome = !home;
  if (!home) {
    if (isVercelRuntime()) {
      home = getTempDir("api-anything");
    } else {
      const localHome = path.resolve(process.cwd(), "data", "api-anything");
      home = isWritableDir(localHome) ? localHome : getTempDir("agent-search-api-anything");
    }
    process.env.API_ANYTHING_HOME = home;
  }

  const sitesDir = resolveRepoSitesDir();
  const synced: string[] = [];

  if (lastSyncedHome !== home) {
    try {
      const targetDir = path.join(home, "sites");
      mkdirSync(targetDir, { recursive: true });
      if (sitesDir) {
        const expectedFiles = new Set<string>();
        for (const file of readdirSync(sitesDir)) {
          if (!file.endsWith(".json") && !file.endsWith(".md")) continue;
          expectedFiles.add(file);
          const src = path.join(sitesDir, file);
          const dst = path.join(targetDir, file);
          if (!existsSync(dst)) {
            copyFileSync(src, dst);
            synced.push(file);
          } else if (managedHome || isVercelRuntime()) {
            const srcBuf = readFileSync(src, "utf8");
            const dstBuf = readFileSync(dst, "utf8");
            if (srcBuf !== dstBuf) {
              copyFileSync(src, dst);
              synced.push(file);
            }
          }
        }
        // Remove stale repo specs (e.g. startpage.json / qwant.json) from managed runtime dirs
        if (managedHome || isVercelRuntime()) {
          for (const existing of readdirSync(targetDir)) {
            if ((existing.endsWith(".json") || existing.endsWith(".md")) && !expectedFiles.has(existing)) {
              rmSync(path.join(targetDir, existing), { force: true });
            }
          }
        }
      }
    } catch {
      // Read-only filesystem fallback: api-anything still has bundled sites and direct HTTP fallbacks handle custom specs.
    }
    lastSyncedHome = home;
  }

  return { home, sitesDir, synced };
}
