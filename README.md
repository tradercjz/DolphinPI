# DolphinPI

<p align="center">
  <strong>🐬 基于 <a href="https://pi.dev">pi-coding-agent</a> 的 DolphinDB 智能编程助手</strong>
</p>

<p align="center">
  RAG 文档检索 · WebSocket 脚本执行 · 自动错误修复
</p>

---

## 概述

DolphinPI 是一个 pi-coding-agent 扩展包，专为 **DolphinDB** 开发者设计。它集成了两大能力：

| 能力 | 实现 | 说明 |
|------|------|------|
| **RAG 文档检索** | DolphinMind 知识库 | 编写脚本前自动查询官方 API 文档、函数签名和用法示例 |
| **脚本执行验证** | dolphindb WebSocket | 写完脚本直接在服务器上运行验证，即时反馈结果 |

LLM 在生成每行 DolphinDB 代码前都会先检索官方文档，不会凭记忆编造不存在的 API。

## 快速开始

### 1. 安装

```bash
pi install /path/to/DolphinPI
```

### 2. 设置 TLS（DolphinMind 使用自签证书）

```bash
export DOLPHINPI_TLS_INSECURE=1
```

### 3. 启动配置

```bash
pi
/ddb:config
```

按提示完成两步配置：

- **DolphinDB 服务器** — 主机、端口、用户名、密码
- **DolphinMind 登录** — 区号（默认 86）、手机号、密码 → 自动获取 JWT Token

### 4. 诊断验证

```
/ddb:doctor
```

一键检查：配置文件 → JS SDK → DolphinDB WebSocket 连接 → DolphinMind API 状态。

### 5. 开始编程

```
用户: 帮我写一个 DolphinDB 因子回测脚本

LLM 自动流程:
  dolphindb_search("因子回测最佳实践")
       ↓
  基于文档生成脚本
       ↓
  dolphindb_execute(script)
       ↓
  ✅ 执行成功 / ❌ 报错 → dolphindb_search(错误信息) → 修复 → 重新执行
```

## 命令与工具

### 命令

| 命令 | 功能 |
|------|------|
| `/ddb:config` | 交互式配置 DolphinDB 连接 + DolphinMind 登录 |
| `/ddb:doctor` | 诊断检查：配置、SDK、DolphinDB 连接、DolphinMind 状态 |

#### `/ddb:config` 交互流程

```
首次配置:
  ├─ DolphinDB Host / Port / User / Password
  ├─ Scope: Project (<cwd>/.dolphinpi/config.json) 或 Global (~/.dolphinpi/config.json)
  └─ 可选：登录 DolphinMind（区号 + 手机号 + 密码）

已有配置:
  └─ [Modify DDB | Login Mind | View JSON | Test DDB | Cancel]
       ├─ View JSON  → 查看当前完整配置
       ├─ Test DDB   → WebSocket 连接验证 (执行 version())
       └─ Login Mind → 手机号登录获取 Token
```

### LLM 工具

| 工具 | 触发场景 | 功能 |
|------|---------|------|
| `dolphindb_search` | 写代码前 / 报错后 / 用户询问 API | 从 DolphinDB 官方知识库检索文档，返回 Markdown 格式片段 |
| `dolphindb_execute` | 写完脚本需要验证 | 通过 WebSocket 在服务器上执行脚本，返回结果 |

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                      DolphinPI                          │
│                                                         │
│  ┌──────────────────┐  ┌─────────────────────────────┐ │
│  │ dolphindb_search │  │      dolphindb_execute      │ │
│  │                  │  │                             │ │
│  │ HTTP multipart   │  │    WebSocket (dolphindb)    │ │
│  │       ↓          │  │             ↓               │ │
│  │ DolphinMind API  │  │    DolphinDB Server         │ │
│  │ :8007            │  │    ws://host:port           │ │
│  │                  │  │                             │ │
│  │ 服务端 RAG 管道:  │  │    execute("script")        │ │
│  │ 查询改写          │  │    → 序列化结果             │ │
│  │ → 混合检索        │  │                             │ │
│  │ → RRF 融合       │  └─────────────────────────────┘ │
│  │ → Rerank         │                                   │
│  │ → 全文加载        │   ┌─────────────────────────────┐ │
│  └──────────────────┘   │       事件监听               │ │
│                          │  tool_result → 检测 DDB 错误 │ │
│                          │  session_start → Footer 状态 │ │
│                          │  session_shutdown → 清理连接 │ │
│                          └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**关键设计决策：**

