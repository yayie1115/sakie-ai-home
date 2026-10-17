# 小家｜共同工程状态与交接（2026-10-16）

> GitHub 文档供 Chat 与原有 Codex 窗口共同读取。本文件记录最新阶段边界；正式七阶段路线以已批准工程任务书为准，旧报告只是历史证据。**文档中的“计划”不是执行生产操作的授权。**

## 工程状态
- **正式第二阶段进行中，第三阶段未启动。**
- Windows 本地代理和增量同步：有实现及隔离测试证据，真实双端公网、设备撤销、断电与完整迁移尚未最终验收。
- Windows ACL：合成范围、审计、目录级恢复及最小执行器实验已完成；**真实 S1—S7 ACL 治理尚未执行**。下一步按 `acl-s1-preflight-review.md` 的要求单独核准后受控处理，禁止对整棵混合 data/backups 目录运行旧 Plan。
- Windows 后端和 local-agent 预定以 `艺11\hhdn` 普通权限运行；不得把本机 Windows SID 永久写入迁移格式。

## 首尔 VPS 与截止日期
- 新腾讯云首尔 VPS：Ubuntu 24.04、2 vCPU/4GB、60GB SSD，已完成独立 SSH 密钥登录及快捷别名、禁止 Root SSH 和密码认证、Nginx HTTP 公网测试、TLS HTTPS 200、私钥权限及临时副本清理验证。
- **新 VPS 当前仅有测试网页；正式前后端、数据迁移与 DNS 切换尚未完成。**
- `sakiehome.icu` 当前仍指向旧 VPS，切换前必须验证唯一写入源、旧站资产、数据库/WAL一致性备份、浏览器/同步验收及回退计划，绝不双机同时写入。
- **旧 VPS 2026-10-22 到期：迁移/必要备份与退役判定须在此之前完成；如果安全验收来不及，应尽早准备续期或安全保底，不能为赶截止跳过数据保护。**
- 现证书至 **2027-01-12** 到期，正式上线时需设置并实测自动续签/替换。

## 最新部署审查
- [首尔 VPS 部署准备审查](seoul-vps-deployment-readiness.md)（只读，未部署）。
- [第二阶段审查状态补记](phase2-seoul-review-status.md)。
- 重点阻塞：Compose 缺必要生产配置及持久化；当前后端无 WebSocket 入口，不得把 /ws 伪装成已实现；真实旧 VPS 唯一数据源未知；第二阶段源码仍含未提交变动，直接克隆旧 main 会遗漏成果。新 VPS 不应复制 Windows 完整主库。
- 产品/UI 唯一当前基线：[需求与交互规范 v1.1](sakie-ai-home-产品需求与交互规范-v1.1.md)。老版 [架构审查](architecture-review.md) 是历史材料；其早期能力评估不得覆盖最新代码审查。

## 下一项（原 Codex 执行，待 Chat 审核）
**用户澄清（2026-10-16）：10 月 22 日旧 VPS 到期，所说的“搬迁”主要指将旧机承载的网站/服务部署与入口切到新首尔 VPS；目前用户认为旧机大概没有必须迁移的业务数据，但尚未核实。** 不要把任务扩大成 Windows 主数据库全量搬家，也不能未经核查断言旧机无独有数据。

优先完成最小只读服务清单：旧机现有站点/反向代理、进程、容器、计划任务、端口、证书、域名解析与服务依赖；区分必须搬、可以重建和可以退役。顺带只核实有无必须保留的业务数据、媒体或配置（不读取凭据内容）；确认后制定新机部署、域名切换、验收及回退顺序。用户此前已连接过旧机，Codex 应优先询问现成的已授权连接途径，不必重复做长篇资产研究。

**截止日前目标：服务在新机正常工作且域名指向新机，旧机可安全退役。** 不因第二阶段未全部完成就把未实现模块标记为生产可用；生产范围应明确。仅在得到逐批授权后执行部署、DNS 修改和旧机操作。证书续期仍为上线验收事项。

## 协作规则
- Codex 结束一轮后，将安全脱敏的 `docs/reviews/` 报告及此文件的增量状态提交并推送；Chat 从 GitHub 读取，核验后再给下一任务。**每次完成即登记，区分设计通过、隔离测试通过、真实环境验收通过。**
- 公共仓库禁止上传 .env、模型/API Key、TLS/SSH 私钥、登录令牌、数据库/备份、真实内容、个人隐私或敏感日志。
- 不覆盖 Codex 同时编辑的同一路径；先拉取、核对差异，再提交。保留有用的历史审计，真正重复或过时文件先检查引用再清理。

## 2026-10-16 增量登记：旧机盘点与最小搬迁准备

