# KIDSPPT 首版实施计划

> 使用 subagent-driven-development 分配独立前端任务，主任务负责后端与集成。用户已批准首版方案及大陆用户范围，无需重复确认实施。

目标：提供可运行的微信小程序源码、配套服务和浏览器体验预览，实际导出可编辑 PPT，并验证前 5 页免费及完整版权益隔离。

架构：Node.js 24 HTTP 服务、SQLite 持久化任务与订单、私有本地文件目录、PptxGenJS 导出；原生微信小程序和浏览器测试界面共用 REST API。

规格：`docs/spec.md`；接口：`docs/api.md`。

## 全局约束

- 大陆用户，币种 CNY，完整 PPT 5000 分/份，前 5 页免费。
- 已购买同一作品版本重复下载免费；总页数不超过 5 页无需支付。
- 用户尚未注册小程序，无 AppID、商户或 AI 密钥。实际外部调用不得伪装为已接通。
- 本地演示仅监听回环地址，支付演示与真实订单分开；真实收款默认关闭。
- 首版使用原生 JavaScript ES modules 和 JSDoc，避免增加 TypeScript 构建环节；业务接口在文档中固定。
- 当前独立新项目无已有 git 历史；使用独立目录，无需为其他项目创建 worktree。
- 首版使用单服务 SQLite 和私有文件系统，部署前需配置持久卷、备份、访问域名及清理期限。
- 本任务不公开孩子照片、不上线、不真实收费。

## Task 1: 生成及文件边界（主任务）

文件：`server/validation.mjs`、`server/outline.mjs`、`server/ppt.mjs`、`tests/generation.test.mjs`。

- [ ] 先写断言：非法年龄/年级/自定义空名称被拒绝；使用独立后 5 页标记及照片导出，ZIP 内不存在未授权内容。
- [ ] 运行 `node --test tests/generation.test.mjs` 记录失败。
- [ ] 实现 `validateInput(input)`、`validateSlides(slides, photoIds)`、`makeOutline(input, photos, config)`、`exportDeck(slides, photos, outputDir, metadata)`。
- [ ] 分别建立免费、完整 Presentation 实例，仅向免费实例传入前 5 页。
- [ ] 用 PPT 包结构测试及实际渲染验证文字、照片、页数。

测试目标示例：
```js
assert.equal(freeSlideCount, 5);
assert.equal(fullSlideCount, 8);
assert.equal(freeXml.includes('ONLY_PAID_PAGE'), false);
```

## Task 2: 账号、任务和权益（主任务）

文件：`server/store.mjs`、`server/app.mjs`、`server/worker.mjs`、`server/payments.mjs`、`server/main.mjs`、`tests/api.test.mjs`。

- [ ] 先测试两个独立登录会话：账号 B 无法读取 A 的素材、作品、订单和下载地址。
- [ ] 测试未支付完整版拒绝、免费版允许、伪造金额拒绝、模拟付款幂等、下载重试不重收费、过期链接失败。
- [ ] 实现哈希会话令牌、图片真实格式/尺寸校验、去 EXIF、任务队列和重启恢复。
- [ ] 实现作品编辑版本检查、导出确认、持久化订单、短期下载签名及删除清理。
- [ ] 实现微信 code 登录适配和 Qwen 图片/文本适配，缺配置时报明确错误；真实支付在渠道资质未核实前返回未开通。
- [ ] 验证非演示模式不能创建演示会话或调用模拟付款。

测试目标示例：
```js
assert.equal((await asB(`/api/decks/${aDeck.id}`)).status, 404);
assert.equal((await asA(`/api/decks/${aDeck.id}/download?variant=full`)).status, 402);
assert.equal((await simulatePayment(order.id)).status, 200);
```

## Task 3: 原生微信小程序（独立实现者）

文件范围：`miniprogram/**`、`tests/miniprogram.test.mjs`。

- [ ] 根据 `docs/api.md` 实现网络封装，演示登录与真实微信登录分开。
- [ ] 实现制作表单、上传排序删除、输入验证、异步进度、可编辑内容确认、分页作品预览及下载。
- [ ] 实现我的作品、删除确认、订单状态和微信文档打开/转发。
- [ ] 所有错误都能恢复操作状态；页面卸载停止轮询；不输出密钥。
- [ ] Node 测试可提取逻辑和页面注册；微信开发者工具、真机因缺 AppID 标记 NOT_EXECUTED。

## Task 4: 浏览器预览（独立实现者）

文件范围：`web/**`。

- [ ] 使用同一 REST API 实现完整本地体验；不以此替代微信运行时。
- [ ] 页面首屏直接为制作表单；白底、绿色主操作、珊瑚辅助色，紧凑且适合家长使用。
- [ ] 实现照片、字段、大纲编辑、进度、免费/完整下载、模拟支付确认、作品与订单列表。
- [ ] 手机和桌面无横向溢出，按钮状态完整，图片和标题不遮挡。

## Task 5: 集成、评审及交付（主任务）

文件：`scripts/test-ui.mjs`、`README.md`、`.env.example`、`docs/progress.md`。

- [ ] 运行完整 Node 测试，逐项修复。
- [ ] 使用 Playwright 执行真实上传、编辑、导出、下载和模拟解锁，保存手机/桌面截图。
- [ ] 独立代码审查账号隔离、支付边界和文件泄露，完成必要修复及复测。
- [ ] 实际渲染 PPT 样本，人工检查中文、长标题与横竖图片。
- [ ] 将源码、规格、验证证据和未接通项目一并整理到固定项目目录，启动本地服务并给出 URL。
