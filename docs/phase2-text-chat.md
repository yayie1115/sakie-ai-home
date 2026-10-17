# 第二阶段第一部分：DeepSeek 文本聊天

基线：main，2cf90cc。本文区分代码能力、测试结果与尚未启用的真实运行配置。本轮不提交、不推送、不部署，不接入私人历史进行模型联调。

## 已实现

- 保留 React/Node/TypeScript/SQLite、第一阶段认证、CSRF、Origin、数据隔离与备份/迁移工具。
- ModelProvider 可替换接口；DeepSeekProvider 使用原生 fetch 调用官方兼容 POST /chat/completions。非流式普通文本，thinking disabled，无 SDK 自动重试或第三方新依赖。
- 会话创建及列表、消息持久化、分页历史、轮次查询与显式重试。客户端产生 UUID v4 请求编号；后端决定轮次及消息顺序。
- user 原文、queued 轮次/任务和原文 outbox 在同一事务提交后才返回 durable=true。HTTP 202 表示已可靠接收，不表示已生成回复。
- assistant 原文、轮次成功状态、调用成功记录及 outbox 在同一事务提交。只有有效非空文本且 finish_reason=stop 才能作为成功回复。
- 单个后端进程、全局一个模型调用并发；事件驱动处理持久队列，无高频模型轮询。不同会话共享这个 worker，同一会话只允许一个未解决轮次。
- 网页提供最简聊天界面。消息正文由 React 作为文字渲染，不执行模型生成的 HTML。打开、刷新、选择会话及读取历史均不会触发模型。

## 职责与限制

本机运行的是云端角色的开发实例。聊天完整写入当前后端 SQLite 和待归档 outbox，不依赖 local-agent 在线，所以不要求 Windows 归档服务可达才能完成这条后端聊天链路。但尚未部署腾讯云，也尚未验证真实 Windows 关机时的云端站点可用性。

Windows 主要归档、主动认证连接、设备配对、传输、连续 ACK、水位复核均未实现。chat_outbox 的事件全部视为未可靠归档，无 TTL 或自动清理；不能把近期上下文窗口当成消息留存窗口。原文在 messages 和 outbox 中均保存，磁盘占用会增长。

一个 SQLite 库只能由一个后端进程提供本轮聊天服务；禁止 PM2 cluster、多副本或以不同端口同时启动多个后端指向同库。当前仅有单进程调度，不具备跨进程 worker 锁、分布式租约或故障接管。正式部署前必须验证单实例运行配置。

## 数据库 v3

第一阶段 v1/v2 迁移 SQL 不变，追加 phase2-durable-text-chat：

| 表 | 职责 |
| --- | --- |
| chat_conversations | 会话与后端 next_turn_seq |
| chat_turns | 以 conversation_id + client_message_id 唯一的持久处理任务、正文哈希、状态 |
| chat_messages | 不可自动清理的 user/assistant 原文、UUID、消息序号、正文哈希 |
| chat_attempts | 每次实际调用的独立 ID、provider/model、开始/结束、结果及已知用量 |
| chat_retry_requests | 显式重试请求的持久幂等编号，避免网络重发重复发起调用 |
| chat_archive_identity | 持久 producer_id，为未来同步预留 |
| chat_outbox | 全局 stream_seq、event_id、producer_seq、版本、原文 payload 与哈希 |

原四张业务表、record_metadata、auth_sessions 及原 UUID 保留。消息序号为 turnSeq*2-1（用户）和 turnSeq*2（回复），不能按 UUID 或设备时间排序。

outbox 是未来同步的数据来源，不提供未经认证的导出接口。未来恢复旧库时仍必须保留第一阶段 restore-info.json 隔离机制，复核 archive 身份、代次及水位，不能直接沿用旧 ACK。暂不消费/删除 outbox，也没有归档确认状态。

## 状态、故障和重试

queued → running → succeeded / failed / unknown。

