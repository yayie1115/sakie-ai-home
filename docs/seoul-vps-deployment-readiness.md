# 首尔 VPS 部署准备审查（第二阶段）

审查日期：2026-10-16。项目：E:\sakie-ai-home。性质：代码与既有报告的只读审查，新增审查文档，不是部署批准。

## 1. 结论与证据边界

当前代码已具备私人文本聊天和 Windows 增量归档的基础能力，但尚不具备“直接运行现有 compose 即可安全上线”的条件。主要阻塞是生产配置/持久存储不完整、真实双端启用与公网验收未完成、旧 VPS 数据源未核实、第二阶段尚未形成可复现发布版本。资源升级不消除这些条件。

新服务器 Ubuntu 24.04 LTS、2 vCPU/4GB/60GB、43.133.73.31、SSH 加固及 Nginx HTTP/HTTPS 200，均为用户提供的信息，本轮没有连接服务器、访问其 IP/域名或重新验证。正式 DNS 未切换。本轮未读取真实 .env 正文、打开真实数据库、查询真实备份、修改 ACL、运行服务/模型/测试/构建、迁移或上传数据、修改 DNS、提交或推送 Git。

已直接读取：根 package.json/compose.yaml/.gitignore/.dockerignore；前后端 Dockerfile、frontend/nginx.conf、vite.config.ts；backend 配置、server/app、认证、聊天适配器/路由、数据库启动/迁移及维护 CLI；local-agent CLI/网络策略；前端路由、布局、认证和聊天组件；同步实现关键事务/ACK路径与测试用例；现有阶段及 ACL 报告。引用的历史测试结果是报告证据，不是本轮重新执行结果。

Git：main，HEAD 2cf90cc（第一阶段 foundation）。只读 git status 确认第二阶段仍有25个已跟踪文件修改，以及聊天、同步、代理、测试、ACL工具和报告等未跟踪文件。单独克隆该提交不会包含当前第二阶段成果。本轮不提交；发布前需另行验收并授权生成稳定版本/发布清单。

原七阶段任务书与最新产品需求 v1.1 未提供，用户已明确本轮跳过。因此不能更新不存在的原任务书，也不能宣称 UI 已通过 v1.1 验收；本轮状态另记 docs/phase2-seoul-review-status.md，待补齐原文再回填。

## 2. 构建、进程与配置的实际情况

| 组件 | 已有入口与命令（本轮未执行） | 输出、端口与限制 |
| --- | --- | --- |
| 前端 | frontend/package.json：npm run build -w frontend；开发 npm run dev -w frontend | TypeScript noEmit 后 Vite 输出 frontend/dist；开发127.0.0.1:5173，strictPort，/api代理127.0.0.1:3000；生产应提供静态文件，不运行 Vite 开发服务 |
| 后端 | backend/src/server.ts → backend/dist/server.js；npm run build -w backend；npm run start -w backend | Node >=24 <25；默认127.0.0.1:3000；单进程 Express + node:sqlite；容器内 HOST=0.0.0.0，不等于应暴露公网3000 |
| 代理 | local-agent/src/cli.ts → local-agent/dist/cli.js；npm run build -w local-agent；npm run start -w local-agent -- <子命令> | 无入站端口；pair/once/run/status/approve-production；仅运行于 Windows；status也会打开归档库，不能拿它作为只读检查命令 |
| contracts | packages/contracts/src/index.d.ts；workspace build/typecheck | 共享协议类型，不是常驻服务 |
| 容器 | compose.yaml，backend/Dockerfile，frontend/Dockerfile | Node24-alpine构建；后端非root node；静态Nginx容器；前端默认宿主8080:80；backend无宿主端口映射；均restart unless-stopped |

根 npm run build/typecheck 遍历四工作区；npm test 执行 backend 测试（含跨工作区代理与 Windows ACL 测试）。Linux不应把Windows专用跳过项当作已验收。没有本轮产物重建或容器启动证据。

