# 第一阶段交付与操作说明

架构基线为 architecture-review.md。本文描述本阶段代码与验证边界，不代表双端系统已经上线。未操作腾讯云、域名、线上 Nginx、Docker 或其他服务；未提交和推送本轮代码。

## 已实现

- 保留 frontend/backend、React/Node/TypeScript/SQLite。新增 contracts 类型 workspace 和 local-agent 接口 workspace；后者没有运行进程、监听端口或定时器。
- SQLite v1 原始建表 SQL 保存在 legacy-schema.ts。迁移顺序连续、事务提交、checksum 历史校验、外键检查；现有库禁止启动时静默原地升级。
- 显式升级流程：一致性备份 → 恢复到独立候选 → 副本迁移 → 业务正文哈希对账 → 获取原库写事务并重新核对快照指纹 → 应用迁移。数据在验证后变化时中止，不覆盖新写入。
- SQLite Online Backup API、一致性检查、逐文件 SHA-256 清单、实际恢复与校验。恢复只接受不存在的新目录，拒绝覆盖现有数据库。
- 可备份已停写的媒体目录，流式计算哈希，拒绝路径穿越、重复项、校验损坏和符号链接。不实现媒体上传/播放/元数据服务；数据库与媒体的一致性要求调用方先暂停媒体及关联元数据写入，不能把 --media-quiesced 当作自动文件系统快照。
- 单私人用户登录：随机生成访问密码；只持久保存带随机盐的 scrypt 校验值；HttpOnly + SameSite=Strict Cookie；生产 Secure；数据库只存会话 token 哈希；会话过期、退出、凭据轮换和 CSRF/Origin 校验；失败登录限制和同时 scrypt 验证数量限制。
- 极简登录/退出页面，仅用于认证，没有业务 UI 扩展或美化。密码不写 localStorage，模型密钥与设备凭据均未进入前端。
- 四类 API 路径、字段、分页和成功状态码保留；访问必须先登录，写请求带 CSRF。DELETE 返回 204，但仅设置隐藏标记；后续查询 404、列表不显示，原始业务行保留。

## 项目外存储与角色

本机默认路径：

~~~text
E:/sakie-ai-home-data/cloud/sakie.db
E:/sakie-ai-home-data/cloud/auth/owner.json
E:/sakie-ai-home-backups/cloud/
E:/sakie-ai-home-data/tests/（独立临时测试目录）
~~~

旧数据库 E:/sakie-ai-home/backend/data/sakie.db 保留原位。导入命令只读原库，先生成快照，在候选中迁移，再生成新的外部运行库；不升级、移动、清空或覆盖旧库。执行导入时必须停止旧写入服务，避免两个数据分支。若目标库已存在不覆盖、不重复导入。

默认 RUNTIME_ROLE=cloud 代表本机后端模拟未来云端角色，不代表 Windows 完整归档服务已经实现。windows 角色的存储职责与本地服务边界已定义，真正归档和网络连接留待第二阶段。DATA_DIR、BACKUP_DIR、DATABASE_PATH、OWNER_CREDENTIAL_FILE 可覆盖路径；开发环境拒绝把运行数据放入源码、构建目录。生产挂载路径须由管理员显式准备，不能直接照搬 Windows 路径。

## 本地启动与首次身份配置

从 E:/sakie-ai-home 执行。首次迁移旧布局时，在维护状态执行一次：

~~~powershell
npm run db:prepare -w backend -- --import-legacy
~~~

已有外部运行库时该命令不覆盖。没有旧库的新安装会创建新的空运行库。直接启动遇到未导入旧库会拒绝服务并给出命令，防止静默丢失旧数据；本轮完成外部副本准备后，原 npm run dev 不变。

由用户在自己的终端执行身份配置，不要将输出密码发到聊天或提交 Git：

~~~powershell
npm run auth:setup -w backend
npm run dev
~~~

命令生成一次性显示的高熵访问密码，保存到用户自己的密码管理器；磁盘 owner.json 不包含明文。已有身份时默认拒绝替换；需要主动轮换时：

~~~powershell
npm run auth:setup -w backend -- --rotate
~~~

轮换改变身份版本，使旧会话立即失效。没有身份配置时服务仍可启动，健康检查可用，所有业务 API 拒绝访问，登录返回 503；不会自动设置默认密码。初始身份生成及浏览器手动登录留给用户执行，本轮不生成或索取真实密码。