- 新增[本轮脱敏报告](reviews/2026-10-16-vps-inventory-and-minimal-migration.md)。基于远程main `334694b`，通过fetch及独立文档工作树核对本文件、部署审查和产品v1.1；没有pull覆盖Windows开发工作区，未提交第二阶段业务代码。
- **已验证**：Windows运行库、WAL/SHM、身份文件及备份目录存在（仅元数据，未读正文/开库）；指定本机开发端口与node进程检查无匹配。新首尔VPS通过现有`sakie`入口限定只读核验：Ubuntu24.04、2CPU，宿主Nginx active/enabled，80/443指向同一测试静态目录；当前PATH未见node/npm/docker/certbot，无所查站点API反代。资源单次快照：available3164MiB、根盘约50G可用，不是应用性能验收。未发现certbot定时器不等于所有续签方式均不存在。
- **阻塞**：没有旧VPS已授权连接方式，尚未核实其业务服务、数据库/唯一消息/媒体/凭据/备份及唯一写入源；**不得判定旧机可退役**。最少补充旧机SSH别名或主机+普通账户+已配置密钥路径（不要密钥正文），及2026-10-22精确到期时刻。
- **仅设计**：最少Compose/持久路径/身份只读挂载/回环端口/日志与资源/双层反代信任边界/明确拒绝`/ws`；一致性保全→副本演练→隔离部署→受控配对→单写源切换→退役，均需分批授权。
- 产品v1.1已可读取：以§12/P0台账为准；允许数据和权限充分的离线云端业务，本地依赖暂停；7天保留期须本机持久化且校验后起算，当前清理仍关闭；80%容量告警与完整冲突/UI要求尚未交付。旧报告的“v1.1未提供”只代表上一轮历史状态。
- **尚未执行**：旧机连接、真实备份/恢复/迁移、停服务、安装/生产部署、ACL/DNS变更、模型调用、正式配对。本轮不重跑代码测试。Windows源码与历史资产保留。
- 时间风险：建议10月18日前取得旧机证据；若仍不能安全保全，建议10月20日前由用户决定续期或保底，不等到10月22临期跳过验收。只是建议，不自动续费或执行。
- 下一步：Chat审核报告；用户补旧机入口后完成限定只读盘点，再申请一致性保全及其他独立维护授权。**正式第二阶段仍进行中，第三阶段未启动。**

- 提交前通过GitHub连接器复核main已更新至987d7b55ea6cfe0d08058c6bc778429fe119a7ab，已保留其共同状态澄清：10月22日前主要完成旧机网站/服务与入口搬迁；Windows主库不搬，旧机数据迁移仅在发现需保留资产时启动，不把第二阶段全部产品能力完成当成既有网站服务搬迁的前提。

## 2026-10-16 用户补充：旧机服务去留（未授权执行删除）
- 用户确认：**AruHost / aru-selfhost 不再需要**，属于可退役对象；先核对其具体进程/目录/依赖，不能仅凭目录名对其它服务执行删除。**本决定不是立即 rm、docker rm 或删除卷的授权**。
- 用户确认：**Phosphene 要保留**，未来拟作为小家的 MCP「玩具」接入。旧 VPS 已从用户终端截图见 `phosphene-app-1`（healthy，映射 3000→8080），需确定其卷/持久状态/启动配置和依赖并保全，避免旧 VPS 10 月 22 日到期丢失。是否与小家同机部署、MCP 接口实现方式与授权范围尚待设计/确认；不要宣称现已支持 MCP。
- 用户截图另显示旧机 `caddy` 监听 80/443/8443、Node 8787、Python 8899。服务归属与是否属于 AruHost/Phosphene 未证实，**先做对应关系核对，不能全部删或全部迁**。
- 旧机经腾讯云 OrcaTerm 网页终端管理，**没有配 Windows SSH**。不要求用户为了盘点另配 SSH；可通过已有网页终端执行限定只读命令并让 Chat 汇总脱敏结果。
- 调整迁移方案：保留 Phosphene 的必要文件/配置和数据（安全离机副本），决定新机的隔离运行方式后再迁；AruHost 及相关进程待确认无其它依赖后再单独申请停用/清理许可；部署小家仍需独立验收。

## 2026-10-16 旧机 OrcaTerm 补充证据：Phosphene 有须保留历史数据
- 用户明确：Phosphene **已有需要保留的历史数据**；其迁移优先级为“先制作可恢复的离机备份并验证，再考虑停旧机/恢复新机”，不得仅迁 Docker 镜像。
- 旧机只读命令输出：Caddy `active`（`/lib/systemd/system/caddy.service`）；`aru-selfhost.service` 为 enabled（仍未停用）；`caddy_api.service` disabled、`caddy.service` enabled。`phosphene-app-1` 已见 healthy；其 Docker Mount 输出为 `bind | /data`（此处 `/data` 是容器内目标路径，**尚不知宿主机 Source 路径**）。
- Node 8787 和 Python 8899 进程的 cwd 分别为 `/` 和 `/root`，不能据此确认归属。待补只读信息：Phosphene bind mount Source 与只读容量/文件类型元数据、项目启动配置文件所在位置及备份方法；避免输出 `.env`/令牌/内容。
- **禁止在备份与恢复验证前删除容器、宿主机挂载源、Docker 卷或旧机**。AruHost 待淘汰决定不等于已获执行删除授权。

