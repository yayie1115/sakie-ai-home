# Morrow + Serein：上下文来源与联合恢复交接（2026-10-28）

## 结论

**本轮交付了可执行的宿主来源清单、保守写入保护、联合加密快照及恢复候选；没有完成正式原话同步的全部放行条件，因此没有开启正式同步，也没有部署本轮宿主候选。** 不把局部清单的 `complete` 当作双方完整来源认证，不修改 `SOURCE_RETRACTION_VERIFIED=False`，不自动解除 `recall_blocked`。自动 Event 仍独立关闭。

基线 GitHub/local main 为 `27054b290383923dd11aff8262de97bdcf19ea6c`，开始时工作区干净。正式部署文件树为 `bd6c8afcfe1b8600868ad6b93eb8449b194e8633`，无未提交改动。既有固定 Serein 上游仍为 `ec9f99e8cbc5abf6c024e668760e5cf55884c3dd`，未更新或重装。

## 实际实现与边界

|能力|本轮实际结果|生产状态|
|---|---|---|
|消息、有效版本、正文哈希、会话、可解析来源事件 ID 的依赖清单|新增 `context_provenance.py`，持久化且不可通过模型参数授予权限|仅隔离实现；正式库未安装|
|历史读取、旧摘要、固定/动态记忆、Ombre、Hook、媒体和工具结果|接入实际上下文读取路径；不可证明部分明确记录 unknown|候选代码，未部署|
|生成中撤回、摘要发表前校验、派生输出绑定|来源变化使清单失效；摘要在写事务中再检查；生成回复可保留为历史，但失效派生内容不作为正常模型历史继续使用|仅隔离验证|
|既有记忆表写入|启用隔离保护时，数据库触发器拒绝无宿主用户操作权限的新增/改/删；未注册 UDF 的连接也不能绕过|候选保守阻断，不是所有后台记忆能力已迁移完成|
|用户记忆维护|实际认证后的 CRUD 路由显式进入 owner scope；模型不能通过参数取得它|真实隔离 HTTP 进程验证；正式不变|
|Serein Scene 写入|有新宿主 Trace 时拒绝降级为无绑定 MCP 写入；双端上下文回执未完成时明确返回未保存|仅隔离保护；没有冒充写入闭环完成|
|联合备份/恢复|`joint_memory_backup.py` 复用既有认证加密格式；锁定声明的 SQLite 写入和旧 worker 互斥锁，校验保留回执链，恢复到新目录再核验|合成验证；未制作/覆盖正式备份|
|旧 Event、影子数据、旧索引|复用已有 receiver/guard/epoch；新增真实固定上游恢复实验确认恢复后撤回及旧索引读取仍被阻断|已有防护保留；不是自动 Event 模型验收|

### 持久结构与上下文调用链

只在显式调用 `context_provenance.initialize(db)` 的独立副本建立：

- `morrow_context_control`：缺省 `enabled=0`，普通应用启动不自动安装、不启用。
- `morrow_context_manifests`：版本、用途、会话、依赖哈希、unknown 原因、状态。
- `morrow_context_dependencies`：清单到对象的索引。
- `morrow_context_derivations`：输出的语义哈希、宿主清单或独立 owner 操作关联。
- `morrow_context_quarantine`：编辑/删除后的保守模型读取隔离，不删除原记录，不自动清空。

清单不保存提示词正文或密钥。消息语义快照包括消息 ID、会话、角色、正文、时间、有效版本及该版本、附件/tool_log 和可见性；旧版本不会被猜测为当前版本。摘要链只继承可验证的原始依赖；未知旧摘要保留未知标记和输入哈希。替换摘要前再校验旧摘要没有并发改变，不把可变摘要输出作为自身证据。

实际接线：

1. `app._stream_reply_impl` 保持生成 scope 到部分/最终回复持久化；`chat_engine.stream_chat` 复用它。
2. `chat_engine.get_history`、`get_conversation_summary`、`get_memory_entries`、`get_relevant_dynamic_memories` 登记真实读取对象；人格核心只记录其版本哈希，不改正文。
3. 旧 Ombre、没有来源回执的 Hook、工具返回、临时上下文、额外上下文和媒体投影标为 unknown。源撤回后不通过被隔离旧摘要、旧回复和旧记忆再次正常注入；不猜测旧材料对应哪条聊天。
4. `app._run_compression_claimed` 过滤失效投影，记录候选来源并在摘要写事务中核验；`bind` 在同一事务关联输出。
5. `app`、`chat_engine`、`tools` 的主库连接注册相同校验 UDF。legacy ZIP 恢复不能覆盖含已启用来源清单或已保留清单的数据库，防止旧 ID 重用绕过来源状态。