后端必须明确的生产配置：

| 配置 | 代码默认/当前边界 | 生产准备要求 |
| --- | --- | --- |
| NODE_ENV/HOST/PORT | development/127.0.0.1/3000 | production；宿主直跑只监听回环，容器监听内部网络 |
| RUNTIME_ROLE | cloud，可选windows | VPS为cloud；该值不是安全隔离机制，不会自动把业务表变成Windows归档 |
| PUBLIC_ORIGIN | http://127.0.0.1:5173 | 必须显式 https://sakiehome.icu；生产未设置或非HTTPS会启动失败 |
| DATA_DIR/DATABASE_PATH | 源码旁的数据目录；SQLite文件 | 显式指定服务专属绝对路径；运行库、WAL/SHM同属持久目录；禁止镜像层/发布目录存数据 |
| BACKUP_DIR | 源码旁备份目录 | 独立持久目录；与数据库分别管理容量；同VPS同盘不是异地容灾 |
| OWNER_CREDENTIAL_FILE | DATA_DIR/auth/owner.json | 独立可读取的私人身份材料，禁止进入静态目录/Git；运行账户无需写身份文件，维护另行授权 |
| SESSION_HOURS | 168，范围1—720 | 显式记录选值；生产Cookie Secure、HttpOnly、SameSite=Strict |
| DEEPSEEK_API_KEY/MODEL/BASE_URL | key/model空则禁用新调用；地址https://api.deepseek.com | 仅后端注入，不用VITE_变量；模型名显式选择，不在文档存真实key |
| MODEL_TIMEOUT_MS | 60000，允许100—300000 | 模型超时与HTTP任务查询不同；由后台工作者调用，不应靠延长浏览器POST等待模型 |
| CHAT_MAX_OUTPUT_TOKENS | 1024 | 可配置，不能当成费用硬预算 |
| CHAT_CONTEXT_TURNS/CHAT_CONTEXT_MAX_CHARS | 12/48000 | 近期完整轮次和字符上限，不是精确Token窗口；可配置，不发送完整历史 |
| CHAT_MAX_MESSAGE_CHARS/CHAT_MAX_QUEUED_TURNS | 12000/16 | 输入和待处理队列边界；非并发16个模型请求 |
| CHAT_SYSTEM_PROMPT | 默认稳定人格文本 | 与动态上下文分离；如含私人信息也按敏感配置保护 |

代理现有SYNC_POLL_MS=5000、SYNC_BATCH_SIZE=50（最大100）、SYNC_RETRY_BASE_MS=1000、SYNC_RETRY_MAX_MS=60000；这是同步轮询，不是LLM轮询。实际启用需数据库/凭据/策略/批准文件明确绑定。Windows运行账户仍为艺11\hhdn普通令牌。

dotenv默认按进程工作目录读取.env。npm workspace后端命令应明确工作目录；直接node/容器建议由维护工具注入环境或受保护环境文件，不能假设仓库backend/.env会自动进入镜像。

### 现有容器交付的具体缺口

1. compose只配置NODE_ENV/HOST/PORT/DATABASE_PATH，没有必需PUBLIC_ORIGIN，按当前代码将直接失败。
2. 仅sakie-data挂/app/data，未配置持久备份、身份初始化和模型秘密注入；不能靠默认推导路径。精简镜像目录结构与源码不同，应显式设置上述所有路径。
3. backend镜像保留dist并prune开发依赖，npm脚本中的tsx src/cli.ts维护命令不能原样在该镜像执行；后续需受控使用已编译dist/cli.js并验证工作目录/参数，不得临时装开发依赖来绕过。
4. 当前8080映射未绑定127.0.0.1；宿主已有TLS Nginx时须避免容器入口被公网绕过。不能让第二套Nginx抢占80/443或覆盖现有站点。
5. compose无资源限制/日志轮转/异地备份/发布版本锁定；node:24-alpine和nginx:stable-alpine为浮动标签，发布需记录实际版本/镜像摘要。
6. healthcheck只查SQLite SELECT 1，不证明身份可用、模型可用、磁盘可写、归档追平；unhealthy本身不等于已配置自动恢复。
7. 本轮没有验证Docker build、Linux原生SQLite运行或镜像维护操作，不能把TypeScript历史构建通过等同于镜像验收。