## 2026-10-16 Phosphene 数据源确认（OrcaTerm 只读）
- 旧上海 VPS 上 `phosphene-app-1` 的容器内 `/data` 是 **rw bind mount**，宿主机 Source=`/home/ubuntu/phosphene-data`；该目录占用约 **2.2 MB**，顶层 **2 个子目录、3 个普通文件**。仅统计元数据，未读取文件正文。
- Docker Image=`phosphene-app`，RestartPolicy=`unless-stopped`，容器此前显示 healthy。镜像名称不能证明存在可从公共注册中心重新拉取的镜像；需要核实构建源码/部署配置及安全恢复手段。
- 用户明确 Phosphene 有必须保留的历史数据，须在旧机到期（2026-10-22）前，制定受控短暂停写窗口，获得一致性备份、保存到旧机以外的安全位置，并验证恢复及程序可启动；备份不进入公共 GitHub。当前**尚未执行备份/迁移/停机**，不能把 2.2MB 视为已安全保全。
- AruHost 不迁移的决定不影响 Phosphene 的保全。未来作为小家的 MCP 玩具仅为需求意向，不代表已实现接口或已授权公开其访问端口。

## 2026-10-16 收工交接：用户要求暂停，明天继续
- **已暂停，今晚不再执行服务器变更或备份。** 用户同意 Phosphene 可以短暂停用数分钟以做一致性备份，但目前只是允许安排维护窗口，**尚未停止容器、生成备份、上传文件、部署新机或修改 DNS**。
- 最新已确认：旧 VPS 2026-10-22 到期；首尔新 VPS SSH/Nginx/HTTPS 测试已通过但仅有测试页；域名仍指向旧机且用户电脑访问提示未备案；AruHost 不再需要但未删除；Phosphene 要保留历史数据并计划未来成为小家的独立 MCP 玩具；数据宿主机路径 `/home/ubuntu/phosphene-data`，约 2.2MB（2 目录、3 文件），容器 `phosphene-app-1` healthy，Image `phosphene-app`，重启策略 unless-stopped。
- **明天优先**：在旧 VPS 网页终端确认 Phosphene 构建/启动来源、与其他服务的依赖；按已同意的短维护窗口实施受控停写→生成一致性备份→校验并保存至旧机以外安全位置→复启；此后验证程序和数据在首尔新机的恢复。执行之前核对具体命令及存放位置；不上传含真实数据的备份到公开 GitHub。
- 然后分批推进服务迁移、HTTPS/自动续期、实际域名访问与 DNS 切换、最终旧机退役判定。**不得假称搬迁或第二阶段完成。**
- 协作继续：Codex 每轮上传脱敏报告和进度到 GitHub；Chat 直接从 GitHub 审查并更新；无用户明确请求不安排定时提醒。

## 2026-10-17 后续扩展需求：多 AI 角色与群聊（先预留，暂不开发）
- 用户希望将来可创建**多个 AI 角色**，每个具有独立人设、头像/名称、模型配置及**长期记忆**，但**不要求新角色拥有自主生活/自主行为调度**。用户与各角色聊天频率可能很低，休眠不应导致记忆丢失。
- 预留每个角色参与独立私聊与多成员群聊的可能性；谢亦言现有长期私聊时间线及其特有自主机制不受影响。私聊记忆按角色与会话权限隔离，群聊哪些记忆可进入角色记忆、可跨会话引用需要后续细化，**默认不向其他 AI 暴露私人聊天/记忆**。
- 工程早期设计/重构时注意可扩展的角色ID、会话ID、成员关系、消息发送者ID、记忆归属与访问授权边界；群聊 AI 回复需支持点名/发言仲裁及轮次、Token/预算上限。**仅作兼容性设计约束，不授权立即新增 UI、迁移生产数据库、改现有代码或扩大阶段二范围。**
- 优先级仍为旧 VPS 2026-10-22 前迁移和第二阶段同步可靠性；正式产品规格及群聊细节另行确认，不以此记录替代 v1.1 权威规范。

## 2026-10-17 多 AI 群聊记忆补充决定
- **用户确认：某个 AI 在群聊中亲历的内容，可以被该 AI 记住，并在后来与用户的私聊中自然提起/引用。** 群聊经历不是默认只能留在群内；允许角色跨会话形成连续认知。
- 实施仍须有来源可追溯（群 ID、消息/事件 ID、成员与时间）、角色归属、可见性/授权边界；其他角色**不能因此自动获得用户与谢亦言等的一对一私聊或私密记忆**。群聊事件的记忆共享与成员退出后的访问细则后续设计。
- 仍为**未来扩展需求**，目前只预留，不立即开发。2026-10-22 旧 VPS 服务迁移及 Phosphene 可恢复备份优先。

