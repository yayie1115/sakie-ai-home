# Phosphene 首尔隔离部署与恢复：事前核验及批量审批方案

日期：2026-10-17（北京时间）。工程仍在正式第二阶段；Phosphene是旧VPS到期前并行服务搬迁，不代表第三阶段开始，也不是MCP接入开发。

## 1. 本轮结论与边界

**已完成只读检查与方案准备，未完成安装、构建或历史恢复验收。** 新机可用于隔离预演，但必须先批准下列变更闸门。发现两个需要重点审阅的问题：源码包未随附独立校验文件；应用正常启动会自动修改恢复副本并启动Webhook，不能把“启动看看”当作只读恢复验证。

先通过GitHub连接器读取main的docs/PROJECT-STATUS.md，承接其中旧机OrcaTerm、历史数据保全、源码打包及新机接收的记录；没有再尝试连接旧机或要求用户为旧机配置SSH。新机通过既有sakie别名、已验证host key、普通SSH账户只读检查，未使用sudo。

未安装/卸载软件，未更新APT缓存，未改变Docker/系统服务、Nginx、DNS、ACL或Windows数据。没有创建新机工作目录、解包、运行源码、开SQLite、启动应用、读取.env/私钥/历史内容或传出真实数据。只写脱敏报告并更新GitHub共同状态。旧机Phosphene、AruHost、原备份均未触碰。

历史记录中“尚未生成备份/尚未离机”等是早期状态；用户和最新共同状态已确认旧机Phosphene恢复healthy、Windows离机副本SHA匹配，新机数据归档SHA匹配。本轮重新验证的是新机现有归档，不把上述用户证据冒称本轮旧机实测。

## 2. 主机与现存服务：本轮实测

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| 系统/架构 | Ubuntu24.04、amd64 | 符合官方Docker Engine支持范围 |
| 资源快照 | 内存total3659MiB、available3145MiB；swap1987MiB、used0；根盘59G、可用约50G、13%使用 | 不是构建或应用RSS/CPU实耗；并行编译前需保留宿主余量 |
| 监听端口 | 22/80/443及回环DNS；选定18080未监听 | 隔离端口拟127.0.0.1:18080；不碰80/443，不增加公网入口 |
| Nginx | active/enabled；原sakie-test、sakie-https链接仍在 | 不覆盖、不reload、不更改测试站 |
| Docker/containerd | unit inactive，PATH未找到docker/containerd/runc；dpkg查询未发现所查Docker系列包记录 | 没有先卸载任何包；安装前仍需完整APT模拟依赖审阅 |
| 安装工具 | curl/gpg/apt-get/python3存在 | 未执行下载脚本、APT update或安装 |
| 现有配置/存储 | 未发现所查/etc/docker、/var/lib/docker、/var/lib/containerd、Docker源/key路径 | 检查仅限这些路径，不是全盘服务穷尽证明 |
| 上传区 | /home/ubuntu/phosphene-migration为700，3个文件均600 | 不更改权限、不生成校验副本、不解包到此目录 |

Docker安装会新增daemon、socket、containerd、桥接网络/防火墙规则及存储目录，可能在安装阶段自动启动服务。它不是“只有命令行工具”的无影响操作；需要G1批准。宿主Nginx继续独占80/443，Phosphene本轮不做域名接入。

## 3. 归档完整性与路径安全

### 3.1 数据包

phosphene-20261017T055917Z.tar.gz：1647674字节；对应.sha256存在。本轮从校验文件只提取64位摘要，在内存计算实际摘要并比较，**匹配**；没有因校验文件旧绝对路径而改写原文件。

- gzip完整读取到EOF/CRC通过；tar共11对象：6目录、5普通文件，总普通文件载荷2137324字节。
- 单一顶层phosphene-data；预期phosphene-data/phosphene.sqlite存在，uploads下4个文件，扩展名均webp。
- 未发现绝对/上跳/反斜杠/盘符路径、规范化重复路径、软/硬链接或特殊设备对象；未见异常PAX键。没有WAL/SHM条目。
- WAL缺席与用户此前停写tar流程相容，但**不证明数据库已checkpoint、迁移兼容或历史完整**；这些只能在新副本恢复后验收。
- 没有读取DB页/账户记录、图片正文或打印私人文件名。原tar/sha256保留原样，前后归档摘要未变化。

