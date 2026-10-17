# 第二阶段阶段性交付与 Chat UI 开发准备

验收日期：2026-10-15。项目：E:/sakie-ai-home；分支 main；已提交基线 2cf90cc26bbb346bc83904d289966147565053d0（第一阶段）。第二阶段仍为工作区改动，尚未提交或推送。本文为当前状态说明；其他阶段文档中的“本轮”“当前数据库”等表述须结合其编写阶段理解。

## 1. 本次操作边界与结论

只读审查业务代码、真实数据库、现有备份及权限；运行类型检查、隔离测试和构建；新增本文及更新文件清单。没有修改业务代码、真实环境配置、聊天记录、真实数据库、现有备份或真实 ACL；没有迁移、启动生产同步、连接云端、调用真实模型、提交或推送 Git。测试对新建夹具执行迁移、恢复、权限设置和回退，不是对真实目录操作。构建写入被忽略的 dist。

结论：第二阶段核心代码及隔离回归通过，尚不能宣称正式双端同步已经启用。真实数据库仍为 v3，当前应用要求 v4；真实 ACL 收紧、真实迁移、设备配对和生产目标人工确认均待单独授权。

## 2. 实际完成情况

| 能力 | 已实现 | 本轮验证及实际启用状态 |
| --- | --- | --- |
| 文本聊天 | ModelProvider 抽象、DeepSeek 官方兼容文本适配器、后端密钥配置、会话/消息/任务/尝试记录 | 模拟供应商及本机 HTTP 回归通过；本轮没有真实付费调用；不代表生产验收 |
| 可靠持久化 | 用户消息、任务和 outbox 原子提交；助手消息与成功状态原子提交；客户端 UUID 幂等，冲突拒绝 | 重复请求、失败、超时未知、进程中断、队列恢复测试通过 |
| 上下文 | 可配置近期完整轮次与字符上限，稳定人格和动态上下文分离；长期记忆不可用时明确告知 | 单测通过；不发送全部历史，不实施长期检索 |
| 认证 | 私人用户会话、HttpOnly Cookie、CSRF/Origin；独立设备令牌、一次性配对和撤销 | 匿名及设备令牌访问业务数据被拒绝；配对/撤销仅夹具测试 |
| 增量归档 | 稳定事件 ID/顺序、内容校验、版本事件、持久化 ACK、断线重试、本地事务后确认 | 本机隔离测试通过；真实 Windows 长期归档未配对启用 |
| 修改和软删除 | 聊天及原四模块版本事件和墓碑；原文不被物理清除 | 回归通过；聊天修改/删除尚无 UI |
| Windows ACL | Check/Plan/Apply/Verify/Restore 工具，哈希审阅、清单检查、危险链接拒绝、原权限恢复 | Windows 夹具真实执行并通过；没有对真实文件 Apply |
| 防误连 | 默认仅精确本机地址；生产 HTTPS 白名单、交互短语、策略哈希及路径绑定、禁止重定向 | 拒绝路径及模拟生产成功路径通过；未批准真实生产目标 |
| 成本边界 | 模型尝试及供应商返回的 Token/缓存用量记录 | 未返回的费用/价格版本/缓存写入为未知，不记成零；完整预算、费用核算未完成 |

聊天以云端顺序为权威，本地代理只主动出站，不开 Windows 入站管理端口。当前为单后端进程、单事件流，不支持多主数据库或多后端共享任务队列。未引入 Redis、Mem0、独立向量库、OB 服务或其他常驻基础设施。

## 3. 数据库、备份与迁移依赖