## 2026-10-17 Phosphene 首份一致性备份已在旧机生成（待离机保全）
- 用户在旧上海 VPS 的 OrcaTerm 执行了受控短暂停写备份脚本：停止 `phosphene-app-1` → `tar` 打包 `/home/ubuntu/phosphene-data` → 成功执行归档列表校验并生成 `.sha256` → 重新启动容器。
- 截图确认压缩包 `/home/ubuntu/phosphene-backups/phosphene-20261017T055917Z.tar.gz` 大小约 **1.6 MB**，同路径有对应 `.sha256`（约 131 字节），权限 `600 root:root`；终端提示 `BACKUP CREATED - NOT YET OFF SERVER`。容器重启时为 `health: starting`，**尚待证实变为 healthy**。
- 备份尚未离开旧 VPS；`tar -tzf` 仅证明归档可读，不等于已经完成**异机恢复演练**。下一步核实 Docker 健康，再采用受控、加密的方式将备份和校验文件转移到 Windows 私有目录或首尔新 VPS，校验 SHA-256、实施隔离恢复测试。**不要把备份放进公开 GitHub，不要在未确认传输方向/权限前执行用户终端里尚未运行的 scp 草稿。**
- 旧机数据、容器及 AruHost 均未获删除授权，DNS 未切换。搬迁完工仍未验收。

## 2026-10-17 Phosphene 离机备份 SHA-256 校验通过
- 用户反馈：已通过旧机 OrcaTerm 文件管理功能下载 Phosphene 的 `.tar.gz` 和 `.sha256` 至 Windows，并执行先前给出的 PowerShell SHA-256 检查，结果与预期 `BACKUP VERIFIED - SHA256 MATCH` 一致。
- **已验证的是下载副本和原备份校验值匹配**，不等于已做隔离恢复、验证容器的数据可读，也不等于新 VPS 已部署 Phosphene。旧机数据/备份暂时保留，不删、不停用。
- 接下来优先只读核查旧机 Phosphene 镜像构建与编排来源、启动方式和可安全迁移的必要程序资产；然后确定新机恢复/验收方案。公共仓库不得保存真实数据或秘密。

## 2026-10-17 Phosphene 旧机部署来源确认
- 旧 VPS OrcaTerm 截图确认容器 `phosphene-app-1` 恢复到 `healthy`（截图中 Up 3 minutes）。Docker Compose 标签：Project=`phosphene`、WorkingDir=`/home/ubuntu/phosphene`、ConfigFiles=`/home/ubuntu/phosphene/docker-compose.yml`；发现 `/home/ubuntu/phosphene/Dockerfile`。本地镜像 `phosphene-app` 存在，约 119 MB，不能据此推断镜像可公开拉取。
- 下一步核对该项目构建上下文及启动依赖、敏感配置文件的存在性（不读取秘密值），准备将程序资产及已经完成 SHA256 检查的私有数据备份安全搬到新 VPS。切勿将 .env、数据归档、私钥提交公开 GitHub；实际重建、恢复和网络切换仍待分步验收。

## 2026-10-17 Phosphene 构建目录进一步核验（旧机终端）
- 截图看到 `/home/ubuntu/phosphene` 包含 `docker-compose.yml`、`Dockerfile`、`docker-entrypoint.sh`、`.dockerignore`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`drizzle/` 迁移、`docs/DEPLOYMENT.md`、`docs/BACKUP.md`、`docs/MCP.md` 等源码/构建及文档资产。
- 项目 `.env` **存在**，应走私密迁移路径；不得直接在聊天截图、公有 GitHub、脱敏报告中输出值。容器挂载 `/data` 为 bind，用户历史数据离机备份的 SHA256 已验证，但尚未恢复演练。
- 下一步：查清安全构建/运行条件，保留私有环境文件、源码及 DB 的关联；按非公开方式打包必需源码（排除 .env、node_modules、数据和其他秘密），再在隔离新环境中构建及恢复，审核后才开放公网端口。

## 2026-10-17 Phosphene Compose 结构确认
- 旧上海 VPS 终端只读检查：`docker compose config --services` 输出仅 `app`；compose 采用 `build.context: .`，项目为 `/home/ubuntu/phosphene`，约 321 MB；`docker compose config --volumes` 没有输出命名卷；容器数据采用既有宿主机 bind `/home/ubuntu/phosphene-data`。
- `git remote -v` 未显示可用远程仓库。暂不能直接在首尔通过 Git 克隆。**下一步应先核对 Dockerfile 和 .dockerignore 的构建所需文件/排除项，再安全打包源码，严禁将 `.env`、凭据及真实数据库放入公共 GitHub**。历史数据备份已离旧机、SHA256 校验通过，尚未做恢复验收。

## 2026-10-17 Phosphene archive transfer to Seoul verified
- Windows SCP transferred three files into Seoul VPS user-private `~/phosphene-migration/`: source archive `phosphene-source-export.tar.gz`, history/data backup `phosphene-20261017T055917Z.tar.gz`, and matching `.sha256`. All three SCP transfers reached 100%.
- First checksum command failed because the `.sha256` entry contained the old VPS's absolute path; this was a **path mismatch, not evidence of corruption**. Subsequent read-only checksum command stripped old path in a pipe and validated the archive on Seoul; user confirmed it returned the expected success output. Source tar list read succeeded. No Docker deployment/restore or DNS changes yet.
- Next: check Seoul Docker/Compose and source archive structure; stage isolated restore, retaining original tarballs unchanged. Verify runtime health and user data before any cutover. Do not expose Phosphene port publicly or upload backups to public GitHub.