访问 http://127.0.0.1:5173 或同端口 localhost；默认开发配置允许这两个等价 Origin。生产必须显式配置 PUBLIC_ORIGIN=https://sakiehome.icu；不能使用开发 Origin 列表放宽公网规则。Cookie 只在 HttpOnly 存储；登录和 GET /api/auth/session 返回 CSRF token，后续 POST/DELETE 使用 X-CSRF-Token。授权的 API 客户端也应先登录，不能使用未来设备凭据代替用户会话。

GET /api/health 保持公开，仅返回服务存活和数据库查询结果，不泄露业务内容。GET /api/auth/session、所有四类业务 API 均需身份验证。

## 数据库结构变化

schema version 从 1 增至 2，原四张业务表和索引不改字段、UUID、内容或重要程度量表。新增：

| 表 | 作用 |
| --- | --- |
| schema_migrations | 版本、名称、SQL checksum、应用时间 |
| auth_sessions | 会话 token 哈希、身份版本、过期时间 |
| record_metadata | resource + record_id、revision、provenance_status、deleted_at |

旧业务行初始化为 revision=1、legacy_unverified；不补造来源引用。新建记录标为 user_recorded，不等同于模型核验事实。隐藏时 revision 增加。尚未实现完整修改历史、来源事实库或记忆层算法。

## 备份与恢复操作

~~~powershell
npm run db:backup -w backend
npm run db:verify -w backend -- --backup E:/sakie-ai-home-backups/cloud/snapshot-实际目录
npm run db:restore -w backend -- --backup E:/sakie-ai-home-backups/cloud/snapshot-实际目录 --target E:/sakie-ai-home-data/recovery-新的目录
~~~

旧路径或其他角色使用 --database 和 --backup-dir 显式指定。带媒体备份须先停写媒体及关联元数据：

~~~powershell
npm run db:backup -w backend -- --media-dir E:/sakie-ai-home-data/windows/media --media-quiesced
~~~

媒体字节的最终存储方式仍待后续确认；此能力只是通用文件备份，不表示媒体系统已落地。

恢复先校验完整包，再写入新目录。损坏或恶意包拒绝恢复；恢复出的数据库为 <target>/sakie.db，并生成新的 restoreGeneration 标记。不能把旧快照直接恢复到有新消息的库。

恢复候选被隔离：prepareStorage 发现要求会话撤销或归档水位复核的 restore-info.json 时拒绝启动。用户必须保留原运行库和恢复副本，后续通过受控启用流程撤销会话、核验归档代次/游标及新写入增量后再切换。本阶段不实现通用合并或自动生产回退，不应直接删除标记绕过保护。

对需要升级的已存在运行库，先停写后执行：

~~~powershell
npm run db:migrate -w backend
~~~

失败事务回滚，备份和演练副本保留供检查；重复执行验证当前迁移历史后返回 changed=false。新版本数据库不能用旧 v1 程序直接打开。代码回退不能恢复旧快照覆盖后续新数据；应使用兼容桥接程序，或在隔离副本中核验并重放增量后再切换。

## 异地备份接入要求（未实现）

当前实测备份仍在 E 盘，与主库同盘，不具备磁盘损坏容灾能力。不能将本地双目录描述为已完成异地备份。

后续需要将完整 snapshot 包复制到另一物理磁盘或用户确认的异地目标；复制完成后在目标执行相同校验，记录成功时间、来源快照指纹与恢复演练结果。待确认目标、加密方式、密钥恢复、频率、保留期限、容量及告警；不得未经确认上传到第三方存储。备份包含私人原文，外传前应加密并限制访问。

用户主动永久删除与备份处理须单独设计：身份确认、对象范围、同步删除标记、备份到期/隔离策略、审计与不可恢复提示。本阶段不提供物理擦除或自动销毁备份。

## 仅设计与尚未实现

- 同步协议、设备配对与撤销、云端消息持久化接口、本地归档接口：仅契约，详见 sync-protocol-v1.md。
- 记忆逻辑区分 experience / fact-cognition / autobiography / impression；处理通道 automatic-facts / primary-model-reflection；来源引用带记录 ID、版本、哈希和 realityScope。只有类型边界，没有自动整理或模型自主记忆算法。
- ModelCallLedger / BudgetPort / ContextAssemblyPort：仅接口，没有真实模型调用、费用账表、预算执行或提示词缓存实现。稳定人格与动态证据结构已分离。
- 没有聊天闭环、WSS、outbox/inbox 实现、自动同步、活动调度、向量检索或后台 LLM 轮询。
- 未引入 Redis、独立向量数据库、Mem0、OB、额外常驻服务或新的外部运行依赖。

## 测试与未验证事项

