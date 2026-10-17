# Part 2 正式启用前：隔离部署验收交付

2026-10-17。本轮基线 main `240a39c8795a1c4d39e0913be5181b41144dfc5c`，开始工作区干净、与远程一致；再次核实仓库为 Private。开始先在 `.phase1-work/deployment-runtime-*` 保存原 Git bundle 和完整已审查源码归档。未覆盖开发成果。

## 已实测交付

| 内容 | 证据 / 结果 |
| --- | --- |
| 实际生产后端镜像 | 使用当前 `backend/Dockerfile`、`npm ci`、TS 构建及真正 `dist/server.js`，不是旧 fake-cloud 镜像。Node 24.22.0；镜像 314,832,890 bytes，ID 见 runtime-result。后端树 `2af51891ee6a45ab32b241de5497a945c6f02225` 本轮未改 |
| 全新 Compose 隔离部署 | 首尔新 `/home/ubuntu/sakie-activation-lab-7db8599c`，独立项目、网络、数据/备份/身份；仅 127.0.0.1:13401、13443。Compose config 与容器内 nginx-t 通过；没有改宿主 Nginx、现有服务或 DNS |
| TLS、路由和认证 | 自签测试 CA 校验通过，GET health200、业务未登录401、错误 Origin403、无 CSRF403；有效会话创建合成记录201；Secure/HttpOnly/SameSite 验证；`/` 与 `/ws`404 |
| 持久化与权限 | UID1000，数据/备份目录0700，身份文件0400且只读 bind 实际拒写；cap-drop ALL/no-new-privileges、512MiB/PID96、unless-stopped、所有发布地址回环验证通过 |
| 重启恢复 | Compose restart 后同一合成记录及登录会话仍在；应用进程 TERM 退出后 Engine restart policy 实际触发、RestartCount 增长，恢复后记录仍在、SQLite integrity=ok。不是强杀 WAL 写入中的故障测试，也未重启宿主 Docker/整机 |
| Windows 临时任务 | 普通令牌，COM ValidateOnly、注册、按需执行通过；InteractiveToken/LeastPrivilege、登录触发器配置通过；真实子进程先异常退出再自动重启，停止任务后父子进程均退出；唯一临时任务已移除。**未实际注销/登录/重启 Windows** |
| 新增定向测试 | `node --test tools/activation/supervision.test.mjs` **11/11、0失败、0跳过**。另只重跑受修改影响的原配置测试1/1、候选释放安全门槛测试1/1（全新合成 DB）；没有重跑132项、公网同步或真实历史副本迁移 |
| 维护入口 | 新 release-candidate-cli：同一镜像、无网络、只读源码、无数据库/身份挂载的 `--check-runtime --backend-dist /app/dist` 成功；不需要宿主 Node。**未执行 CLI 的真实候选释放模式** |
| 空闲资源快照 | 后端19.6MiB/512MiB、7 PIDs；验收Nginx2.602MiB/64MiB、2 PIDs；瞬时CPU均0%。这不是峰值/负载测试，也不是正式整体占用。结束宿主 available2658MiB、swap0；仅作当时快照 |

原始结果已脱敏保存：[Compose](evidence/2026-10-17-activation-runtime/compose-result.json)、[临时任务](evidence/2026-10-17-activation-runtime/task-result.json)、[版本/运行时](evidence/2026-10-17-activation-runtime/runtime-result.json)。全量合成构建日志、失败实验与临时身份/证书留在忽略目录及新远程 lab，不进入 Git。结束已停止两个新验收容器、释放两个端口；保留合成数据与审计，未安装正式任务。

## 本轮真实修复及验证边界

