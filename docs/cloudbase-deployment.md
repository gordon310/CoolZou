# CoolZou 云托管与轻量服务器部署

## 已配置的公开信息

- CloudBase 环境：`prod-d5gx1s4o899f5b776`
- CloudBase 服务：`express-5r3p`
- CloudBase 公网域名：`https://express-5r3p-314278-7-1488722877.sh.run.tcloudbase.com`
- 轻量服务器公网 IP：`43.142.125.248`

这些值可以保存在源码中。`GATEWAY_SECRET`、`WECHAT_APP_SECRET`、支付密钥、AI 密钥和 TLS 私钥不能提交或发送到聊天中。

## 本次照片上传修复的更新顺序

当前服务器和 CloudBase 网关已经部署过时，按下面顺序更新，不要重新创建密钥或证书。

1. 在腾讯云轻量应用服务器控制台打开实例 `43.142.125.248`，点击“登录”，在网页终端的文件按钮中上传 [轻量服务器应用包](/Users/gordonmac/GordonDev/CoolZou/artifacts/coolzou-server-20260917-photo-limits.zip) 到 `/home/ubuntu/`。
2. 在服务器终端执行：

```bash
cd /home/ubuntu/coolzou
unzip -oq /home/ubuntu/coolzou-server-20260917-photo-limits.zip -d /home/ubuntu/coolzou
sudo docker compose -f /home/ubuntu/coolzou/deploy/compose.yaml up -d --build
sudo docker compose -f /home/ubuntu/coolzou/deploy/compose.yaml ps
curl -k https://127.0.0.1:8443/health
```

压缩包不含 `.env.production` 和 `deploy/tls`，因此现有密钥、微信 AppSecret 和证书会保留。健康检查必须返回 `{"ok":true}` 后再更新网关。

3. 进入“腾讯云控制台 → 云开发 CloudBase → 环境 `prod-d5gx1s4o899f5b776` → 云托管 → 服务 `express-5r3p` → 部署发布”，上传 [CloudBase 网关包](/Users/gordonmac/GordonDev/CoolZou/artifacts/cloud-gateway-20260917-photo-limits.zip)。保留现有环境变量，容器端口填写 `80`。
4. 新版本显示“服务正常”后，访问 `https://express-5r3p-314278-7-1488722877.sh.run.tcloudbase.com/health`，确认返回 `{"ok":true}`。
5. 按本文“微信小程序后台”一节增加 `uploadFile` 合法域名，再在微信开发者工具中打开项目目录 `/Users/gordonmac/GordonDev/CoolZou/miniprogram`，点击“编译”测试照片，最后点击右上角“上传”。

## 1. 首次部署轻量服务器

先下载 [轻量服务器应用包](/Users/gordonmac/GordonDev/CoolZou/artifacts/coolzou-server-20260917-photo-limits.zip)。在腾讯云轻量服务器控制台点击实例的“登录”，打开网页终端，使用网页终端的文件上传功能上传该 zip。上传后先确认文件位置：

```bash
find /home/ubuntu -maxdepth 3 -type f -name 'coolzou-server-20260917-photo-limits.zip' -print
```

如果能看到文件路径，再执行下面命令。使用 `/home/ubuntu` 是为了避免普通 `ubuntu` 用户没有 `/opt` 写入权限：

```bash
mkdir -p /home/ubuntu/coolzou
unzip -oq /home/ubuntu/coolzou-server-20260917-photo-limits.zip -d /home/ubuntu/coolzou
cd /home/ubuntu/coolzou
cp .env.production.example .env.production
openssl rand -hex 32
```

后面的所有 `docker compose`、证书和健康检查命令，都必须继续在 `/home/ubuntu/coolzou` 目录执行；看到终端提示符为 `~/coolzou$` 后再继续，不要回到 `~$`。

如果提示 `unzip: command not found`，先执行：

```bash
sudo apt-get update && sudo apt-get install -y unzip
```

把随机值填入服务器 `.env.production` 的 `GATEWAY_SECRET`。同一个值稍后填入 CloudBase 的 `GATEWAY_SECRET`。在服务器本地填入微信公众平台“开发管理”中的 `WECHAT_APP_SECRET`，不要发送给他人或粘贴到聊天中。

