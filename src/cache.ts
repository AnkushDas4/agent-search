import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

interface StoredCacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
}

export interface CacheStats {
  backend: "memory" | "disk+memory";
  entries: number;
  max_entries: number;
  ttl_ms: number;
  persistent_path: string | null;
}

export interface SearchCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  persistentDir?: string;
}

function isWritableDirectory(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export class SearchCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly memory = new Map<string, StoredCacheEntry<unknown>>();
  private persistentDir: string | null = null;

  constructor(options: SearchCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 256);
    this.ttlMs = Math.max(0, options.ttlMs ?? 900_000);
    if (options.persistentDir && isWritableDirectory(options.persistentDir)) {
      this.persistentDir = options.persistentDir;
    }
  }

  private diskFilePath(key: string): string | null {
    if (!this.persistentDir) return null;
    const hash = createHash("sha256").update(key).digest("hex");
    return path.join(this.persistentDir, `${hash}.json`);
  }

  get<T>(key: string): T | undefined {
    if (this.ttlMs === 0) return undefined;
    const now = Date.now();
    const memHit = this.memory.get(key);
    if (memHit) {
      if (memHit.expiresAt <= now) {
        this.memory.delete(key);
        this.removeDisk(key);
        return undefined;
      }
      // Refresh LRU order
      this.memory.delete(key);
      this.memory.set(key, memHit);
      return memHit.value as T;
    }

    const file = this.diskFilePath(key);
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredCacheEntry<T>;
        if (!parsed || parsed.key !== key || parsed.expiresAt <= now) {
          rmSync(file, { force: true });
          return undefined;
        }
        this.setMemory(key, parsed);
        return parsed.value;
      } catch {
        try {
          rmSync(file, { force: true });
        } catch {
          // ignore read-only error
        }
      }
    }

    return undefined;
  }

  set<T>(key: string, value: T): void {
    if (this.ttlMs === 0) return;
    const now = Date.now();
    const entry: StoredCacheEntry<T> = {
      key,
      value,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.setMemory(key, entry);
    this.writeDisk(key, entry);
  }

  private setMemory<T>(key: string, entry: StoredCacheEntry<T>): void {
    if (this.memory.has(key)) {
      this.memory.delete(key);
    } else if (this.memory.size >= this.maxEntries) {
      const oldestKey = this.memory.keys().next().value;
      if (oldestKey !== undefined) {
        this.memory.delete(oldestKey);
      }
    }
    this.memory.set(key, entry);
  }

  private writeDisk<T>(key: string, entry: StoredCacheEntry<T>): void {
    const file = this.diskFilePath(key);
    if (!file || !this.persistentDir) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry), "utf8");
      renameSync(tmp, file);
      this.pruneDiskIfNeeded();
    } catch {
      // Gracefully fall back to memory-only on read-only or full filesystems
      this.persistentDir = null;
    }
  }

  private removeDisk(key: string): void {
    const file = this.diskFilePath(key);
    if (!file) return;
    try {
      rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }

  private pruneDiskIfNeeded(): void {
    if (!this.persistentDir) return;
    try {
      const files = readdirSync(this.persistentDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const full = path.join(this.persistentDir!, f);
          return { full, mtimeMs: statSync(full).mtimeMs };
        });
      const limit = this.maxEntries * 2;
      if (files.length <= limit) return;
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const excess = files.slice(0, files.length - this.maxEntries);
      for (const item of excess) {
        rmSync(item.full, { force: true });
      }
    } catch {
      // ignore pruning error
    }
  }

  clear(): void {
    this.memory.clear();
    if (!this.persistentDir) return;
    try {
      for (const f of readdirSync(this.persistentDir)) {
        if (f.endsWith(".json")) {
          rmSync(path.join(this.persistentDir, f), { force: true });
        }
      }
    } catch {
      // ignore
    }
  }

  getStats(): CacheStats {
    const now = Date.now();
    for (const [k, v] of this.memory.entries()) {
      if (v.expiresAt <= now) {
        this.memory.delete(k);
      }
    }
    return {
      backend: this.persistentDir ? "disk+memory" : "memory",
      entries: this.memory.size,
      max_entries: this.maxEntries,
      ttl_ms: this.ttlMs,
      persistent_path: this.persistentDir,
    };
  }
}
