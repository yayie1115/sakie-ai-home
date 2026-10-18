# Chat v11：隔离批提交闭环与最小兼容方案

2026-10-18。已保护本地全部 21 个未提交文件并校验副本；安全快进最新 main `02c46d5`，读取新 Chat 数据/API、Chat×Memory 和候选审计草案。仓库经 GitHub 元数据确认仍为 Private。首批 React 报告已单独提交/推送：`31cb153`，仅一份文档，没有夹带源码。本报告是本批第二份文档交付；候选源码仍保留本地，不把尚未确认的 MEM-04/README/路由改动一并提交。

## 本批实际完成

复用现有 React Timeline、owner 登录/CSRF、UUID、ChatService/ChatStore、queued turn、revision、原子 outbox 和 LocalArchive，完成**合成私聊的多气泡最终提交→假模型→持久历史→刷新恢复**。没有新建生产 API、改旧 SQL/迁移校验和或重写同步。

- 暂存、编辑、删除、重排仅在标签页合成草稿中进行；暂存不写 turn/attempt/outbox，不调用模型。
- 最终提交冻结 `submissionId + 有序 bubble UUID/revision/content/quote`，先保存客户端快照，再发送。未收到匹配的 durable 回执不丢 pending；相同请求重试/并发点击复用编号。durable 202 不冒充模型回复成功。
- 客户端先持久保存已消费的草稿，再释放提交编号；覆盖服务器已落盘但回执丢失、以及客户端收到回执后尚未来得及清草稿的崩溃窗口。明确的未入库拒绝可解锁原气泡；未知、冲突回执不自动更换编号或重复调用。
- 服务端在继承的 BEGIN IMMEDIATE 入库事务内检查引用当前 revision/成功轮次/原文/同会话范围，以及新气泡 UUID 不与旧气泡或 legacy 消息 ID 冲突；任一失败不产生部分回合。
- 已接纳重试先验证既有正文哈希，不因引用后来编辑而使原持久回执失去幂等性；新提交引用旧版本则拒绝。
- 独立运行器只创建带专用标记的新合成库，仅监听回环，用固定假模型，不加载 dotenv、真实凭据或供应商 SDK。联调页面先检查服务端注入标记，再挂载登录组件；普通 Vite 页面误带 `?lab=1` 时不发任何认证/API 请求。

### 兼容机制与限制

旧 v3 有 `UNIQUE(turn_id,role)`，且 messageSeq 固定为 turnSeq×2±1。因此实验将气泡清单编码进**一个** legacy 用户消息的规范 JSON envelope (`sakie.text-bubbles.lab.v1`)，由旧 send 原子落盘并只 kick 一次队列；历史投影还原各气泡。不是把多个气泡循环调用旧发送 API。legacy 单气泡 API 不变；历史 UUID、序号和内容哈希没有重写。

这只是**实验兼容候选，不是正式最终存储设计**：旧客户端会看到 envelope，普通模型上下文也会看到编码内容（实验假模型专门解码）；没有证明真实模型适配。既有 outbox 和 LocalArchive 无须理解新事件种类，就能逐字归档全部 bubble ID、顺序和正文。测试已核对归档原文一致且未清理 outbox；没有执行公网同步或真实配对。

## 正式联动最小方案 / 当前缺口

| 能力 | 最小兼容处理 | 尚未完成 |
|---|---|---|
| 多 pending 最终提交 | 当前隔离 envelope + 一次旧 turn；永久保留 parent messageId 与 bubbleId 映射，先验证原子性 | 正式版建议追加 bubble/version sidecar，与 legacy 消息映射；不移除旧约束、不重编号。迁移须另行评审，不能直接把 lab 格式启用到主库 |
| 消息版本 | quote 用 parent messageId + 当前 revision + bubbleId 绑定；既有 PATCH/DELETE/outbox 不变 | chat_message_state 只有最新修订，不是完整可切换版本。独立气泡编辑/重生成、activeVersionId、版本历史和双端物化尚未实现，联调不假装支持 |
| 群聊权限 | 当前服务只允许一个显式合成私聊；跨会话引用拒绝，不接受客户端群标签或 actor 列表授予权限 | 需要可信 persona/member/会话 kind 与 membershipRevision；新成员仅获得本群全部历史。owner 登录不等于 AI 有权访问所有会话。当前无正式群聊 API |
| 会话回收站 | 原 v11 的会话删除/恢复仍是独立合成 UI；不调用真实删除 | 需要统一回收站元数据/修订、即时禁止提交与检索、生成中接纳策略、恢复再核验，以及同步能力协商。旧消费者拒绝未知事件，不能单方面新增新 kind 或偷偷清 outbox |
| 记忆来源失效 | 本批不调用 memory-next；临时来源应标 parent+revision+bubbleId，编辑 parent 会保守失效整批来源 | envelope 不能直接当自然语言证据投给旧 reader；正式 bubble 证据适配、会话软删/成员撤权实时门禁、恢复及多源重算均待后续，不能声称已经集成 |

## MEM-04 只读登记（未重做）