- 同会话同 clientMessageId 同原文返回原轮次；同 ID 异原文返回 409 MESSAGE_ID_CONFLICT。正文空白保留，不先 trim 后保存。
- 重发 messages 请求不等于重新调用模型，已失败或未知的轮次也不会因消息重发自动重试。
- 已知拒绝（如 401/402/429）记录 failed；网络错误、超时、部分响应异常与不明确的服务端错误记录 unknown。供应商原始错误正文不会返回浏览器或写日志。
- 被长度截断、过滤或要求工具调用的结果不写为成功 assistant 消息；已有用量如实记录。
- 成功收到供应商回复但 SQLite 无法提交时，事务回滚，不报告成功；worker 停止接收新任务。重启会把遗留 running 标为 unknown，保留用户原文和已有事件。
- 重启只恢复 queued；running 不能当作安全重试。查询状态、打开页面不会重新调用。
- failed/unknown 可显式重试，使用新的 retryId；同 retryId 网络重发只处理一次。unknown 必须 acknowledgeUnknown=true，网页提示可能再次计费。
- 无法保证供应商侧恰好调用一次。超时前供应商可能已经生成、计费；即使取消请求也无法撤销远程处理。
- 一个失败/未知轮次会阻止该会话继续排新轮次，避免错乱上下文。用户可重试，或新建会话；本轮没有“跳过失败轮次”功能。
- HTTP 202 之后关闭网页不取消后端任务；202 之前的网络错误必须使用同一 ID 查询/重发。未入库草稿只在当前页面内存中，未实现浏览器离线发件箱；关闭、刷新或切换页面可能丢失未入库草稿，界面会提示。

## 配置

仅在本机编辑被忽略的 E:/sakie-ai-home/backend/.env；不要发送密钥给协作者，不要使用 VITE_ 前缀，也不要将真实 .env 添加到 Git。缺少 key 或 model 不妨碍已升级数据库启动及读取历史，但新消息返回 503 MODEL_NOT_CONFIGURED。

以 backend/.env.example 为模板。需要自行设置：

~~~dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
~~~

上面 API Key 留空，必须由用户在本机填写。模型名仅为查询官方文档时的示例，代码不默认选定模型，使用时以账号实际可用模型为准。

