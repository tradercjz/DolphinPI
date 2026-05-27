/**
 * DolphinDB JavaScript API wrapper — connection pool + script execution.
 *
 * Uses the official dolphindb npm package (WebSocket protocol).
 * Maintains a single persistent connection (recreated on config change).
 */

import { DDB } from "dolphindb";
import type { DolphinPiConfig } from "./config";

// ─── Connection pool ──────────────────────────────────────────────────────

let _ddb: DDB | null = null;
let _lastConfigKey: string = "";

function configKey(cfg: DolphinPiConfig): string {
  return `${cfg.host}:${cfg.port}:${cfg.username}:${cfg.password}`;
}

/**
 * Get (or create) a connected DDB instance.
 * Reconnects if config has changed.
 */
export async function getConnection(cfg: DolphinPiConfig): Promise<DDB> {
  const key = configKey(cfg);

  if (_ddb && _lastConfigKey === key) {
    // Reuse existing connection — connect() is idempotent (checks if already connected)
    try {
      await _ddb.connect();
      return _ddb;
    } catch {
      // Connection stale, recreate below
      _ddb = null;
    }
  }

  // Create new connection
  const url = `ws://${cfg.host}:${cfg.port}`;
  _ddb = new DDB(url, {
    autologin: true,
    username: cfg.username ?? "admin",
    password: cfg.password ?? "123456",
  });

  await _ddb.connect();
  _lastConfigKey = key;

  return _ddb;
}

/**
 * Execute a DolphinDB script and return the result as a JSON-stringifiable value.
 */
export async function executeScript(
  cfg: DolphinPiConfig,
  script: string,
): Promise<unknown> {
  const ddb = await getConnection(cfg);
  return ddb.execute(script);
}

/**
 * Close the current connection (e.g., on shutdown / reconfig).
 */
export function closeConnection(): void {
  _ddb = null;
  _lastConfigKey = "";
}
