# CoolZou 并发与故障恢复评估

日期：2026-09-16。对象：本地代码及部署包；未修改腾讯云生产服务。

## 结论

原项目存在可能导致内存、磁盘或连接资源耗尽的入口，不能仅凭每日一份作品的限制判断安全。已增加保护，并在本地 Linux Docker 中验证 20 个合成账号的上传、生成和下载，以及进程崩溃、卡死、OOM 后的恢复。结果支持小规模试运营，不代表生产可用性承诺或恶意流量防护承诺。

## 发现与处理

| 优先级 | 原问题 | 本次处理 |
| --- | --- | --- |
| P0 | 小于 1 MB 的图片仍可能解码为数百 MB，且上传无并发上限 | 2400 万像素上限、静态图片校验、解码超时、全站最多同时处理 2 张、每账号 1 张 |
| P0 | 应用没有内存上限，可能拖累整台 4 GB 主机 | 应用容器 1536 MiB、JS 堆 768 MiB、2 CPU、128 进程限制；Nginx 128 MiB |
| P0 | 服务卡死但进程不退出时，原 restart 策略不会处理 | HTTP/任务超时健康检查，主机独立 watchdog 重启 unhealthy 容器 |
| P1 | 缺少崩溃后的持久原因记录，OOM 时应用无法自己记录 | 应用日志持久化；主机订阅 Docker oom/die/health 事件，区分 OOM 与其他退出码 137 |
| P1 | 请求体、同时请求数及连接生命周期缺少足够约束 | 应用同时请求 32、连接 64；网关同时请求 64、连接 128；请求体与读写超时限制 |
| P1 | 下载把完整文件读入内存；断开连接后上游仍可能继续工作 | 文件流式发送；网关在客户端中断后取消上游连接 |
| P1 | 未使用的上传照片可不断堆积 | 每账号最多 30 张未使用照片；每 10 分钟清理超过 24 小时且未关联作品的照片，每批最多 100 张 |
| P1 | 磁盘耗尽后数据库和日志也可能无法写入 | 空闲低于 1 GB 时暂停新上传及排版，不主动删除用户已有作品；日志自动轮转 |
| P1 | 排队任务没有全站数量边界 | 新任务超过 100 个排队/执行任务时拒绝，并返回可重试提示 |
| P1 | 上传中途失败会让先前成功的照片在界面消失，连续点击可能触发重复上传 | 每张成功即更新；上传期间禁止重复选择/提交；繁忙错误最多重试 5 次 |
| P1 | 写 PPT 中途退出可能留下半成品 | 写临时文件后原子替换，完成前不发布下载 |

原有保护保留：免费内容 2 个执行槽、付费内容 2 个执行槽、排版 2 个执行槽；重复生成幂等；每日作品限制；失败重试次数限制；用户文件鉴权；正式 AI 与真实支付仍未开放。

## 崩溃恢复行为

- 进程退出：Docker `unless-stopped` 自动重启。
- 服务卡死：15 秒一次健康检查，连续 3 次失败标记 unhealthy；主机 watchdog 每 10 秒检查，最多等待 25 秒结束旧容器，再重启。单任务超过 180 秒也会使健康检查失败。
- 重启抑制：同一容器健康异常触发的重启间隔至少 120 秒；人工 `docker stop` 不会被 watchdog 拉起。
- 进程重启后，原来 running 的任务被记录为中断并标记失败；queued 任务继续执行。不会盲目重试可能已计费的模型调用。
- 数据库、照片、PPT、应用日志保存在既有 Docker 数据卷中，容器重建不删除卷。
- 主机整体掉电、系统无法启动、硬盘损坏、Docker 长时间不可用不属于本机制能独立修复的情况。

