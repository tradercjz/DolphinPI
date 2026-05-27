/**
 * Thin HTTP client for DolphinMind RAG API.
 *
 * ## Two operations:
 *
 * 1. login(countryCode, nationalNumber, password) → POST /api/v1/auth/login → returns JWT token
 * 2. retrieve(question, topK, token) → 
 *    a) POST /api/v1/rag/conversations  (create session)
 *    b) POST /api/v1/rag/chat (multipart/form-data) → parse SSE stream for source docs
 *
 * Chat endpoint returns SSE events:
 *   - type: "status"   → progress message
 *   - type: "source"   → document fragment (file_path + content)
 *   - type: "content"  → LLM-generated answer chunk (ignored — pi's own LLM handles this)
 *   - type: "end"      → stream finished
 *   - type: "error"    → error
 *
 * We collect only "source" events and discard LLM-generated content.
 */

import {
  resolveDolphinMindConfig,
  isDolphinMindConfigured,
  DOLPHINMIND_DEFAULT_BASE,
} from "./config";

// ─── Types ────────────────────────────────────────────────────────────────

export interface RetrievalResult {
  source: string;
  content: string;
  score: number;
  start_line?: number;
  end_line?: number;
  metadata?: Record<string, unknown>;
}

interface LoginResponse {
  code: number;
  message?: string;
  data?: {
    token: string;
    official_token?: string;
  };
}

interface ConvResponse {
  conversation_id: string;
}

interface SSEEvent {
  type: string;
  message?: string;
  file_path?: string;
  content?: string;
  detail?: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────

export enum DolphinMindErrorKind {
  NotConfigured = "not_configured",
  Network = "network",
  Auth = "auth",
  Forbidden = "forbidden",
  RateLimit = "rate_limit",
  Server = "server",
}

export class DolphinMindError extends Error {
  constructor(
    message: string,
    public readonly kind: DolphinMindErrorKind,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DolphinMindError";
  }
}

// ─── Internal helper ──────────────────────────────────────────────────────

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

// ─── Login ────────────────────────────────────────────────────────────────

/**
 * Login to DolphinMind with countryCode + nationalNumber + password.
 * POST /api/v1/auth/login → returns JWT token.
 */
export async function loginToDolphinMind(
  countryCode: string,
  nationalNumber: string,
  password: string,
  signal?: AbortSignal,
): Promise<string> {
  const { baseUrl } = resolveDolphinMindConfig();

  const body: Record<string, string> = { password };
  if (countryCode) body.countryCode = countryCode;
  if (nationalNumber) body.nationalNumber = nationalNumber;

  const resp = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const preview = text.slice(0, 300);

    switch (resp.status) {
      case 401:
        throw new DolphinMindError(
          `DolphinMind 登录失败: 手机号或密码错误。${preview}`,
          DolphinMindErrorKind.Auth,
          resp.status,
        );
      case 422:
        throw new DolphinMindError(
          `DolphinMind 登录失败: 参数不完整。${preview}`,
          DolphinMindErrorKind.Auth,
          resp.status,
        );
      case 429:
        throw new DolphinMindError(
          `DolphinMind 登录频率限制，请稍后再试。`,
          DolphinMindErrorKind.RateLimit,
          resp.status,
        );
      default:
        throw new DolphinMindError(
          `DolphinMind 登录失败 [${resp.status}]: ${preview}`,
          DolphinMindErrorKind.Network,
          resp.status,
        );
    }
  }

  let respBody: LoginResponse;
  try {
    respBody = (await resp.json()) as LoginResponse;
  } catch {
    throw new DolphinMindError(
      "DolphinMind 登录响应格式异常",
      DolphinMindErrorKind.Network,
    );
  }

  if ((respBody.code === 0 || respBody.code === 200) && respBody.data?.token) {
    return respBody.data.token;
  }

  throw new DolphinMindError(
    respBody.message || `登录失败 (code=${respBody.code})`,
    DolphinMindErrorKind.Auth,
  );
}

// ─── Retrieve (via chat endpoint) ─────────────────────────────────────────

/**
 * Create a new RAG conversation.
 * POST /api/v1/rag/conversations
 */
async function createConversation(token: string, signal?: AbortSignal): Promise<string> {
  const { baseUrl } = resolveDolphinMindConfig();

  const resp = await fetch(`${baseUrl}/api/v1/rag/conversations`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: "{}",
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new DolphinMindError(
      `DolphinMind 创建会话失败 [${resp.status}]: ${text.slice(0, 300)}`,
      DolphinMindErrorKind.Network,
      resp.status,
    );
  }

  const data = (await resp.json()) as ConvResponse;
  return data.conversation_id;
}

/**
 * Build a manual multipart/form-data body.
 * Avoids relying on the FormData global which may behave inconsistently in some Node.js runtimes.
 */
