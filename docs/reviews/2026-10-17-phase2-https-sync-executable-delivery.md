# Part 2 HTTPS 同步：可执行包与授权闸门

2026-10-17。已读取 main 最新共同状态；本轮只提交此脱敏报告，不上传业务源码或部署包。

## 实际交付

- 修改前保护 148 份 Git 可见非敏感源码/文档及哈希；没有 pull/reset/stash。原保护文件最终仅 package.json 按预期增加命令，暂存区为空。
- 新增 tools/https-sync/：独立合成云端 cloud.mjs、专用 Dockerfile/compose.json、两个独立 Nginx 模板、私有部署打包器、Windows 只读权限检查/准备入口、一键 accept.mjs、TLS 隔离测试及随包 OPERATIONS.md。复用现有协议、AuthService、ChatService、HttpSyncTransport、SyncRunner、LocalArchive 和编译后 Agent CLI；没有改业务 schema 或生产服务代码。
- 命令：npm run prepare:sync:https；npm run test:sync:https。
- 最终私有包：项目 .phase1-work/https-deploy-e0776eec-7247-4129-892e-1bcaf7770b26.tar.gz，54 个显式清单文件；SHA-256：`fbd5495988aa40001834b1c7518c8d84f313071cd5cb9c36bff0d664419c4fe1`。包含编译后端及运行依赖锁文件，不含 node_modules、真实配置、数据库、测试身份、密钥或媒体。仅在获批后经 SSH 私密传送。
- 一键验收在获批后运行：`node tools/https-sync/accept.mjs --run <新私有验收目录> --authorized-remote-run`。先使用既有 approve-production 终端确认，将精确 origin、策略哈希、归档/凭据路径绑定；不绕过确认。密码仅通过既有 SSH 私密读取新合成身份到进程内存，不打印、不存 Windows；测试设备最终撤销，失败留证，不自动清理。

## 本轮新增验证

6/6 通过、0 失败、0 跳过；未重跑旧完整回归或已有浏览器演示。

| 验证 | 结果 |
| --- | --- |
| 部署包白名单/清单哈希/归档路径 | 通过；acceptance.env 仅新 run ID 和公开 origin，无密钥 |
| 拒绝重复初始化、未知库、已初始化但缺失的库 | 通过；不接纳/覆盖已有数据 |
| 错误服务标记 | 登录密码回调及数据库创建前停止 |
| 远程地址/未批准生产策略、旧验收资产 | 请求前阻断，不复用旧结果 |
| Windows 私有目录入口 | 两脚本 Windows PowerShell 解析通过；非私有新夹具只读拒绝，无 ACL 写入 |
| 本机实际 TLS + 独立云进程 + Windows Agent | 证书严格验证；未信任测试 CA 的客户端拒绝连接，测试 CA 仅子进程信任、不写系统证书库。正常认证/CSRF/Origin、实际 CLI、重复发送、自动断线重连、ACK 丢响应、云端进程结束/重启、撤销阻断均通过 |

TLS 场景最终 6 条原始消息、6 个事件、3 次假模型调用；两端消息 ID/顺序/内容哈希一致，ACK=本地游标=6；云库 v4、完整性检查通过，设备已撤销。网络故障为客户端注入，非物理 WAN 中断。后端/Agent 构建及 git diff --check 通过。源码安全扫描：133 个候选、28 个人工复核项、0 阻断；3 份机器身份文档仍隔离，完整源码未提交/公开。

## 一次性最小授权清单（尚未执行）

1. **首尔独立验收实例**：通过已验证 SSH 别名 sakie，只读确认端口/资源/phos 基线后，私密上传本包，在新 /srv/sakie-sync-acceptance/{release,data,identity,evidence,acme} 范围施工。仅新 data/identity 为容器 UID1000 私有目录；运行身份只读挂载，持久化 SQLite/WAL/SHM 在新 data。独立 Compose 项目、仅 127.0.0.1:3301、内部网络、无真实模型，日志上限 2×5MiB。384MiB/0.5 CPU 是配置上限而非实测消耗；构建前另核对余量。不安装/升级 Docker，不修改 sudo/SSH 策略。
2. **专用 HTTPS 入口**：新增 sync-check.sakiehome.icu 指向首尔的 DNS 和独立 80/443 vhost、ACME webroot/证书；使用 certbot certonly --webroot，避免自动改其他 vhost。仅转发该主机 /api/；/ws 和其他路径 404，无 CORS/信任代理扩展。nginx -t 后受控 reload；不改主域/www、不改 phos 站点/容器/证书续期配置。仅沿用现有 certbot 定时器，不变更其他服务。
3. **Windows 新隔离范围与临时配对**：只在 E盘新建与本包 run ID 对应的空私有目录，授权仅该目录的继承隔离 ACL（普通运行用户、SYSTEM、Administrators；运行用户及未来文件按需 Modify）。不改真实 data/cloud、备份、.env 或旧夹具 ACL。用户交互完成既有生产地址确认后，创建一个可撤销合成设备并执行一键验收；允许脚本通过固定 SSH Docker 命令读取该合成登录材料、重启且只重启验收容器。

如 sudo 非交互能力不足、3301 已占用、目录/项目意外存在、资源不足、phos 基线异常或任何 nginx/TLS/标记检查失败，立即停止；不自动授权 sudo、不结束其他服务、不换端口扩大范围。回滚仅停止新验收容器、在受控维护下禁用新增站点并 nginx -t/reload；保留包、身份、数据库和审计，不 down -v、不恢复覆盖、不动现有备份。详细顺序和证据清单位于包内 OPERATIONS.md。

## 未验证与结项门槛

尚未连接首尔，未部署、改 DNS/ACL、配对真实服务器或重启任何远程容器。Docker 镜像构建/Compose 执行、Nginx 语法及宿主内部网络端口可达性、实际 sudo 能力、正式 Windows 私有 ACL 正向验收、公开证书/DNS/真实公网同步仍待上述授权后验证。新入口可能受配对/登录共享代理 IP 限流，当前保守保留原机制，不擅自扩大 trust proxy。

因此本轮已把“可执行准备”交付，尚不能宣布 Part 2 真实 HTTPS 验收通过。授权后直接部署这一独立包并跑同一脚本，按 result.json 与双端持久性证据结项；不再重复大型预审。Phosphene、旧 VPS、真实数据和第三阶段功能均未操作。
