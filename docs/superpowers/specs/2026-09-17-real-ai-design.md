# KIDSPPT 真实 AI 接入设计

日期：2026-09-17  
状态：已获用户确认，待按计划实现  
范围：真实 AI；真实支付继续关闭

## 目标

把当前 `AI_MODE=demo` 的本地文字整理替换为受预算控制的 DashScope 多模态调用，同时保留现有作品生成、前 5 页免费、账号配额、任务队列和 PPT 排版流程。

## 非目标

- 不接入微信支付或支付宝支付。
- 不修改小程序登录、上传、下载和 CloudBase 网关协议。
- 不把 API Key、图片 Base64、模型响应或 AppSecret 写入源码、接口响应或普通日志。
- 不在真实模型失败时静默回退到演示内容。
- 不先切换生产 `AI_MODE=qwen`；先完成隔离测试、受控真实调用和部署前验收。

## 当前边界

- `APP_MODE=live` 和真实微信登录保持不变。
- `PAYMENT_MODE=disabled` 保持不变。
- 正式试运营每个微信账号每天最多新建 1 份作品，按北京时间计日。
- 免费阶段最多向模型提供前 8 张照片；完整版阶段保留现有 `complete` 任务接口，但支付关闭时不对线上用户开放。
- 已上传照片以服务器私有 JPEG 文件为输入，不创建公开图片 URL。
- 所有 AI 生成结果必须继续通过现有 `validateSlides` 校验后才写入作品。

## 方案选择

### 方案 A：新增 OpenAI SDK 适配层

增加第三方 SDK，调用 Chat Completions 并使用 SDK 的结构化输出封装。

优点是请求代码较短；缺点是增加依赖、锁文件和供应商行为面，当前项目没有必要为一次 provider 接入引入 SDK。

### 方案 B：Node 原生 `fetch` + 独立 DashScope 适配器（采用）

新增小型 `server/ai.mjs`，使用现有 Node 运行时的 `fetch` 调用 `${DASHSCOPE_BASE_URL}/chat/completions`。`qwen3-vl-plus` 以非思考模式使用 `response_format: { type: 'json_object' }`，再由服务端严格校验 slides；请求有图片像素、输入/输出和超时上限，响应只提取结构化内容及 usage。

这是当前最小可维护方案：无新依赖，provider 协议集中在一个文件，现有 `phaseGenerator` 注入点可继续用于合成测试。DashScope 官方兼容接口支持图片输入、JSON Schema 输出和 `prompt_tokens`、`completion_tokens`、`total_tokens` 用量字段；实现仍必须在本地重新校验模型输出。

### 方案 C：DashScope 原生 API

使用 `/api/v1` 原生协议，获得更强的供应商特性控制，但会引入另一套请求和响应结构，当前没有足够理由承担额外复杂度。

## 架构和数据流

```text
Worker outline/complete
  -> CostControl 事务预留
  -> AI adapter 读取私有 JPEG + 生成多模态请求
  -> DashScope Chat Completions
  -> 校验 HTTP、finish_reason、JSON、usage
  -> validateSlides
  -> CostControl 按实际 usage 结算
  -> Store 写入 slides / directory / job 状态
  -> 现有 PPT 排版流程
```

### AI 适配器接口

`server/ai.mjs` 提供以下内部接口：

```js
createDashScopeGenerator(config, dependencies = {})
  -> async function generatePhase(input, photos, kind)
  -> { slides, usage: { model, promptTokens, completionTokens, totalTokens, costMicros } }
```

其中 `photos` 只包含 `{id, path}`；适配器负责读取文件、识别 MIME、构造 data URL，不向调用方返回图片内容。

`dependencies.fetchImpl` 和 `dependencies.now` 仅用于测试注入；生产默认使用全局 `fetch` 和 `Date.now`。

### 模型和配置

先保留现有兼容变量，并新增按阶段可选的配置：

```env
AI_MODE=demo|qwen
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3-vl-plus
DASHSCOPE_MAX_INPUT_TOKENS=32000
DASHSCOPE_MAX_COMPLETION_TOKENS=4096
DASHSCOPE_TIMEOUT_MS=60000
DASHSCOPE_INPUT_PRICE_MICROS_PER_MILLION=
DASHSCOPE_OUTPUT_PRICE_MICROS_PER_MILLION=
```

