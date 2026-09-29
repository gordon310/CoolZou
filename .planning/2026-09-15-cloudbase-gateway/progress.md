# Progress

## 2026-09-15

- **Status:** in_progress
- 已确认 CloudBase 示例服务公网访问正常，返回 HTTP 200。
- 已读取小程序请求、上传、图片预览、PPT 下载和服务器路由实现。
- 已确认采用 CloudBase 安全网关方案。
- 已完成 CloudBase 流式网关，允许 `/api/`、`/download/` 和 `/health`。
- 已验证网关覆盖伪造密钥、删除 Origin、保留方法、查询、请求体和响应状态。
- 已完成服务器可选网关密钥保护，使用恒定时间比较；本地未配置时行为不变。
- 已支持通过 `HOST` 控制服务器监听地址。
- 已完成小程序 CloudBase 初始化和 `callContainer` JSON 传输。
- 已保留本地 `wx.request` 模式，并将图片和 PPT 二进制下载切至 CloudBase 公网域名。
- 下一步：添加轻量服务器 Docker 与 TLS 配置。

## 2026-09-16

- **Status:** blocked_for_remote_deploy
- 已完成轻量服务器 Docker、Nginx TLS、IP 证书初始化脚本、生产环境变量示例和部署说明。
- 已完成服务器网关密钥保护、小程序 CloudBase JSON 调用、受保护图片/PPT 下载链路。
- `npm test`：44/44 PASS；`npm run test:ui`：PASS。
- `docker compose config`、shell 语法检查和 IP 证书 SAN 校验：PASS。
- Docker 镜像构建未完成：本机访问 Docker Hub 的 IPv6 认证地址超时。
- 腾讯云轻量服务器尚未实际部署；`https://43.142.125.248:8443/health` 当前连接超时。
- CloudBase 当前公网地址的 `/health` 返回 404，仍是示例服务，尚未替换为 CoolZou 网关。
- 尚未完成微信开发者工具/真机联调，也未配置小程序下载合法域名。
- 正式 AI、真实微信支付/支付宝支付仍保持关闭，属于上线前另一个配置和审核阶段。
- 已生成可交付包：`artifacts/cloud-gateway-20260916.tar.gz`、`artifacts/coolzou-server-20260916.tar.gz`，并生成 `artifacts/SHA256SUMS`。
- 轻量服务器已完成实际部署；公网 `https://43.142.125.248:8443/health` 返回 HTTP 200 和 `{"ok":true}`。

## Test Results

| Test | Expected | Actual | Status |
|---|---|---|---|
| CloudBase 示例根路径 | HTTP 200 | HTTP 200 | PASS |
| 网关定向测试 | 3 tests pass | 3 tests pass | PASS |
| 服务器网关保护测试 | 1 test pass | 1 test pass | PASS |
| 小程序云调用定向测试 | 4 tests pass | 4 tests pass | PASS |
| 完整 Node 测试 | 全部通过 | 44/44 | PASS |
| UI 流程测试 | 桌面端和移动端通过 | `UI PASS` | PASS |
| 轻量服务器 HTTPS 健康检查 | HTTP 200 | 连接超时，HTTP 000 | NOT_EXECUTED |
| CloudBase 网关健康检查 | HTTP 200 | HTTP 404，示例服务 | NOT_EXECUTED |

## Error Log

| Error | Resolution |
|---|---|
| 项目不是 Git 仓库 | 保留现状，不执行提交或工作树操作 |
| 计划补丁上下文不匹配 | 重新读取文件并按当前位置修正 |
| 服务器使用普通 `ubuntu` 用户执行 `/opt` 部署命令且压缩包未上传 | 改用 `/home/ubuntu/coolzou`，先上传并用 `find` 确认压缩包位置 |
| 服务器交付包遗漏 `.env.production.example` | 补回无密钥配置模板并重新校验服务器 zip |
| 服务器 `/health` 经 Nginx 转发后返回 404 | 为应用增加公开健康接口，新增回归测试；45/45 测试和 UI 测试通过，发布 `coolzou-server-20260916-r2.zip` |
| 微信云托管版本 `express-5r3p-002` 启动失败 | 启动日志确认 `UPSTREAM_ORIGIN is required`；需先在服务设置补齐四个网关环境变量，再重新部署 |
| 小程序照片上传返回 `cloud.callContainer -606001` | 确认 Base64 照片超过 `callContainer` 请求限制；开始改为 `wx.uploadFile` 受保护上传路径 |

## 2026-09-16 Photo Upload Repair

- **Status:** local_pass
- 用户要求部署前必须在本地通过测试；缺失环境或依赖由项目侧补齐。
- 目标：照片走独立文件上传，JSON API 保持 `callContainer`，不新增对象存储服务。
- 小程序照片已改用 `wx.uploadFile`；CloudBase 网关增加 `/upload/assets`；服务器增加受保护 multipart 上传接口。
- 定向测试：24/24 PASS；独立上传链路：1/1 PASS；干净 Node 24 容器完整测试：50/50 PASS。
- UI 回归：`UI PASS: desktop and mobile flows verified`。
- 生产依赖锁定并审计：0 vulnerabilities；服务器与网关 Docker 镜像均构建成功。
- 真实服务器容器联调：健康检查、照片上传、JPEG 下载、作品生成、PPT 下载、ZIP 完整性和媒体嵌入全部 PASS。
- 本地临时容器已停止；未向线上服务器或 CloudBase 发布任何文件。
- 已生成并从压缩包根目录重新构建验证：`artifacts/coolzou-server-20260916-upload-fix.zip`、`artifacts/cloud-gateway-20260916-upload-fix.zip`。
- 两个交付包均未包含 `.env.production`、TLS 私钥或其他真实密钥；部署文档已区分“已有服务更新”和“首次部署”。

## 2026-09-17 Cloud E2E

- **Status:** cloud_e2e_pass
- 服务器容器与 CloudBase 网关均正常，服务器 `/health` 返回 `{"ok":true}`，网关公网 `/health` 返回 `{"ok":true}`。
- 微信后台已同时配置 `uploadFile` 和 `downloadFile` 合法域名：`https://express-5r3p-314278-7-1488722877.sh.run.tcloudbase.com`。
- 微信开发者工具实际完成照片上传、作品生成、前五页预览、免费下载和完整版下载，用户确认全流程无异常。
- 照片限制已生效：最多20张，客户端压缩后单张不超过1MB，总上传不超过20MB，服务端再次校验。
- 上传失败根因：此前仅配置了 `downloadFile` 合法域名，缺少 `uploadFile` 合法域名；补充后恢复正常。
- 当前正式 AI 与真实支付仍保持关闭，以上结论是试运营链路闭环，不代表真实模型调用或真实收款已启用。
