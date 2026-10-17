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

