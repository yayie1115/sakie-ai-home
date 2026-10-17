# Phosphene：G1安装结果与G2只读准备交付

日期：2026-10-17（北京时间）。正式第二阶段进行中；本轮为旧VPS到期前并行迁移准备，不是第三阶段，也没有开发MCP接入。

基线：[安装/恢复事前方案](2026-10-17-phosphene-isolated-deployment-preflight.md)。用户在本轮明确回复“授权执行G1”；G1技术审查通过并不代替该授权。G2仅获只读准备权限，未执行构建、解包、迁移或历史副本启动。

## 1. 结论

- **G1已安装并验证通过**：官方APT仓库，固定版本、仅5个新包、无现有包升级/移除；原Nginx配置与HTTPS测试页保持一致；没有Phosphene容器/镜像或应用公网端口。
- **源码独立SHA256来源校验已补齐**：用户明确确认摘要来自旧机OrcaTerm实际sha256sum输出，与首尔原源码包再次计算结果一致。
- **G2 migration-only与网络隔离步骤已审阅，但未构建或实测**。先迁移-only新副本、后断网新副本启动，仍需后续批准；不能把G1通过写成历史恢复验收通过。
- Windows未提交源码、真实数据库、备份及ACL没有改变；旧机Phosphene/AruHost、现有Nginx站点和DNS未操作。

## 2. G1执行顺序和安装证据

没有重复此前归档完整性/清单预检。安装前只补充本次变更必需的审计基线：包版本/服务、选定Nginx配置指纹、测试页内容、监听、路由/地址、IPv4/IPv6防火墙及当前用户组。私人原始审计存放在新机/home/ubuntu/phosphene-g1-audit/20261017T065723Z，不上传GitHub。

执行：

1. 用现有sakie、严格host key校验连接；sudo仅用于已批准安装/网络审计范围。
2. 下载官方Docker仓库签名key，核验主指纹9DC858229FC7DD38854AE2D88D81803C0EBFCD88；添加/etc/apt/keyrings/docker.asc及/etc/apt/sources.list.d/docker.sources（noble/stable/amd64）。没有安装便利脚本或替换Ubuntu系统源。
3. APT update后审阅固定候选版本和模拟清单：**0 upgraded、5 newly installed、0 to remove、0 not upgraded**。推荐的rootless-extras/pigz未装；APT提示的autoremove没有执行。
4. 真实安装前再次模拟并断言只有这5包；安装使用no-install-recommends/no-upgrade/no-remove，不允许隐式升级/移除。needrestart设为仅列出，未借安装重启其他服务。
5. 安装返回0；对前后完整dpkg已安装清单比较，新增恰为5包、版本变化0、移除0。

| 包 | 实际安装版本 |
| --- | --- |
| docker-ce | 5:29.9.1-1~ubuntu.24.04~noble |
| docker-ce-cli | 5:29.9.1-1~ubuntu.24.04~noble |
| containerd.io | 2.4.2-2~ubuntu.24.04~noble |
| docker-buildx-plugin | 0.38.0-1~ubuntu.24.04~noble |
| docker-compose-plugin | 5.6.0-1~ubuntu.24.04~noble |

Docker Engine客户端/服务端均29.9.1，Compose v5.6.0，Buildx v0.38.0。镜像存储驱动报告overlayfs，cgroup driver=systemd。实际候选来自安装时官方仓库，本文不要求以后盲目重复“最新版安装”。

过程格式问题如实记录：首次模拟封装末尾PY未正确终止导致NameError，未触发安装；改用直接Python stdin重新检查模拟并通过。安装后的shell验证在全部检查结束后遇末尾CR格式报错，已用独立Python断言重新验证包、组、监听、路由、防火墙及页面一致性，最终返回0和G1_VERIFICATION_PASS。没有由此卸载、重装、扩大权限或忽略真实服务失败。

## 3. G1服务、权限、网络及站点验收

| 项目 | 实测结果 |
| --- | --- |
| 服务 | nginx、docker、containerd、docker.socket均active；Nginx仍enabled，Docker相关新服务/套接字按包安装行为enabled |
| socket | /var/run/docker.sock为Unix socket，660 root:docker；没有TCP监听配置或2375/2376监听 |
| 用户组 | 当前运行用户id -nG安装前后完全一致，未把任何用户加docker组、未修改sudoers；软件包创建的docker组/Unix socket不等于授予普通账户Docker权限 |
| 容器/镜像 | Docker info显示Containers=0、Running=0、Images=0；未拉hello-world或Phosphene镜像，未启动应用 |
| 应用端口 | 无18080、3000或8080监听；监听仍仅22/53/80/443，80/443进程归属Nginx |
| 原Nginx配置 | 两个原站点文件SHA核验通过；未编辑/覆盖/reload站点 |
| HTTP/HTTPS | 安装前后本机HTTP均200；按sakiehome.icu正确SNI和系统信任验证的HTTPS均200，页面响应体字节一致 |
| 公网定向TLS | Windows curl --resolve定向首尔IP访问sakiehome.icu返回200，TLS验证通过；不是DNS切换后验收 |
| 资源 | 安装后快照available3073MiB、swap使用0；不是Phosphene构建/应用实耗或性能保证 |

