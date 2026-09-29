# Findings

## Requirements

- 使用 CloudBase 环境 `prod-d5gx1s4o899f5b776`。
- 使用服务 `express-5r3p`。
- 使用腾讯提供的公网域名，不购买自有域名。
- 轻量服务器继续承担 AI、图片处理和 PPT 生成。
- 不在源码中保存 AppSecret、服务器密码、TLS 私钥或网关密钥。

## Research Findings

- `miniprogram/utils/api.js` 目前所有请求都依赖 `apiBaseUrl` 和 `wx.request`。
- 图片预览使用 `<image src>`，无法附带 Authorization 请求头，必须先下载为小程序临时文件。
- PPT 下载已经使用 `wx.downloadFile`，可以继续携带 Authorization 请求头。
- 服务端所有状态和文件都由本地 SQLite 与 `var/` 管理，直接迁移为服务器主动拉取云任务会扩大首版范围。
- CloudBase 示例公网地址已实测返回 HTTP 200，当前运行 Express 示例页。

## Technical Decisions

| Decision | Rationale |
|---|---|
| 网关采用 Node 标准 `http`/`https` 流式代理 | 无需额外代理依赖，支持大文件流 |
| 后端仅在配置 `GATEWAY_SECRET` 时强制校验 | 本地测试和现有演示模式保持可用 |
| 图片由小程序先用 `wx.downloadFile` 下载后再展示 | 保留服务器鉴权，不创建公开图片链接 |
| 生产上游只允许 HTTPS | 避免用户照片和令牌明文传输 |

## Visual/Browser Findings

- 云托管控制台已创建 Express.js 服务。
- 环境 ID：`prod-d5gx1s4o899f5b776`。
- 服务名：`express-5r3p`。
- 公网域名：`https://express-5r3p-314278-7-1488722877.sh.run.tcloudbase.com`。

## 2026-09-16 Status Evidence

- 本地源码和部署配置已经完成并通过自动化验证，但这不等于远程服务已经部署。
- CloudBase 公网地址的 `/health` 当前返回 HTTP 404，说明 `express-5r3p` 尚未运行本项目网关。
- 轻量服务器 `43.142.125.248:8443` 当前连接超时，说明 HTTPS 入口尚未完成部署或防火墙放行。
- 远程部署不能在当前环境代办：尚未取得服务器控制台/SSH 操作入口，也未执行 CloudBase 服务替换。
- 本地已生成 CloudBase 网关包和轻量服务器应用包，均不包含生产密钥、TLS 私钥或 `.env.production`。

## 2026-09-16 Photo Upload Failure

- 微信开发者工具已成功通过 `callContainer` 完成配置与登录初始化。
- 选择照片后返回 `cloud.callContainer:fail -606001`。
- 当前小程序将整张照片读取为 Base64，再放入 JSON 请求发送到 `/api/assets`。
- 外部资料与微信云托管示例均表明文件不应放入 `callContainer` 请求体；应使用独立文件上传通道，仅让 JSON API 传输元数据。
- 采用现有公网网关的受保护上传路径，不新增对象存储；部署前必须完成本地真实文件上传验证。