### 3.2 源码包

phosphene-source-export.tar.gz：831185字节；77对象（65文件、12目录），普通文件载荷1493422字节；gzip CRC与上述路径/类型检查通过。归档本身**没有**配套phosphene-source-export.tar.gz.sha256，上传区实际只有3文件。

本轮计算了本机源码SHA256，未把它当作独立来源认证。最少补充动作是由用户在旧机已有OrcaTerm对原源码包执行sha256sum并提供摘要，或安全补传对应校验文件；不要重传.env。此项阻塞“来源已验证”的构建批准，但不阻止先审G1安装。

源码包含Dockerfile、entrypoint、Compose、package/锁文件、配置、前后端、构建脚本、5份SQL及Drizzle journal、public资源。相对导入的静态检查未见缺失目标；未发现.env、node_modules、.git、数据库、私钥路径；限定源码常见私钥/Token签名扫描无匹配。**这是有限检查，不是证明整个源码绝无任何秘密。** 未复制源码或数据到公共GitHub。

## 4. 实际构建链与环境条件

### 4.1 构建与运行

源码证据：Dockerfile:1—10、12—37；package.json scripts/dependencies；pnpm-workspace.yaml；src/server/config.ts、db/client.ts、lib/deployment.ts、index.ts。

- Node镜像实际是docker.m.daocloud.io/library/node:24.14.0-bookworm-slim，双阶段；pnpm@10.13.1，锁文件v9，pnpm install --frozen-lockfile → pnpm build → pnpm prune --prod。
- 前端Vite输出dist/web；后端esbuild输出dist/server/index.js和stdio-bridge.js。运行CMD限定V8 old-space128MB、semi-space4MB，**不是总RSS上限**。
- 运行镜像另装ca-certificates/gosu/tini；entrypoint起始可能为root，仅对DATA_DIR根chown，然后gosu降到node。它不递归修复所有恢复文件的所有权；需在新副本上单独核对实际UID/GID和各文件可写性。
- 依赖含@libsql/client、Drizzle、argon2、sharp等；pnpm允许argon2/esbuild/sharp构建脚本，需验证amd64预编译包/本地编译可用性。不能把存在锁文件当构建已通过。
- 构建要访问镜像代理、包注册源和Debian源。镜像是标签而非digest，后续记录真实digest；若代理不可用，停止并审阅是否改为对应官方同版本镜像，不擅自切latest或其他版本。
- 运行只需本地/data，未见必须引入外部数据库/Redis的配置。本轮不启动stdio桥、不做MCP开发或接入。

### 4.2 导出包的已知缺口

1. 源码未带原.env，符合保密要求；没有独立源码校验文件。运行值需另行私下配置，不能在聊天提供正文。
2. 未导出tests及docs/DEPLOYMENT.md、docs/BACKUP.md；validate-deployment.mjs依赖的zeabur-template.yaml也缺失。
3. validate-deployment脚本要求Compose含命名卷phosphene-data:/data，而导出Compose实际使用宿主bind；即使补模板，该断言也与现部署不一致。
4. 因此不能运行pnpm check后声称原项目全套验证通过；后续隔离构建应报告实际build/typecheck/定向恢复验证结果，缺失测试明确未验，不删断言来“变绿”。这些不一定阻断现有Dockerfile构建，但构建成败仍未实测。

### 4.3 需要明确的环境配置（只列名称与非秘密值）

