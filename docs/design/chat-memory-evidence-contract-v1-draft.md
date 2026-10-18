# Chat × Memory 证据与失效契约草案 v1 · 2026-10-18

> **设计草案，尚未实现、尚未批准数据库迁移或生产启用。** 配套阅读 `docs/design/chat-v11-codex-handoff.md` 和 `docs/design/chat-data-api-contract-v1-draft.md`。

## 一、现有代码事实（已核对 main）
- `backend/src/modules/memory/routes.ts` 使用通用 `recordRouter` 操作 `memories`，字段为 `id/content/type/createdAt/importance`；目前没有可见的 Chat 来源证据关联或检索权限判断。
- `backend/src/modules/chat/context.ts` 只读取当前会话近期已成功的 user/assistant 对，并明确向模型声明长期记忆与 Windows 归档检索不可用；不能宣称已经集成长期记忆。
- `backend/src/modules/sync/mutations.ts` 修改消息时写 `chat_message_state` 最新修订及 outbox 事件，不提供完整历史版本切换；消息修改只允许成功轮次。
- `backend/src/modules/sync/events.ts` 将事件写入 `chat_outbox` 供后续归档；归档事件是同步事实，不等于 AI 当前有权检索。
- 当前仓库代码搜索未发现独立 `memory-next` 候选实现；它可能在其他分支/未合并代码中，**本次不能证明已存在或已接入**。后续必须单独核对来源、分支和测试。

## 二、设计原则
1. **原始经历不可静默改写；当前可用的解释可以修订。** 将消息事实、候选记忆、解释、证据来源、当前有效性分开保存。
2. 记忆不是对话记录的复制品：候选提取 → 来源核验 → 权限判定 → 去重/关联 → 可用记忆。不得把 AI 的猜测当用户事实。
3. 每个可检索记忆至少有 `memoryId`、`claim/summary`、`sourceEvidence[]`、`scope`、`status`、`updatedAt`；证据包括 `conversationId/messageId/versionId`（或其他模块的来源 ID）。
4. 区分 `user_stated`、`assistant_inferred`、`externally_verified` 等证据性质；主观印象可存为印象，不升级为客观事实。
5. 记忆权重可衰减，不代表删除原始经历；对事实认识变化保留旧解释及修订轨迹。
6. 检索权限必须在**每次读取时**验证，不能仅在写入向量索引时判断。群成员可读本群获准历史，不因此能读其他私聊。
7. 一个 AI 的全局人格与模型配置共用；会话范围内私密信息不能因人格连续性自动泄漏到其他会话。跨会话记忆共享须有显式 scope/授权策略。
8. 已撤销、删除、回收站、失效版本、未提交草稿、待提交气泡、未知/失败生成内容不得进入正常检索或模型上下文。

## 三、证据状态与事件
| 事件 | 证据与记忆处理 |
|---|---|
| 成功提交并完成生成 | 合格消息版本可作为候选来源；提取异步执行，失败不阻塞 Chat |
| 暂存/草稿 | 不提取、不检索、不进入 AI 上下文 |
| 编辑消息 | 旧版本证据标记 superseded，重新验证由它支持的记忆；新版本需重新提取/审核 |
| AI 单泡/整轮重生成 | 只有用户选定且成功的版本成为 active；未选版本不参与检索 |
| 删除消息 | 立即撤销该消息对检索和记忆的可用性，相关记忆重新计算证据支持 |
| 删除会话进入回收站 | 立即禁止从该会话读取历史、检索或继续提取；已派生索引必须按来源禁用 |
| 30 天内恢复会话 | 在用户仍有权限、版本仍有效的前提下重新启用来源；需重新校验派生记忆，不盲目恢复旧缓存 |
| 到期永久删除 | 在明确的归档/同步/备份保留策略下，受控擦除会话独有的来源与派生内容；多来源记忆保留其他独立证据支持的部分 |
| 记忆被用户纠正 | 记录纠正和反证，降低或撤销旧结论，保留审计关系；不要静默覆盖事实来源 |

## 四、关键设计：多来源记忆
例：某个偏好同时由私聊 A 与日记 D 独立支持。删除 A 后，记忆不能继续引用 A，也不应无条件删除 D 支持的结论。

建议采用 `memory_claims` + `memory_evidence_links` 的逻辑关系：
- `memory_claims` 保存当前结论、事实/印象性质、置信度与状态。
- `memory_evidence_links` 逐条保存来源类型、来源 ID、消息版本、独立性及撤销状态。
- 检索时以**仍获准且有效的证据集合**判断是否可用。无有效来源的结论变为 `unsupported`，从模型上下文和搜索结果中排除。
- 源证据只在授权范围内用于当前对话；即使结论本身可跨会话共享，也不能泄露受限来源的原话、链接或具体细节。

## 五、检索门禁（伪流程）
```text
request(personaId, conversationId, userContext)
  -> verify current owner/session and conversation not deleted
  -> verify persona membership and allowed memory scope
  -> candidate memories (only active claims)
  -> for each claim, filter evidence by source version ACTIVE,
     source conversation not deleted, source permission allowed,
     evidence not revoked
  -> reject unsupported claims
  -> redact restricted source details
  -> budget by relevance, importance, recency, uncertainty
  -> assemble model context with provenance/uncertainty labels
  -> record retrieval decision without leaking secrets to logs
```
默认 **fail closed**：权限或来源状态不可验证则不检索。记忆检索失败不得假装成功或编造共同经历。

## 六、原子性、同步与清理
- 消息状态/版本/删除与其来源失效标记必须有事务一致性或可靠 outbox 事件补偿；检索层采用实时状态门禁，避免异步索引尚未更新的泄漏窗口。
- `chat_outbox` 既有事件不应被简单删掉以伪装“忘记”；应设计删除墓碑、归档消费者确认、派生副本清理与备份保留边界。
- 回收站到期清理需要幂等任务、失败重试、进度记录及独立验证；**没有这些机制之前不得自动物理删除真实库数据**。
- 多设备同步后，撤销权限要能在离线设备重新连接时传播；离线缓存不能无限保留可检索副本。

## 七、实施顺序与验收
1. 先找到并审查任何 `memory-next` 候选分支/补丁；不要重做已存在且合格的能力。
2. 在合成库设计证据链接、有效版本与权限门禁；先做消息编辑/删除/会话软删导致检索失效的测试。
3. 设计多源记忆重新计算、恢复会话、权限变化与异步索引失效测试。
4. 最后接入提取与上下文组装；先假模型、假记忆，核实可追溯、无跨会话泄漏、失败关闭，再讨论真实模型启用。
5. 全程不操作真实主库、备份、生产部署或真实模型；新增数据库迁移只能追加版本，不得改写历史迁移。

## 八、必须通过的测试
- 私聊 A 的专属秘密不进入群聊 B 的模型上下文。
- 群聊新成员可读取本群获准历史，但无法检索其他会话。
- 草稿、暂存和失败/未知回复不被提取。
- 编辑/重生成后旧版本不进入搜索、记忆或上下文。
- 删除会话后即刻检索不到其独有证据；恢复后重新核验。
- A+D 两来源记忆：删除 A 后保留 D 独立支持的内容，但不泄漏 A。
- 记忆权重衰减不擦除原始经历；用户纠正不被旧印象覆盖。
- 索引更新失败、断线或权限状态未知时，检索拒绝受限内容。