- 真实库：E:/sakie-ai-home-data/cloud/sakie.db。只读 PRAGMA user_version=3，integrity_check=ok，foreign_key_check 无异常；迁移账本包含连续 v1、v2、v3；chat_messages=2，chat_outbox=2。本报告不记录消息正文或私人标识。
- 本轮逐表有序内容摘要与此前安全 v3 快照一致。此项证明当前逻辑表内容一致，不是全磁盘或操作系统断电保证。
- 当前 backend/src/database/migrations.ts 最新版本 v4。v1 原四业务表；v2 会话认证及记录元数据；v3 持久聊天；v4 增量同步。旧 SQL 校验和受迁移账本保护。
- v4 追加 sync_pairings、sync_devices、sync_mutations、sync_record_events、chat_message_state；保留现有 UUID、原始聊天及 outbox。local-agent 归档库为独立 schema v1，与云端数据库版本不是同一概念。
- 迁移入口位于 backend/src/database/upgrade.ts：一致性备份、独立恢复演练、旧表列值保留校验、事务升级和失败回滚。启动不静默迁移旧库；因此当前真实 v3 不能直接用要求 v4 的后端启动。
- 本轮只读 verifyBackup 校验了已有真实数据副本对应的 v3 快照、隔离 v4 快照、本地归档 v1 快照：清单、文件哈希、SQLite 完整性均通过。没有重新恢复这些真实副本。自动化测试另在合成夹具上实际执行备份/恢复及失败回滚。
- 备份根目录 E:/sakie-ai-home-backups；数据根目录 E:/sakie-ai-home-data，均在源码仓库外。现有同盘备份不能抵御 E 盘整体损坏；异盘/异地加密备份未启用。
- 恢复必须写入新目录；不得用旧快照覆盖含新消息的库。恢复标记要求会话撤销及归档水位核对；不得通过删除标记跳过核对。本地旧备份回退会被归档代际/云端 ACK 检查阻断，需要显式撤销旧设备并受控重新配对。
- SyncService.canPrune 始终拒绝清理。ACK 不等于可以删除原文；没有自动云端原始数据清理逻辑。

本轮查询时未发现本机 3000、5173 监听；未启动开发服务器或常驻同步代理。其他端口和系统服务不在此次检查范围。

## 4. 同步安全约束与覆盖范围

协议基线 docs/sync-protocol-v1.md；实现说明 docs/incremental-sync.md；启用安全步骤 docs/sync-security.md。

本地事件、投影和连续游标必须同一事务 COMMIT 后才能发 ACK。ACK 丢失后按云端持久确认点重放；重复事件校验整个信封，不同内容同 ID 拒绝，不能跳过冲突。收到缺序、逆序、未知类型或恢复水位不一致时停止，保留诊断证据。云端重启保留事件、凭据摘要及确认状态，代理退避持久化，不触发模型重试。

归档范围是原始聊天/版本、四业务模块的现存快照及后续版本，不是整库镜像：会话标题、认证会话、后端任务内部状态、媒体未完整同步。初始旧记录只保存可证实的当前状态，不伪造过去版本。没有长期记忆提取、搜索、自主活动或双向编辑冲突合并。

网络策略位于 local-agent/src/network-policy.ts，transport 和 CLI 强制使用。默认 test 仅允许 http://127.0.0.1:3000 与 http://127.0.0.1:3100；其他测试端口需要显式本机白名单。拒绝 localhost/DNS 推断、通配符、非规范 URL、嵌入凭据、额外路径和重定向。production 必须明确策略文件、精确 HTTPS origin、交互终端确认短语，并绑定策略哈希、数据库和凭据的物理规范路径。凭据版本 2 绑定环境，旧凭据不能自动联网。未生成真实生产批准。

策略不是抵御同一账号恶意改文件的密码学授权；运行中不热加载文件，删除批准文件不会自动停止既有进程。修改配置应先停止代理，再重新确认和启动。

## 5. 本轮实际验证结果

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| npm run typecheck | 成功，退出码 0 | frontend/backend/contracts/local-agent；含后端测试类型检查 |
| npm test | 64 通过，0 失败，0 跳过，退出码 0 | 本机隔离夹具，约 37.2 秒；Windows ACL 测试实际执行 |
| npm run build | 成功，退出码 0 | 四工作区；前端 43 modules、主 JS 270.61 kB / gzip 86.89 kB，为产物大小而非运行内存 |
| git diff --check | 成功 | Git 有 LF/CRLF 提示，不是测试失败 |
| 真实数据库只读检查 | 通过 | v3，不迁移；与此前安全快照逻辑内容一致 |
| 选定既有备份只读校验 | 通过 | v3/v4/归档 v1 各一个，不代表全量历史备份均已重检 |