| 配置 | 隔离预演建议/实际边界 |
| --- | --- |
| NODE_ENV/PORT | production/8080，保持生产认证语义；不为绕过Cookie改development |
| PUBLIC_URL | 原Compose有旧机地址默认值，必须隔离覆盖；内部阶段按实测访问拓扑设定，不能无意指回旧机 |
| PHOSPHENE_DATA_DIR | /data；SQLITE_PATH=/data/phosphene.sqlite、LOCAL_STORAGE_PATH=/data/uploads可显式固定 |
| PHOSPHENE_SETUP_TOKEN | 配置可空而非启动必填；安全上隔离预演仍需私下设置保护值或确认既有initialized状态；不显示/索取其正文，不给历史库重新setup |
| PHOSPHENE_MCP_AUTH_MODE | 保持token模式，不用none；它并不禁用Webhook；无需新建MCP接入凭据 |
| LOG_LEVEL | 先warn或error，仍需限制/脱敏日志；不能保证低日志级别就绝无私人错误信息 |
| ZEABUR_WEB_URL | 可选部署回退，非本机必需；不得依赖旧机回退值 |
| PHOSPHENE_MCP_URL/TOKEN | 属可选stdio桥环境，不是本轮恢复所需；不迁移/启动桥 |

旧.env的缺席不意味着无法恢复登录：既有账号验证信息可能在历史SQLite中，尚未打开确认。若启动显示首次setup或旧历史不可见，必须停在副本故障，不重设账户/导入空数据来伪造通过。

## 5. 恢复的核心风险：启动不只是迁移

实际src/server/index.ts:153—158在listen前依次调用initializeDatabase、initializeStorage、pruneOrphanedProofFiles、seedDatabase、reconcileSystem，之后启动Webhook worker（190）。

| 副作用 | 代码证据 | 隔离要求 |
| --- | --- | --- |
| 自动Drizzle迁移 | db/client.ts:26—34，WAL、synchronous=NORMAL；journal含0000—0004且SQL均在 | 只在新可写副本执行；先记录真实旧账本，不假定5项已应用；NORMAL不等于小家FULL耐久保证 |
| 临时文件/孤立附件清理 | storage.ts:46—99按规则清tmp备份文件、无DB引用proof目录 | 首次启动前保留完整只读文件指纹；任何删除必须能解释并留证，不能让仅存原件受影响 |
| 种子更新 | db/seed.ts多处insert/update、ANALYZE | 不能把启动前后全表哈希必相等当唯一标准；保留历史核心数据并逐项解释合法新增/更新 |
| 时钟驱动任务处理 | domain.ts含过期任务、处罚/统计重整 | 当前日期可使备份里的未完成任务过期，需G2明确批准“仅在副本允许这些变化”，不得回灌旧机 |
| Webhook自动投递 | index.ts启动；worker约2秒轮询并fetch | 历史配置/待投递项可能导致重复外发；必须首次启动前从网络层隔断出站，不能只关闭MCP认证或只绑回环 |

本轮不读取历史Webhook地址或签名秘密。是否存在待投递项尚未知；按“可能存在”设计。不得用删除历史待办/清空Webhook表的方式规避。

## 6. 批量审批闸门G1：Docker Engine + Compose最小安装

**未执行，等待Chat/用户明确批准。** 推荐官方APT仓库路线，不使用curl|sh；Ubuntu24.04/amd64已核实。

批准范围应一次包含：

1. 记录当前APT包/服务/网络基线；只增加Docker专属keyring和source文件，若路径已有内容先停审。必要时安装ca-certificates/curl。
2. APT update后列候选版本，运行apt-get模拟安装，审查移除/升级清单，选定稳定版本并记录；若要移除既有运行时或影响Nginx/其他服务，停止重新审查。
3. 安装docker-ce、docker-ce-cli、containerd.io、docker-buildx-plugin、docker-compose-plugin及模拟清单内必要依赖。承认其包脚本可能自动创建/启动docker.service、docker.socket、containerd和桥接/iptables规则。
4. 不把ubuntu加入docker组，不修改sudoers/SSH，不将Docker socket暴露TCP；需要的维护命令只在本次获批范围内使用sudo。docker组相当于root权限，不能当普通无风险授权。
5. 验证Engine/Compose版本、daemon/socket、宿主80/443仍由Nginx监听、原测试页及证书路径未变；安装本身不开放Phosphene端口。hello-world拉取/运行若包含在批准范围内才执行。

