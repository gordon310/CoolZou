# KIDSPPT 首版接口约定

基础地址：`http://127.0.0.1:4317`，默认演示模式，仅本机可访问。JSON 请求/响应。失败返回 `{error:{code,message}}`；默认成功 200，异步接受 202。浏览器采用 HttpOnly Cookie；小程序使用 `Authorization: Bearer <token>`。不得把 token 放在 URL。

## 登录与配置

- `GET /api/config` -> `{mode:'demo'|'live', aiMode:'demo'|'qwen', aiAvailable:boolean, paymentMode:'demo'|'disabled', priceFen:5000, freePages:5, maxPhotos:20, maxPhotoBytes:1000000, templates:[{id,name,description}]}`。`aiAvailable=true` 表示服务端已选择 `demo` 或完成 `qwen` 启动配置，不代表 provider 当前健康。
- `POST /api/session/demo`，无参 -> `{token,user:{id}}`。没有账号名参数；新的调用创建新的独立账号。仅 demo 可用。
- `POST /api/session/wechat`，`{code}` -> `{token,user:{id}}`。仅配置了真实微信密钥时可用。
- `GET /api/me` -> `{user:{id}}`，可检测已有会话。
- `POST /api/logout` -> `{ok:true}`。

## 图片

- `POST /api/assets`，`{name,data:<纯base64>}` -> `{id,url,width,height}`。url 为已登录鉴权图片接口。
- `GET /api/assets/:id` -> JPEG 二进制，必须登录且归属当前用户。
- `DELETE /api/assets/:id` -> `{ok:true}`，只删除未关联作品的上传素材。

## 作品输入

```json
{"title":"校园活动记录","nickname":"小朋友","grade":3,"gender":"boy","content":"活动第一步\n活动第二步\n重点清楚，语言自然","reviewOutline":false,"pageCount":12,"template":"fresh","photoIds":["asset-id"],"consent":true}
```

gender: `boy`/`girl`。template: `fresh` 清新自然、`playful` 活力童趣、`report` 简洁汇报；未传或不支持时默认为 `fresh`。title 1-40 字，nickname 最多20字且可空；grade 1-6，pageCount 5-20（无明确分页材料的建议上限）；`content` 为演示稿描述，1-8000字，照片1-20张，单张上传不超过1MB，总上传不超过20MB。客户端会先压缩超过1MB的照片，服务端仍会再次校验。`reviewOutline` 仅传true时停留在大纲编辑，默认false直接排版。年龄和PPT类型不再必填或保存；旧字段会被忽略。为兼容旧客户端，也接受 `flow` 和 `requirements`。

## 作品

- `POST /api/decks`，以上作品输入 -> `{deck}`。整理内容；默认继续导出，只有reviewOutline=true时等待编辑确认。
- `GET /api/decks` -> `{decks:[deck]}`，创建时间倒序。
- `GET /api/decks/:id` -> `{deck}`，生成中可每 1500ms 轮询。
- `PUT /api/decks/:id/outline`，`{revision,slides}` -> `{deck}`；只在 outline_ready 可编辑。免费编辑 revision 加一；已付款补全仅可编辑后续页，保持订单版本与前5页不变。
- `POST /api/decks/:id/generate`，`{revision}` -> `{deck}`；只生成家长确认的版本，开始导出任务。
- `POST /api/decks/:id/retry` -> `{deck}`；仅失败时重试原阶段，每阶段最多重试一次。
- `DELETE /api/decks/:id` -> `{ok:true}`；删除素材和输出，保留必要订单状态。

deck 结构：`{id,title,nickname,grade,gender,content,requirements,flow,reviewOutline,pageCount,template,theme,status,stage,revision,createdAt,updatedAt,error,slides,photos,paid,actualPages,aiMode}`。服务端会将新客户端的 `content` 同步保存在兼容字段 `flow` 和 `requirements` 中。缺少reviewOutline的历史作品维持原有编辑流程。

status: `outlining`、`outline_ready`、`queued`、`rendering`、`ready`、`failed`。stage 为可直接展示的中文实际阶段。error 为可显示字符串或 null。photos 为 `{id,url,width,height}` 数组。