测试运行时清空进程模型密钥/模型配置，并通过额外 fetch guard 仅放行字面量 127.0.0.1 HTTP。生产成功路径使用模拟 fetch。测试产物放 E 盘新建隔离目录，未清理任何用户数据。故障注入出现的 worker persistence failure 提示是预期测试情景，最终 64 项均通过。

覆盖：匿名/CSRF/越权、幂等聊天、未知调用结果、真实子进程中断、迁移失败与中断、WAL 一致性备份、离线聊天和补齐、重复/冲突事件、本地事务失败不 ACK、ACK 请求及响应丢失、重启和持久游标、软删除、旧备份水位核对、生产误连阻断、ACL 预览/设置/继承/恢复及危险路径拒绝。

尚未验证：公网真实双端链路、真实 v4 启用、腾讯云内存/磁盘/吞吐、断电硬件故障、生产 Docker/Nginx、iPhone/Windows 浏览器端到端交互、跨普通 Windows 账号实际登录读取测试、ACL 中途故障注入。无前端专用测试脚本；后端 HTTP 测试不等于 UI 验收。本轮不重复先前曾获授权的真实模型测试。

## 6. Git 与敏感信息安全

main 跟踪 origin/main；只读远程配置为 https://github.com/yayie1115/sakie-ai-home.git。本轮不联网确认仓库可见性、远程分支或是否有人更新。此前检查曾发现仓库为公开，不能按用户早先期望直接称其为私有；下次提交/推送前须重新确认可见性和目标。

本轮初始状态：25 个已跟踪文件修改、30 个新文件，暂存区为空，HEAD 仍为第一阶段。本次另新增本交付文档；FILES.txt 已在原 25 个修改内。没有 commit/push。

检查全部 82 个已跟踪文件及 30 个未忽略新文件：未发现数据库、备份、真实 .env、设备令牌文件或常见 GitHub/API Key/私钥/AWS 密钥模式。扫描不输出命中内容；模式扫描不是对所有可能秘密的绝对证明。代码测试中的虚构凭据不等于真实秘密。

.gitignore/.dockerignore 排除依赖、dist、真实环境文件、SQLite/WAL/SHM、私钥、设备凭据、配对码、本机策略、生产批准、ACL 计划等；backend/.env 及代表性的敏感文件路径经 check-ignore 确认排除。数据/备份目录是仓库外的独立目录，不应复制进仓库。不能使用 git add -f 绕过忽略规则。

真实数据库副本、含私人数据的隔离验收文件及设备测试凭据位于项目外，不能把这些目录或 JSON/报告附件复制进 docs。本文只保存去敏后的状态、接口和路径约定，不包含聊天、令牌或真实环境变量。普通任意命名验收报告不可能仅靠扩展名自动识别，未来提交仍须人工审阅。

## 7. 风险与待授权事项

| 优先级 | 风险/阻塞 | 下一步前置条件 |
| --- | --- | --- |
| 高 | 真实 backend/.env DACL 仍允许 Users、Authenticated Users 读取；真实安全收紧未执行 | 用户审阅当前 SID/目标，停写，重新生成并审阅 ACL Plan，再单独授权 Apply/Verify；本报告不代表授权 |
| 高 | 真实 v3 与当前 v4 代码不匹配，不能直接启动当前后端验收真实聊天 | 用户明确授权后重新备份及演练，再执行 v3→v4；不得复用旧备份覆盖新消息 |
| 高 | 未实际生产配对/同步，仓库私有属性未重新确认 | 明确实际 origin、环境和部署边界；分别授权生产配置/迁移/配对，禁止把测试凭据用于生产 |
| 中 | 单盘备份、原文长期增长、未有异地备份与容量告警 | 制定独立备份及容量维护计划；继续禁止自动清理 |
| 中 | 模型超时结果可能未知，显式重试可能再次计费 | 保留未知状态及用户确认，不自动重试供应商请求；费用未知如实显示 |
| 中 | 无浏览器端自动化与移动端验收 | 下一 UI 阶段加入交互/分页/登录失效/异常恢复验收，使用模拟模型 |
| 中 | ACL 计划会因新测试文件、WAL 或权限变化失效 | 执行前停写重新计划，不删除数据去迎合旧清单；编辑器替换 .env 后再 Verify |
| 中 | 单进程任务及单事件流，不支持多实例；公网及 VPS 资源未实测 | 保持单实例，部署授权后做受控资源测量，不预报估算内存为实测 |

