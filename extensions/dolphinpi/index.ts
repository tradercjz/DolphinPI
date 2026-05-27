/**
 * DolphinPI — pi-coding-agent extension for DolphinDB programming.
 *
 * Core features:
 * - /ddb:config  — interactive config (DolphinDB connection + DolphinMind login)
 * - /ddb:doctor  — diagnostic check (config, Python SDK, DDB connection, DolphinMind)
 * - dolphindb_search — RAG tool: retrieve DolphinDB docs via DolphinMind
 * - Auto-error-recovery — detects DDB script errors, suggests retrieval
 *
 * ## /ddb:config flow
 *
 *   ┌─ 已有配置？
 *   │   ├─ 是 → [Modify | View JSON | Test Connection | Cancel]
 *   │   └─ 否 → 直接录入
 *   ├─ DolphinDB 连接: Host / Port / User / Password
 *   ├─ DolphinMind 登录: username + password → POST /api/v1/auth/login → 获取 token
 *   ├─ Scope: [Project | Global]
 *   └─ 写入文件
 *
 * ## RAG retrieval (dolphindb_search)
 *
 * dolphindb_search → DolphinMind POST /api/v1/rag/retrieve
 * Server-side pipeline: query rewrite → hybrid search → RRF → rerank → full-text
 * Auth: Bearer <token> (token obtained via login with username+password)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  loadConfig,
  loadedConfigPath,
  saveProjectConfig,
  saveGlobalConfig,
  resolveDolphinMindConfig,
  saveDolphinMindToScope,
  isDolphinMindConfigured,
  DOLPHINMIND_DEFAULT_BASE,
  DEFAULT_DDB_CONFIG,
  type DolphinPiConfig,
} from "./config";
import { getConnection, executeScript, closeConnection } from "./ddb";
import {
  retrieveFromDolphinMind,
  loginToDolphinMind,
  formatResultsAsMarkdown,
  DolphinMindError,
} from "./dolphinmind";

// ─── Error pattern detection ───────────────────────────────────────────────

const DDB_ERROR_PATTERNS = [
  /Syntax Error: \[line \d+\]/i,
  /The function \[.*?\] expects/i,
  /Can't find (the )?(function|object|table|variable)/i,
  /is not a (valid )?(function|table|variable|database|partition)/i,
  /remoteRun.*?failed/i,
  /connect.*?refused|Connection refused/i,
  /Authentication failed/i,
  /dolphindb\.(session|DBConnection|MultithreadedTableWriter)/i,
  /Type (Mismatch|Check|Error)/i,
  /Invalid (parameter|argument)/i,
  /Cannot (convert|cast|assign)/i,
];

function detectDDBError(output: string): boolean {
  return DDB_ERROR_PATTERNS.some((pat) => pat.test(output));
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractTextContent(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  if (typeof content === "object" && content !== null) {
    return JSON.stringify(content);
  }
  return undefined;
}

function describeConfig(cfg: DolphinPiConfig): string {
  return `${cfg.host}:${cfg.port}  user=${cfg.username ?? "admin"}`;
}

// ─── Extension factory ─────────────────────────────────────────────────────

export default function dolphinPI(pi: ExtensionAPI) {
  // ══════════════════════════════════════════════════════════════════════
  // Tool: dolphindb_search
  // ══════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "dolphindb_search",
    label: "DolphinDB Search",
    description:
      "从 DolphinDB 知识库（DolphinMind）检索与问题相关的文档片段。适用于：编写 DolphinDB 代码前查 API 语法/函数签名/参数说明、理解流计算/回测/SQL/分布式等概念、排查脚本报错原因。仅返回参考资料，不生成答案。",
    promptSnippet:
      "从 DolphinDB 知识库 (DolphinMind) 查询函数签名、API 文档、概念说明 — 写脚本前查语法、报错后查原因",
    promptGuidelines: [
      "编写 DolphinDB 脚本前，先用 dolphindb_search 检索相关函数的签名、参数和用法示例，确保语法正确。",
      "DolphinDB 脚本运行报错后，用 dolphindb_search 检索错误信息关键词，查找官方文档中的解决方案。",
      "当用户询问 DolphinDB API、函数、语法或概念问题时，优先调用 dolphindb_search 获取权威参考，而非凭记忆回答。",
      "dolphindb_search 返回的是官方知识库文档片段，请基于这些片段编写代码，不要自行编造不存在的 API。",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "检索问题或关键词。尽量用完整的自然语言描述意图，例如：'如何在 DolphinDB 中进行因子回测' 或 'streamEngineParser 函数的参数说明'",
      }),
      top_k: Type.Optional(
        Type.Number({
          description: "返回文档数量，默认 5，范围 1-20",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const results = await retrieveFromDolphinMind({
          question: params.question,
          topK: params.top_k ?? 5,
          signal,
        });

        const formatted = formatResultsAsMarkdown(results);

        return {
          content: [{ type: "text" as const, text: formatted }],
          details: {
            count: results.length,
            sources: results.map((r) => r.source),
            raw: results,
          },
        };
      } catch (err) {
        if (err instanceof DolphinMindError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            details: { error: err.kind, statusCode: err.statusCode },
          };
        }
        throw err;
      }
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tool: dolphindb_execute — run DolphinDB scripts
  // ══════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "dolphindb_execute",
    label: "DolphinDB Execute",
    description:
      "在 DolphinDB 服务器上执行脚本并返回结果。用于验证编写的 DolphinDB 代码是否正确运行。脚本在已配置的 DolphinDB 服务器上通过 WebSocket 连接执行。",
    promptSnippet:
      "在 DolphinDB 服务器上执行脚本并返回结果",
    promptGuidelines: [
      "写完 DolphinDB 脚本后，用 dolphindb_execute 在服务器上验证脚本是否正确运行。",
      "dolphindb_execute 接受完整的 DolphinDB 脚本（多行），返回执行结果。",
      "运行报错时，先分析错误信息，再用 dolphindb_search 检索修复方案，修改后重新用 dolphindb_execute 验证。",
    ],
    parameters: Type.Object({
      script: Type.String({
        description:
          "要在 DolphinDB 服务器上执行的完整脚本。支持多行语句。例如: 'version()' 或 't = table(1..5 as id, rand(100.0, 5) as val); select * from t'",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const cfg = loadConfig();
      if (!cfg) {
        return {
          content: [{
            type: "text" as const,
            text: "DolphinDB 未配置。请先运行 /ddb:config 配置服务器连接。",
          }],
          details: { error: "not_configured" },
        };
      }

      try {
        const result = await executeScript(cfg, params.script);

        // Format result
        let output: string;
        if (typeof result === "string") {
          output = result;
        } else if (result === undefined || result === null) {
          output = "(执行成功，无返回值)";
        } else {
          try {
            output = JSON.stringify(result, null, 2);
          } catch {
            output = String(result);
          }
        }

        return {
          content: [{ type: "text" as const, text: output }],
          details: { ok: true, raw: result },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `DolphinDB 执行错误: ${msg}`,
          }],
          details: { ok: false, error: msg },
        };
      }
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // Command: /ddb:config
  // ══════════════════════════════════════════════════════════════════════

  pi.registerCommand("ddb:config", {
    description: "配置 DolphinDB 连接和 DolphinMind 登录",
    handler: async (_args, ctx) => {
      const existing = loadConfig();
      const configPath = loadedConfigPath();
      const mindCfg = resolveDolphinMindConfig();

      // ── Step 1: Menu when config exists ────────────────────────────

      if (existing && configPath) {
        const mindStatus = mindCfg.token ? "已登录" : "未登录";
        const action = await ctx.ui.select(
          `当前: ${describeConfig(existing)} | DolphinMind: ${mindStatus}`,
          [
            "Modify DDB 修改 DolphinDB 连接",
            "Login Mind 登录 DolphinMind",
            "View JSON 查看配置",
            "Test DDB 测试 DolphinDB 连接",
            "Cancel 取消",
          ],
        );

        if (!action || action.startsWith("Cancel")) return;

        if (action.startsWith("View JSON")) {
          const display = {
            ...existing,
            dolphinmindToken: mindCfg.token
              ? mindCfg.token.slice(0, 16) + "..."
              : undefined,
          };
          if (mindCfg.baseUrl) {
            (display as Record<string, unknown>).dolphinmindBaseUrl = mindCfg.baseUrl;
          }
          await ctx.ui.select("当前配置", [JSON.stringify(display, null, 2)]);
          return;
        }

        if (action.startsWith("Test DDB")) {
          await testConnection(ctx, existing);
          return;
        }

        if (action.startsWith("Login Mind")) {
          await dolphindMindLoginFlow(ctx, existing ? loadedConfigPath() : null);
          return;
        }

        // "Modify DDB" — fall through to input flow
      }

      // ── Step 2: DolphinDB connection input ─────────────────────────

      const defaults = existing ?? DEFAULT_DDB_CONFIG;

      const host = await ctx.ui.input("DolphinDB Host:", defaults.host);
      if (host === undefined) return;

      const portStr = await ctx.ui.input("DolphinDB Port:", String(defaults.port));
      if (portStr === undefined) return;

      const port = parseInt(portStr, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        ctx.ui.notify(`无效端口: ${portStr}`, "error");
        return;
      }

      const username = await ctx.ui.input(
        "DolphinDB User:",
        defaults.username ?? DEFAULT_DDB_CONFIG.username,
      );
      if (username === undefined) return;

      const password = await ctx.ui.input(
        "DolphinDB Password:",
        defaults.password ?? DEFAULT_DDB_CONFIG.password ?? "",
      );
      if (password === undefined) return;

      const embeddingApiKey = existing?.embeddingApiKey;

      // ── Step 3: Scope ──────────────────────────────────────────────

      const scope = await ctx.ui.select("Scope 保存到:", [
        `Project 项目级  (<cwd>/.dolphinpi/config.json)`,
        `Global  全局级  (~/.dolphinpi/config.json)`,
        `Cancel 取消`,
      ]);

      if (!scope || scope.startsWith("Cancel")) return;

      const isProject = scope.startsWith("Project");

      // ── Step 4: Save DDB config ────────────────────────────────────

      const cfg: DolphinPiConfig = {
        host: host || defaults.host,
        port: port || defaults.port,
        username: username || defaults.username,
        password: password || defaults.password,
        embeddingApiKey,
      };

      if (isProject) {
        saveProjectConfig(cfg);
      } else {
        saveGlobalConfig(cfg);
      }

      const savedPath = isProject
        ? "<cwd>/.dolphinpi/config.json"
        : "~/.dolphinpi/config.json";

      ctx.ui.notify(
        `✅ DolphinDB 配置已保存到 ${savedPath}\n${describeConfig(cfg)}`,
        "success",
      );

      // ── Step 5: DolphinMind login ──────────────────────────────────

      const mindCurrent = resolveDolphinMindConfig();
      if (!mindCurrent.token) {
        const setupMind = await ctx.ui.confirm(
          "DolphinMind 登录",
          "是否登录 DolphinMind（用于文档检索）？\n需要 DolphinMind 用户名和密码。",
        );
        if (setupMind) {
          await dolphindMindLoginFlow(ctx, isProject ? "project" : "global");
        }
      }
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // Command: /ddb:doctor
  // ══════════════════════════════════════════════════════════════════════

  pi.registerCommand("ddb:doctor", {
    description: "检查 DolphinPI 配置和连接状态",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      let allOk = true;

      // Config file
      const cfg = loadConfig();
      const cfgPath = loadedConfigPath();
      if (cfg && cfgPath) {
        lines.push(`✅ 配置文件: ${cfgPath}`);
        lines.push(`   DolphinDB: ${cfg.host}:${cfg.port}  user=${cfg.username ?? "admin"}`);
      } else {
        lines.push(`❌ 未找到配置文件`);
        lines.push(`   期望: <cwd>/.dolphinpi/config.json 或 ~/.dolphinpi/config.json`);
        allOk = false;
      }

      // Node.js SDK
      try {
        require.resolve("dolphindb");
        lines.push(`✅ dolphindb JS SDK: 已安装`);
      } catch {
        lines.push(`⚠️  dolphindb JS SDK: 未安装`);
      }

      // DolphinDB connection (WebSocket)
      if (cfg) {
        ctx.ui.notify("正在连接 DolphinDB (WebSocket)...", "info");
        try {
          const ddb = await getConnection(cfg);
          const ver = await ddb.execute("version()") as string;
          lines.push(`✅ DolphinDB 连接: 正常 (v${ver})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lines.push(`❌ DolphinDB 连接: 失败`);
          lines.push(`   ${msg.split("\n")[0]}`);
          allOk = false;
        }
      } else {
        lines.push(`⊘  DolphinDB 连接: 跳过 (无配置)`);
      }

      // DolphinMind
      if (isDolphinMindConfigured()) {
        const mind = resolveDolphinMindConfig();
        lines.push(`✅ DolphinMind: ${mind.baseUrl} (已登录)`);
      } else {
        const mind = resolveDolphinMindConfig();
        if (mind.baseUrl) {
          lines.push(`⚠️  DolphinMind: ${mind.baseUrl} (未登录，运行 /ddb:config)`);
        } else {
          lines.push(`⊘  DolphinMind: 未配置 (运行 /ddb:config)`);
        }
      }

      const status = allOk ? "✅ 全部检查通过" : "⚠️ 存在需要修复的问题";
      await ctx.ui.select(status, lines);
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // Event: tool_result — detect DDB errors and suggest retrieval
  // ══════════════════════════════════════════════════════════════════════

  let lastErrorSuggestTime = 0;

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const content = extractTextContent(event.content);
    if (!content || !detectDDBError(content)) return;

    const now = Date.now();
    if (now - lastErrorSuggestTime < 30000) return;
    lastErrorSuggestTime = now;

    if (isDolphinMindConfigured()) {
      ctx.ui.notify(
        "⚠️ 检测到 DolphinDB 脚本报错。可以让我用 dolphindb_search 检索文档来修复。",
        "warning",
      );
    } else {
      ctx.ui.notify(
        "⚠️ 检测到 DolphinDB 脚本报错。运行 /ddb:config 登录 DolphinMind 后可自动检索。",
        "warning",
      );
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // Event: session_shutdown — cleanup DDB connection
  // ══════════════════════════════════════════════════════════════════════

  pi.on("session_shutdown", async () => {
    closeConnection();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Event: session_start — show config status in footer
  // ══════════════════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    const cfg = loadConfig();
    const mindOK = isDolphinMindConfigured();

    if (mindOK && cfg) {
      const mind = resolveDolphinMindConfig();
      ctx.ui.setStatus("dolphinpi", `🐬 DDB:${cfg.host}:${cfg.port}  Mind:${mind.baseUrl}`);
    } else if (cfg) {
      ctx.ui.setStatus("dolphinpi", `🐬 DDB:${cfg.host}:${cfg.port}  /ddb:config`);
    } else {
      ctx.ui.setStatus("dolphinpi", "🐬 /ddb:config 配置 DolphinDB");
    }
  });
}

// ─── UI helpers ────────────────────────────────────────────────────────────

async function testConnection(ctx: ExtensionContext, cfg: DolphinPiConfig): Promise<void> {
  ctx.ui.notify("正在连接 DolphinDB (WebSocket)...", "info");

  try {
    const ddb = await getConnection(cfg);
    const version = await ddb.execute("version()") as string;
    await ctx.ui.select("DolphinDB 连接测试", [`✅ Connected — v${version}`]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.ui.select("DolphinDB 连接测试", [`❌ Connection failed`, ``, msg]);
  }
}

/**
 * DolphinMind login flow:
 * 1. Show current server address
 * 2. Ask for username + password
 * 3. POST /api/v1/auth/login → get token
 * 4. Save token to config
 */
