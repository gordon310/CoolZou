# CoolZou 云托管安全网关计划

## Goal
在不购买自有域名的前提下，让微信小程序通过腾讯云托管安全访问上海轻量服务器上的 CoolZou API、图片和 PPT 下载。

## Next Step
上传本地验证通过的服务器包和 CloudBase 网关包，配置 `uploadFile` 合法域名，再在微信开发者工具和真机完成云端联调。

## Current Phase
Phase 5（云端部署与真机联调）

## Phases

### Phase 1: 现状确认
- [x] 确认 CloudBase 环境、服务名和公网地址
- [x] 确认现有后端使用本地 SQLite、文件目录和内置任务队列
- [x] 确认小程序当前使用 `wx.request`
- **Status:** complete

### Phase 2: 安全网关与服务器保护
- [x] 为代理转发和网关密钥校验写失败测试
- [x] 创建最小 CloudBase 网关服务
- [x] 为服务器 API 增加网关密钥保护
- **Status:** complete

### Phase 3: 小程序云调用
- [x] 为 `wx.cloud.callContainer` 请求和错误处理写失败测试
- [x] 初始化 CloudBase 并切换 JSON API 传输
- [x] 保留本地开发模式
- [x] 通过公网网关下载受保护的图片和 PPT
- **Status:** complete

### Phase 4: 服务器容器部署
- [x] 添加应用容器和反向代理配置
- [x] 添加自签名 TLS 证书初始化脚本
- [x] 提供不含真实密钥的环境变量示例
- [x] 在腾讯云轻量服务器实际部署并开放 HTTPS 入口
- **Status:** complete

### Phase 5: 验证与交付
- [x] 运行定向测试
- [x] 运行完整测试
- [x] 检查无密钥进入源码
- [x] 输出云托管与服务器部署步骤
- [ ] 在 CloudBase 替换示例服务并验证 `/health`
- [ ] 在微信开发者工具和真机验证 `callContainer`、图片和 PPT 下载
- **Status:** in_progress（本地验证完成，云端联调待执行）

### Phase 6: 照片上传通道修复
- [x] 为公网受保护文件上传写失败测试
- [x] 小程序照片改用 `wx.uploadFile`
- [x] 网关增加仅允许 Bearer 会话的上传路径
- [x] 服务器解析 multipart、限制大小并校验图片格式
- [x] 运行定向测试和完整测试
- [x] 在本地启动真实网关与服务器完成文件上传
- [x] 所有本地验证通过后重新生成部署包
- **Status:** complete

## Decisions Made

| Decision | Rationale |
|---|---|
| CloudBase Express 作为无状态安全网关 | 复用腾讯公网域名和 `callContainer`，无需自购域名 |
| 业务数据、SQLite、AI 和 PPT 生成继续留在轻量服务器 | 避免试运营阶段重写数据库和增加 CloudBase 资源成本 |
| 网关到服务器使用 TLS + 专用密钥 | 防止照片、会话和 PPT 在公网明文传输 |
| JSON API 使用 `callContainer`，二进制使用云托管公网域名 | `callContainer` 不适合大 PPT 文件流，公网域名可被 `wx.downloadFile` 使用 |
| 照片使用 `wx.uploadFile` 走受保护公网上传路径 | 避开 `callContainer` 100KB 请求限制，不增加对象存储依赖 |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| 项目目录不是 Git 仓库 | 1 | 不创建工作树、不提交；仅做精确文件修改并记录验证结果 |
| 更新计划文件时上下文定位不匹配 | 1 | 重新读取当前内容后按准确位置更新 |
| 照片 Base64 上传返回 `cloud.callContainer -606001` | 1 | 根因是请求包超过 100KB；改为公网文件上传通道 |
| 本机共享 `node_modules` 污染首次生成的锁文件 | 1 | 在隔离 Docker 环境重新生成锁文件并确认只含项目依赖 |
| Docker Hub IPv6 认证地址超时 | 1 | 使用已校验的 AWS Public ECR 官方 Node 镜像缓存完成本地构建 |
| 容器联调脚本使用 zsh 保留变量 `status` | 1 | 不重复创建作品，读取已创建作品并继续验证 |
