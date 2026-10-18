# Chat 数据与 API 契约草案 v1 · 2026-10-18

> 状态：**设计草案，不是已实现 API，也不是数据库迁移授权**。与 `docs/design/chat-v11-codex-handoff.md` 配套。前端可据此定义 mock，但不得假定这些接口已经上线。

## 1. 代码审计依据（当前 main）
- `backend/src/modules/chat/schema.ts`：现有 v3 包含 `chat_conversations`、`chat_turns`、`chat_messages`、`chat_attempts`、`chat_retry_requests`、`chat_outbox`。
- `backend/src/modules/chat/store.ts`：会话目前仅 `id/title/created_at/next_turn_seq`；列表按 rowid，不按最新活动；每轮固定用户与助手各最多一条消息，消息序号 `turn_seq*2-1/turn_seq*2`。
- `backend/src/modules/chat/routes.ts`：已有创建/列表、发送/消息分页、轮次/重试、消息 PATCH/DELETE；**没有**私聊角色选择、群成员、草稿、待提交、引用、搜索、会话回收站等 API。
- `backend/src/modules/chat/service.ts`：`send` 直接创建 queued 轮次并 kick worker；绝不能把 UI 的“暂存”接到现有发送接口。
- `backend/src/modules/sync/mutations.ts`：现有编辑只维护最新 `chat_message_state`，不能把它误认为完整可切换的版本历史；现有修改要求轮次已 succeeded。
- `backend/src/database/migrations.ts`：现有 latestVersion=4，所有扩展必须另追加迁移，**禁止修改既有迁移 SQL 或历史校验和**。

## 2. 不可改变的边界
1. 角色 `personaId` 全局唯一，角色模型/人格配置全局共用；`conversationId` 是消息、草稿、引用、群内备注、权限的隔离边界。一个 AI 的多个会话不等于多个 AI。
2. 私聊一个角色至多有一个有效会话（可从回收站恢复）；群聊有独立成员表，成员加入可见该群全部历史，但无权读取其他会话。
3. 保留原 `chat_turns`、`chat_messages`、`chat_outbox`、重试幂等及归档语义。既有消息 ID、序号、内容哈希不能重新编号或覆盖。原始消息不因 UI 编辑被静默改写。
4. 既有 v3 固定一轮两条消息，**与 v11 多气泡/待提交/单泡重生成不兼容**。设计需区分逻辑回合与消息气泡，先提出迁移兼容方案（例如新增 bubble 表和排序键，保留 legacy 映射），不得直接删除旧 UNIQUE(turn_id,role) 或重算历史序号。
5. 草稿与待提交必须在服务端明确区分；暂存不产生 `chat_turns`、`chat_attempts` 或模型调用；最终提交成功才进入既有持久队列。发送成功前不得清空客户端唯一副本。
6. 切换会话不触发模型。客户端数据缓存必须以 `conversationId` 为 key；所有异步请求返回时验证请求所属会话，禁止过期响应覆盖当前输入框。
7. 删除/恢复和永久清理必须考虑 outbox、归档副本、记忆证据、多源记录、共享媒体及备份保留策略；**30 天到期不代表能直接 SQL 级联删除所有副本**。

## 3. 逻辑模型（建议映射，非强制一表一对象）
- `Persona`: `id`, `displayName`, `modelConfigRef`, `personaConfigRef`, `status`。
- `Conversation`: `id`, `kind: private|group`, `title`, `privatePersonaId?`, `privateRemark?`, `pinnedAt?`, `lastActivityAt`, `deletedAt?`, `purgeAfter?`, `revision`。
- `ConversationMember`: `conversationId`, `personaId`, `groupRemark`, `groupBehaviorConfig`, `joinedAt`, `membershipRevision`。
- `Draft`: `conversationId`, `body`, `quoteTarget?: {messageId,versionId,selectedText?}`, `revision`, `updatedAt`。初版可本地持久化，必须显式标注离线/跨设备不保证；正式多端同步需单独 API。
- `PendingBubble`: `id`, `conversationId`, `kind`, `content`, `quoteTarget?`, `position`, `revision`。服务端持久化可选阶段，**未最终提交不得成为模型上下文或归档的正式聊天消息**。
- `MessageBubble`: `id`, `conversationId`, `turnId`, `speakerPersonaId?`, `bubbleOrder`, `kind`, `activeVersionId`, `createdAt`, `deletedAt?`。
- `MessageVersion`: `id`, `messageId`, `versionNumber`, `content`, `origin: original|edit|regeneration`, `status`, `createdAt`。搜索、模型上下文和记忆只使用当前**有效且获准**版本；旧版本供用户查看但不默认进入检索。
- `ChatEvent`: `id`, `conversationId`, `turnId?`, `kind`, `status`, `occurredAt`, `safeSummary`，仅展示真实可验证事件。
- `RecycleEntry`: `id`, `resourceKind`, `resourceId`, `deletedAt`, `purgeAfter`, `restoreState`；复用未来统一回收站服务，不让 Chat 独建孤立回收站。