安装停止条件：官方源签名/网络失败、APT非预期移除升级、资源不足、daemon异常、原站点受影响、端口/防火墙边界无法证明。不要自动删包或重装到成功。

回滚稿：停止本次新建的实验容器；只停止/禁用本次新装且基线无依赖的Docker/socket/containerd；按安装记录卸载本次包及Docker专属源/key文件，恢复原先enabled状态。**不autoremove、不清空/var/lib/docker或containerd、不删除持久数据/归档，不覆盖防火墙全表**；防火墙差异需逐项核对，无法确认时停止留证。回滚不承诺所有内核/网络状态自动完全还原，安装前必须记录基线。

参考（本轮查阅）：[Docker Ubuntu安装](https://docs.docker.com/engine/install/ubuntu/)、[Docker权限与开机行为](https://docs.docker.com/engine/install/linux-postinstall/)。官方说明发布端口可能绕过部分宿主防火墙规则，因此不能只依赖UFW而映射0.0.0.0。

## 7. 批量审批闸门G2：隔离构建与副本恢复验收

**未执行，不因G1通过而自动开始。** 批准对象须限定新建独立工作根，例如/home/ubuntu/phosphene-lab/<唯一run-id>，不得指向旧机或任何既有/data源。原上传区只读使用，不chmod/chown或覆盖原tar/sha。

### 7.1 构建与目录边界

- 源码来源摘要先补齐；批准后安全解包到不存在的source目录，只接受已查普通文件/目录，再做逐项清单/类型复核。不按tar里的Owner恢复权限，不跟随链接，不使用通配rm或直接整树覆盖。
- 布局：source（仅程序）、evidence（私人审计）、baseline（完整恢复只读基线）、migration-copy（迁移演练）、runtime-copy（完整启动演练），再独立创建Compose配置/秘密文件。实际Owner及最小访问权仅在新夹具批准范围内设置，绝不触碰真实Windows ACL。
- baseline先从原tar还原为phosphene-data，再映射其内容到新/data，不能误多套一层/data/phosphene-data。原归档始终不挂成可写卷。建立全文件摘要和SQLite readonly integrity/foreign_key/旧账本及关键历史统计，私人证据不含密钥值/正文。
- 构建上下文只指source，不包含整个phosphene-migration或lab根；补充实验用.dockerignore排除.env.*、所有data/baseline/copy/evidence、归档及身份文件。源码内原.dockerignore只排.env，不能替代完整实验边界。
- 使用独立Compose项目名phosphene-lab-<run-id>和独立镜像标签，不直接运行原Compose（其3000公网映射和旧机bind不可复用）。不挂Docker socket，不用privileged/host网络，不共享宿主服务配置。先restart=no，有限日志/内存/PID/CPU，待实测调整；不配置开机自启。
- 构建阶段允许必要下载但不挂历史数据/秘密；记录镜像摘要、依赖安装及原生模块结果，串行构建，内存不足即停，不改全局Docker/Nginx设置。

### 7.2 迁移和全启动分开验收

1. 原样baseline不启动Phosphene，不在其中执行migration；记录其指纹之后只读留存。
2. migration-copy只运行相同源码的db/migrate-cli.ts，不能走index.ts的清理/seed/reconcile。**当前运行镜像没有这个编译入口**（构建只输出index/stdio），prune后也不能假定有tsx。实际执行前须审阅隔离迁移工具方案：例如仅在实验构建派生稿中，将现有migrate-cli.ts额外打包到dist并记录差异。不能改原归档，也不能自写一套SQL假装等价Drizzle。
3. 在断网新副本记录迁移结果：迁移账本连续/与源码吻合，integrity_check=ok、外键无违规、旧主键/关键历史值保留、附件路径存在及字节摘要一致；重复迁移不新增账本/改历史。失败仅保留候选和错误，重新建全新副本，不回写baseline或旧机。
4. runtime-copy必须由验证过的基线/迁移副本另建，明示允许第5节的启动副作用，仅测试数据副本承受这些变化。首次用network_mode:none、不映射任何宿主端口，容器内loopback /healthz和docker exec只读核验；既阻断Webhook，也避免原有配置外发。
5. full startup后逐项分类附件清理/种子/过期任务等变化；不能只见healthy就通过。任何核心历史丢失、附件删除不明、意外setup、迁移错误即停止，保留证据和副本。
6. 需要浏览器查看时再审阅实验内部桥接网络与仅127.0.0.1:18080:8080的映射。internal network不应被当成绝对防外发证明：先验证容器无法访问公网、宿主敏感地址、其他容器和真实Webhook目标，再启动有历史配置的应用。出站无法证明阻断时保留network_mode:none，以容器内检查代替，不冒险放行。
7. 浏览器经SSH本地转发访问，不改DNS/Nginx。生产Cookie带Secure，单纯HTTP隧道不保证所有浏览器登录成功；若遇限制，另审实验私有TLS方案或用户在私人终端的容器内认证核验，不降级production、不关闭CSRF、不在聊天贴密码/Cookie。公网/正式域名登录不是本轮验收。
8. 用已配置的历史登录方式由用户自行核对历史列表、统计和4个附件；脱敏报告只记录通过/未通过和差异类别。不要调用setup、密码重置、Token轮换或MCP接口来绕过登录。/healthz只说明进程可响应，不能证明数据完整。
9. 显式stop/start再重复核验同一bind数据、关键ID/附件摘要；迁移账本不重复，合法启动变化可解释，挂载路径仍独立。必要时重建容器再验证，**不down -v，不清卷，不启动旧机同步**。V8限制不等于容器内存峰值，记录RSS/CPU/磁盘/健康结果。

### 7.3 恢复失败与实验回退

任何失败先停止本实验容器，不自动重启到“成功”，保留原tar、baseline及失败副本/私人证据。诊断不粘贴完整数据库、日志、环境或秘密到GitHub。不能拿已被reconcile改过的副本当成可信新原始基线。

实验回退仅撤销本次实验容器/实验网络/发布端口和获批运行状态；不删除数据目录、镜像或证据，不改旧机、AruHost、Nginx、DNS。决定重试时另建run-id，先说明差异。不因新机恢复通过而自动停旧机或宣布其可退役。

## 8. 通过标准与本轮状态

| 验收项 | 本轮状态 | 下轮必须有的证据 |
| --- | --- | --- |
| 最新共同状态及阶段边界 | 已读取承接 | 第二阶段进行中；无MCP开发 |
| 系统/服务/端口/包只读核验 | 已验证 | G1后重新核对原站点与网络 |
| 数据SHA、gzip、tar路径 | 已验证 | 仍需恢复后SQLite/历史/附件验证 |
| 源码gzip、路径、导入/迁移文件存在 | 已验证 | 来源独立SHA待补；依赖安装/镜像构建未测 |
| Docker安装 | 未执行、待G1 | 版本、包变更、daemon/网络基线和回滚记录 |
| 隔离目录、迁移工具与恢复 | 仅设计、待G2 | baseline指纹、无出站副本迁移及合法差异 |
| 历史可读与持久性 | 未验证 | 用户私人核对、重启/重建后的ID/附件一致 |
| Nginx/DNS/旧服务/AruHost | 未变更 | 本轮不申请这类动作 |
| 原项目测试 | 本轮未运行 | 导出包测试资产不全，不能声称全回归通过 |

## 9. 提交给Chat的最少决定

- **G1**：是否批准官方APT Docker/Compose专属安装、必要daemon/socket/containerd启动及可审计网络变更，限第6节范围和停止/回滚条件；不改Nginx、不加docker组。
- **G2**：先补源码独立摘要并审阅迁移-only入口派生稿，再批准新夹具解包/构建/副本迁移及断网全启动；明确允许副本的seed/过期任务/附件清理变化但禁止外发，不回灌旧机。
- 历史账号凭据由用户保留并私下输入；无需在聊天提交原.env或密钥。本轮不要求用户逐条批准每条命令，也不把安装批准扩展为恢复/公网切换批准。

等待上述审核；当前目标尚未完成隔离部署或恢复验证。旧VPS10月22日到期前的服务切换另行分批授权，不能因本轮检查通过自动执行。
