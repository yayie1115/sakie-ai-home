# 第二阶段后半部分：云端到 Windows 增量归档

> 安全更新：代理现已强制test/production隔离、精确白名单和生产人工确认；旧无环境凭据将拒绝联网。ACL工具和最新命令见 [同步安全说明](sync-security.md)。

本轮复用第一阶段契约、第二阶段聊天 outbox 和现有备份工具。没有操作腾讯云，没有提交/推送 Git，没有调用真实模型，也没有迁移或修改真实聊天库。本轮新增内容尚未在真实站点启用。

## 当前实施范围

已实现：

- 复用 chat_outbox，保持已有 event_id、stream_seq、producer_seq 和原文哈希；不创建平行聊天事件流，不整库覆盖。
- 独立设备配对/认证/撤销；用户 Cookie 只用于管理配对和撤销，设备 Bearer 只能访问同步端点。
- Windows local-agent 主动出站、认证 HTTPS 增量拉取；不监听本地 HTTP 管理端口或暴露 SQLite。
- 本地 SQLite 事务原子提交原始事件、版本投影、幂等收据及连续游标，COMMIT 成功后才能 ACK。
- 云端事务持久保存已投递水位和 ACK；客户端重试、服务器重启或 ACK 丢失均不依赖内存状态判断归档。
- 聊天消息修改/软删除、Memory/Diary/Dream/Activity 创建/修改/软删除均产生版本事件，保留可追溯旧内容。
- 可配置轮询、指数退避和抖动；重试时间、错误类别和进度状态在本地落盘。仅同步请求轮询，不轮询模型。
- 旧本地备份恢复后代次或水位不一致时 fail closed；显式撤销旧设备并重新配对后，可通过逐页重复投递补齐。

未实现：通用双向多主同步、Windows 编辑回传、媒体文件同步、长期记忆提取或检索、UI 美化、同步管理 UI、自动开机启动、独立 WSS 服务、生产部署、自动清理、异地备份。

归档范围是原始聊天消息及其修改事件、四类记录及其版本。不是数据库逐表镜像：用户会话、模型密钥、设备凭据和云端执行任务不会复制给归档库；会话标题等未产生事件的管理元数据目前不在归档范围。空会话没有原文事件。已存在的聊天全部依靠原 v3 outbox，不从数据库内容重新生成旧事件 ID。

## 职责与数据流

1. 网页继续通过第一阶段用户认证和 CSRF 调用聊天 API。Windows 不参与模型请求的成功前提。
2. 云端把用户/模型原文、任务状态与 outbox 持久化，聊天上下文仍受既有近期窗口限制。
3. local-agent 使用独立设备凭据主动连接云端 /api/sync；允许生产 HTTPS，开发时仅允许 loopback HTTP。
4. 客户端先 resume，得到云端持久 ACK 和远端头水位，从 ACK 后按顺序拉取。
5. 本地校验原文 JSON 哈希、完整事件身份、版本、消息顺序、连续序号。整个批次在同一 SQLite 事务中提交。
6. 提交后为该已投递批次的末尾序号生成 committed 收据，再发送 ACK。云端验证设备代次、投递上限和末事件证明，事务保存 ACK。
7. ACK 丢失时从旧云端 ACK 重放，本地重复验证后不重复写入。即便本地已有更高游标，也只确认本次已投递且已提交的前缀，不越级确认未投递水位。

当前采用 HTTPS 请求轮询，而不是原规划中“未来 WSS”的传输选项；共享语义仍为 SyncEvent / ArchiveIdentity / ArchivedCursor / ResumeRequest。未引入 ws、Redis、向量库或其他常驻服务。若以后改 WSS，应复用相同事务/游标/确认规则，不能改成收到网络帧即 ACK。

## 协议、顺序与幂等

streamId 为 chat: 加原 chat_archive_identity.producer_id。该身份持久保存，不能在每次启动时重建。所有支持资源共用同一 outbox 流，云端 stream_seq 是增量顺序，message_seq 是会话内消息顺序。

WireSyncEvent 在原 SyncEvent 上增加 payloadJson，传输数据库中原始序列化字节。payloadHash 对其 UTF-8 内容计算 SHA-256；解析结果必须与 payload 一致。对 eventId、producerId/producerSeq、streamSeq 的任意身份碰撞，都要核对包含 kind、所有序号、哈希及 payloadJson 的完整事件指纹。同 ID 异内容/异头部直接冲突，不覆盖。

批次必须按序、无缺口；不支持静默忽略未知事件或版本。失败时事务回滚，游标不前进，并在 archive_conflicts 记录本地证据。证据属于私人归档内容，不能提交 Git。完全相同证据去重，永久错误进入 blocked，不不断跳过错误重放后续数据。

