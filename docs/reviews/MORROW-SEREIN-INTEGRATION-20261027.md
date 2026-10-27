# Morrow + Serein 基础集成交付（2026-10-27）

## 范围与固定版本

承接 `MORROW-SEREIN-INTEGRATION-AUDIT.md`。Morrow 保留 Flask/SQLite、原前端、人格、模型提供方及调用方式。Serein 固定 `ec9f99e8cbc5abf6c024e668760e5cf55884c3dd`，未修改其 UI、人格或记忆算法。没有 Aru 真实历史导入，没有真实付费推理调用。

本次选择独立 Python-only 服务，不安装 Node 管理网页、不修改主站路由/DNS/证书、不公开管理 API。独立服务账户、运行目录、数据、凭据与 systemd 服务，回环 8011；MemoryMax 768MiB、MemoryHigh 640MiB、CPUQuota 50%、TasksMax 64。构建与依赖只在独立虚拟环境完成，不共享 Morrow 包环境。依赖解析结果保留在服务器，非自动跟随上游更新。

## 实现与安全边界

|能力|实际结果|
|---|---|
|Serein 服务|已独立运行，健康检查200，开机启动，仅回环监听|
|Morrow Hook 接口|源码接线完成：调用前准备动态来源材料、工具续轮复用、最终成功确认，失败熔断后正常聊天。正式 hook_ready=false，尚无语义模型验证，不会把空库/配置错误当成功召回|
|受限 MCP|复用 Morrow MCP 客户端，适配器只开放read_memory、recall_memory、write_scene、edit_scene、set_scene_status；不开放原话管理、配置、导入或流水线管理。正式私有MCP发现恰好5项|
|Scene 写入/修订|真实回环HTTP/MCP合成实例通过；丢ACK/超时保留unknown并阻止盲重试；成功结果持久缓存。不是远端exactly-once保证，未知结果仍需人工核查|
|来源证据|基础写Scene不暴露evidence_refs，拒绝模型伪造来源；Scene是主观表达，不能冒充已核实事实|
|旧记忆去重|代码具备replace_legacy开关，但**正式保持false**，保留旧固定/动态/Ombre与记忆写工具。Serein自动召回未开启，不会出现两套自动注入；未来确认单一写入权威后才能切换。后台自主活动尚未接新的Scene工具|
|原话候选投递|独立SQLite outbox、稳定事件身份、内容冲突、inflight/ack状态、顺序恢复及远端入库前后核对已实现并合成验证；没有注册正式消息采集/后台投递worker，没有历史回填。仍须补生产采集、版本/撤回事件接线，不是改开关即可完成|
|编辑/选版本/删除传播|**未完成，正式同步硬性关闭**。固定上游缺少已验证的统一来源修订/撤回协议；SOURCE_RETRACTION_VERIFIED=false，改配置不能绕过。Scene自身软删除通过不等于原话撤回闭环通过|
|Event 后台|扩展和任务生命周期已运行；阶段复用现有聊天连接，Writer并发1。auto_enabled=false，避免未经验证整理或费用。模型真实结构输出和源撤回尚未验证|
|Aru|纯解析预览候选，支持显式会话ID、角色、ISO时区、顺序、相对附件引用、稳定ID/源hash；不写数据库、不抓附件。真实导出格式仍待核验|
|备份|SQLite一致性备份、实例配置/索引/侧库打包，复用现有scrypt+AES-GCM认证加密，每份发布前实际独立解密恢复检查。恢复目标必须不存在；不自动清理旧备份|

**不能宣称完整记忆闭环已启用。** 原话不进入Serein，Event就不能自动整理新聊天；只有MCP接通也不会自动归档历史。

## 模型检查（没有输出或提交凭据）

已在服务器内复用现有唯一OpenAI兼容连接与最近已使用的聊天模型到Serein的Router/Curator/Writer配置；原Morrow模型配置不变。只读取提供方 `/models`，返回133个模型ID，没有发现名称明确含embedding/rerank的项目。目录名不能证明端点绝不支持这两种能力，**未发起收费探测或猜测模型号**。

还需要用户确认可用的 Embedding、Reranker 模型ID/接口及其预算；可能复用同一服务，也可能需要其他已批准服务。之后还须准备路由和索引、运行合成语义召回后才能打开hook_ready。不能把普通聊天模型当Embedding/Reranker。Event复用连接仅是配置就绪，不是其真实JSON输出能力已验证。

## 实际执行的测试

|命令/范围|实际结果|
|---|---|
|独立源码副本 `python -m compileall -q .`|通过|
|新增 `unittest discover -s tests -p test_serein_bridge.py`|25/25通过；合成数据，无真实模型|
|完整 `unittest discover -s tests -p 'test_*.py'`|394/394通过，59.981秒；隔离数据库/认证，无生产配置|
|`tests/serein_transport_check.py --python <固定Serein解释器>`|12项真实回环传输检查通过；新建临时Serein进程/数据库/凭据，退出清除自身实例|
|固定Serein上游6个选定文件的pytest|132项中131通过、1失败；1条依赖弃用警告，没有隐藏失败|

12项传输检查覆盖：鉴权、MCP白名单、Scene写读、修订、缺模型Hook降级、原话归档/重复、宿主冲突、远端同ID不同内容预检、服务重启持久性、Scene软删除后正文不可读、正式来源同步硬门槛、服务离线降级。**不包括真实语义模型、真实Event模型或原话删除撤回验收。**

