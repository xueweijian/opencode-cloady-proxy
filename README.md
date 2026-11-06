# opencode-cloady-proxy

OpenCode API 反向代理 —— Node.js 常驻服务版本，部署在 **Cloady**（NeptoLab 的 PaaS）。

用于绕过 `opencode.ai` 对 `muse-spark-1.2/1.3-contributor`、`beam-free` 等模型的 IP 地理门
（中国大陆直连返回 `RegionError: This model is not available in your country`）。

## 为什么不用环境变量

**这个代理不需要任何 key 或 token。** 它是透明反向代理：API key 由客户端每次请求的
`Authorization` 头带上来，服务端原样转发给 `opencode.ai`。

唯一的两个可选环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口。Cloady 会自动注入，一般不用管 |
| `UPSTREAM` | `https://opencode.ai` | 上游地址，正常不需要改 |

## 区域选择（关键）

Cloady 免费档**只在 4 个区域**提供：`eu1`（德国）、`jpn1`（日本）、`use1`（美东）、`usw1`（美西）。

- ✅ **必须选 `usw1` 或 `use1`** —— 只有美国出口能过 opencode.ai 的地理门
- ❌ `jpn1`（日本）和 `eu1`（德国）**不能绕过地理门**，部署了也是 RegionError

其余区域（`usc1` / `uk1` / `aus1` / `ind1` / `sin1`）属于 trial 或 disabled 计划，
不在免费档内。

## 部署

### 方式一：GitHub 仓库（推荐）

在 Cloady 部署输入框粘贴仓库 URL：

```
https://github.com/xueweijian/opencode-cloady-proxy
```

然后在应用卡片的 Settings 里：

- **Region** → `usw1`（US West）或 `use1`（US East）
- **Port** → `8080`
- **Start command** → 留空（有 Dockerfile，自动用 `CMD`）

### 方式二：上传文件夹

把本目录打包成 zip 上传（< 50MB）。

### 方式三：REST API

```bash
curl https://cloady.com/api/workspaces/<workspaceSlug>/deploy \
  -H "Authorization: Bearer cldy_…" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "opencode-proxy",
    "region": "usw1",
    "port": 8080,
    "source": {"type": "github", "repo": "https://github.com/xueweijian/opencode-cloady-proxy"}
  }'
```

## 功能

- **UA 治理**：通用 SDK UA（okhttp / python-requests / undici 等）改写为 `cherry-opencode-proxy/1.0`，
  避免 opencode.ai 的 Cloudflare 1010 拦截
- **`x-opencode-session` 注入**（OpenCode Go 自 2026-09-05 起的硬性要求），优先级链：
  1. 客户端自带 → 原样透传
  2. `x-conversation-id` / `x-session-id` / `x-correlation-id` → 复用
  3. JSON POST → 确定性指纹 `sha256("ocp1|model|system|first-user")[0:8]`
  4. 兜底随机 UUID
- **SSE 收尾补丁**：上游有时不发 `finish_reason:"stop"` 和 `data: [DONE]`，客户端会报
  `AI_FinishReasonError "other"`。本代理**只补缺失的那一半** —— 上游现已常自带 `[DONE]`，
  无条件重复注入会让严格客户端在第一个 `[DONE]` 处提前截断
- **客户端 IP 清洗**：删除 `x-forwarded-for` / `cf-connecting-ip` 等，上游只看到 Cloady 出口 IP
- **CORS**：全放开，含 OPTIONS 预检

## 路由

| 入站 | 出站 |
|---|---|
| `/zen/*` | `https://opencode.ai/zen/*`（原样） |
| `/v1/*` | `https://opencode.ai/zen/go/v1/*` |
| 其他 | `https://opencode.ai/zen/go/v1/*` |
| `/` | 健康检查 `{"status":"healthy"}` |

## 本地测试

```bash
node --check server.js
PORT=8080 node server.js
sh smoke-test.sh http://127.0.0.1:8080
```

## 与 Wasmer 版的关系

同一套逻辑的两个运行时实现：

- **本仓库**：`node:http` 常驻服务，用于 Cloady / VPS / 任何容器平台
- [`opencode-edge-proxy`](https://github.com/xueweijian/opencode-edge-proxy)：WinterCG
  `addEventListener("fetch")` 入口，用于 Wasmer Edge（WinterJS）

业务逻辑（UA 治理、session 指纹、SSE 补丁、路由）完全一致。
