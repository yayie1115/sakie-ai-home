# Part 2 真实 HTTPS 增量同步验收结果

2026-10-17。用户已批准整批隔离验收，并单独批准 Docker internal 网络的最小 Nginx 回环适配。**Windows Agent ↔ 首尔后端的真实公网 HTTPS 合成同步已通过。**本报告更新原同一文件；只提交脱敏文档，不公开业务源码。

## 实际部署与通过证据

- 私密传输的原包 SHA-256：`fbd5495988aa40001834b1c7518c8d84f313071cd5cb9c36bff0d664419c4fe1`；首尔安全解包及 54 个文件哈希通过，专用镜像实际构建成功，运行用户 1000:1000。
- 新范围仅 /srv/sakie-sync-acceptance：release、合成 data/identity、evidence、ACME webroot。data/identity=0700，身份文件=0600、运行时只读挂载；数据库文件实际0644，但父目录0700阻止其他普通用户访问，不可脱离私有目录搬移。没有挂载/迁移真实数据库或备份。
- 新域名 sync-check.sakiehome.icu 的 A=43.133.73.31，无 AAAA；用户完成 DNS。专用证书签发成功，实际客户端正常验证 TLS；新独立 80/443 站点与回环3301转发已启用，未改原站点文件。健康入口：https://sync-check.sakiehome.icu/api/health；/ws=404，未认证业务API=401。
- Windows 仅新建 E盘 https-acceptance-e0776eec-7247-4129-892e-1bcaf7770b26 私有目录：普通用户所有，阻断父目录继承，仅该用户、SYSTEM、Administrators；用户对当前及未来文件有 Modify。用户亲自在既有终端入口确认精确 HTTPS 目标及路径绑定；前后私有检查通过。真实 .env、旧数据根、备份及旧测试夹具 ACL 未动。

| 本次真实链路验收 | 结果 |
| --- | --- |
| 正常用户认证 / CSRF / 错误Origin / 设备权限分离 | 通过；设备凭据不能访问用户业务API |
| 实际编译后的 Windows Agent CLI 及重复发送 | 通过；同客户端ID重用消息收据，没有重复模型调用 |
| Agent 断线、云端继续聊天、自动重连 | 通过；故障为客户端注入，非切断物理 WAN |
| 本地事务提交后 ACK 响应丢失 | 通过；本地与云端已可靠落盘，重传不重复 |
| 首尔验收容器重启及游标恢复 | 通过；同一容器/IP，持久化身份、ACK及消息保留；没有重启Docker主服务或VPS |
| 双端完整性与原始数据 | 云v4、本地归档v1，integrity_check均ok；6条消息/6个事件的ID、顺序、内容哈希一致，ACK=本地游标=6；云端3次假模型调用，原文仍6条，未执行清理 |
| 设备撤销 | 已撤销临时设备，云端activeDevices=0；本地retry=blocked为撤销后的预期安全状态，未安装常驻代理 |

## 执行中发现并解决的问题

1. Docker 29.9.1 接受 PortBindings，但仅 internal 网络实际未发布端口；容器自身健康，宿主直达其172.19.0.2:3000正常。先停下只读诊断，经用户追加确认后，仅新增 Nginx 127.0.0.1:3301 → 该私网IP 转发；保留 internal 网络，未改Docker全局设置或接入普通出站网络。与 [Moby上游现象记录](https://github.com/moby/moby/discussions/53256)一致，结论以本机inspect/监听实测为准。
2. prepare-windows.ps1 误用同进程脚本的 LASTEXITCODE；改为独立 Windows PowerShell 检查进程读取真实退出码，未重写已通过ACL。隔离回归已复现旧失败并验证修复。
3. Node子进程继承 PowerShell7模块路径，导致Windows PowerShell5无法加载Get-Acl模块；accept.mjs仅清理该子进程PSModulePath，使其加载自身模块，不改系统/用户环境配置或权限。同时新增无凭据的阶段诊断。
4. 新Nginx reload后第一次HTTP探测短暂命中旧worker返回404；只读复查及公网探测随后200，没有以修改其他站点解决。证书申请在公网ACME路径通过后才执行。

新增2项Windows兼容性定向回归2/2通过、0跳过；复用此前6/6隔离准备证据，本轮未重跑旧完整回归或浏览器演示。后端/Agent镜像构建实际通过；git diff --check通过。源码安全扫描133个候选、29个人工复核项、0阻断，3份机器身份文档继续隔离；暂存区为空、已跟踪敏感路径筛查为空。

## 非干扰、资源与留证

- default、sakie-test、sakie-https、phos站点文件SHA-256与执行前逐项一致。nginx/docker/phosphene-relay均active，phos容器healthy且原启动时间不变；phos HTTPS前后均200。未读取其业务数据/密钥，未改其配置、证书或容器。
- 验收容器只读rootfs、内部网络、身份只读；实测向宿主公网443出站为ENETUNREACH。384MiB/0.5CPU为配置限额；执行后单次docker stats约20.49MiB、CPU0.00%，宿主可用内存2728MiB；这些是瞬时读数，不是峰值或长期容量结论。
- 原包、manifest、新站点配置、前后哈希、Windows新目录ACL审计、双端脱敏完整性统计保留在私有/本地忽略范围。Windows新私有目录的result.json为本次通过结果。没有删除任何历史数据、原包或备份。

## 剩余边界与回退

- 本轮通过的是**真实HTTPS + 合成数据 + 假模型**。未迁移用户聊天库、启用长期生产设备或调用收费模型；不据此宣布整个正式数据启用完成。
- 验收实例暂保留，restart=no；未设置Windows常驻服务，未验证整机重启/证书续签dry-run/容器重建。新证书使用webroot，现有certbot定时器及phos续签配置未改。
- 当前回环适配固定绑定已核验容器IP。**不要直接重建容器、改网络或docker compose up触发重建后沿用旧IP**；需另行核对IP/服务标记并受控更新专用配置。同一容器restart已实测通过。这是验收拓扑的明确限制，不是长期生产自动恢复方案。
- 若需收起验收，只停止sakie-sync-acceptance的cloud，禁用本次新增的http/https/loopback站点后nginx -t/reload；保留全部新数据/身份/审计，不down -v、不prune、不覆盖恢复，不碰phos。DNS/证书后续去留交用户决定。
- 完整Windows源码仍未提交公开GitHub；只更新本报告。下一步由Chat审核本次公网证据，再决定第二阶段整体结项及真实存储启用范围；不提前扩展第三阶段。