单测另外覆盖实际上下文组装、工具续轮仅一次确认、流式错误/取消/耗尽工具轮次不登记成功、最近五次成功冷却与持久恢复、Scene未知写入跨重启阻断、队列丢ACK有序恢复、Aru歧义拒绝、加密备份真实恢复、错误密码/篡改拒绝和现存目标拒绝。

上游失败为 `test_latest_pipeline.py::test_failed_image_finishes_summary_and_manual_retry_remains_available`：预期旧失败图片仅转录一次，实际计数2次。没有为通过而修改固定上游或删除断言。图片转录、真实原话同步、自动Event保持关闭；不把此结果写成Serein完整回归通过。所选Hook/MCP/Event合成模型测试不证明真实提供方语义质量。

## 备份、回退和运维

改动前已对Morrow正式库执行SQLite backup、integrity_check并复制到独立恢复库再次核验，保留旧程序/服务配置和私有环境副本；没有旧快照覆盖生产库。

`serein_backup.py`只接受密码文件路径，不接受命令行明文密码。密码与备份分开，文件/临时目录私有；本次生成的恢复凭据不在源码、报告或日志中。后台每日备份不自动删除保留代际；空间不足安全停止。**同一VPS备份不是灾备，恢复凭据离机保管与异地加密副本仍待安排。**

多库/文件快照不是一个跨库原子事务。权威恢复点需暂停Serein/桥接写入后制作；派生索引恢复后按canonical版本核对，必要时重建。日常备份会逐库一致性复制、检测复制时文件变化，不能据此宣称跨库全局原子性。

失败回退：关闭独立桥接配置的enabled开关，恢复上一Morrow程序；保留新侧库、Serein库和未知操作状态，不恢复旧数据库覆盖新消息。停Serein时Morrow仍走原模型。恢复仅向全新隔离目录执行，校验后再决定是否切换，不能直接执行覆盖式restore。

## 后续最小工作

1. 确认可用Embedding/Reranker与费用，完成小规模合成语义检索后启用Hook。
2. 单独补齐并验证来源编辑、版本选择、删除撤回与派生证据失效；未通过前保持真实原话自动同步关闭。
3. 核查固定上游图片重试失败；不为开功能自动升级未审查版本。
4. 配置离机恢复凭据与异地加密备份。
5. 真实Aru文件到来后先核对语法、时区与稳定身份，先独立候选库原文归档，再单独批准历史Event整理。现在不需要用户提供真实文件。

当前Morrow原记忆管理页面仍管理原memory_entries，不会伪装显示Serein Scene。本批没有新增前端管理页面或公开管理站点；模型可通过受限工具读取保存的Scene。用户手机操作与真实模型效果仍待实际验收，代码通过不等于用户验收。

## 正式部署最终核验

- Morrow实际部署应用提交：`78bda6b9a123b64cad83545ec73153d2fb3713d6`。沿用原Gunicorn，确认无活跃聊天/夜间任务后优雅HUP重载，master PID不变；没有迁移主库。保留部署前程序引用和一致性数据库备份作为回退条件。
- 只向私有环境文件追加集成配置文件路径，并在内存比较其余认证/模型变量完全不变。原人格、提供方和聊天数据没有被替换。
- 正式开关：enabled=true、tools_enabled=true、hook_ready=false、raw_sync_enabled=false、replace_legacy=false；Event auto_enabled=false。语义召回、真实来源同步和自动Event仍未启用。
- 自动审批最初拒绝了会在Hook未准备时抑制旧记忆的部署批次；该批次没有执行。之后采用明确更安全替代：保留replace_legacy=false，再完成部署。无需为了本批基础接线降低旧记忆能力。
- 主站HTTPS、登录、会话读取均200，未认证会话读取401，空消息校验400且未创建记录；没有发起真实模型回复测试。
- 正式Morrow库integrity_check为ok，schema与部署前一致；会话、消息、人格、提供方和旧记忆数量均保持。Serein正式库integrity_check为ok，raw_events/documents均为空，临时传输测试数据没有混入正式实例。
- Serein服务和加密备份timer均enabled；已成功执行首份加密实例备份，其发布前经过真实解密、独立恢复和SQLite完整性检查。日备份04:30并有随机错峰，不自动删除历史备份。恢复凭据只在服务器私有文件，不在仓库或报告中；离机保管尚未完成。
- 部署后瞬时cgroup内存：Serein约55.7MiB、记录峰值约56.2MiB；Morrow约52.1MiB。系统available约2484MiB，磁盘约46GiB可用。这是空库/低负载快照，不是历史导入或向量召回峰值保证。
- SakieTouch、Phosphene relay保持active，Phosphene容器healthy；主站及两个独立网站HTTPS均200，没有更改Nginx/DNS/证书或重启这些独立服务。
- 已跟踪源码的敏感模式扫描无命中；服务器内存中将真实认证/模型/实例/备份凭据与已跟踪源码作精确比对，结果零命中。没有复制凭据到测试或Git。
- 本轮额外模型活动仅为免费模型目录GET，不调用推理；真实模型推理请求数0。GitHub Actions公共API查询遇限流，本报告没有声称远端CI已全部通过；上面的394项为实际VPS隔离副本执行结果。