- **RAG 逻辑全部在服务端** — DolphinPI 只做 HTTP 调用和格式化，不包含向量检索、BM25、Rerank 等
- **JavaScript 原生连接** — 使用 `dolphindb` npm 包（WebSocket），无需 Python 子进程
- **只收集文档，不生成答案** — chat SS 流中忽略 LLM 生成的 `content` 事件，只保留 `source` 文档片段。最终答案由 pi 的 LLM 基于文档生成

## 配置

### 配置文件

优先级：**项目级 > 全局级 > 默认值**

```
<cwd>/.dolphinpi/config.json    # 项目级
~/.dolphinpi/config.json        # 全局级
```

```json
{
  "host": "127.0.0.1",
  "port": 8848,
  "username": "admin",
  "password": "123456",
  "embeddingApiKey": "...",
  "dolphinmindToken": "eyJ...",
  "dolphinmindBaseUrl": "https://dolphindb.cn:8007"
}
```

### 环境变量

| 变量 | 用途 | 说明 |
|------|------|------|
| `DOLPHINPI_DDB_HOST` | DolphinDB 主机 | 默认 `127.0.0.1` |
| `DOLPHINPI_DDB_PORT` | DolphinDB 端口 | 默认 `8848` |
| `DOLPHINPI_DDB_USER` | DolphinDB 用户名 | 默认 `admin` |
| `DOLPHINPI_DDB_PASS` | DolphinDB 密码 | 默认 `123456` |
| `DOLPHINPI_DOLPHINMIND_TOKEN` | DolphinMind JWT | 跳过登录直接使用 |
| `DOLPHINPI_TLS_INSECURE` | 跳过 TLS 验证 | 设为 `1`（DolphinMind 自签证书必须） |

环境变量优先级高于配置文件，但低于 `/ddb:config` 交互式输入。

## 项目结构

```
DolphinPI/
├── package.json                     # pi 包描述 + dolphindb 依赖
├── README.md
├── extensions/dolphinpi/
│   ├── index.ts                     # 主扩展 — 注册工具/命令/事件处理
│   ├── config.ts                    # 配置管理 — 加载/保存/解析 + TLS 处理
│   ├── ddb.ts                       # DolphinDB 连接池 — WebSocket 单例
│   └── dolphinmind.ts               # DolphinMind HTTP 客户端 — 登录 + 检索
└── skills/dolphinpi/
    └── SKILL.md                     # LLM 行为引导 — 何时检索、如何执行
```

### 各模块职责

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | ~560 | 注册 2 个工具 (`dolphindb_search`, `dolphindb_execute`) + 2 个命令 (`/ddb:config`, `/ddb:doctor`) + 3 个事件处理 (`tool_result`, `session_start`, `session_shutdown`) |
| `config.ts` | ~210 | DolphinDB 连接配置 + DolphinMind API 配置的加载/保存/解析，TLS 自签证书兼容 |
| `ddb.ts` | ~70 | DolphinDB WebSocket 连接池，配置变更时自动重连 |
| `dolphinmind.ts` | ~400 | DolphinMind 登录 API 调用 + SSE 流解析 + 文档片段收集 + 错误分类处理 |
| `SKILL.md` | ~90 | LLM 行为指令："永远不要编造 API"、"写代码前先检索"、"报错后检索修复" |

## 依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `@earendil-works/pi-coding-agent` | (pi 内置) | 扩展 API |
| `typebox` | (pi 内置) | 工具参数 Schema |
| `dolphindb` | ^3.1.48 | DolphinDB WebSocket 客户端 |

## License

MIT