async function dolphindMindLoginFlow(
  ctx: ExtensionContext,
  scopeOrPath: "project" | "global" | string | null,
): Promise<void> {
  const current = resolveDolphinMindConfig();

  // Base URL is always the default — user never sets it
  const baseUrl = DOLPHINMIND_DEFAULT_BASE;

  // Ask for country code + phone number + password
  const countryCode = await ctx.ui.input("区号 (例如 86):", "86");
  if (countryCode === undefined) return;

  const phone = await ctx.ui.input("手机号:", "");
  if (phone === undefined || !phone.trim()) {
    ctx.ui.notify("手机号不能为空，登录取消。", "warning");
    return;
  }

  const password = await ctx.ui.input("密码:", "");
  if (password === undefined || !password.trim()) {
    ctx.ui.notify("密码不能为空，登录取消。", "warning");
    return;
  }

  ctx.ui.notify("正在登录 DolphinMind...", "info");

  try {
    const token = await loginToDolphinMind(
      countryCode.trim() || "86",
      phone.trim(),
      password,
    );

    // Determine save scope
    let scope: "project" | "global";
    if (scopeOrPath === "project" || scopeOrPath === "global") {
      scope = scopeOrPath;
    } else if (scopeOrPath && scopeOrPath.includes(process.cwd())) {
      scope = "project";
    } else {
      scope = "global";
    }

    saveDolphinMindToScope(scope, { baseUrl, token });

    const scopeLabel = scope === "project"
      ? "<cwd>/.dolphinpi/config.json"
      : "~/.dolphinpi/config.json";

    ctx.ui.notify(
      `✅ DolphinMind 登录成功！\nToken 已保存到 ${scopeLabel}`,
      "success",
    );
  } catch (err) {
    if (err instanceof DolphinMindError) {
      await ctx.ui.select("DolphinMind 登录失败", [`❌ ${err.message}`]);
    } else {
      ctx.ui.notify(`DolphinMind 登录异常: ${String(err)}`, "error");
    }
  }
}