## 3. 云端和Windows职责、数据流

浏览器 → VPS同源HTTPS /api → 持久云端SQLite（用户消息、任务、outbox）→ 单后台模型工作者 → DeepSeek → 助手消息/调用结果原子落盘 → 浏览器HTTP轮询读取。

Windows代理 → 主动出站HTTPS /api/sync → 事件批次 → Windows归档SQLite原文/版本/幂等收据/连续游标同事务提交 → 提交后ACK → VPS持久保存确认点。

| 放首尔VPS | 留Windows | 尚未实现/不能宣称 |
| --- | --- | --- |
| frontend/dist、Node API、用户认证、DeepSeek调用、近期上下文、持久聊天与outbox、设备配对/撤销与同步API | local-agent、完整长期归档库、设备明文令牌及批准文件、主要长期数据/未来媒体、私人备份 | 长期记忆提取/检索、媒体同步、自主活动、完整费用预算及完整人格配置UI |

VPS仍必须有自己的持久SQLite；不能把云端数据库放Windows共享路径，否则电脑关机会破坏在线聊天。浏览器不直连Windows，不开放SQLite或Windows管理接口。云端当前保留所有消息，尚非只保留近期的物理缓存：上下文窗口裁剪只控制模型输入，不删除原文。

现有记忆/日记/梦境/活动CRUD仍在后端SQLite，事件归档其版本到Windows，并未把全部Repository改成读取Windows主库。不要把“Windows主要存储”的目标解释成当前所有读写已本地化。

### 离线与增量一致性核对

- backend/src/modules/chat/store.ts及service.ts持久保存用户消息/任务/outbox，助手回复与成功记录原子提交；clientMessageId和retryId去重，冲突拒绝。一个进程中单工作者处理；不能开多个实例/PM2 cluster写同库。
- 队列中断后待处理任务可恢复；运行中模型调用进程中断或超时可能标unknown，必须人工知情重试，不假造成功，也不自动补发可能重复计费请求。
- Windows不在线不阻塞上述聊天路径；仅组装可配置近期上下文，明确长期记忆不可用。没有已运行的自主活动系统，不能报告“自主活动离线暂停已实机验收”。
- local-agent/src/runner.ts在commitBatch后取已提交收据并ACK；archive.ts的事件、投影和连续游标事务提交。ACK请求/响应丢失重放，校验稳定事件ID与内容，缺序/冲突/未知事件停止。
- 云端sync_devices持久保存ACK与delivered_seq，恢复代次/云端流ID/本地水位不一致要求核对；旧备份不能覆盖新消息后直接复用高ACK。
- SyncService.canPrune始终false，ACK前后都没有自动原文清理。60GB仍可能耗尽，必须容量告警和受控拒写，不允许用删未归档消息来恢复空间。
- 当前归档覆盖原始聊天与版本、四模块状态及后续事件，不是整库镜像；会话标题、任务内部状态、登录会话、媒体不完整归档。

docs/sync-protocol-v1.md顶部已说明增量HTTPS实现，但下文保留“本阶段没有聊天API/同步轮询”等第一阶段表述，并提未来WSS。现状应以实现、incremental-sync.md、sync-security.md及本报告为准；后续单独授权整理协议状态，不能因历史WSS文字新增本轮WS范围。

## 4. Nginx与认证边界