2026-09-14分阶段补充：新作品 `pipeline:2`、`phase:'free'|'full'`、`directory:[{title}]`、`freeReady`、`fullReady`。`ready` 代表当前阶段就绪，不代表完整版已生成。免费阶段 `slides` 最多5项，`actualPages` 为目录总页数；付款后补全其余正文。`reviewOutline=true` 时每个阶段都进入编辑，不选则直接排版。旧作品 `pipeline:1` 保留原文件与权益。

正式试运营新任务按账号北京时间每天限1份；本地 `APP_MODE=demo` 且 `AI_MODE=demo` 为便于验收放宽为每天20份。同账号相同输入和照片内容哈希复用任务；删除不恢复次数。只更换模板时复用已整理内容，仅创建排版任务，不再次调用AI或占用每日次数。额度返回 `429 daily_quota`，账号另有活动任务返回 `409 active_task`。配置增加 `dailyFreeTasks`、`freePhotoLimit:8`、`aiAvailable`。`AI_MODE=qwen` 会在真实模型调用前预留预算，响应必须包含合法 usage 和结构化 slides；预算不足、provider 失败或输出无效时任务失败且不会回退为 demo。

slides 为 `{title,body,notes,photoIds}` 数组，title最多40字，body最多180字，notes最多8000字，photoIds最多1张且属于作品。实际页数1-20，不为凑页数添加空话；不超过5页的文件可完整免费下载。生成后只允许下载冻结版本；首版不支持对已导出作品重新编辑，可新建作品。

- `GET /api/decks/:id/preview/:page` -> 单页 PNG（若实际渲染可用）；page 从 1 起。免费只允许前 5 页，已购买全部可看。未生成 PNG 时返回 503，前端显示基于 slides 的“排版预览”，不可伪称真实 PPT 截图。
- `GET /api/decks/:id/download?variant=free|full` -> `{url,filename,expiresAt}`。full 未解锁返回 402（总页数 <=5 时允许），url 短时有效。
- 已付款但完整版未就绪返回 `409 deck_not_ready`，继续轮询作品；补全期间前5页仍可下载。
- GET 下载返回的 url -> PPTX 二进制；必须同一会话有效。小程序用 `wx.downloadFile({url,header:{Authorization:...}})` 后 `wx.openDocument({filePath,fileType:'pptx',showMenu:true})`，可用时 `wx.shareFileMessage`。

## 订单

- `GET /api/orders` -> `{orders:[order]}`。
- `POST /api/decks/:id/orders`，`{channel:'wechat'|'alipay'}` -> `{order}`。重复请求返回当前有效订单；金额始终服务端确定。首版仅面向中国大陆，支持微信支付和支付宝；真实商户配置完成前，live 模式返回 `503 payment_not_configured`。
- `GET /api/orders/:id` -> `{order}`。
- `POST /api/orders/:id/demo-pay`，`{confirm:true}` -> `{order}`，仅 demo，可重复调用但只解锁一次。UI 必须明确“模拟支付，不会扣款”。
- live 下下单返回 `503 payment_not_configured`，不能做出实际已收款的表示。

order：`{id,deckId,title,revision,amountFen:5000,currency:'CNY',channel:'wechat'|'alipay',status:'pending'|'paid'|'cancelled',mode:'demo'|'live',createdAt,paidAt}`。

前端不得因本地状态变为 paid 直接发放下载权；每次必须调用下载 API。配置显示 paymentMode=disabled 时按钮显示“支付尚未开通”，禁用付款。

新作品下单前预留交付预算；预算不足返回 `503 budget_exhausted` 且不创建订单。未支付15分钟预留过期，重新下单可续期；直接支付过期订单返回 `409 order_expired`。模拟支付事务内确认付款并只创建一次 `complete` 任务。订单 `delivery` 显示待支付、生成中、待确认大纲、可下载或交付异常待处理。真实付款和退款未实现，配置 `PAYMENT_MODE=live` 仍拒绝下单。