原始聊天 content 保留于 archive_messages；后续编辑/软删除只写 archive_message_state 和原始 archive_events。云端同样保留 chat_messages，不重写原文，仅写 chat_message_state。页面历史和后续上下文读取当前未删除投影，编辑不会自动重新生成回复或增加模型调用。

四类记录当前值仍在原业务表，旧版本完整保存在 outbox / archive_record_versions。首次配对为旧记录生成当前版本快照，包含已软删除记录，并标 baseline=true；不虚构升级前未保存的版本历史。chat_outbox 中的已存在聊天事件不重新生成。bootstrap 在配对时执行，按记录遍历、单事务、不把全库加载到内存；数据量大时仍可能暂时占用 SQLite 写锁，应在维护窗口首次配对。

## 新增云端 v4 结构

| 表 | 用途 |
| --- | --- |
| sync_pairings | 单次配对码哈希、有效期、消费状态 |
| sync_devices | 设备令牌哈希、归档身份及恢复代次、投递与确认水位、撤销状态 |
| sync_mutations | 修改请求的持久幂等 ID、请求指纹与结果 |
| sync_record_events | 资源/ID/版本到事件 ID 的唯一映射，防止 bootstrap 或重复修改重发新版本 |
| chat_message_state | 聊天编辑和软删除投影，原始消息表不变 |

只追加迁移 4，原 v1/v2/v3 SQL 保持不变。迁移工具在备份和独立副本演练后，额外流式校验全部旧表原列值，包括聊天、outbox、认证及额外用户表，不再只校验最初四个业务表。成功升级没有自动 down；回退不能用旧快照覆盖含新消息的库。

## Windows 归档库

归档库使用独立 schema v1，不能把云端数据库路径传给 local-agent。初始化仅适用于全新空库；已有不匹配数据库会拒绝打开，不能自动重建。已有归档版本校验迁移 checksum，启用 foreign_keys、WAL 和 synchronous=FULL。

| 表 | 用途 |
| --- | --- |
| archive_identity | archiveId、restoreGeneration、streamId、已观察的恢复标记 |
| archive_events | 原始事件、序号、payload 字节及哈希、完整事件指纹 |
| archive_messages / archive_message_state | 聊天原文与当前版本/软删除投影 |
| archive_records / archive_record_versions | 四类记录当前投影及所有已接收版本 |
| archive_cursor | 与原始事件同事务提交的连续归档水位及证明 |
| archive_retry | 持久退避时间、失败次数、phase 和脱敏错误类别 |
| archive_conflicts | 错误证据，不自动清理 |
| archive_migrations | 归档 schema checksum |

local-agent 默认不开启网络监听。归档 DB、设备凭据和配对码文件必须放项目外，例如 E:/sakie-ai-home-data/windows/。CLI 拒绝源码目录中的这些路径。设备凭据以 mode=0600 新建并拒绝覆盖，但这不等于已经验证 Windows ACL 隔离；真实启用前由管理员确认只有预期 Windows 用户可读。

## 安全与接口

所有端点响应 no-store。配对码 10 分钟失效、单次消费，云端仅存哈希。配对入口有限额的失败次数限制；设备令牌为独立随机凭据，云端不保存明文。不接收前端 API Key，也不输出令牌到日志。

| 接口 | 认证及作用 |
| --- | --- |
| POST /api/devices/pairings | 用户 Cookie + CSRF；创建一次性码，响应 pairingId 是秘密，只能保存到受控本地文件 |
| GET /api/devices | 用户 Cookie；查看设备、代次和持久 ACK，不返回令牌哈希或明文 |
| POST /api/devices/:id/revoke | 用户 Cookie + CSRF；撤销设备，旧凭据立即失效 |
| POST /api/sync/pair | 仅凭单次码；请求 {pairingCode,archive:{archiveId,restoreGeneration}}，返回一次设备凭据 |
| POST /api/sync/resume | 设备 Bearer；{archive,lastArchived}，返回 resume 或 reconcile-required、streamId/headSeq/ackSeq |
| POST /api/sync/pull | 设备 Bearer；{afterSeq,limit}，必须从当前持久 ACK 拉取，limit 默认50、上限100 |
| POST /api/sync/ack | 设备 Bearer；SyncProofCursor，必须已提交、身份正确、证明匹配且不超过已投递水位 |
| PATCH /api/chat/messages/:id | 用户 Cookie + CSRF；{baseRevision,requestId,content}，只修改已完成轮次 |
| DELETE /api/chat/messages/:id | 用户 Cookie + CSRF；{baseRevision,requestId}，保留原文的软删除 |
| PUT /api/{memories,diaries,dreams,activities}/:id | 用户 Cookie + CSRF；{baseRevision,requestId,record} 完整对象替换；Memory 创建时间保持原值 |