- **已在 main**：`backend/src/modules/memory-next/` 12 个隔离源码，及 batches/integration/version-regression 三个测试文件。相关历史：`9cfa7aa`、`81a9fb4`、`64f7885`。来源批次、当前版本失效、授权解析和同连接 source/grant 原子核验均可复用。
- **仅本地未提交**：`extraction-provider.ts`、`extraction-service.ts`、43 项模型提取测试和原 MEM-04 报告。43/43 与完整 184 项结果是此前证据，本轮未重跑或冒称新增验证。
- 新远程记忆草案关于“搜索未找到候选”的表述不代表本地/历史不存在；本轮已用 Git 跟踪清单与提交核实。
- Chat v4 reader 固定私聊 scope，且没有完整成功生成/会话回收站/群成员门禁，不应直接作为新群聊记忆来源。现有 memory-next 也尚未接生产上下文。
- 本轮未修改这些源码或测试；以保护副本哈希复核，不展开并行记忆工程。

## 准确源码文件清单（本地候选，未随报告提交）

新增：

1. `packages/contracts/src/chat-v11.d.ts`：隔离批提交/回执/引用/历史类型。
2. `backend/src/modules/chat/v11-lab/codec.ts`：严格请求字段/UUID/大小校验及规范 envelope。
3. `backend/src/modules/chat/v11-lab/store.ts`：薄继承入库门禁，在旧 accept 事务内核验引用与 UUID；不复制队列逻辑。
4. `backend/src/modules/chat/v11-lab/routes.ts`：仅实验运行器挂载的认证路由与合成库限制。
5. `frontend/src/modules/chat/v11/submission.ts`：可恢复、并发去重的最终提交客户端。
6. `frontend/src/modules/chat/v11/LinkedChatDemo.tsx`：复用现有 Timeline 的认证联调组件。
7. `tools/chat-v11-lab.mjs`：合成库/假模型/回环服务启动与严格限定的续跑入口。
8. `tools/chat-v11-linked.acceptance.mjs`：新增定向 API、归档、故障恢复及真实浏览器验收。

调整：`packages/contracts/src/index.d.ts` 仅追加 type export；`GroupChatPreview.tsx` 增加有标记的联调分支；`v11/state.ts` 增加来源引用元数据；`v11/Timeline.tsx` 增加提交中锁定/真实版本入口拒绝/来源引用传递；`group-chat-preview.css` 增加提交状态样式。上述前端路径均位于 `frontend/src/modules/chat/`。

未改：旧 app.ts、ChatPage、ChatStore/ChatService/原 routes/schema、数据库迁移、sync/local-agent、README、main.tsx、router.tsx、全部 memory-next 及原有备份文件。

## 实际测试

| 命令/证据 | 结果 |
|---|---|
| `npm run typecheck` | 四工作区通过；后续前端安全门修改后另跑 frontend typecheck 通过 |
| backend / frontend build | 通过；最新前端 52 模块，JS gzip 约 97.53 kB，仅产物大小非内存实测 |
| `node --import tsx --test tools/chat-v11-linked.acceptance.mjs` | **15/15，通过，0 失败/跳过** |
| `node --import tsx --test tools/chat-v11.acceptance.mjs` | **原有 13/13，通过，0 失败/跳过**；因共用组件本批改变而针对性复验，不是重做 |

15 项覆盖：路径/库防误连、owner/CSRF/Origin、最终提交原子性、旧归档兼容、并发和丢回执幂等、UUID 冲突、非法请求拒绝、outbox 故障完整回滚、当前引用核验、重启及旧单消息 API、客户端快照/存储失败/错误回执/确定拒绝/并发，以及真实 Edge 393px 手机视口下暂存→两气泡提交→假回复→刷新→丢回执→原 ID 重试。浏览器还验证普通静态页误带 lab 参数时零 API 请求。

未重跑 132 项旧回归、公网 HTTPS、正式数据库副本或真实模型；本次合成测试不代表生产验收。新实验库创建沿用现有 v1-v4 初始 schema，没有迁移旧库；原演练目录和备份没有读取、覆盖或删除。

## 可运行入口与后续

本机已启动：`http://127.0.0.1:5191/demo/chat-group?lab=1`。需登录，**公开合成演示密码** `demo-only-sakie-v11`，不是私人凭据。暂存多条后最终提交，会得到明确标注的假模型回复。服务只绑定本机；不能从手机直接通过公网访问。运行器：`node tools/chat-v11-lab.mjs`（构建后启动）；已构建可加 `--no-build`。`--resume` 只接受本工具创建且标记匹配的实验运行名称，不接受真实数据库路径。原 `5187/demo/chat-group` 仍是无 API 的 UI 演示。

剩余风险：envelope 不是正式 bubble/version 存储；实验 history 只读最近 100 条 legacy 消息、缺生产分页；UUID 唯一性扫描未做规模优化；未做真实 iPhone Safari/多进程多实例/正式负载或真实模型验证；客户端恢复限当前标签页 sessionStorage，存储不可用时停止发送。不会靠现有实验身份授权生产。

本轮无需进一步高影响授权即可完成上述实验。正式库备份/追加迁移、真实群聊/设备身份、ACL、生产 API/部署、真实模型收费调用，都仍需另行明确授权，本轮均未做。下一批建议：先评审正式 bubble/version sidecar 与 legacy 映射，再在新的合成库验证当前版本/成员门禁/会话软删的统一有效性；不要直接把本实验格式用于真实聊天或并行扩建 MEM-04。