## 2026-10-17 DNS 控制台截图确认（未执行切换）
- 腾讯云 Lighthouse 域名解析页面显示 `sakiehome.icu` 与 `www.sakiehome.icu` 各有一条正常的 A 记录，均指向旧 VPS `122.51.204.197`；该视图显示共两条记录。新首尔 VPS 目标 IP `43.133.73.31`。此为控制台截图证据，不代表另行独立实时 DNS 探测。
- **DNS 未变更**。切换前需小家正式服务/反代通过新机定向访问验收，核实 `www` TLS SAN 覆盖或配置重定向及匹配证书，并准备回滚；不能因为新机测试站 HTTPS 200 就立刻切解析。待部署验证后，经用户明确同意再修改两条 A 记录。

## 2026-10-17 Phosphene 首尔隔离部署：只读预检完成，变更待批

- 新增[隔离部署与恢复事前审阅报告](reviews/2026-10-17-phosphene-isolated-deployment-preflight.md)。先读取main最新状态承接任务，提交前保留本日新增DNS截图记录；未覆盖Windows未提交源码。本轮通过GitHub连接器仅提交脱敏文档。
- **已实测**：新机Ubuntu24.04/amd64，Nginx active/enabled，80/443仍为现有测试站；Docker/containerd未运行，所查Docker包和命令未发现；拟隔离端口18080空闲。内存available3145MiB、根盘约50G可用为单次主机快照，不是构建/应用耗用。
- **归档检查通过**：数据tar与现有.sha256匹配；两tar gzip CRC及路径/对象类型检查通过。源码77对象（65文件/12目录），数据11对象（5文件/6目录），含预期SQLite及4个uploads图片，无归档WAL/SHM。本轮未解包、打开历史DB或读取秘密正文。
- **来源校验缺口**：上传区实际3文件，只有数据包对应.sha256，源码包没有独立校验文件。本机已计算源码指纹，仍须旧机已有OrcaTerm提供原包摘要或补传校验文件，不要求重新配置旧机SSH、不索取.env。
- **关键恢复风险**：Phosphene启动自动迁移、清临时/孤立附件、更新种子、处理过期任务并启动Webhook，故不能挂原备份直接试启动。先留不可变baseline、在新副本做migration-only，再在禁止出站副本启动；不能把已变更副本当可信原始基线，也不能重复外发历史Webhook。
- **构建限制**：Node24.14.0多阶段、pnpm10.13.1/锁文件、5份迁移SQL均在；原Compose含公网3000映射/旧路径，不能原样运行。导出未含测试及validate-deployment依赖模板，原校验还有卷断言不一致，不能声称全套pnpm check通过。未构建镜像/安装依赖。
- **G1待批**：官方APT Docker Engine/Compose安装、审阅模拟包清单、记录daemon/socket/containerd与网络变化和回滚；不加docker组，不改Nginx，不开放应用公网端口。
- **G2待批**：先补源码来源摘要并审核migration-only派生入口，再批准新实验根目录解包/隔离构建/副本恢复；仅副本承受启动副作用。首次network_mode:none，无端口映射；如需交互访问，另验网络禁止出站且仅回环18080，不改DNS/现有站点。
- **未完成**：Docker安装、实际解包/恢复、SQLite完整性/账本/历史可读性/容器重启持久性；没有旧机停用、AruHost删除、真实ACL、DNS变更、MCP接入或付费调用。旧机仍是当前服务，数据与备份保留。
- **正式第二阶段仍进行中**；Phosphene属于10月22日前并行服务搬迁，第三阶段未开始。等待Chat批量审阅G1/G2后再执行，不逐条命令索批，也不自动跨闸门。

## 2026-10-17 Phosphene G1完成、G2只读准备完成（未恢复历史副本）

