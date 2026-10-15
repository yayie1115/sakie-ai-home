# 同步协议基础（第一阶段仅定义，未实现传输）

## 状态与范围

协议类型位于 packages/contracts/src/index.d.ts。本阶段没有 WebSocket、聊天 API、消息任务、同步轮询、消息清理任务、设备配对 API 或自动归档。接口声明不等于已实现的持久化能力。

## 职责与权限

- 云端是聊天顺序的唯一权威；浏览器不决定 turnSeq，Windows 不重排云端轮次。
- Windows 保留完整原始消息；云端保存持久消息、必要人格副本、近期上下文和待同步原始事件。
- 第一版采用云端顺序写入、Windows 完整归档，不设计通用多主数据库。
- 未来本地服务主动连接云端认证 WSS，不监听公网管理端口。设备凭据与用户登录会话分离，单次配对、权限范围和撤销由 DeviceAuthPort 约束；本阶段没有创建设备凭据。

## 唯一标识与原子落盘

ClientMessage 使用 clientMessageId + conversationId；重复提交保留原 clientMessageId。同 ID 同正文返回原结果，同 ID 不同正文冲突，禁止覆盖。messageId、turnId、eventId 均必须全局唯一。turnSeq 决定会话处理顺序；streamSeq 决定同步流顺序；producerId + producerSeq 识别来源流。不能用 UUID 或机器时间排序。

CloudMessageStore.accept 必须在同一 SQLite 事务中持久保存消息、任务和 outbox 后才返回 DurableMessageReceipt。消息确认、处理完成、收到网络帧和可靠归档是不同状态。未来实现应使用数据库唯一约束和内容哈希，而不是只在内存查重。

## 连续确认与重试

SyncEvent 包含 schemaVersion、eventId、producerId、producerSeq、streamSeq、payloadHash、kind、payload。

LocalArchivePort.commitBatch 必须原子提交原始事件、幂等收据和游标；仅提交成功才返回 durability=committed 的 ArchivedCursor。收到帧不能视为归档完成，ACK 不能跨越尚未提交的缺口。发送侧保留事件直到可靠归档确认；ACK 丢失时重发，接收侧只入库一次。

连接中断使用有抖动的指数退避，重试与游标必须落盘。首次连接、追平中、在线可用要分别表示。只有归档追平约定水位后，才允许完整记忆与自主活动。未知事件或坏哈希保留错误证据，不静默跳过。

## 旧备份恢复

ArchiveIdentity 必须有 archiveId 与 restoreGeneration；恢复旧备份会产生新的 restoreGeneration。ResumeRequest 携带本地可靠游标，云端遇到归档代次变化、未知归档或本地游标领先，返回 reconcile-required，不能直接沿用旧确认水位。

第一阶段恢复工具生成 restore-info.json，其中 requiresArchiveReconciliation=true、requiresSessionRevocation=true。prepareStorage 会拒绝直接启动这种恢复候选。真正的同步水位复核和人工启用流程留待后续阶段；不得为了启动而直接删除恢复标记。副本迁移演练可以读取隔离候选，不代表它被启用为运行库。

## 保留与冲突

未可靠归档的原始消息不得按缓存 TTL、摘要预算或窗口裁剪删除。RetentionPolicy 的接口仅预留，本阶段没有任何自动清理实现。未来达到容量边界时必须报警或拒绝无法持久化的请求，不能伪造接受成功。

未来可编辑对象使用 aggregateId + baseRevision，旧版本修改形成明确冲突并保留双方版本。设备时钟不能作为覆盖依据。原始经历不因去重、衰减或摘要删除；用户永久删除及备份擦除的权限与审计另行设计。

## 第二阶段验收合同

1. 断开 Windows，用假模型完成云端消息收取与回复，重启云端后已确认消息仍存在。
2. 同消息和同批事件重发十次，只保留一次；同 ID 不同内容返回冲突。
3. ACK 丢失、乱序批次、处理时杀进程后能续传，不跨缺口推进游标。
4. 恢复旧本地快照必须进入 reconcile-required，不直接宣布完整在线。
5. Windows 上线后对账 ID、轮次、正文哈希和事件数；自主活动在离线及追平期间为零。
6. 模型调用未知结果不能当作普通同步重试，避免重复费用。