ACL 工具不是磁盘加密，不能阻止管理员/SYSTEM读取。恢复旧 ACL 会重新开放旧访问，亦需单独授权。数据库升级后若产生新消息，不得简单回滚旧快照；应停写、保存当前完整备份、在副本上制定保留新增数据的回退方案。

## 8. Chat UI 下一阶段可复用清单（未实施）

### 现有组件和路由

- frontend/src/main.tsx：StrictMode、BrowserRouter、AuthenticationGate、AppRouter。
- frontend/src/app/AuthenticationGate.tsx：登录/加载/失败/退出、会话与 CSRF、统一带认证请求；frontend/src/app/api.ts：ApiError、useApi 和上下文。不得另建前端 Token 或把模型 Key 放 VITE_ 变量。
- frontend/src/app/Layout.tsx：现有导航及 Outlet；frontend/src/app/router.tsx：/ 首页占位、/chat 真实 ChatPage、其余模块占位、404。首页“各模块尚未实现”文字已滞后，此轮不改界面。
- frontend/src/modules/index.ts：chat、memory、diary、dream、activity、music、device。动态/收藏/设置尚无独立页面或路由，不得报告为已完成。
- frontend/src/modules/chat/ChatPage.tsx：现有 ChatPage 和文件内 ChatPanel，负责会话列表/创建/切换、消息分页/合并/排序、草稿、发送幂等 ID、任务轮询、失败/未知重试及离开提醒。可在 UI 开发时按职责抽取，但本轮不重构。
- frontend/src/styles.css：极简基础样式，无完整设计系统。packages/contracts/src/index.d.ts 提供共享协议；需要前端视图模型时应复用而非另定义不兼容消息结构。
- frontend/vite.config.ts：127.0.0.1:5173 严格端口，/api 代理到本机 3000；当前未启动。构建通过不等于地址当前可访问。

### 现有 HTTP 契约

所有下列业务接口通过现有会话；写入还需 X-CSRF-Token 和合法 Origin。响应及错误字段以 routes/store/contracts 为准。

| 接口 | UI 可复用语义 |
| --- | --- |
| GET /api/chat/config | configured、maxMessageChars、memoryStatus；GET 不触发模型 |
| GET /api/chat/conversations?before=&limit= | items/nextBefore，会话默认 20，最大 100 |
| POST /api/chat/conversations | id（客户端 UUID）、title；重复创建使用同 ID |
| GET /api/chat/conversations/:id/messages?before=&limit= | items/nextBefore/unresolvedTurn；默认 50、最大 100；before 为排他消息序号 |
| POST /api/chat/conversations/:id/messages | clientMessageId/content；202 是可靠受理，不是助手完成；不确定网络结果重放同 ID，同 ID 不同内容冲突 |
| GET /api/chat/turns/:id | turn/messages；只读轮询，不能据轮询失败自动重发模型 |
| POST /api/chat/turns/:id/retry | retryId/acknowledgeUnknown；未知结果需明确再次计费确认，重试复用 retryId |
| PATCH /api/chat/messages/:id | requestId/baseRevision/content，版本冲突需处理；现 UI 尚未接入 |
| DELETE /api/chat/messages/:id | requestId/baseRevision，软删除，现 UI 尚未接入 |

已有轮询在排队/运行时约 1.2 秒、读取错误时约 3 秒，仅查持久状态，不调用模型；完成/卸载停止。后续界面须区分排队、运行、成功、已知失败、未知、断网、未配置、登录失效和版本冲突，不能把 HTTP 202 当成功回复。