首次创建 IP 证书并启动：

```bash
sh deploy/create-ip-certificate.sh 43.142.125.248
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
```

腾讯云防火墙仅开放：

- `8443/TCP`：云托管访问服务器。
- `22/TCP`：仅允许自己的当前公网 IP，用于管理。

不要开放应用内部端口 `4317`。暂时不需要开放 `80` 和 `443`。

`deploy/tls/server-ca.b64` 是证书公钥的 Base64，可填入 CloudBase 的 `UPSTREAM_CA_B64`；`server.key` 是私钥，只能留在服务器。

服务器完成后执行健康检查：

```bash
curl -k https://127.0.0.1:8443/health
curl -k https://43.142.125.248:8443/health
```

两次都应返回 `{"ok":true}`。第二次失败时，先检查腾讯云防火墙是否放行 `8443/TCP`，不要开放 `4317/TCP`。

## 2. 首次替换 CloudBase 示例服务

下载 [CloudBase 网关包](/Users/gordonmac/GordonDev/CoolZou/artifacts/cloud-gateway-20260917-photo-limits.zip)。进入 CloudBase 控制台，选择环境 `prod-d5gx1s4o899f5b776`，打开云托管服务 `express-5r3p`，选择“部署/更新服务”，部署方式选“上传代码包”，上传该 zip。

上传时确认：目标目录留空，Dockerfile 名称为 `Dockerfile`，容器端口为 `80`，开启公网访问。压缩包根目录必须直接看到 `Dockerfile`，不能再套一层文件夹。

在 CloudBase 服务变量中配置：

```text
UPSTREAM_ORIGIN=https://43.142.125.248:8443
UPSTREAM_CA_B64=<deploy/tls/server-ca.b64 的完整单行内容>
GATEWAY_SECRET=<与服务器相同的随机值>
REQUIRE_WECHAT_CONTEXT=true
```

保持公网访问开启：普通 API 只接受微信上下文；公网仅用于带用户令牌的图片和 PPT 文件下载。

部署后检查：

```text
https://express-5r3p-314278-7-1488722877.sh.run.tcloudbase.com/health
```

应返回 `{"ok":true}`。

如果返回 `502`，依次检查：服务器 `8443` 是否可访问、CloudBase 的 `UPSTREAM_CA_B64` 是否完整、两边的 `GATEWAY_SECRET` 是否完全一致。不要把密钥发到聊天中。

## 3. 微信小程序后台

小程序 JSON API 使用 `wx.cloud.callContainer`，无需配置 `request` 合法域名。

照片上传使用 `wx.uploadFile`，图片和 PPT 下载使用 `wx.downloadFile`。进入“微信公众平台 → 开发与服务 → 开发管理 → 开发设置 → 服务器域名”，将下面地址分别加入 `uploadFile` 合法域名和 `downloadFile` 合法域名：

```text
https://express-5r3p-314278-7-1488722877.sh.run.tcloudbase.com
```

不要填写路径，也不要在末尾添加 `/`。

## 4. 当前上线边界

- 2026-09-17：CloudBase 服务 `express-5r3p` 的公网 `/health` 曾短暂在 TLS 建连后无响应，未做云端变更即恢复；本机和轻量服务器两侧现在均返回 `{"ok":true}`。仍须在不消耗超额额度的前提下完成真机验证。
- `AI_MODE=demo`：默认本地整理，不产生模型费用。要启用真实千问，先按 [真实 AI 受控上线](/Users/gordonmac/GordonDev/CoolZou/docs/real-ai-rollout.md) 配置服务器，不要把 Key 放进小程序包或网关变量。
- `AI_MODE=qwen`：服务启动会校验 Key、Base URL、模型、Token 上限、超时和输入/输出单价；每次调用先预留预算，真实 usage 无法核对时不会发布作品。
- `PAYMENT_MODE=disabled`：真实支付仍关闭。
- `APP_MODE=live`：使用微信真实登录，不创建演示账号。
- SQLite 和 `var/` 通过 Docker volume 持久化；不要执行 `docker compose down -v`。