官方资料：[首次调用](https://api-docs.deepseek.com/zh-cn/)、[Chat Completions](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)。API 地址允许显式配置 HTTPS 基址（可带 /v1）；拒绝 URL 内凭据、查询串和 fragment，不跟随重定向。密钥只发送到配置的基址，务必确认其由预期模型供应商控制。

| 配置 | 默认值 | 意义 |
| --- | --- | --- |
| MODEL_TIMEOUT_MS | 60000 | 每次调用含响应读取的截止时间 |
| CHAT_MAX_OUTPUT_TOKENS | 1024 | 发送给供应商的输出上限 |
| CHAT_CONTEXT_TURNS | 12 | 最多读取的此前成功完整轮次数，另加当前用户消息 |
| CHAT_CONTEXT_MAX_CHARS | 48000 | 近期 user/assistant 内容字符总预算，含当前消息，不含两段 system |
| CHAT_MAX_MESSAGE_CHARS | 12000 | 单条用户文本长度限制；上下文字符预算不得低于它 |
| CHAT_MAX_QUEUED_TURNS | 16 | 全局 queued + running 接纳上限 |
| CHAT_SYSTEM_PROMPT | 内置简短中性人格说明 | 可配置稳定人格；不是历史数据或长期记忆注入入口 |

上下文只查询有限数量的最近成功轮次，按完整 user/assistant 对从新到旧纳入，超预算停止，不截断原文、不改写持久历史。不注入日记、梦境、收藏、动态或长期记忆。另有固定声明说明长期记忆不可用，不能假装读过旧记忆。

字符预算不是精确 Token 预算。本轮没有历史摘要算法或精确 tokenizer；稳定人格先于动态聊天，保留供应商缓存兼容的前缀结构，但缓存命中不能保证。

## 调用记录与费用边界

chat_attempts 保存每次尝试，不只记录成功。可用的 prompt/completion token、cache hit 和 cache miss 单独记录。DeepSeek cache miss 不代表已完成 cache write；cache_write_tokens 没有可靠返回值时为 NULL。失败或未知调用无法确认的用量同样为 NULL，不填零。

本轮不硬编码供应商价格；currency/cost_micros/price_version 为 NULL，表示尚未核算，绝非免费。未实现费用查询 UI、账单对账、周期费用统计或金额硬预算。输出、上下文、单并发及队列限制只能限制资源规模，不能替代费用预算。现有 ModelCallLedger/BudgetPort 保留，完整统一账本和预算执行留待后续。

## API

所有下列接口位于第一阶段登录保护之后。写请求还须携带用户 Cookie、可信 Origin（浏览器）和 X-CSRF-Token；设备 Bearer 不能代替用户登录。

| 方法 | 路径 | 参数/响应要点 |
| --- | --- | --- |
| GET | /api/chat/config | configured、maxMessageChars、memoryStatus=unavailable，不返回模型凭据 |
| POST | /api/chat/conversations | {id:UUID v4,title?:string}，同 ID 同标题幂等 |
| GET | /api/chat/conversations | limit（默认20，上限100）、before 游标；items、nextBefore |
| POST | /api/chat/conversations/:id/messages | {clientMessageId:UUID v4,content:string}；202、durable、turnId、turnSeq、messageId、turn |
| GET | /api/chat/conversations/:id/messages | limit（默认50，上限100）、before 消息序号；items 按顺序、nextBefore、unresolvedTurn |
| GET | /api/chat/turns/:id | turn、该轮已落盘 messages；仅查状态，无模型副作用 |
| POST | /api/chat/turns/:id/retry | {retryId:UUID v4,acknowledgeUnknown?:boolean}；202、turn |

分页游标是独占上界，重发采用原 ID。对话与消息列表都不一次返回全历史。错误包括 400 校验、401 登录、403 CSRF/Origin、404、409 幂等冲突/未解决轮次、429 队列满、503 未配置/worker 不可用；不返回供应商原始正文。

## 本机启用步骤（尚未对真实运行库执行）

在 E:/sakie-ai-home 目录操作。先停止旧开发后端，确保没有旧版本服务继续写原库；不要同时运行两个版本指向同一个数据库。

~~~powershell
npm run db:migrate -w backend
~~~

该命令沿用第一阶段工具：一致性备份 → 恢复到独立隔离候选 → 迁移演练/旧业务核验 → 检查源库未变 → 事务迁移。重复执行验证迁移历史后返回 changed=false；失败回滚，不自动覆盖数据。

如果尚未配置用户身份，由用户本机运行：

~~~powershell
npm run auth:setup -w backend
~~~

已有 owner.json 时不要覆盖，不必再 setup。命令在用户终端显示一次随机密码，应自行保存；本轮未生成真实用户密码。

在被忽略的 backend/.env 填写模型配置后运行：

~~~powershell
npm run dev
~~~

访问 http://localhost:5173/chat，先登录再新建会话并发送。即使未配置模型，登录、原记录 API 和历史读取仍可使用；首次启用前仍需要完成 v3 迁移。不要直接用本轮代码替换生产镜像，现有生产环境未修改或验收。

## 本轮实际验证

- typecheck：四个 workspace 通过，含后端测试类型检查。
- test：33 项通过，0 失败、0 跳过，保留第一阶段全部 18 项，新增 15 项聊天测试。
- build：frontend/backend/contracts/local-agent 通过。frontend 产物约 270.61 kB JS（当次构建），不是 VPS 内存实测值。
- 覆盖：认证/CSRF、API 基本闭环、分页、同 ID 反复提交、异内容冲突、并发未解决轮次、显式重试幂等、超时和迟到回复、进程中断后的 unknown、queued 恢复、单 worker 顺序、上下文窗口、outbox 同事务、模拟写盘失败、用量空值、官方兼容请求形状和错误脱敏、v2→v3 备份及恢复、重复迁移及失败回滚。
- HTTP 测试需要本机回环网络权限。初次受限执行返回 EACCES；正常权限执行通过。Vite 初次受限构建发生 realpath EPERM；正常权限构建通过。
- 本地启动冒烟：使用全新隔离目录 E:/sakie-ai-home-data/phase2-validation/startup-ygIihj 和测试身份启动源码后端及 Vite，健康检查200、登录200、/chat 入口200、匿名业务请求401；显式禁用真实模型。子进程已关闭，测试数据保留。该检查验证页面入口，不等同于浏览器交互验收。
- 实际运行库 E:/sakie-ai-home-data/cloud/sakie.db：只读核验和一致性备份，仍为 v2；迁移前后逻辑指纹一致。未在真实运行库上应用 v3。
- 实际 v2 备份：E:/sakie-ai-home-backups/phase2/snapshot-n7YfWC。
- 实际迁移候选：E:/sakie-ai-home-data/phase2-validation/rehearsal-qFE8RH/candidate/sakie.db，v3，integrity_check=ok。保留恢复隔离标记，不作为运行库直接启用。
- 升级工具额外保留候选迁移前快照 snapshot-NCn20X 及内部演练副本 upgrade-8VAbnz，均在 E:/sakie-ai-home-backups/phase2 下。

未验证：真实 DeepSeek 凭据/模型可用性、真实计费、iPhone/Windows 浏览器完整交互、Docker 实际运行、腾讯云资源和线上 HTTPS、真实断电及跨设备同步。测试只使用合成内容和假模型/模拟响应，没有调用真实模型或外传私人历史。

## 具体文件

新增：

- backend/src/modules/chat/config.ts、provider.ts、deepseek.ts、schema.ts、store.ts、context.ts、service.ts、routes.ts。
- backend/test/chat.test.ts。
- frontend/src/app/api.ts。
- frontend/src/modules/chat/ChatPage.tsx。
- docs/phase2-text-chat.md。

调整：

- backend/src/database/migrations.ts：只追加 v3。
- backend/src/config/env.ts、backend/.env.example：加入后端聊天配置。
- backend/src/app.ts：注册认证后的聊天路由，支持测试注入 provider/service。
- backend/src/server.ts：成功监听后才恢复任务，关闭时终止当前调用并等待状态记录。
- backend/test/storage.test.ts：保留原断言，把“最新版为2”的断言调整为 latestVersion。
- frontend/src/app/AuthenticationGate.tsx：向子组件提供同源认证请求，不暴露 HttpOnly 会话 token。
- frontend/src/app/router.tsx：替换 chat 占位路由。
- frontend/package.json、package-lock.json：仅增加已有内部 contracts 类型依赖，无新外部依赖。
- 两端 chat/README.md、README.md、docs/sync-protocol-v1.md、FILES.txt：更新当前范围和文件清单；第一阶段交付文档继续作为历史快照保留。

## 回退和遗留风险

真实运行库尚未升级，因此本轮代码回退不会需要恢复真实数据库。不要自动丢弃工作区改动；需要回退代码时保留本轮补丁后按基线核对。

未来一旦真实库升到 v3，第一阶段程序会拒绝打开它。迁移失败有事务回滚，成功升级后不能恢复旧快照覆盖新聊天。应保留新库和新消息，在独立候选中使用兼容程序或核验增量后受控切换；本轮没有原地 down 迁移、通用消息合并或自动生产回退。

备份仍与主库同在 E 盘，不抵御整盘故障；异地加密备份与磁盘容量告警未实现。真实迁移必须停写。模型已处理但响应丢失时无法恢复未收到的回复，也无法确认费用；unknown 和人工重试是明确边界。单实例服务、外部目录权限和生产配置必须部署前单独验收。

## 本轮停止点

未实现：完整双端同步、本地长期归档、记忆检索/摘要算法、人格编辑界面、工具调用、多模型界面、流式输出、浏览器离线队列、完整费用和预算系统、自主活动、媒体、其他模块 UI。没有自动提交/推送 Git，没有操作腾讯云或其他服务。