## 4. API 契约候选（新增/扩展；**未实现**）
| 方法 | 路径 | 关键行为 |
|---|---|---|
| GET | `/api/chat/personas` | 可选 AI 角色；不暴露密钥 |
| POST | `/api/chat/conversations` | 扩展 `kind`、`personaId` 或 `memberPersonaIds`；私聊按 persona 去重；新群成员必须明确选定 |
| PATCH | `/api/chat/conversations/:id` | `title/privateRemark/pinned` 等字段，乐观并发 revision |
| GET/PUT | `/api/chat/conversations/:id/members` | 群成员及各群独立备注/行为，版本冲突保护 |
| GET/PUT | `/api/chat/conversations/:id/draft` | 可选跨设备草稿；`body/quote/revision`，绝不触发模型 |
| GET/POST/PATCH/DELETE | `/api/chat/conversations/:id/pending` | 待提交气泡管理、顺序调整；不产生正式 turn |
| POST | `/api/chat/conversations/:id/submit` | 带 `submissionId` 幂等；原子消费待提交快照、写正式轮次/outbox、触发队列；成功后才清空 pending |
| GET | `/api/chat/conversations/:id/search` | 关键词、日期、分页游标、当前有效版本、消息跳转定位 |
| GET/POST | `/api/chat/messages/:id/versions` | 查看版本、显式编辑/重生成；重生成需要新的幂等 ID 与明确费用确认边界 |
| DELETE/POST | `/api/chat/conversations/:id`, `/api/recycle/:entryId/restore` | 软删、30 天恢复、检索权限撤销；到期清理独立后台流程 |

上述 `submit` 是**目标接口**，不是对旧 `POST /conversations/:id/messages` 的替换承诺。实施前必须给旧单气泡客户端保留兼容路径；提交多气泡必须定义原子性、同会话未完成轮次处理、提交时网络中断/重复请求、部分附件失败以及用户编辑待提交内容时的冲突。

## 5. 状态机和验收
- 输入 `editing` → 点击暂存 `pending` → 用户编辑/排序/删除（仍 `pending`）→ 最终提交 `submitting` → 服务器 durable 202 `queued` → `running` → `succeeded|failed|unknown`。
- `submitting` 网络未知时**使用同一 submissionId 重查/重发**，不能自动创建第二轮或丢弃本地待提交。
- 引用目标必须包含 `conversationId/messageId/versionId`，不允许引用跨权限消息；被删除/失效的引用显示不可用标记，不能悄悄串入别的会话。
- 置顶不改变真实 `lastActivityAt`；新群创建可以记录创建活动；未读状态与消息排序独立。
- 会话删除后禁止新提交、禁止历史搜索/记忆检索、停止后续生成的接纳；进行中的模型调用须定义中断与供应商不确定费用，不宣称能撤销已发生调用。
- 必测：跨会话草稿/引用/待提交隔离；新建私聊角色选择和去重；新建群未选成员不创建；刷新恢复；提交幂等和重试；旧 v3 消息兼容；编辑/重生成有效版本；软删恢复；记忆检索撤销； outbox/归档不丢事件；认证与 CSRF。

## 6. 实施门槛和安全
1. 先在合成 SQLite 和假模型下做迁移兼容性与 API 测试，提交设计评审和风险，再编码。任何迁移只允许新版本号追加，不修改 v1-v4。
2. 先让前端用 mock 实现 v11；后端独立增加契约，最后联调。禁止把未实现 API 写成已完成。
3. 不访问、不修改 `E:\sakie-ai-home-data\cloud\sakie.db`，不触碰真实备份/ACL/密钥，不部署腾讯云、不调用真实模型；生产启用需用户单独明确批准。
4. 记忆系统的候选代码尚未在本次逐文件审计中确认，必须单独核对，不能声称已接入。