四类记录单条 GET 的 X-Record-Revision 响应头提供当前版本，原响应 JSON 格式保持兼容。旧 DELETE 路径和 204/404 语义保留；重复删除不会生成重复事件。聊天历史消息包含当前 revision，未编辑为1。修改冲突返回409，不采用最后写入覆盖。

pull 既限制条数，也流式累计约512KiB原文预算；至少返回一条较大的合法事件，客户端整个响应上限4MiB、单个事件原文上限1MiB。消息和记录原接口长度限制继续生效。所有网络请求有超时，禁止重定向，外网只允许 HTTPS；无认证浏览器 Cookie 无法代替设备 Bearer，设备 Bearer 也不能访问聊天等业务 API。

HTTPS 和受信任设备身份保证确认来自已授权归档端；服务端不能从一个 ACK 数学证明物理磁盘永不损坏或设备未被攻陷，所以 ACK 本身绝不等于删除许可。

## 清理政策：本轮完全关闭

SyncService.canPrune 固定返回 false；本轮没有删除云端原始消息、outbox 或本地归档的清理入口、定时器或任务。即使所有设备 ACK 已追平也不清理。

未来若实现清理，至少需要：已确定的必需归档设备集合、未撤销且代次已核验的连续 ACK、无缺口完整性核验、可验证的异盘/异地备份与恢复演练、恢复后 ACK 失效处理、明确的原文留存及用户删除政策、事务内重新核对。任一条件缺失不得按 TTL、上下文窗口或摘要预算删除原文。撤销设备不能被自动当成“已归档”。

## 恢复与冲突操作

1. 使用已有一致性备份机制，恢复到全新目录，不覆盖原归档库或含新增记录的库。
2. restore-info.json 保留不删除。归档端读到新的 restoreGeneration 后更新本地归档身份；旧设备绑定在云端仍指向旧代次，resume 必须进入 reconcile-required。
3. 即使用户误复制旧 DB 而没有恢复标记，只要本地可靠水位低于云端已确认水位，仍会因 cursor-behind 停止。
4. 操作者先保留现有库/备份，对账恢复候选；通过用户认证撤销旧设备，生成新单次配对码。
5. 使用新的凭据文件为该恢复候选重新配对。不能覆盖旧凭据文件，也不能删除恢复标记绕过检查。
6. 新设备 ACK 从0开始重放所有保留事件，本地已有前缀按完整事件指纹去重，逐页确认，追平后才标 caught-up。旧设备的历史 ACK/撤销记录保留，不作为新代次确认。
7. 如果云端已缺少原事件、流身份变化、同ID冲突或本地领先，不自动合并/覆盖，停在 blocked 供人工核查。本轮没有自动恢复/整库替换逻辑。

归档库不保存用户登录会话，因此恢复代次变更主要用于设备同步绑定；第一阶段云端恢复候选的 prepareStorage 隔离机制不变，也不能删除标记直接启动云端旧快照。

配对响应丢失或设备凭据文件写入失败可能需要操作者撤销该设备再生成新码，不能盲目反复覆盖。首次配对和重新配对均为受控步骤，不会自行开通公网接口。

## 客户端运行和配置

在 E:/sakie-ai-home 构建后，以下命令仅用于已经授权的测试环境/后续正式启用；本轮未对真实库执行配对或升级。

~~~powershell
npm run build -w local-agent
npm run start -w local-agent -- pair --cloud http://127.0.0.1:3100 --database E:/sakie-ai-home-data/windows/test-archive.db --credentials E:/sakie-ai-home-data/windows/agent-credentials-test.json --pairing-code-file E:/sakie-ai-home-data/windows/pairing-code-test.txt
npm run start -w local-agent -- once --credentials E:/sakie-ai-home-data/windows/agent-credentials-test.json
npm run start -w local-agent -- status --credentials E:/sakie-ai-home-data/windows/agent-credentials-test.json
npm run start -w local-agent -- run --credentials E:/sakie-ai-home-data/windows/agent-credentials-test.json
~~~

run 前台运行、Ctrl+C 停止；只向指定云端出站。once/status 不自动登录用户、不生成模型调用。pair 使用秘密文件，不把配对码放到命令行。正式地址需 HTTPS，但未授权前不得把上述命令指向生产域名。不得将测试归档误当成已完成的正式 Windows 归档。