- 新增[G1安装证据与G2准备报告](reviews/2026-10-17-phosphene-g1-install-and-g2-readiness.md)。用户本轮明确“授权执行G1”后才安装；技术审查通过没有被当成执行授权。
- **G1已完成**：官方Docker APT noble/stable仓库，签名key主指纹核验；模拟与真实前后包清单均为恰好5个新包、0升级、0移除。固定安装Engine/CLI29.9.1、containerd.io2.4.2、Compose5.6.0、Buildx0.38.0；不安装rootless-extras/pigz、不autoremove。完整包版本与安装日志见私人新机审计，不上传原始日志。
- **已验证**：docker/containerd/docker.socket active，Nginx仍active/enabled；用户组成员关系未变，未给用户加入docker组；Docker API仅Unix socket（660 root:docker），无TCP配置/监听。当前0容器、0镜像，无Phosphene运行或公网应用端口。
- **站点未受影响**：原两个Nginx配置指纹及HTTPS响应体一致，80/443仍属Nginx；本机HTTP/HTTPS200，Windows定向首尔的公网TLS验证通过且200；没有改DNS或Nginx配置。
- **网络实际变化已留证**：新增默认Docker网络、172.17.0.0/16网桥（与原记录路由无重叠）、IPv4/IPv6 Docker链；IPv4 filter FORWARD从ACCEPT变为DROP，INPUT/OUTPUT仍ACCEPT。不能宣称系统网络完全未变；未来转发型业务需另验，未清空或回灌全局防火墙。
- **G2源码来源校验已补齐**：用户明确确认64位摘要来自旧VPS OrcaTerm实际sha256sum输出，首尔源码原包重新比对完全一致；不再阻塞于独立来源摘要，未伪造sidecar文件。旧机无需新SSH。
- **G2仅只读准备**：migration-only入口只调用initializeDatabase/shutdownDatabase，派生Dockerfile拟在prune前额外打包该入口；完整启动副本仍有seed/过期任务/附件清理/Webhook副作用。方案统一先network_mode:none、无端口/宿主socket，先合成探针后新历史副本；不以仅绑定回环替代出站隔离。
- **尚未实施**：未解包、构建、迁移、开历史SQLite、启动任何历史副本或验证重启持久性；未跑原项目测试；未修改旧机Phosphene/AruHost、Windows数据/备份/ACL、DNS或现有Nginx站点；无MCP接入开发。
- 下一步等待Chat审核G1证据，并单独批准G2派生编译、网络合成探针及新夹具副本恢复/启动的限定范围与副作用。**正式第二阶段仍进行中，第三阶段未启动。**


## 2026-10-17 执行策略调整：加速交付，不变更七阶段验收底线
- 用户明确要求加快小家搭建，不能把连续只读预检、重复性报告和安全验证无限叠加在关键路径上。**七阶段路线与既有用户已批准功能不删减；正式第二阶段仍未完成，不虚报进入第三阶段。**
- 启用两条互不冲突的工作流：A）第二阶段核心同步功能交付/批量测试，聚焦真实未满足验收项；B）2026-10-22 前的旧 VPS 服务迁移、Phosphene G2 独立隔离恢复。若并行 Codex/Chat，严禁双方同时改同一服务器配置或同一路径。
- Codex 后续一次领取一个成组、可测试的交付包；**先交运行成果、测试摘要、问题清单，少做重复预审**。每轮只记录变化、实际证据、关键阻塞、下一任务；历史审查保留链接即可，尽量避免追加重复叙述。只对真实数据风险、权限、生产部署、DNS 等高影响动作设置审批闸门。
- 第二阶段完成标准以真实协议/同步端到端、幂等去重、ACK/游标、掉线/重启恢复、双端权限及数据安全证据为准；可提前在隔离环境实施第三阶段所需的最小聊天界面/假模型端到端演示，但不得据此宣布第三阶段或生产环境完成。
- 最新 Phosphene G1 已完成并验收（见 [G1报告](reviews/2026-10-17-phosphene-g1-install-and-g2-readiness.md)）；下一步骤 G2 为隔离构建、迁移副本、断网启动及恢复测试。源码 SHA 来源校验已通过。用户此前授权 G1，不自动包含 G2 的真实数据副本启动。
- **优先协调**：一条任务指令包含本轮目标、变更边界、批量实施、测试、GitHub 提交；若遇未授权的生产变更再单独请示。预计工期按测后阻塞项重新评估，不再给无依据的“今天必完成”承诺。

## 2026-10-17 第二阶段核心集中收尾：隔离进程闭环通过

- [本轮精简验收表](reviews/2026-10-17-phase2-sync-core-acceptance.md)。未连接首尔/旧VPS；Phosphene G2仍待独立批准，第三阶段未启动。
- 先保护94份当前未提交源码/测试/包配置，另保留本轮文档改前副本；最终核对无计划外覆盖。未pull/reset/stash。只在原Windows源码及新合成夹具开发。
- **已修复**：同步409仅明确RESUME_REQUIRED可自动重试，永久流缺口/非法ACK/未知冲突安全blocked；限制冲突体16KiB，不记录正文；非对象JSON成功响应作为永久协议错误。原缺陷先复现失败后修复。
- **可运行成果**：Windows项目根 `npm run test:sync:e2e` 自动构建backend/local-agent，用编译app与代理CLI分进程、回环HTTP、文件SQLite、假模型验证7组场景；生产代码没有增加假模型开关。
- **实际证据**：COMMIT后ACK前强制结束代理并重放；同步HTTP断网时聊天继续；丢ACK响应后硬重启云进程保留设备/游标；旧归档水位拒绝；版本/软删除保原文；撤销使代理停止，新配对全流幂等追平。最终10原始消息、12事件、5假模型调用，双端ID/顺序/内容及事件哈希逐项相符，无重传重复模型调用。
- **批量测试**：四工作区typecheck/build通过；同步定向26/26；完整132项为131通过、0失败、1既有符号链接Win32=1314跳过；最终编译产物E2E独立1项通过（含7组连续场景，不并入132计数）。没有剩余本轮测试失败。
- **边界**：真实DB/备份/ACL/密钥未改，只有新合成夹具；未验证真实公网/物理断电/浏览器端或付费模型。清理仍关闭。源码改动及可运行测试仍在原未提交工作区，GitHub本轮只提交报告与状态，不能声称远程main已有完整第二阶段代码。
- 下一步：本次隔离核心阻塞已解决；Chat审阅后确定完整源码安全发布及真实存储权限、迁移/设备配对/公网链路验收的批量授权。阶段二总体仍待这些真实启用门槛，不把本轮通过宣称生产或第三阶段完成；不提前扩展记忆/自主活动/群聊/复杂UI/MCP。