**限制：** 宿主清单还没有成为 receiver 验证并关联 `morrow_document_dependencies` 的版本化凭证。现有 `source_context` 只能证明指定原话，不证明摘要/工具/媒体/外部记忆的完整来源。因此新增保护模式拒绝 Serein 写入，不发送一个只含近期原话的“假完整”请求。独立主观 Scene 的上游语义未改变、旧记忆未删除；有聊天依赖的调用不能借“主观”标签绕开来源核验。

## 联合快照与恢复的实际保证

调用入口为 `joint_memory_backup.snapshot(databases, assets, destination, passphrase, writers_quiesced=True)`，恢复为 `restore(package, new_target, passphrase)`；没有新增后台定时任务。

- 声明数据库至少包含 host、receiver、index；可额外加入桥接 operations/deliveries 库等持久控制库。host 整库保留 outbox、控制表、原消息与来源清单；receiver 整库保留原话档案/原始版本、回执、epoch、Scene/Event/影子数据和派生依赖；索引独立完整复制。
- 配置、实例身份与批准的媒体必须通过明确 assets 根目录覆盖。程序不猜路径、不读取未知凭据、不替操作者宣称清单完整。未声明 SQLite 不能作为普通资产被直接复制。
- 复用既有 `memory_outbox.delivery_lock`；按稳定顺序对全部声明数据库取得 `BEGIN IMMEDIATE` 写入预留，另外的只读连接执行 SQLite backup，避免在持有写事务的同一连接上调用 backup 导致死锁。
- 全部保留事件通过原 `source_protocol` 重建链；逐条核对 receiver 回执的 ID/序号/哈希，检测洞、分叉、旧宿主、落后于已确认水位的 receiver，以及未知实例。丢 ACK 可以被识别，但本工具不修改 ACK、不清理数据、不解除隔离。
- 资产前后完整清单和 SHA-256 核对，拒绝符号链接及复制中变化；加密前清单、解密后完整清单、SQLite integrity/FK 和双方水位再次核验。复用 `serein_backup`/`cloud_backup` 的认证加密，不自创算法。
- 加密包实际解密到独立临时目录通过后才发布；目标已存在、密码错误、认证失败或校验异常不覆盖目标。明文只在本工具创建的私有临时目录；不留普通明文备份。

**没有证明的范围：** `writers_quiesced=True` 是调用方必须满足的维护前提，不是本工具已排空聊天、工具、媒体或 Event 任务的证明。SQLite 锁不等于跨文件系统全局事务；正式资产范围、实例配置引用、全部任务排空及停写证据尚未编排。恢复副本链一致不等于可覆盖/接管现有生产实例。必须再与仍在运行的对端握手核对水位，保持隔离；本工具不连接生产、更不自动恢复到正式目录。

## 本轮执行的检查

Linux 最终完整后端回归目标：`python -m unittest discover -s tests -p 'test_*.py'`，使用现有 Python 环境、全新临时源码目录、显式合成 DB/AUTH/SECRET 和关闭 debug。未导入真实聊天或真实配置；HTTP 测试不启动 scheduler。

|检查|实际结果|
|---|---|
|来源依赖定向 `test_context_provenance.py`|26/26；含来源编辑/删除/版本、并发摘要写入、旧摘要未知、媒体/tool_log、跨会话派生失效、原始记录保留、真实子进程恢复、坏清单、未知写入阻断、重复初始化|
|真实回环 HTTP `test_context_process.py`|2/2；独立进程、真实认证路由、启用保护后的用户记忆 CRUD 与未认证拒绝；不是生产端到端认证|
|联合备份 `test_joint_memory_backup.py`|13/13；含加密实际恢复、错误密码、损坏包、已有目标、文件变化、SQLite/worker 锁、旧快照/分叉/回执洞、丢 ACK 后新进程继续及禁止解除 recall_blocked|
|Linux 最终完整回归|479/479，0 失败、0 跳过，69.760 秒；最终源码版本执行，未沿用前轮 438 项|
|compileall、变更空白检查|通过；最终提交前再次执行|
|固定 Serein 实际 Schema/FTS 索引 `tests/serein_joint_backup_check.py`|3/3：完整加密恢复；真实 Projector 重投不重复；恢复后修改来源、epoch 推进、Scene 失效且陈旧索引不可召回|
|Windows 普通权限定向|来源 26/26、HTTP 2/2、联合备份 13/13|
|Windows 沙箱早期尝试|出现目录 rename 拒绝和回环网络 WinError 10013；正常权限定向复验通过，未通过跳过断言掩盖|
|Windows 完整回归|早期版本运行 460 项、2 个旧备份测试错误；未将后续定向通过描述为最终 Windows 全量通过|
|真实付费模型|本轮主动调用 0；没有重复 Embedding/Reranker 探测，无 Aru 导入|