| 环境参数 | 默认值 | 说明 |
| --- | --- | --- |
| SYNC_POLL_MS | 5000 | 已追平时的同步轮询间隔，不是模型轮询 |
| SYNC_BATCH_SIZE | 50 | 每批最多100个事件 |
| SYNC_RETRY_BASE_MS | 1000 | 指数退避起点，含抖动 |
| SYNC_RETRY_MAX_MS | 60000 | 退避上限；实际资源消耗未在 VPS 测量 |

凭据文件包含 cloud、deviceId、token、database；不得提交 Git、截图或发到对话中。Git/Docker 忽略规则补充 agent-credentials*.json、local-agent.json、pairing-code*.txt，但不能以此替代目录外存储和权限控制。

## 可执行的本轮验收

在 E:/sakie-ai-home 执行：

~~~powershell
npm run typecheck
npm test
npm run build
~~~

只重跑同步验收：

~~~powershell
node --import tsx --test backend/test/sync.test.ts
~~~

测试用例自行创建独立云端 v4 和 Windows 归档 v1，使用本机随机端口、临时测试登录和假模型，不读取 backend/.env 中的密钥值、不调用真实模型、不启动真实归档进程，也不会修改 E:/sakie-ai-home-data/cloud/sakie.db。正常权限可能是本机回环网络测试所必需的。

测试矩阵：

| 场景 | 必须成立的验收条件 |
| --- | --- |
| Windows 离线 | 假模型聊天继续落盘，outbox保留；上线后ID/原文哈希和会话消息顺序一致 |
| 重复/重叠批次 | 同批重投10次只保留一次，同ID异头部/正文冲突 |
| 乱序/缺口/未知事件 | 整批回滚、不推进游标、保存错误证据 |
| 本地提交失败 | 原文、事件收据和游标一起回滚，ACK为0 |
| COMMIT 前杀进程 | 子进程实际退出，重开库无半批收据，重放恢复 |
| ACK 请求丢失 | 本地提交保留，云端ACK不动，重开本地库后重放去重 |
| ACK 响应丢失 | 云端确认保留，重连无重复消息，旧ACK不回退 |
| 云端重启 | 关闭并重开测试服务/SQLite，事件ID、设备凭据和ACK仍有效 |
| 修改/软删除 | 原始聊天未改写，投影/版本与删除标记一致，重复请求不重复生成事件 |
| 旧记录迁入 | 仅生成真实存在的当前版本快照，不编造过去版本 |
| 恢复旧本地备份 | 新代次或较低水位停止同步；撤销、重新配对、逐页重放后追平 |
| 自动重连 | 首次失败后持久退避，后台循环恢复，模型调用计数不增加 |
| 迁移 | v3副本先备份/演练到v4，失败回滚，原消息/outbox/旧账本保留 |
| 路径错误 | 把云端库传给归档端必须拒绝且不改变原库指纹 |
| 清理 | 无论ACK前后 canPrune 都为false，无原文清理副作用 |

这些是本机角色模拟与故障注入，不能表述为已经在腾讯云或真实物理断网/断电验收。未验证公网 TLS/Nginx、真实跨设备网络、长期容量/内存占用、Windows 自动启动和异地容灾。

### 手动隔离验收环境（可选，禁止直接修改真实库）

若要手动配对，先用新的空目录准备测试云端，而不是迁移当前真实库。以下在新的 PowerShell 终端执行，并确保测试端口3100空闲：

~~~powershell
Set-Location E:/sakie-ai-home
$testRunId = [guid]::NewGuid().ToString('N')
$testRoot = "E:/sakie-ai-home-data/sync-manual-$testRunId"
$env:DATA_DIR = "$testRoot/cloud"
$env:DATABASE_PATH = "$testRoot/cloud/sakie.db"
$env:BACKUP_DIR = "E:/sakie-ai-home-backups/sync-manual-$testRunId"
$env:OWNER_CREDENTIAL_FILE = "$testRoot/cloud/auth/owner.json"
$env:NODE_ENV = 'development'
$env:PORT = '3100'
$env:HOST = '127.0.0.1'
$env:DEEPSEEK_API_KEY = ''
$env:DEEPSEEK_MODEL = ''
node --import tsx --input-type=module -e "import {openDatabase} from './backend/src/database/index.ts';const db=openDatabase(process.env.DATABASE_PATH);db.close();"
npm run auth:setup -w backend
npm run dev -w backend
~~~

保存该测试终端显示的一次性访问密码；不要发送到对话中，也不要复用真实密码。测试服务中模型被显式禁用。准备另一个终端，登录并生成秘密配对文件，所有变量值均保留在用户自己的终端中：

