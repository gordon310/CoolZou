# 真实 AI 受控上线

支付保持关闭：整个过程必须保留 `PAYMENT_MODE=disabled`。生产服务器环境文件是：

```text
/home/ubuntu/coolzou/.env.production
```

不要把 `DASHSCOPE_API_KEY`、`WECHAT_APP_SECRET` 或服务器环境文件内容发送到聊天、提交到源码或放进小程序包。

## 上线前配置

在 DashScope 当前账户和所选模型的计费页面确认输入/输出单价，再在服务器环境文件填写：

```text
AI_MODE=demo
DASHSCOPE_API_KEY=<只在服务器填写>
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3-vl-plus
DASHSCOPE_MAX_INPUT_TOKENS=32000
DASHSCOPE_MAX_COMPLETION_TOKENS=4096
DASHSCOPE_TIMEOUT_MS=60000
DASHSCOPE_INPUT_PRICE_MICROS_PER_MILLION=<实际输入单价乘1000000>
DASHSCOPE_OUTPUT_PRICE_MICROS_PER_MILLION=<实际输出单价乘1000000>
PAYMENT_MODE=disabled
```

单价单位是“微元人民币 / 百万 token”。例如账户单价若为 `1` 元/百万 token，配置整数就是 `1000000`。本次服务器使用中国内地兼容接口和 `qwen3-vl-plus` 时，官方目录价在输入不超过 32K Token 的档位为输入 `1` 元、输出 `10` 元/百万 Token，因此受控配置可填写 `1000000` 与 `10000000`。若地域、Base URL、模型或档位改变，必须重新确认价格后再改配置。

适配器固定 `enable_thinking=false`，使用该模型支持的 `json_object` 输出，并在服务端继续逐字段校验 slides；每张图片都带服务器生成的图片 ID，且单张视觉输入限制为 262144 像素。`DASHSCOPE_MAX_INPUT_TOKENS=32000` 与该图像/文字上限配套，避免进入更高输入价格档位。

填写后先保持 `AI_MODE=demo`，只检查配置文件存在、变量非空和价格为正整数；不要在 shell 输出 Key。当前代码会在 `AI_MODE=qwen` 启动时缺少任一必填项就拒绝启动。

服务器上的只读字段检查只输出存在性，不输出 Key 内容：

```bash
cd /home/ubuntu/coolzou
for key in APP_MODE AI_MODE PAYMENT_MODE DASHSCOPE_API_KEY DASHSCOPE_BASE_URL DASHSCOPE_MODEL; do
  grep -q "^${key}=" .env.production && echo "${key}=present" || echo "${key}=missing"
done
```

## 受控切换

1. 备份当前服务器环境文件，并只在服务器编辑 `/home/ubuntu/coolzou/.env.production`。
2. 将 `AI_MODE` 改为 `qwen`，再次确认 `PAYMENT_MODE=disabled`。
3. 仅重建/重启应用服务，然后检查本机和 CloudBase 网关健康接口：

```bash
cd /home/ubuntu/coolzou
sudo docker compose -f deploy/compose.yaml up -d --build
curl -k https://127.0.0.1:8443/health
curl -fsS https://express-5r3p-314278-7-1488722877.sh.run.tcloudbase.com/health
```

4. 使用一份已获授权的合成/测试素材和一个微信测试账号只提交一次任务。核对：作品由真实 provider 返回、`usage` 存在、`ai_budget` 为 `settled` 且金额等于整数成本、页面通过 `validateSlides`、PPT 能正常下载。不要用 demo 文本作为真实 AI 成功证据。
5. 若 provider 返回错误、超时、无效 JSON、usage 缺失或成本超过预留，任务必须失败且不能发布内容；将这些情况记录为 `FAIL`，不要重复刷调用。

## 回滚

把服务器 `/home/ubuntu/coolzou/.env.production` 中的 `AI_MODE` 改回 `demo`，重启应用并再次检查健康接口。保留 `PAYMENT_MODE=disabled`，不要执行 `docker compose down -v`，不要删除 SQLite 或 `var/` 数据卷。

## 本次受控发布结果（2026-09-17）

- `PASS`：新适配器已部署到生产服务器；本地 Node 100/100、桌面/手机 UI 回归和候选 Docker 构建通过。
- `PASS`：使用独立临时 SQLite 数据目录和合成 JPEG 完成一次真实 DashScope 调用，返回 5 页 PPT、`usage` 与预算结算均有效；按公开目录价计算的名义成本为 `9123` 微元（约 ¥0.009123），不等同于账户实际扣款。
- `PASS`：生产已为 `APP_MODE=live`、`AI_MODE=qwen`、`PAYMENT_MODE=disabled`；内部受信任配置检查显示 `aiAvailable=true` 且支付渠道为空。
- `PASS`：CloudBase 服务 `express-5r3p` 的公网 `/health` 已恢复；本机和轻量服务器两侧均返回 `{"ok":true}`。此前短暂的 TLS 后无响应未触发任何 CloudBase 变更。
- `NOT_EXECUTED`：不消耗微信测试账号当日一次额度的真机端到端任务；真实账户账单对账。网关健康恢复不是这两项的替代证据。