优先复用宿主现有TLS入口，后端仅回环或容器私网；静态文件可由宿主直接提供，或转到仅回环绑定的现有前端容器。两种拓扑在部署方案批准时选定，不同时引入两套服务守护。

现有frontend/nginx.conf：/api/保留路径转backend:3000，其他请求SPA回退；无TLS、无/ws、无Upgrade处理、无日志容量配置。backend这个主机名依赖Compose网络，不能直接复制到宿主当回环后端名称。

| 路径/边界 | 部署时应核验 |
| --- | --- |
| / 与 /chat等前端路由 | frontend/dist静态资源及SPA回退；index.html避免长时间缓存，带hash资源可长缓存；不把.env/DB/备份放web root |
| /api/ | 保留/api前缀；代理到127.0.0.1:3000或实际私网服务；保留Cookie/Origin/X-CSRF-Token/Authorization；不启用业务响应代理缓存 |
| /api（无末尾斜杠）及未知API | 明确JSON错误或受控重定向规则，不能返回SPA HTML伪装200；精确/api与/api/需分别验收 |
| /ws、/ws/及子路径 | 当前无WebSocket服务器或upgrade监听；正式入口应明确拒绝/404，不能落入SPA返回200，更不能宣称WSS已支持 |
| HTTP→HTTPS | 仅正式站点范围重定向，保持现有证书验证/其他站点不受影响；端口3000/5173/8080不对公网开放 |

生产前端统一使用相对/api；不新增跨域访问许可。用户认证是Cookie+会话，写请求检查CSRF，存在Origin时检查精确Origin；无Origin不是免除CSRF。设备同步使用独立Bearer token，pair接口靠短时单次配对秘密，不能用用户Cookie绕过设备校验，也不能让设备令牌访问普通业务API。/api/health公开只返回有限健康状态。

app.ts未设置trust proxy：当前req.ip在反代后可能全是代理IP，登录和配对限流会共享额度。不要简单trust proxy=true以接受伪造X-Forwarded-For；上线前选择并验收可信回环/私网代理边界或受控Nginx限流方案。Secure cookie由NODE_ENV决定，不依赖req.secure，但不代表真实HTTPS链路已验收。