## 2026-10-17 Phosphene G2 隔离恢复进展（用户终端截图佐证）
- 用户已批准 G2 并在首尔 VPS 手工执行：源码安全解包、派生镜像构建，终端输出 BUILD COMPLETE；创建 baseline/migration-copy/runtime-copy，隔离 network=none、PortBindings={}；迁移仅在 migration-copy 执行，复跑输出 migrations are up to date。
- runtime-copy 容器断网启动，短暂 starting 后达到 running/healthy，容器内 /healthz 返回 HTTP 200；之后按测试脚本停止。原数据 tar、Windows 备份、旧机、Nginx、DNS 均未作为本轮更改目标。
- 用户截图的初步只读核对：baseline/runtime SQLite integrity_check 都为 ok，表数量 21→21；uploads 4→4 且文件 SHA256 一致；两张表行数增加 338→341、213→215，**尚不清楚具体表及新增记录含义**。
- 后续截图：21张声明主键的表均比较，MISSING_HISTORICAL_KEYS=0、无跳过；相同 runtime 容器重新启动达到 running/healthy，停止后 SQLite integrity=ok、foreign_key_issues=0、历史附件4个字节摘要全一致，PERSISTENCE_CHECK_PASS。
- **阶段结论**：G2 技术性离线副本恢复/重启检查取得通过证据，但不能等同生产切换或业务历史全量验收：需解释两表+3/+2变动、确认用户历史账号和内容可读，且旧机后续写入必须在最终切换时做一致性增量/停写备份。实验容器结束后已停止，禁止直接外网暴露、自动重启或 DNS 切换。Phosphene 和小家正式第二阶段为不同工作线。

## 2026-10-17 Phosphene G2 新增记录定位（待解释）
- 用户在首尔实验 baseline 与 runtime-copy 之间只读比较确认：`audit_logs` 338→341（+3），`point_ledger` 213→215（+2）；脚本输出 `DIFF_CHECK_COMPLETE`。尚未核实新增行的业务来源，尤其积分流水可能影响业务余额/任务状态，不能仅凭主键未缺失/数量增长就判定无损或准许生产切换。
- 下一步优先静态代码审查 seed/reconcile/过期任务对这两表的写入条件，并在隔离副本只读核对新增行的类型/关联/时间（不要公布历史正文、用户名、令牌、地址）；必要时验证积分余额与流水聚合一致。不得清除这5行、修改 baseline 或回灌旧机。已完成的数据库完整性、附件和容器重启测试无需重复。

## 2026-10-17 Phosphene 最终备份恢复与断网启动（用户确认）
- 用户在旧上海 VPS 经 OrcaTerm 执行已批准停机和最终一致性备份，反馈成功；旧容器按脚本设置 restart=no 并停止。用户通过 Windows 将最终 tar.gz 与 sha256 上传首尔，反馈首尔 SHA 校验成功。
- 最新备份在首尔新建独立 phosphene-final-candidate baseline/runtime-copy，用户反馈 FINAL_CANDIDATE_READY（归档路径检查、SQLite完整性/外键、附件数量均通过）。
- 使用既有 phosphene-lab:isolated 镜像在 network=none、无映射端口、restart=no、仅新 runtime-copy bind 数据的环境中运行终验；用户反馈最终批次完成（预期健康200、原历史主键/附件、SQLite验证通过）。此处为用户反馈，未提供终端逐项截图，需以终验完整输出作为详细证据。
- 尚未完成：清理后循环任务/待办最终DB状态的独立核对；用户登录历史可读性确认；正式运行实例安全环境变量与访问通道/HTTPS；新旧数据终态比对及正式切换。**旧机保持停止，DNS/Nginx未授权更改，测试容器按脚本停止。**
- 避免再重复构建或重新迁移测试。下一步限定只读 introspection 确认任务系列和未完成任务状态；随后准备以最新baseline另开正式运行数据副本，避免直接拿已发生启动副作用的测试runtime-copy作为正式基线。

