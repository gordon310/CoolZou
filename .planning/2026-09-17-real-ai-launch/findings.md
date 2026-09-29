# 核查事实

- 2026-09-17：服务器 .env.production 的 DASHSCOPE_API_KEY 非空，未读取其值到本地。
- 生产 APP_MODE=live、AI_MODE=demo、PAYMENT_MODE=disabled；app/edge 健康，watchdog active。
- 环境文件权限为 644，部署前应收紧到 600，并在服务器保留受限备份。
- 输入/输出上限及价格配置尚缺失；当前代码不能直接切换 qwen。
- makePrompt 要求使用附带图片 ID，但适配器只发送图片数据，没有逐图 ID 标注。
- aiMaxInputTokens 目前仅参与预算计算，没有调用前输入边界检查。
- AI 预留复用了订单的 15 分钟过期语义；需要核对重启/重试是否能重复使用同一预留。
- 原有本地测试：npm test，90/90 PASS；未进行真实 provider 调用。
- Firecrawl developer index 未给出足够的中国地域官方计费/结构化输出证据，需补查百炼官方文档。
- 百炼官方文档确认：Qwen3-VL-Plus 在非思考模式支持 JSON Object；JSON Schema 支持列表不包含该模型。
- 百炼中国北京目录价：qwen3-vl-plus 在输入不超过 32K Token 时，输入 1 元、输出 10 元/百万 Token。请求按文字字节上界与每图最大 258 Token 限制在 32K 以内。
- 修复后全量 Node 测试 100/100 PASS，桌面与手机 UI PASS。
- 生产服务器当前包没有 server/ai.mjs，必须先部署新包；Dockerfile 与本地一致。
- 新包已部署，生产环境文件权限已收紧为 600；本地与服务器 `server/ai.mjs` SHA-256 一致。
- 独立临时 SQLite 数据目录与合成 JPEG 的单次真实 DashScope 验证通过：5 页 PPT、`prompt_tokens=603`、`completion_tokens=852`、`total_tokens=1455`、名义结算 `9123` 微元；无临时作品写入生产数据卷。
- 生产 `APP_MODE=live`、`AI_MODE=qwen`、`PAYMENT_MODE=disabled`；内部受信任配置检查显示 AI 可用、支付渠道为空。
- CloudBase 公网 `/health` TLS 建连成功但 15 秒内未返回 HTTP，服务器 Nginx 未见对应请求；轻量服务器本机和公网 `8443` 返回 200。故障位于 CloudBase 服务或平台侧，尚未对 CloudBase 做任何修改。
- 随后 CloudBase 公网 `/health` 已自行恢复；本机和轻量服务器均返回 `{"ok":true}`。这仅证明网关健康，不替代每日额度受限的真机端到端验证。