未来如批准WS：必须另建真实握手入口、Cookie/设备认证分界、Origin校验、撤销/过期断开及消息权限；普通Express HTTP认证不会自动保护upgrade。Nginx应显式使用HTTP/1.1并传Upgrade/Connection，配置空闲超时与心跳；不能用带秘密的URL查询参数。此为后续设计，不是本次需要新增的聊天依赖。依据：[Nginx WebSocket官方说明](https://nginx.org/en/docs/http/websocket.html)。

## 5. 资源、日志与守护方案（仅预算）

没有新VPS CPU/RSS/磁盘余量、网络或性能实测。以下是试运行分配建议，不是实耗或承诺：

| 项目 | 4GB/2核下的初始预算建议 | 核验与停止条件 |
| --- | --- | --- |
| 操作系统/SSH/Nginx/现有服务 | 预留约1GB以上，现有服务占用先测 | 若其他服务占用超预期，先缩本项目预算，不修改它们 |
| Node API/SQLite | 先按约512—1024MiB观测范围评估，单进程 | 记录RSS、峰值、事件循环延迟、CPU、写锁/响应时间；有数据前不盲目设过紧硬上限导致OOM |
| 可用余量 | 目标至少约1GB，另留文件缓存空间 | 内存持续紧张或重启循环停止试运行；不以频繁重启“解决”泄漏 |
| 构建 | 优先本机构建/受控独立构建；若VPS构建则串行低峰 | 记录npm ci/tsc/Vite峰值，不能把产物体积当内存；不得影响既有站点 |
| SQLite | 不设新DB服务，WAL/FULL/busy_timeout=5000 | 观测WAL增速与checkpoint；未归档原文不清理；备份/迁移须保留足够额外空间 |

60GB建议先盘点OS/既有数据/镜像占用；规划示例上限：发布/镜像与构建缓存5GB，应用日志1GB，云端库含WAL和事件10GB，同机备份10GB，至少保留10GB应急余量，其余留系统/既有服务。不是配额或自动删除策略；迁移/一致性备份/演练至少核算额外多份数据库空间，实际目录超过预算即重新评审。70%预警、80%升级告警、临界水位停止新写的阈值可作为待验证起点，当前没有实现告警或业务容量保护。

守护择一：

- 宿主Node：另行提供本项目专属systemd unit，非root专用用户、WorkingDirectory明确、外部EnvironmentFile、UMask=0077、仅数据/备份目录可写；Restart=on-failure配退避/启动限速，网络与挂载就绪后启动、单实例。stop超时须大于现有10秒退出窗口并实测，运行中模型任务可能进入unknown，不自动付费重试。unit及开机自启本轮未创建/验证。
- Docker：保留项目专属Compose，显式持久卷、秘密注入、健康观测、日志与资源边界；启用Docker开机启动需单独维护授权，不能改全局daemon影响其他服务。restart unless-stopped不替代健康故障处理；不得双重由systemd反复启动同一后端。
- Windows：后续在艺11\hhdn普通账户下为代理配置计划任务/受控服务，绝不以管理员常驻运行；开机/睡眠恢复后重试与路径绑定须实机验收。当前无已验证的自动启动安装。

日志：优先仅错误码/请求ID/状态/耗时，不记录消息正文、Cookie、Bearer、密码、配对码或环境转储；Nginx也不能记录敏感请求体/Authorization。配置本项目日志轮转与保留天数，日志不替代持久同步审计。Docker默认json-file可能无限增长，应仅对本项目设local或有max-size/max-file的日志策略，不改全局配置。[Docker官方日志说明](https://docs.docker.com/engine/logging/configure/)。身份初始化CLI会打印一次性密码，必须在私人终端操作且避免被服务日志/终端录制收集。

失败恢复：不可写/磁盘满/数据库错误要停止接收无法持久化的新请求，不能返回虚假202；当前需补验该故障路径。保留故障现场，恢复用新目录候选并核对会话、流身份、游标与数据指纹；不要删除restore-info标记绕过隔离。回滚二进制前检查schema兼容，不允许v3代码直接假定可写v4。旧快照绝不可覆盖含新消息的运行库。

## 6. 旧VPS盘点、迁移范围与单写源

本轮没有读旧VPS，无法证明其无数据，也不能假设Windows现有cloud库就是旧VPS的唯一权威副本。正式切换前必须确定当前唯一写入源及所有写入端（旧API、工作者、旧同步代理）。

| 资产 | 后续受控迁移/核对范围 | 禁止做法 |
| --- | --- | --- |
| 云端运行SQLite | 一致性快照、迁移账本、chat全表/原始outbox、archive producer身份、设备/ACK、版本事件和必要认证状态；先副本验证 | 仅拷sakie.db而忽略活动WAL；两台服务器各写后按时间覆盖；只迁“近期聊天” |
| 人格/模型/身份配置 | 必要人格副本、PUBLIC_ORIGIN等配置、owner验证材料；模型key在新机受控配置/按需轮换；确定是否撤销旧会话/重配设备 | 将.env或身份文件放Git、前端、报告或公开构建上下文 |
| Nginx/TLS/服务 | 盘点当前站点名、端口、证书续期、代理、专属守护、目录权限及日志设置，按新机情况重建站点配置 | 整份覆盖新机nginx.conf、systemd或旧机其他站点配置；迁root SSH私钥 |
| 备份与媒体 | 旧机若有唯一业务媒体/必要备份，先列来源与校验清单再批准复制；Windows主要归档不搬成VPS主库 | 拷整块E盘、含真数据验收目录、未知历史测试目录或原ACL夹具到VPS |
| Windows归档与凭据 | 留原位置；核对流ID、设备绑定、ACK、本地代次；需要时受控撤销/重新配对 | 因换VPS就清空归档或重置游标；同域名即默认设备连续可信 |

若旧VPS从未运行业务，须用后续只读盘点证据确认，才可采用新空云库方案。若存在多个分叉库，不自动合并，先停止切换并人工对账。同域名DNS切换仍存在缓存指向两台机器的窗口：应冻结旧源写入/只读或经批准统一转发到唯一新源，确保旧模型工作者也停止接任务，不能同时接受写入。回退DNS后若新机已接收消息，不能直接启用旧快照；先隔离并对账保留新消息。

## 7. DNS正式切换前验收门槛（均待执行）

1. 发布准备：授权冻结可复现版本/清单，包含未跟踪的第二阶段源文件；不上传node_modules、.env、数据库、备份、设备材料与私人验收副本。Linux Node24/构建/容器路径需验证。
2. 资产与备份：旧VPS只读盘点、确定唯一权威流、停写窗口与回退负责人；一致性快照可在新目录恢复；迁移先副本演练，记录旧UUID、原文哈希、事件数/顺序与账本。不把历史“真实v3”当作今天已重新检查结果。
3. 权限：Windows S1—S7真实治理仍待授权，.env及数据库/身份/备份/含真数据验收副本必须独立验收；保留原禁止夹具与旧Plan。新VPS独立Linux非root权限审查，秘密不进入公开路径；不得用Windows实验通过替代真实最小权限。
4. 新站点预检：用户另行授权后用curl --resolve或单机hosts使sakiehome.icu连接43.133.73.31，保持正确Host/SNI和有效证书，不用跳过TLS验证；HTTP跳HTTPS、深链/静态/API错误类型、证书续期和端口暴露均验证。
5. 身份：真实HTTPS登录/退出/过期、Secure/HttpOnly/SameSite、匿名401、无CSRF403、错误Origin403；设备令牌不能访问业务API、旧令牌撤销有效；限流代理IP边界验证。不能只测health200。
6. 消息：先假模型/独立库验证持久202、重复UUID/异文冲突、超时unknown、进程重启与人工重试；真实模型仅用户明确授权少量付费验收，禁止页面加载触发模型。
7. 双端：正式策略精确https://sakiehome.icu白名单及TTY短语确认、物理路径绑定、受保护凭据、受控配对。先合成数据验证实际公网Windows离线仍可聊天、云端重启、ACK丢失、网络断连、睡眠恢复、重复事件及游标恢复，按ID/序号/内容摘要对账。生产目标确认不是“准许本轮启动”。
8. 清理与容量：确认无未归档原文清理；实测磁盘满/WAL增长、备份失败、日志轮转、低内存/写锁/重启限速及开机恢复；检查其他站点仍健康。
9. 切换：确认A/AAAA/TTL及证书、旧机唯一写入策略、无DNS缓存双写；切后从iPhone和Windows验证同一会话/消息，持续观察错误/磁盘/同步落后水位。没有这些证据不标记第二阶段上线完成。

## 8. UI实现盘点（不是v1.1验收）

| 已知模块/体验 | 当前实现状态 | 文件证据与缺口 |
| --- | --- | --- |
| 登录/退出 | 已实现基本界面 | AuthenticationGate.tsx、api.ts；无真实iPhone/HTTPS本轮验收 |
| 首页/导航 | 部分实现 | Layout.tsx、router.tsx只有标题/导航/占位；首页“各模块尚未实现”已过时，不是完整首页 |
| 聊天 | 部分实现（最简闭环已实现） | ChatPage.tsx：新建/选择会话、分页历史、纯文本发送、持久化状态轮询、失败/unknown提示及知情重试；无流式/复杂UI、未做本轮E2E |
| 记忆与设定 | 仅占位UI；后端原CRUD | /memory；无三层记忆浏览/检索、无独立人格配置UI；不能把后端记录表当完整记忆系统 |
| 日记/梦境/活动记录 | 仅占位UI；后端基础数据API | /diary、/dream、/activity；未实现相应列表/编辑和活动展示 |
| 音乐播放 | 仅占位 | /music，无实际播放器 |
| 设备与数据 | 仅占位UI；设备同步接口已实现 | /device；无配对/撤销/同步监控/备份管理UI |
| 动态/评论/点赞 | 仅设计/未实现 | modules/index.ts和router.tsx无专属页面，无此数据链路 |
| 他的收藏夹 | 仅设计/未实现 | 无专属路由/模型/服务UI |
| 设置 | 仅设计/未实现 | 无独立设置页，后端环境配置不等于用户设置UI |
| iPhone适配 | 部分基础条件 | index.html有viewport、textarea可换行、导航flex-wrap；无移动专项布局/触控/键盘遮挡/后台恢复验收 |
| 编辑/软删除 | API存在，UI未实现 | chat routes PATCH/DELETE有版本事件；现有前端合并历史不会主动移除已缓存的删除项，跨端变化显示需后续修正 |

ChatPanel未确认草稿/请求ID仅在组件内存，刷新或关闭页面可能丢失尚未确认入库草稿；有离开提示但不是持久浏览器离线发件箱。已可靠落云端的消息应通过历史读回，不等于尚未发送消息已持久化。现有纯文本用React渲染，不代表完成Markdown/媒体需求。日记/梦境/收藏/动态并未默认注入模型上下文。

产品v1.1的具体布局、交互和验收条款未知，以上只基于用户先前列出的模块和当前代码；不得补造v1.1要求或借本轮设计UI。

## 9. 阶段证据、风险与后续顺序

历史证据：docs/acl-directory-recovery.md记载完整106项（105通过、0失败、1项Win32 1314符号链接跳过），四工作区typecheck/build通过；docs/acl-minimal-executor-lab.md另记新增21/21针对性测试通过，该轮未重跑106项，不能相加声称127项完整回归。chat.test.ts和sync.test.ts存在离线、ACK丢失、重复事件、事务中断、云端重启、恢复代次与v3→v4案例。本轮只是查阅用例及报告，没有重新运行。

| 优先级 | 风险/未验收项 | 上线前条件 |
| --- | --- | --- |
| P0 | 不完整compose会失败或丢备份/身份持久性 | 批准并验收生产配置、持久路径和维护入口 |
| P0 | 旧机数据源与双写窗口未知 | 只读盘点、停写/单写源方案、恢复对账；未知状态禁止覆盖 |
| P0 | 真实Windows敏感资产权限治理未完成 | 按已审方案单独授权，不能用当前合成执行器直接治理真实路径 |
| P0 | 正式迁移/设备配对/网络批准与公网闭环未完成 | 独立授权、迁移副本演练、真实HTTPS及断连恢复对账 |
| P1 | 未提交源码导致发布遗漏、生产镜像未验 | 形成受审可复现版本和Linux交付证据 |
| P1 | 无异地备份/容量告警/守护验收 | 受控恢复演练、容量预算实测、日志/自启动/故障停止验收 |
| P1 | 代理限流共享IP、/api和/ws落SPA风险 | 部署配置审阅与HTTPS反代边界测试 |
| P2 | 协议历史状态矛盾、UI占位、草稿/跨端刷新限制 | 单独文档修订与后续产品UI范围确认；不阻止隔离部署预演 |

建议下一步只做独立授权的“旧VPS只读资产盘点 + 新机只读资源/网络/服务盘点”，确定数据源和部署拓扑后再准备生产配置变更稿。随后分别批准迁移、权限治理、上线预演和DNS切换；不因本报告写完自动执行任何一步。原七阶段任务书/v1.1待用户提供后再回填状态与逐条验收。