- `agent-host.mjs` 复用新 `supervision.mjs`：停止可立即中断30秒退避；未知/缺失状态和启动失败均 blocked，不再盲重启。测试覆盖真实子进程异常重启、blocked/未知状态、状态不可读、运行中停止无残留、退避中停止、启动失败及预先停止；不绕过原正式路径、凭据和 ACL 检查。
- `render.mjs` 的 XML 去掉字节编码声明，修复 Windows COM/BSTR 导入报“无法切换编码”；同一普通账户的临时任务真实导入已通过。
- `release-candidate.mjs` 仅增加显式编译模块目录参数/加载函数；新 CLI 让容器内 `/app/dist` 可被维护入口复用，原默认路径和安全门槛保留。原候选释放的合成定向测试通过；本轮无正式激活。
- 新 lab 准备/验收脚本、临时任务脚本，以及 RUNBOOK 的八步执行卡。只修复启用工程问题，未改业务表、同步协议、前端产品范围。
- 实验层问题已留证：只读 Nginx 容器需将临时目录放到 tmpfs；共享 backend 网络命名空间会在 backend restart 后失联，最终改为**两个全新桥接容器+服务 DNS**。正式模板仍为宿主 Nginx → 127.0.0.1:3401，未改为该实验拓扑。Docker kill 属人工停止、容器内 PID1 KILL 不构成有效重启故障注入；最终使用应用 TERM 退出检验策略，不能把早期超时说成生产缺陷。
- 因不改宿主 Nginx，实际路由验收采用新 Nginx 容器、自签证书及服务 DNS；**不等于已验收正式宿主站点、公开证书/域名、整机启动或真实数据**。正式最终 HTTP 链路仍在获批维护批次核验。

## 剩余门槛与一次集中授权

目前无需重开架构审查；下一步按 [RUNBOOK 的 Production execution card](../../tools/activation/RUNBOOK.md) 执行。执行前只需明确：**正式独立 API 域名、加密独立备份落点、接受登录后 Agent（未登录视为离线）**。API/Agent 就绪不等于 v1.1 完整网页上线。

| 待授权范围 | 执行与验收门槛 / 回退 |
| --- | --- |
| 最新主库停写/备份/候选 | 明确全部实际写入端后，停写 `E:\sakie-ai-home-data\cloud\sakie.db`；新 `E:\sakie-ai-home-backups\activation-live\<batch>`、私有候选及独立加密介质。备份实际校验→新候选v4→旧行/UUID/事件保持→新v4快照。当前真实库版本/新消息/活跃设备本轮**未读**。绝不原地覆盖旧库 |
| 精确权限 | 旧 `.env` 单文件和新 windows-live、identity-live、activation-live、固定发布目录；归档可写、身份配对后维护所有者+运行只读。只改批准闭合集，不动两个根目录、旧 Plan/z-denied 或旧验收树。ACL/继承/编辑器替换失败即停 |
| 正式首尔 API | 新 `/srv/sakie-home/{releases,data,backups,identity}` 与单独 API Nginx 站点/证书/获批新域名；3401回环。用户私下配置新 owner/模型环境；私有候选验证/收据后启动。Nginx-t、现有站点不变、401/CSRF/来源边界及重启检查。不得操作 phos、旧机、主域/www |
| 新设备与常驻任务 | 全新 archive/凭据，用户精确地址确认，pairingId私有文件，once追平至稳定head，ID/hash/order/本地提交游标/云ACK一致；封存身份权限后再安装 SakieHome-LocalAgent。按需运行、用户登录切换和另行约定整机重启窗口核验；失配/blocked/未知锁即停，不重置游标 |

失败前若无新写入，只停新增组件并保留候选/审计；有新写入后先停新写入并备份新状态，另建候选前向核对，**不得恢复旧库覆盖新消息**。回撤只涉及新任务/指定设备/新站点，禁止 down-v/prune。独立备份落点未定前不正式切换。

可受控接受的剩余风险：监督宿主自身被杀不会自动重启（避免任务层盲重试，应人工检查锁/状态）；Docker healthcheck不自动重启“仍存活但不健康”的进程；实际登录/宿主重启和生产峰值尚未验证。需要无人值守开机前 Agent 或宿主自动恢复时，应另立明确授权/验收，不在本轮偷偷扩展。

本轮未读取真实 .env/模型密钥、正式数据库或备份，没有真实 ACL、正式设备配对、生产部署、真实收费调用或 DNS 变更。仅提交审阅后的源码/文档/合成脱敏证据到现有私有 main，停止于正式启用门槛。