### 网络实际变化（不能宣称系统网络未变）

- 新增Docker默认bridge/host/none网络；bridge子网172.17.0.0/16，与安装前已记录非默认路由无重叠。
- IPv4新增DOCKER、DOCKER-BRIDGE、DOCKER-CT、DOCKER-FORWARD、DOCKER-INTERNAL、DOCKER-USER链；**filter FORWARD默认策略由ACCEPT变为DROP**，INPUT/OUTPUT仍ACCEPT。另有Docker NAT链/挂钩。
- IPv6亦新增对应Docker链和表结构；本轮所见IPv6 filter默认策略ACCEPT。
- 以上为Docker初始化变化，基线/结果私下留存；未人为清空规则、关闭防火墙或全表回灌。宿主HTTP/HTTPS已验证正常，但没有证明所有未来转发型业务兼容，未来引入VPN/其他桥接服务应单独检查。

[官方安装说明](https://docs.docker.com/engine/install/ubuntu/)说明Docker会涉及防火墙及daemon；本轮采用官方APT方案，不设置全局Docker日志/资源参数去影响未来其他项目。

其他落盘：官方源及key、APT缓存/安装日志、Docker/containerd默认数据/服务文件与私人审计；GPG检查也初始化了用户的.gnupg目录。未删除这些证据，没有假称只有5个二进制文件发生变化。

## 4. G2独立源码来源校验：已通过

用户提供并进一步明确确认来源为**旧VPS的OrcaTerm实际命令输出**：

~~~text
870154a855b8ae5de63b59be027eebc3d63d6f97695f1c29af747f11b71378ce
~~~

对首尔/home/ubuntu/phosphene-migration/phosphene-source-export.tar.gz只读重新计算摘要，匹配，私人审计记录证据来源和比对结果。没有在首尔伪造“独立来源”校验文件，没有改原包；旧机路径/身份未暴露，未建立旧机新SSH连接。

此项证明用户提供的旧机导出包与首尔包一致，不保证旧机源码自身无缺陷或包完整对应当时运行镜像。上一轮归档路径、gzip和数据包SHA证据沿用，没有重跑全套预检；SQLite完整性、历史账本及附件引用仍未恢复验证。

## 5. migration-only编译入口：审查结果与精确派生稿

新增只读审查确认：src/server/db/migrate-cli.ts仅导入./client并await initializeDatabase、shutdownDatabase；client依赖文件系统/path/URL、libsql、Drizzle migrator、config和schema。schema依赖shared/constants，config依赖的mcp-connection模块无外部导入；检查未见这些入口调用Webhook、seed、reconcile或孤立附件清理。

这只是静态证据，不宣称已经验证全部运行副作用。initializeDatabase仍会建目录、开库、启用WAL/NORMAL并执行真实迁移，必须只指向新的migration-copy。

### 派生Dockerfile建议（未写入源码、未构建）

在未来新建source副本生成独立Dockerfile.lab，只替换唯一一处原构建语句，保留原归档不变：

~~~diff
-RUN pnpm build && pnpm prune --prod
+RUN pnpm build \
+    && pnpm exec esbuild src/server/db/migrate-cli.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/server/migrate-cli.js --packages=external \
+    && pnpm prune --prod
~~~

理由：当前运行镜像只COPY dist，原build只生成index/stdio；迁移脚本用tsx而dev依赖将被prune。必须在prune前用原esbuild0.25.8编译迁移入口，沿用现有bundling选项，dist拷贝自然带入它，不能安装tsx到运行容器后临时执行源码。

执行前检查派生差异严格限这一处，编译成功、产物存在；运行命令覆盖为node dist/server/migrate-cli.js，保留tini/降权entrypoint，关闭该一次性迁移服务的HTTP healthcheck，restart=no，network_mode=none，仅挂migration-copy:/data。不能误执行默认index.js或因迁移job没有HTTP而自动拉起完整应用。

先确认恢复复制的真实UID/GID及每个文件可写，entrypoint仅chown根目录，不会自动修好全部文件；权限操作仅限新夹具另批范围，不能chmod/chown原tar或Windows目录。

## 6. 阻断历史Webhook：以none网络为硬边界

G2首次迁移和完整应用副本启动统一采用Docker **network_mode:none**，不映射端口、不加入其他网络。不是仅靠localhost绑定、环境变量或MCP token模式。

实际启动前的门槛：

1. 镜像构建阶段允许依赖下载，但不挂历史目录、秘密或审计；运行阶段才挂新候选，两个阶段的配置严格分离。
2. 建立新容器但启动前核对HostConfig.NetworkMode=none、无PortBindings、无host网络/privileged、无宿主socket/设备/其他服务目录挂载；容器只具有自身loopback，无公网/宿主/其他容器可达的网络接口。
3. 用无历史数据的合成探针按相同配置验证无非loopback接口/默认路由、外部连接失败；只通过docker exec进行容器内127.0.0.1 healthz，不为浏览器访问提前切桥接网络。
4. 历史Webhook worker即使读取旧任务，也无法出站。它仍可能claim/失败/退避并修改runtime-copy，因此保留不可变baseline，不把副本运行后的Webhook状态回灌旧机或用于正式切换。
5. 不通过删除Webhook表、清空任务、禁用鉴权、改旧机配置来绕过风险；不启动stdio桥或MCP调用。

**尚未执行上述探针或启动任何副本**，不能把none网络设计写成已经完成真实阻断验收。G1仅验证daemon与默认网络，没有创建实验网络/容器。

若后续需要UI，最小安全顺序是先完成none网络中的迁移/历史一致性/完整启动检查，再单独审阅能回环访问且确证不能外发的网络或私有TLS方式。当前G2稿不强行启用internal bridge；不能为提供浏览器地址牺牲Webhook出站阻断。production Secure Cookie也不能通过改development或关闭CSRF绕过。

## 7. 副本恢复执行清单（仅审阅，需后续批准）

1. 新建唯一run-id工作根：source、evidence、baseline、migration-copy、runtime-copy。路径不得命中原上传目录、旧数据源或小家存储。源码/数据各按上一轮安全清单提取，忽略归档Owner，不覆盖已存在目标。
2. 原tar/sha256保持不变；数据顶层phosphene-data正确展开，/data/phosphene.sqlite及/data/uploads映射到候选内容，不能多套目录。baseline只读留存文件摘要和旧库证据，不启动应用。
3. 在新副本核验SQLite integrity_check、foreign_key_check、真实迁移账本、关键历史表/ID及附件引用；不在公共报告输出正文、密码哈希、Token摘要或私密Webhook地址。不把tar格式当成应用ZIP恢复接口输入。
4. migration-copy只跑第5节入口；必须退出0、账本符合5份源码SQL，旧记录/主键保留；重复执行无重复迁移，失败保留现场，不启完整应用“修复”。
5. 再新建runtime-copy，明确允许其发生种子/过期任务/孤立附件清理及Webhook失败状态变化；network=none下完整启动，逐项审阅差异。出现首次setup、历史缺失、附件不明删除或迁移错误立即停止，不重设账号。
6. 容器内health200仅是进程检查；历史可用性需独立DB/文件证据及用户私人核对。没有可用登录验证时明确未验，不索取聊天中的真实密码。
7. restart=no，显式stop/start及受控重建后验证同一个候选bind、关键ID/附件摘要和账本；合法时间驱动变化记录解释，不要求全表字节绝对不变。不down -v，不删除候选/证据，不写回原始备份。
8. 新机成功也不触发旧机停用/DNS切换；旧机若继续有新写，备份之后的增量仍需最终短维护窗口另审，不把旧备份恢复成功当成切换数据已追平。

未解包、未执行迁移工具、未查真实恢复库、未运行构建或登录验收；不把这份清单写为已通过测试。

## 8. 停止条件、回滚与剩余风险

本次安装没有触发非预期包移除/升级、路由重叠、宿主站点故障或Docker服务失败，故没有执行回滚。所有本轮已批准变更有私人前后证据。

若后续要求回滚G1，先确认Docker是否已承载其他新服务，再单独审批停止docker/socket/containerd与移除本次5包及专属源/key；不autoremove、不删除/var/lib/docker、/var/lib/containerd或审计/原包，不把iptables-save整表覆盖回去。FORWARD策略与Docker链需受控逐项复核，不能承诺卸包后自动还原。

剩余事项：

- G2派生编译/原生模块/镜像拉取尚未实测；上一轮缺测试/模板及旧校验断言不一致问题仍在，不能声称全套pnpm check通过。
- 历史DB迁移、附件一致性、登录及重启持久性未验；当前没有任何恢复后业务数据可用的结论。
- 对外站点和自动续签不在本轮部署范围；G1的定向TLS200不是正式DNS切换验收。
- Docker rootful维护权限风险存在，运行账户未加docker组，API只Unix；后续不把挂Docker socket作为方便措施。

## 9. 提交与下一步

本轮仅提交本文与PROJECT-STATUS增量，保留并发文档更新。未提交Windows第二阶段业务代码；原工作区未pull覆盖。

等待Chat审核本次G1证据，并对G2派生编译、合成网络探针、新夹具副本恢复/启动及其限定副作用另行批准。在此之前保持Docker空闲，不启动历史副本、不碰旧机。正式第二阶段仍进行中。