### 下一阶段建议及验收点

先由用户给出 Chat UI 目标和交互偏好，再确定布局；本报告不选择气泡、分栏、配色或导航方案。先复用现有认证、API、会话/消息状态与幂等语义，再针对批准的界面改动补验收。

现有边界：草稿和待确认请求 ID 仅存在当前页面内存，刷新/关闭后不保证未受理草稿恢复；未实现浏览器持久离线发件箱。当前消息集合按 ID 合并，刷新时不会自动移除其他窗口已软删除且不再返回的消息；重新加载页面可取最新集合，UI 阶段需设计正确的版本/删除刷新行为。未实现流式输出、Markdown、多媒体和长历史虚拟列表。

建议使用模拟模型验证：登录及 401 回登录；会话切换和翻页不重复/乱序；重复点击及丢失响应不重复调用；未知结果明确确认；软删除和版本变更刷新一致；页面关闭草稿提醒；iPhone 键盘、滚动、长文本和 Windows 浏览器实际操作。页面打开/轮询不能新增模型调用。真实 v4 未授权前，可用新建合成数据库和模拟 Provider开展 UI 开发，不接触私人历史。

## 9. 尚未启用与停止点

真实 v4 迁移、真实 ACL、真实设备配对、生产批准、常驻代理、自启动、云端部署、长期记忆算法、完整成本预算、媒体归档、双向同步及 UI 改版均未在本轮启用或实现。本阶段止于交付文档和隔离验收结果，等待进一步指令。

## 10. 未提交文件清单

以下为本轮整理后的工作区清单，不包含被忽略的依赖、构建或私人测试产物；状态 M 为已跟踪修改，?? 为新文件。

~~~text
 M .dockerignore
 M .gitignore
 M FILES.txt
 M README.md
 M backend/.env.example
 M backend/src/app.ts
 M backend/src/config/env.ts
 M backend/src/database/fingerprint.ts
 M backend/src/database/migrations.ts
 M backend/src/database/repository.ts
 M backend/src/database/upgrade.ts
 M backend/src/modules/chat/README.md
 M backend/src/server.ts
 M backend/src/shared/record-router.ts
 M backend/test/storage.test.ts
 M backend/tsconfig.test.json
 M docs/sync-protocol-v1.md
 M frontend/package.json
 M frontend/src/app/AuthenticationGate.tsx
 M frontend/src/app/router.tsx
 M frontend/src/modules/chat/README.md
 M local-agent/package.json
 M local-agent/src/index.ts
 M package-lock.json
 M packages/contracts/src/index.d.ts
?? backend/src/modules/chat/config.ts
?? backend/src/modules/chat/context.ts
?? backend/src/modules/chat/deepseek.ts
?? backend/src/modules/chat/provider.ts
?? backend/src/modules/chat/routes.ts
?? backend/src/modules/chat/schema.ts
?? backend/src/modules/chat/service.ts
?? backend/src/modules/chat/store.ts
?? backend/src/modules/sync/events.ts
?? backend/src/modules/sync/mutations.ts
?? backend/src/modules/sync/routes.ts
?? backend/src/modules/sync/schema.ts
?? backend/src/modules/sync/service.ts
?? backend/test/chat.test.ts
?? backend/test/sync-security.test.ts
?? backend/test/sync.test.ts
?? docs/incremental-sync.md
?? docs/phase2-handover.md
?? docs/phase2-text-chat.md
?? docs/sync-security.md
?? frontend/src/app/api.ts
?? frontend/src/modules/chat/ChatPage.tsx
?? local-agent/src/archive.ts
?? local-agent/src/cli.ts
?? local-agent/src/network-policy.ts
?? local-agent/src/runner.ts
?? local-agent/src/schema.ts
?? local-agent/src/transport.ts
?? local-agent/sync-policy.production.example.json
?? local-agent/sync-policy.test.example.json
?? tools/windows-acl.ps1
~~~
