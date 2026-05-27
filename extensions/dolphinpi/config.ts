/**
 * Configuration management for DolphinPI.
 *
 * Manages two configs:
 * 1. DolphinDB server connection (for script execution + connection test)
 * 2. DolphinMind API connection (for RAG retrieval)
 *
 * Config loading priority (project > global):
 *   <cwd>/.dolphinpi/config.json  >  ~/.dolphinpi/config.json
 *
 * DolphinMind also supports env-var overrides.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Handle self-signed cert on DolphinMind server
if (process.env.DOLPHINPI_TLS_INSECURE || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// ─── DolphinDB connection config ─────────────────────────────────────────

export interface DolphinPiConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** 阿里云 DashScope API Key，用于向量 embedding */
  embeddingApiKey?: string;
}

export const DEFAULT_DDB_CONFIG: DolphinPiConfig = {
  host: "127.0.0.1",
  port: 8848,
  username: "admin",
  password: "123456",
};

// ─── DolphinMind API config ──────────────────────────────────────────────

/** Default DolphinMind server address */
export const DOLPHINMIND_DEFAULT_BASE = "https://dolphindb.cn:8007";

export interface DolphinMindConfig {
  baseUrl: string;
  /** JWT token obtained after login, stored for reuse */
  token: string;
}

// ─── Paths ───────────────────────────────────────────────────────────────

function projectConfigPath(cwd?: string): string {
  return join(cwd ?? process.cwd(), ".dolphinpi", "config.json");
}

function globalConfigPath(): string {
  return join(homedir(), ".dolphinpi", "config.json");
}

// ─── DolphinDB config load/save ──────────────────────────────────────────

/**
 * Load DolphinDB connection config.
 * Priority: project-level > global-level
 */
export function loadConfig(cwd?: string): DolphinPiConfig | null {
  const paths = [projectConfigPath(cwd), globalConfigPath()];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        if (raw && typeof raw.host === "string") return raw as DolphinPiConfig;
      } catch {
        /* corrupt file, try next */
      }
    }
  }
  return null;
}

/** Return the path where config WAS loaded from, or null if none found. */
export function loadedConfigPath(cwd?: string): string | null {
  const paths = [projectConfigPath(cwd), globalConfigPath()];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        if (raw && typeof raw.host === "string") return p;
      } catch {
        /* continue */
      }
    }
  }
  return null;
}

/** Save config to a specific path, creating parent directories if needed. */
export function saveConfigAt(
  config: DolphinPiConfig,
  filePath: string,
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Save to project-level config. */
export function saveProjectConfig(config: DolphinPiConfig, cwd?: string): void {
  saveConfigAt(config, projectConfigPath(cwd));
}

/** Save to global config. */
export function saveGlobalConfig(config: DolphinPiConfig): void {
  saveConfigAt(config, globalConfigPath());
}

/** Check if any DolphinDB config exists. */
export function isDolphinDBConfigured(cwd?: string): boolean {
  return loadConfig(cwd) !== null;
}

/**
 * Build a merged config: loaded values with defaults for missing fields.
 */
export function resolveConfig(cwd?: string): DolphinPiConfig {
  const cfg = loadConfig(cwd);
  return {
    host: cfg?.host ?? DEFAULT_DDB_CONFIG.host,
    port: cfg?.port ?? DEFAULT_DDB_CONFIG.port,
    username: cfg?.username ?? DEFAULT_DDB_CONFIG.username,
    password: cfg?.password ?? DEFAULT_DDB_CONFIG.password,
    embeddingApiKey: cfg?.embeddingApiKey,
  };
}

// ─── DolphinMind API config ──────────────────────────────────────────────

/**
 * Load DolphinMind config from the same config file.
 * Priority: env vars > config file
 */
function loadDolphinMindFromFile(): Partial<DolphinMindConfig> {
  const paths = [projectConfigPath(), globalConfigPath()];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        return {
          baseUrl: raw.dolphinmindBaseUrl,
          token: raw.dolphinmindToken,
        };
      } catch {
        /* continue */
      }
    }
  }
  return {};
}

/**
 * Resolve DolphinMind API config.
 * Priority: env vars > config file > defaults
 */
export function resolveDolphinMindConfig(): DolphinMindConfig {
  const envBase = process.env.DOLPHINPI_DOLPHINMIND_BASE || "";
  const envToken = process.env.DOLPHINPI_DOLPHINMIND_TOKEN || "";

  const file = loadDolphinMindFromFile();

  return {
    baseUrl: (envBase || file.baseUrl || DOLPHINMIND_DEFAULT_BASE).replace(/\/$/, ""),
    token: envToken || file.token || "",
  };
}

/** Check if DolphinMind API is fully configured (baseUrl + token). */
export function isDolphinMindConfigured(): boolean {
  const cfg = resolveDolphinMindConfig();
  return !!(cfg.baseUrl && cfg.token);
}

/**
 * Save DolphinMind settings into the config file at the given scope.
 */
export function saveDolphinMindToScope(
  scope: "project" | "global",
  mindCfg: DolphinMindConfig,
  cwd?: string,
): void {
  const filePath =
    scope === "project" ? projectConfigPath(cwd) : globalConfigPath();

  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf-8"));
      // Remove old narwhal keys if present
      delete existing.narwhalBaseUrl;
      delete existing.narwhalToken;
    } catch { /* overwrite */ }
  }

  const merged = {
    ...existing,
    dolphinmindBaseUrl: mindCfg.baseUrl,
    dolphinmindToken: mindCfg.token,
  };

  saveConfigAt(merged as unknown as DolphinPiConfig, filePath);
}