~~~powershell
$testCloud = 'http://127.0.0.1:3100'
$testPairDir = 'E:/sakie-ai-home-data/windows/manual-pairing'
New-Item -ItemType Directory -Force $testPairDir | Out-Null
$ownerSecure = Read-Host '输入刚生成的测试访问密码' -AsSecureString
$ownerCredential = [pscredential]::new('owner',$ownerSecure)
$ownerLogin = Invoke-RestMethod "$testCloud/api/auth/login" -Method Post -ContentType 'application/json' -Body (@{password=$ownerCredential.GetNetworkCredential().Password} | ConvertTo-Json) -SessionVariable ownerSession
$ownerHeaders = @{'X-CSRF-Token'=$ownerLogin.csrfToken}
$testPairing = Invoke-RestMethod "$testCloud/api/devices/pairings" -Method Post -ContentType 'application/json' -Body '{}' -WebSession $ownerSession -Headers $ownerHeaders
$testPairing.pairingId | Set-Content "$testPairDir/pairing-code-test.txt" -Encoding ASCII
Remove-Variable ownerSecure,ownerCredential,testPairing
~~~

然后使用上面的 local-agent pair 命令，将 pairing-code-file 改为实际测试文件。启动 run 前可通过测试用户会话 POST /api/diaries 写入合成日记，停掉归档端后继续写入，再恢复归档端检查追平。聊天的离线回复、顺序、修改和软删除使用自动化测试中的假模型验证，手动测试不需要真实 API Key。

不要将此临时服务的环境变量带入真实启动终端。测试结束使用 Ctrl+C 退出相应测试进程，不删除旧真实数据。测试目录可保留供审查。

## 本轮结果与真实环境状态

实际执行：四个 workspace 类型检查通过；自动化测试54项全部通过（原33项加本轮21项）；四个 workspace 构建通过。测试进程使用独立数据目录并退出，无额外常驻同步服务。

真实库仍为 E:/sakie-ai-home-data/cloud/sakie.db，schema v3。本轮只读保存并最终核对逻辑指纹；未执行真实 v4 迁移、配对、同步或模型调用。真实 backend/.env、访问身份和聊天内容不写入报告或测试文件。

原本机 npm run dev 热重载进程已暂停，防止新源码触发真实库重启/迁移。当前不能直接运行新版本开发服务连接 v3 库；第一阶段的“禁止自动原地升级”仍生效。真实启用需要另行授权：停写 → 新备份 → 副本升级及对账 → v4迁移 → 受控配对 → 对账验收。本轮不得为了恢复网页而擅自升级真实库。

## 修改文件与职责

新增：backend/src/modules/sync/{schema,events,service,routes,mutations}.ts、backend/test/sync.test.ts；local-agent/src/{schema,archive,transport,runner,cli}.ts；本文档。

调整：backend/src/database/{migrations,repository,fingerprint,upgrade}.ts、backend/src/shared/record-router.ts、backend/src/app.ts、backend/src/modules/chat/{store,routes,context}.ts；packages/contracts/src/index.d.ts；local-agent/src/index.ts、local-agent/package.json、package-lock.json；backend/test/chat.test.ts、backend/tsconfig.test.json；.gitignore/.dockerignore、README、FILES、同步协议状态说明。

不修改原云端生产配置、前端UI或真实数据库。v4为追加式结构；已有聊天、UUID、旧outbox事件和认证机制保留。跨 workspace 测试的 TypeScript rootDir 扩为项目根，但测试 noEmit，生产后端构建范围不变。

## 已知风险与停止条件

- 单云端实例、单事件流，本轮不是分布式任务锁或多主数据库；不能同时运行多个后端进程指向同库。
- 首次旧记录快照会占用一次写锁；未在2GB VPS压测，不把估算当实测。HTTP批次和本地事务有界，不引入额外重服务。
- 原文保留与版本事件会增长磁盘占用，本轮没有容量告警和自动清理。磁盘满时必须报错，不能伪造成功或ACK。
- 同盘 SQLite 归档/备份不能抵御整盘损坏；异盘/异地加密备份、保留策略和恢复审计未完成，因此清理始终关闭。
- 真实网络、操作系统断电、后台自启动、设备凭据ACL及公网代理需后续单独验收。
- 同步只归档既有事件，不解决模型调用未知结果；不会因同步重连重试模型。
- 用户主动永久删除及备份销毁尚未设计，当前删除是软删除，原文仍保留；不能声称已完成隐私擦除。
- 本轮无自动提交或推送。下一步只能在用户授权后启用真实副本/数据库，不自行操作生产。