原生恢复实验直接使用已安装的固定 Serein wheel。它缺少宿主备份所需 requests，因此只给该合成实验进程追加宿主已安装依赖的搜索路径；未安装包、未修改任一正式虚拟环境。样本先后修正了时间戳、Scene 必填 cues、索引创建必须使用新路径三项契约错误，最后实际通过；没有更改上游校验标准。

全量回归一次出现已捕获的后台 push 错误：合成测试结束/换库期间缺少 `push_notification_events`，测试总结果仍 OK。未据此声称没有后台日志错误，也未扩展修改推送模块；与来源保护测试的通过分开记录。

## 生产只读核对

|项目|实际状态|
|---|---|
|正式磁盘源码|`bd6c8afcfe1b8600868ad6b93eb8449b194e8633`，干净|
|Morrow 主进程|保持原主进程，启动于 2026-10-27 14:54:56 CST；本轮未重启，不用磁盘 SHA 冒充已加载本轮宿主候选|
|Serein 包装服务|原来源保护入口继续 active，进程启动于 2026-10-27 22:44:43 CST；本轮未重启|
|既有集成|enabled、Hook ready/enabled、limited tools 均 true；replace_legacy=false|
|raw_sync|false|
|source_gateway|未配置，缺省关闭|
|receiver policy|false|
|capture / outbox|0 / 0|
|receiver epoch / source_versions / receipts|0 / 0 / 0|
|宿主上下文扩展|正式未安装、未启用|
|source worker timer|disabled|
|自动 Event|false，单独保持关闭|
|其他服务|Morrow、Serein、触摸服务和现有独立应用服务 active；主站和另外两个独立网站 HTTPS 均 200|
|资源瞬时采样|系统报告 3659 MiB 内存，used 1239 MiB、available 2420 MiB；磁盘约 59 GiB，总占用 12 GiB、可用 45 GiB。不是长期负载结论|

本轮生产没有迁移、重启、清理、配置修改或恢复覆盖；测试仅在新临时目录，原库和已有备份保持不变。

## 尚未通过的启用门槛与最短继续入口

1. **宿主清单到 receiver 的认证接线。** 继续 `context_provenance.Trace` → `memory_outbox.source_context` → `serein_source_receiver.author_scene`，将可验证派生依赖对齐既有 `morrow_document_dependencies` 和 epoch。不能把 local complete 当 remote certified，也不能把未知旧摘要、旧工具/媒体结果认证为原始事实。
2. **全部间接写入/读取覆盖。** 当前启用保护会保守拒绝旧记忆后台写入和 guarded Scene；尚未把它们全部改成可用的新写入路径。通用 MCP、后台任务、外部工具/媒体及未知历史的重整策略还要逐条验证，防止跨会话经未知缓存复活。没有完成此项就不能称“统一安全写入全部上线”。
3. **正式联合备份的维护编排。** 已证明合成数据库与真实上游 Schema 能恢复、撤回；仍需确认真实完整资产清单、桥接账本、密钥/身份、媒体、停写和在途任务屏障，以及恢复副本与活跃对端的实际接管决策。新快照工具没有替代现有正式备份任务，没有生产恢复成功证据。
4. **独立 Event 验收。** 原话归档或恢复通过都不能自动开启 Event；实际模型任务及全部上下文依赖仍单独验收。

后续先读取本报告和本轮提交，不重装 Serein、不重选模型、不重复前轮 28 项作为主要工作。以上门槛未全过前，receiver policy/source_gateway/raw_sync/capture/worker 继续关闭；不得改常量或仅改布尔开关放行。

回退：本轮未变生产，无需生产回退。候选仅允许在新副本初始化。若将来正式安装保护并产生依赖或来源，不得撤掉触发器后运行旧写程序，不得用旧快照覆盖新消息；应保留保护、停止写入、留证核对双方水位后再决定恢复。