第一阶段使用单一 `DASHSCOPE_MODEL`，避免在模型价格和账号可用性尚未核实前硬编码多模型计费策略。模型必须由服务器配置指定；`AI_MODE=qwen` 时缺少 Key、Base URL、模型、最大输出上限或输入/输出单价配置，服务启动或任务执行应 fail closed。`AI_MODE=demo` 保持现有本地演示行为，不要求 provider 配置。

价格配置单位为“每百万 token 对应的微元人民币”，通过整数计算；输入和输出价格必须来自当前 DashScope 账号/模型的实际计费配置，不能把文档中的估算价格直接当成生产账单事实。

### 请求协议

- URL：`${baseUrl.replace(/\\/$/, '')}/chat/completions`。
- Header：`Authorization: Bearer <DASHSCOPE_API_KEY>` 和 `Content-Type: application/json`。
- `messages` 包含现有 `makePrompt(input)` 作为文本指令，以及按 `photos` 生成的图片内容。
- 请求明确要求 JSON，并使用 `response_format: { type: 'json_object' }` 与 `enable_thinking=false`；该模型不使用 JSON Schema 模式。
- JSON 输出必须是 `{ slides: [{ title, body, notes, photoIds }] }`，适配器逐字段、图片归属和长度校验后再取出 `slides`。
- `max_completion_tokens` 使用配置上限，禁止无限输出；非必要不打开思考模式。
- `stream=false`，以便原子取得完整 JSON 和 usage。

### 成本和任务事务

- 真实模型调用前按最大输入、图片数量和最大输出预留预算；预留失败不发送 provider 请求。
- 返回成功且 usage 有效后按实际 usage 结算；缺失、非法或超过预留的 usage 进入 `unknown`/失败状态，不宣称已完成并不自动释放未知费用。
- provider 4xx、5xx、超时、取消和无效 JSON 使用明确的内部错误码；只对可明确判定为瞬时的错误做一次有预算约束的重试。
- 当前 `CostControl` 和日志结构必须保留现有 daily quota、daily/monthly budget、订单预留和幂等语义。

## 错误和安全边界

- API Key 为空：返回内部 `ai_not_configured`，不发请求。
- HTTP 非 2xx：记录状态和安全的 provider 错误类别，不记录响应正文中的密钥或用户内容。
- `finish_reason=length`：返回 `ai_output_limit`，不接受截断 JSON。
- 返回结构不符合 JSON Schema 或 `validateSlides`：返回 `ai_invalid_output`，不回退 demo。
- 请求超时：终止 AbortController，任务失败；只有明确可重试错误才允许一次重试。
- 图片读取/编码失败：任务失败，不上传到其他服务。
- 日志只记录 job、阶段、模型名、token 数、费用和错误类别；不记录 prompt、图片、完整模型响应或 AppSecret。

## 测试验收

必须先写失败测试，再写实现：

1. 正确构造文本 + 多图请求，且不泄露 Key。
2. 非 2xx、超时、断网、空 choices、截断输出和无效 JSON 均 fail closed。
3. 合法 JSON Schema 响应能转为现有 slides，并经过 `validateSlides`。
4. usage 字段正确映射，成本结算使用实际 token；缺失 usage 不会错误结算为 0。
5. 预算不足时不调用 provider。
6. worker 使用 AI 返回结果后继续现有前 5 页和 PPT 排版流程。
7. `AI_MODE=demo` 的现有测试和 UI 流程不变。
8. 使用合成 provider 响应跑完整 Node 测试；真实 API 只使用用户明确配置的生产 Key 做一次受控调用，支付保持 disabled。

## 发布闸门

只有以下条件全部满足，才允许生产切换 `AI_MODE=qwen`：

- 本地完整测试和 UI 测试通过。
- 合成 provider 测试覆盖成功、失败、超时、预算和无效输出。
- 真实 API 单次受控调用通过，确认模型、图片输入、usage 和费用记录。
- 真实微信账号每日配额仍生效。
- 生产服务器已配置 API Key，但 Key 不进入源码和部署包。
- `PAYMENT_MODE=disabled` 仍保持关闭。
- CloudBase、服务器健康检查和 watchdog 通过。
- 小程序体验版只展示真实 AI 已验证的能力，不宣称真实支付。

## 外部参考

- https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions
- https://help.aliyun.com/zh/model-studio/qwen3-vl-plus
- https://help.aliyun.com/en/model-studio/base-url