function buildMultipartBody(fields: Record<string, string>): { body: string; contentType: string } {
  const boundary = "----DolphinPI" + Math.random().toString(36).slice(2);
  const parts: string[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n` +
      `\r\n` +
      `${value}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);

  return { body: parts.join(""), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Send a question via the chat endpoint and collect source documents from the SSE stream.
 *
 * POST /api/v1/rag/chat (multipart/form-data, manually constructed)
 *
 * Only collects "source" type events. Discards LLM-generated "content" events
 * because pi's own LLM will generate the final answer from the documents.
 */
async function chatAndCollectSources(
  token: string,
  conversationId: string,
  question: string,
  signal?: AbortSignal,
): Promise<RetrievalResult[]> {
  const { baseUrl } = resolveDolphinMindConfig();

  const { body, contentType } = buildMultipartBody({
    question,
    conversation_id: conversationId,
    stream: "true",
  });

  const resp = await fetch(`${baseUrl}/api/v1/rag/chat`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": contentType },
    body,
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const preview = text.slice(0, 300);

    switch (resp.status) {
      case 401:
        throw new DolphinMindError(
          `DolphinMind 认证失败 (401)，Token 可能已过期。${preview}`,
          DolphinMindErrorKind.Auth,
          resp.status,
        );
      case 403:
        throw new DolphinMindError(
          `DolphinMind 无权限 (403)。${preview}`,
          DolphinMindErrorKind.Forbidden,
          resp.status,
        );
      case 429:
        throw new DolphinMindError(
          `DolphinMind 配额用尽 (429)。`,
          DolphinMindErrorKind.RateLimit,
          resp.status,
        );
      default:
        throw new DolphinMindError(
          `DolphinMind 检索失败 [${resp.status}]: ${preview}`,
          resp.status >= 500 ? DolphinMindErrorKind.Server : DolphinMindErrorKind.Network,
          resp.status,
        );
    }
  }

  // Parse SSE stream
  const text = await resp.text();
  return parseSSEForSources(text);
}

/**
 * Parse SSE (Server-Sent Events) text for "source" type events.
 *
 * Each SSE event has the format:
 *   data: {"type":"source","file_path":"...","content":"..."}
 *
 * We collect only "source" events and deduplicate by file_path.
 */
function parseSSEForSources(sseText: string): RetrievalResult[] {
  const lines = sseText.split("\n");
  const sources: RetrievalResult[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;

    const jsonStr = line.slice(6).trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;

    try {
      const event: SSEEvent = JSON.parse(jsonStr);

      if (event.type === "error") {
        // Don't add error as source, but collect message
        continue;
      }

      if (event.type === "source" && event.file_path && event.content) {
        // Deduplicate by file_path
        if (seen.has(event.file_path)) continue;
        seen.add(event.file_path);

        sources.push({
          source: event.file_path,
          content: event.content,
          score: 1.0, // Server doesn't return scores in this mode
        });
      }
    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }

  return sources;
}

/**
 * Search DolphinDB documentation via DolphinMind.
 *
 * Since the /retrieve endpoint is not available on this server,
 * we use the chat endpoint: create conversation → ask question → collect source docs.
 *
 * Returns formatted results ready for LLM context injection.
 */
export async function retrieveFromDolphinMind(params: {
  question: string;
  topK?: number;
  signal?: AbortSignal;
}): Promise<RetrievalResult[]> {
  if (!isDolphinMindConfigured()) {
    throw new DolphinMindError(
      "DolphinMind API 未配置。请运行 /ddb:config 登录 DolphinMind（需要手机号和密码），" +
        "或设置环境变量 DOLPHINPI_DOLPHINMIND_TOKEN。",
      DolphinMindErrorKind.NotConfigured,
    );
  }

  const { token } = resolveDolphinMindConfig();

  // Step 1: Create a new conversation
  const conversationId = await createConversation(token, params.signal);

  // Step 2: Chat and collect source documents
  const sources = await chatAndCollectSources(
    token,
    conversationId,
    params.question,
    params.signal,
  );

  // Limit to topK
  const topK = params.topK ?? 5;
  return sources.slice(0, topK);
}

// ─── Formatting ───────────────────────────────────────────────────────────

/**
 * Format retrieval results as Markdown for LLM consumption.
 */
export function formatResultsAsMarkdown(results: RetrievalResult[]): string {
  if (results.length === 0) {
    return "未找到相关文档。请尝试调整检索关键词或检查知识库配置。";
  }

  let md = `从 DolphinDB 知识库检索到 ${results.length} 条相关文档：\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const loc =
      r.start_line != null && r.end_line != null
        ? ` (第${r.start_line}-${r.end_line}行)`
        : "";

    md += `### [${i + 1}] ${r.source}${loc}\n`;
    md += `**相关度**: ${r.score.toFixed(4)}\n\n`;
    md += r.content.trim();
    md += "\n\n---\n\n";
  }

  md += "\n请基于以上文档内容回答问题或编写代码。如文档信息不足，请如实告知用户。";

  return md;
}