## 2026-10-17 Phosphene 循环任务禁用运行验收（用户反馈）
- 用户同意全部停用剩余4个循环系列，仅在首尔独立 deploy-copy 修改 active 1→0；用户确认 SQLite integrity=ok、foreign_key_issues=0。随后已创建并 SHA 校验 deploy-ready 独立压缩快照；原最终备份及 baseline 未覆盖。
- 基于 deploy-copy 复制 verification-copy，在 Docker network=none、无端口映射、restart=no 环境启动同一镜像。用户反馈 `TASK_DISABLE_RUNTIME_PASS` 及预期 HTTP200、AFTER_ACTIVE_SERIES=0、AFTER_PENDING_TASKS=0 等检查成功；测试容器按脚本已停止。这是用户终端结果反馈，非连接器直接实测。
- **下一阶段重点是私人实际登录验证和受控正式部署**，不再重新做已通过的迁移/任务统计。不得直接将 verification-copy 上线，不开放 webhook 出站，不擅自切 DNS/Nginx；如需可达的实例先核实环回端口及容器网络出站阻断，HTTPS Secure Cookie登录配置，必要敏感配置通过私人路径设置。旧VPS仍停机、原始备份保留。

## 2026-10-17 Phosphene 私人浏览器访问与原账号登录通过（用户确认）
- 首尔 `phosphene-private-live` 处于 Docker `network=none`，宿主 `nsenter` 进入该网络空间的内部 `/healthz` 返回200。用户通过仅本机转发 `127.0.0.1:18080` + Windows SSH `-L` 访问到了 Phosphene 登录页，并明确反馈使用原账号**登录成功**。
- 这证明私人网页通道及已有账号认证可用；仍待用户核对旧积分余额（此前界面报告8244）、历史任务/流水及附件是否在新机正常显示。登录成功**不等于**长期 HTTPS 入口、自动启动/转发服务、出站隔离及DNS切换已完成。
- 当前私人转发依赖临时终端/SSH连接，暂不要关闭直至用户查完历史；旧机停机，原始和deploy-ready备份均保留。下一步先进行用户业务数据目视验收，再提出长期安全入口方案；未经明确授权不变更Nginx/DNS/生产端口或重启策略。

## 2026-10-17 Phosphene 私人登录业务验收
- 用户已在新服务器私有浏览器通道使用原账号登录，并确认积分余额、历史任务、积分流水与附件均正确。结合既有数据库、附件及重启检查，本次数据恢复与私人登录验收通过。
- 后续仍需长期访问、服务重启与正式入口方案；现有连接依赖临时终端，尚未切换域名。旧服务器与备份继续保留，未经批准不扩大公网开放范围。

## 2026-10-17 Phosphene 搬迁目标与退役方向（用户确认）
- 用户明确希望 Phosphene **先完整搬迁并维持原有的手机和电脑访问能力**，不是仅在 Windows SSH 隧道中可用；首尔已有数据恢复与私人登录业务验收，但长期 HTTPS/手机公网访问尚未实施。
- Phosphene 暂作为独立服务保留；后续研究其 AI 任务、循环安排、积分流水及交互机制，择优在小家内重新设计实现，等小家替代能力成熟、历史数据保存妥善后再停用 Phosphene。**目前不授权开发移植机制，也不授权删除 Phosphene**。
- 推荐未来用独立子域名 `phos.sakiehome.icu`，主域名留给小家；这是待用户确认的域名方案，**不得视为已批准 DNS/Nginx/TLS 变更**。
- 下一执行批次应在明确批准后配置有持续运行保障的隔离实例、安全出站规则、HTTPS/手机及桌面访问、重启恢复和备份，验证通过前旧 VPS 备份继续保留；不可把当前临时 nsenter/SSH 通道视为最终上线。

## 2026-10-17 Phosphene HTTPS 手机公网登录成功（用户确认）
- `phos.sakiehome.icu` 指向首尔 VPS，新 Nginx 站点与 TLS 证书已存在；截图显示 Nginx、phosphene-relay 均 active，首尔本机域名 SNI HTTPS `/healthz` HTTP200。
- 用户随后用手机访问正式 HTTPS 地址，使用原账号登录成功并表示没有问题。这意味着手机号外网浏览器的实际访问/认证链路已通过用户验收。
- **尚待收尾**：容器自动重启配置（此前 `restart=no`）、转发服务在容器重建/重启后的命名空间重新绑定及 systemd 启动顺序、certbot 自动续签定时器及 dry-run、服务重启验收与备份可恢复性。无需再重复数据库迁移/登录历史验收；旧机数据与 Windows/首尔备份继续保留，不要自动删除或改变主域名解析。

## 2026-10-17 Phosphene 容器重启自动恢复通过（用户确认）
- 之前一次容器重启出现 relay 绑定旧命名空间，手动重启 relay 才恢复。已按后续方案更新 relay 为每个新连接获取当前容器网络命名空间；截图确认服务 active/enabled、127.0.0.1:18080 正常监听、容器 running/healthy。
- 用户执行新版容器重启等待脚本后报告成功，按脚本成功条件应为 `AUTOMATIC_RECOVERY_PASS`；不需要再人工重启 relay。手机正式 HTTPS 登录和证书续签 dry-run 此前均反馈成功。
- 尚未验证**整台 VPS 断电/重启**后的服务恢复；应先只读检查 Docker、relay、nginx、certbot 定时器和依赖顺序，取得用户单独同意后才进行整机重启演练。旧上海 VPS 及备份保留，小家主域名 DNS 不变。