[Docker 官方重启说明](https://docs.docker.com/engine/containers/start-containers-automatically/)
[Docker 事件说明](https://docs.docker.com/reference/cli/docker/system/events/)

## 本地验证

- 自动测试：68 项通过，覆盖 1 MB/5 MB 边界、图片像素上限、请求拥堵、连接中断、低磁盘、队列上限、照片清理、崩溃日志和上传重试。
- Docker 实测：限制 2 CPU / 1536 MiB，20 个独立合成账号，60 张合成照片，20 份前 5 页稿件生成并下载，1 份 20 页完整版补全成功。
- 测试客户端对繁忙响应等待后重试；并非 20 张图片同时解码。记录到 40 次繁忙响应，最终全部完成。
- 该轮耗时约 13 秒；内存采样最大约 171 MiB，健康接口采样耗时 2–38 ms。采样不是瞬时峰值，数据量也不是长期满负荷压力测试。
- 进程 SIGABRT：自动重启通过，登录和作品信息保留。
- 进程 SIGSTOP：健康探测发现卡死，外部 watchdog 重启通过。
- 独立 96 MiB 故障容器：真实内存耗尽，记录 OOM 事件及退出码 137，自动重启通过。
- 人工停止容器：12 秒观察期内保持停止。
- Compose 配置校验、Nginx 1.28 配置校验、Nginx HTTPS 到应用的健康检查转发、Nginx 容器内健康探测均通过。

证据：`artifacts/reliability/docker-report.json`、`artifacts/reliability/watchdog-test.jsonl`。
复测：`node --test tests/*.test.mjs`；构建 `coolzou-reliability-test:20260916` 后执行 `node scripts/test-reliability-docker.mjs`。测试只创建自身命名的容器、数据卷并在结束后清理。

## 上线操作

服务器更新包：`/Users/gordonmac/GordonDev/CoolZou/artifacts/coolzou-server-20260917-photo-limits.zip`。
上传到服务器：`/home/ubuntu/coolzou-server-20260917-photo-limits.zip`。

```sh
cd /home/ubuntu/coolzou
unzip -oq /home/ubuntu/coolzou-server-20260917-photo-limits.zip -d /home/ubuntu/coolzou
sudo docker compose -f /home/ubuntu/coolzou/deploy/compose.yaml up -d --build
sudo sh /home/ubuntu/coolzou/deploy/install-watchdog.sh
sudo docker compose -f /home/ubuntu/coolzou/deploy/compose.yaml ps
curl -k https://127.0.0.1:8443/health
```

观察 app、edge 变为 healthy，以及 `coolzou-watchdog` 为 active。安装脚本将监控放在 `/opt/coolzou-watchdog` 并设置开机启动，使用 Ubuntu 自带 Python 3。当前 Mac 无 systemd，安装步骤需在 Ubuntu 上执行和验收。

CloudBase 网关更新包：`/Users/gordonmac/GordonDev/CoolZou/artifacts/cloud-gateway-20260917-photo-limits.zip`。
路径：微信云托管控制台 → `prod-d5gx1s4o899f5b776` → `express-5r3p` → 部署发布 → 上传代码包。端口 80，保留现有环境变量和证书配置。

小程序：微信开发者工具打开 `/Users/gordonmac/GordonDev/CoolZou/miniprogram`，重新编译，验证照片上传，上传新开发版本。本轮没有自动上传或发布小程序。

更新包不包含 `.env.production`、生产 TLS 证书、私钥或用户数据。不要执行 `docker compose down -v`。

## 查原因

主机容器事件：`/var/log/coolzou/watchdog.jsonl`，保留当前及 4 个轮转文件，每个约 2 MB。

```sh
sudo tail -n 60 /var/log/coolzou/watchdog.jsonl
sudo docker compose -f /home/ubuntu/coolzou/deploy/compose.yaml exec app tail -n 60 /app/var/logs/events.jsonl
sudo docker compose -f /home/ubuntu/coolzou/deploy/compose.yaml logs --tail=100 app edge
```

应用日志位于数据卷内 `/app/var/logs/events.jsonl`，保留当前及 3 个轮转文件，每个约 4 MB。记录时间、任务 ID、异常类型/代码、堆栈位置、进程与资源采样，不主动记录用户正文、图片或密钥。Docker 标准日志每容器 10 MB × 3。

## 尚需运营决策/线上验证

1. 已完成作品与历史输出暂不自动删除。40 GB 磁盘的保留期限、作品备份和未来对象存储方案仍需确定；磁盘保护会暂停新增，不能增加容量。
2. 本轮未做腾讯云生产压力测试、主机重启演练或 systemd 安装验收；也未验证实际公网带宽、微信真机、CloudBase 多实例行为。
3. 正式 AI 上线前仍需验证 API 超时/取消、计费去重、用量对账。当前结果只覆盖本地文字整理模式，不能当作真实模型性能。
4. 没有增加短信/邮件告警；故障会留档并自动恢复，长期反复失败仍需人工查看。