原有四项测试保留全部原断言，仅补充真实登录和写入 CSRF；测试数据转移到独立 E 盘测试目录。新增验收覆盖历史 UUID/正文、额外业务表/BLOB、迁移副本、重复迁移、checksum 篡改、SQL 失败/异常回滚、迁移进程中断恢复、在线 WAL 一致性、实际媒体备份恢复、非法路径/损坏包、禁止覆盖、恢复副本隔离、原库保留、开发启动、所有业务匿名拒绝、登录限流、生产 Cookie 标记、CSRF、Origin、过期/退出/轮换失效、初始身份 CLI。

本轮实际执行结果（2026-10-15）：

| 验证 | 实际结果 |
| --- | --- |
| npm run typecheck | 四个 workspace 通过，包含后端测试类型检查 |
| npm test | 18 项通过，0 失败、0 跳过，原有四项全部保留 |
| npm run build | frontend/backend/contracts/local-agent 全部通过 |
| 原 npm run dev | 实际启动，网页入口和 /chat 为 200，健康检查 200 |
| 未登录业务 API / 会话查询 | 全部 401 |
| 尚未配置真实身份时登录 | 503 AUTH_NOT_CONFIGURED，不回退默认密码 |
| 真实旧库和外部副本 | 旧库 v1、新副本 v2，四张表记录数均为 0，完整性均为 ok |
| 实际旧库快照恢复 | 恢复到全新 recovery-audit 目录，原库与恢复库完整逻辑指纹相同 |
| 外部依赖变更 | 没有新增外部包或改变原包版本，仅增加两个项目内部 workspace |
| 生产基线配置 | compose.yaml、frontend/nginx.conf、CI 配置未变 |

实际首份快照：E:/sakie-ai-home-backups/pre-phase1/snapshot-uwx5c0。实际恢复演练目录：E:/sakie-ai-home-data/recovery-audit-2eae9886686d41ac98b8390e6300694d。导入快照：E:/sakie-ai-home-backups/cloud/snapshot-UOgY2P。以上文件均保留，不会因完成任务自动删除。

检查命令：

~~~powershell
npm run typecheck
npm test
npm run build
~~~

类型检查包含后端测试文件。HTTP 集成测试不能替代真实 iPhone/Windows 浏览器端到端测试。生产 HTTPS、真实浏览器登录、Docker 镜像运行、真实断电、VPS 资源消耗、异地恢复和第二阶段同步均尚未验证。当前不设置未经压测的 VPS 内存/CPU 上限，也不把估算描述为实测。

仓库内 Dockerfile 仅补充新 workspace 的构建输入；未修改 compose.yaml、Nginx 或服务器配置。由于生产新增显式 HTTPS Origin、外部备份目录和身份配置要求，不能直接把本轮镜像替换线上版本。后续部署须先清点其他服务、配置独立卷及权限并在隔离环境演练。

## 第二阶段最小聊天闭环建议

1. 在现有契约上实现云端消息/轮次、持久任务和 outbox 的同事务写入，先用假模型，不接真实供应商。
2. 实现 Windows 主动认证连接、本地归档、持久去重和连续 ACK；配对/撤销独立于用户登录。
3. Windows 关机期间，仅用云端人格副本和近期上下文回复；新消息与回复可靠落盘。
4. 验证断线重连、云端重启、重复投递、同 ID 异内容、旧备份恢复、消息顺序及正文哈希对账。
5. 追平前保持记忆 unavailable，自主活动暂停；不得新增自主活动或完整记忆算法。
6. 完成上述验收后，再单独确认模型和预算实施真实调用。

## 已知风险与回退边界

- 同盘本地备份不能抵御 E 盘整体故障；异地复制、加密、留存清理和自动演练尚未实现。文件包含私人原文，Windows 目录 ACL 仍须管理员按实际多用户环境检查；不能把 POSIX mode=0600 视为已验证的 Windows ACL 隔离。
- 迁移失败支持事务回滚，成功升级支持恢复到独立候选；没有会丢弃新增记录的原地 down 迁移。原 v1 程序不兼容 v2，也没有认证，不能直接作为公网回退目标。需兼容版本及增量核验后受控切换。
- 运行旧服务写旧库、同时运行新服务写新库会产生数据分支；导入必须维护停写。当前新开发服务仅写项目外副本，旧原库不再作为默认运行库。
- 登录限流是有界的单进程内存状态，重启后重置；生产反向代理信任范围、共享出口下的限流行为和 TLS 需部署前验证。
- 本轮未测量 Linux VPS 的真实资源消耗；本机测试和构建通过不代表 2GB VPS 已通过容量验收。

完整修改清单见 phase1-files.md。第一阶段到此停止；不得据此认定第二阶段接口已实现。
