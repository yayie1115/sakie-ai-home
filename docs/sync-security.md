# 同步正式启用前安全措施

本轮只实现工具与代理防护，不对真实文件执行ACL Apply，不迁移真实v3库，不启动常驻同步，不操作云端或Git。

## Windows ACL方案

工具 tools/windows-acl.ps1 默认Check；必须显式提供Targets，没有自动全盘操作。只读目标权限，不读取密钥内容。

政策 private-rwd-v1：当前执行用户SID对目录有Modify，对文件有Read/Write/Delete/Synchronize，不额外授予执行文件权限；SYSTEM及Administrators保留FullControl；不保留Users、Authenticated Users、Everyone或其他账号/组的访问。目录设置私有继承，保护新建WAL/SHM、数据库、备份和设备凭据。所有者不改动，只接受当前用户、SYSTEM或Administrators为所有者。管理员/SYSTEM是受信任主体，本机制不防御本机管理员或磁盘离线读取。

工具只写DACL，不申请所有者或SACL/审计权限。指定UserSid必须是当前执行账号；UAC提权应使用同一个Windows账号。独立服务账号需另行评估。

### 审阅及执行步骤

先确认所有目标都属于本项目，不包含其他用户/服务依赖的目录。建议覆盖：backend/.env、整个E:/sakie-ai-home-data及E:/sakie-ai-home-backups，以包含数据库、历史快照、恢复副本和未来设备凭据。

~~~powershell
Set-Location E:/sakie-ai-home
$aclTargets = @('E:/sakie-ai-home/backend/.env','E:/sakie-ai-home-data','E:/sakie-ai-home-backups')
./tools/windows-acl.ps1 -Mode Check -Targets $aclTargets
~~~

Check只输出SID、规则和风险。Plan记录全部对象、原DACL、owner、文件长度/修改时间，生成SHA256；只新建私有计划文件，不修改Targets。父目录需预先存在，计划必须用新名字：

~~~powershell
$aclPlan = 'E:/sakie-ai-home-data/acl-review/acl-plan-reviewed.json'
./tools/windows-acl.ps1 -Mode Plan -Targets $aclTargets -PlanPath $aclPlan
~~~

审阅Targets、UserSid及Entries，保留审阅时输出的PlanHash。停止相关写入进程；计划后新增文件或内容/DACL/owner变动都会阻断。其他开发测试也会改变data清单，此时重新生成/审阅计划，不删除数据迎合旧计划。

~~~powershell
$reviewedHash = '填入已审阅的PlanHash'
./tools/windows-acl.ps1 -Mode Apply -PlanPath $aclPlan -ExpectedPlanHash $reviewedHash -WhatIf
# 仅在用户明确授权后执行下一行：
./tools/windows-acl.ps1 -Mode Apply -PlanPath $aclPlan -ExpectedPlanHash $reviewedHash -Confirm
./tools/windows-acl.ps1 -Mode Verify -Targets $aclTargets
~~~

Apply对同一份字节验哈希并解析，拒绝未经审阅或被篡改的计划。原ACL与对象清单不匹配则不执行。拒绝盘符根目录、UNC、ADS、重解析点、junction/symlink、硬链接、空DACL及不支持的ACE；不跟随链接跨界修改。路径操作使用LiteralPath或核验过的绝对路径。

WhatIf不修改目标；执行后保存不可覆盖的.apply.json。失败时尝试恢复已触碰对象的原DACL，回滚失败明确列出路径。权限变更不是文件系统事务，必须停写。本轮测试了正常恢复及前置阻断，未在真实目录制造中途权限故障。

需要恢复旧权限时，必须重新授权：

~~~powershell
./tools/windows-acl.ps1 -Mode Restore -PlanPath $aclPlan -ExpectedPlanHash $reviewedHash -WhatIf
# 再次审阅并授权后：
./tools/windows-acl.ps1 -Mode Restore -PlanPath $aclPlan -ExpectedPlanHash $reviewedHash -Confirm
~~~

Restore会重新开放旧ACL里的访问，不是默认回退。只允许清单和文件元数据仍匹配、当前仍满足私有策略时受控恢复；新建消息/WAL/凭据后拒绝恢复，避免新秘密重新暴露。不删除文件或恢复数据库内容。

Verify核验SID、owner和有效权限结构，但不等于已经用另一个Windows账号实际登录验证。编辑器若用新文件替换.env，可能重新继承backend目录权限；应保留ACL编辑，修改后再次Verify。ACL不是加密，也不代替异地加密备份。

## 代理环境与目标隔离

local-agent/src/network-policy.ts是内建策略，transport及CLI强制使用，不依赖临时测试拦截。

默认environment=test，仅允许两个精确origin：

- http://127.0.0.1:3000
- http://127.0.0.1:3100

其他端口、localhost和生产地址在fetch前拒绝。test只允许字面量127.0.0.1或[::1]，不通过DNS/hosts决定是否本机。需要其他测试端口时，将 local-agent/sync-policy.test.example.json 复制到项目外新文件并显式指定：

~~~json
{"version":1,"environment":"test","allowedOrigins":["http://127.0.0.1:3100"]}
~~~

精确匹配协议/主机/端口；没有通配符、子域后缀或端口范围。拒绝URL内凭据、额外路径、查询串、fragment、整数/短IP等非规范写法。末尾单个/表示同一origin。生产域名即使写入test白名单也会被拒绝。NODE_ENV等环境变量不自动切换production。

### 生产必须显式配置并人工确认

生产模板 local-agent/sync-policy.production.example.json 使用不可用占位域名，不能直接启用。生产需要同时满足：

1. 明确--policy，environment=production，配置精确HTTPS白名单。
2. 在真实交互终端运行approve-production，显示策略SHA256、目标、归档路径和凭据路径。
3. 手工输入完整短语 ALLOW PRODUCTION SYNC 加精确origin。无TTY拒绝，没有自动yes开关。
4. 创建独立新确认文件，不覆盖旧文件；这一步不联网、不读令牌、不打开数据库。
5. pair/once/run/status传入同一--policy及--approval；确认记录必须匹配策略哈希、环境、目标、物理规范化后的归档和凭据路径。

仅作命令格式示意，本轮不执行：

~~~powershell
npm run start -w local-agent -- approve-production --policy E:/sakie-ai-home-data/windows/sync-policy.local.json --cloud https://your-server.invalid --database E:/sakie-ai-home-data/windows/archive.db --credentials E:/sakie-ai-home-data/windows/agent-credentials.json --approval E:/sakie-ai-home-data/windows/sync-production-approval.json
~~~

占位域名须由用户替换为明确授权的目标。人工确认不等于授权真实数据库迁移或云端部署。

修改策略、目标端口或绑定路径会使旧确认失效，需生成新的确认文件。请求不跟随重定向，每次请求前复核已加载的策略。文件不热加载，更改后需停掉旧进程并重启；删除确认文件不会自动终止已运行的进程。

确认文件不是密码学签名，不防御同一用户恶意篡改；配置和凭据目录应先受ACL保护。不得将人工确认逻辑当成设备认证的替代品。

### 凭据兼容性

新凭据version=2，含environment、cloud、deviceId、token和database。环境不匹配或旧文件缺少标识时直接拒绝，不按旧cloud字段自动联网。旧设备由用户撤销后重新配对，使用新的文件，不自动覆盖旧令牌。

测试地址的配对和单次运行：

~~~powershell
npm run start -w local-agent -- pair --policy E:/sakie-ai-home-data/windows/sync-policy.local.json --cloud http://127.0.0.1:3100 --database E:/sakie-ai-home-data/windows/test-archive.db --credentials E:/sakie-ai-home-data/windows/agent-credentials-test.json --pairing-code-file E:/sakie-ai-home-data/windows/pairing-code-test.txt
npm run start -w local-agent -- once --policy E:/sakie-ai-home-data/windows/sync-policy.local.json --credentials E:/sakie-ai-home-data/windows/agent-credentials-test.json
~~~

默认白名单已含目标时可省略--policy；正式模式必须另加--approval。API Key仅在后端.env，local-agent只保存独立设备凭据，不复制模型密钥。机器策略、确认记录和ACL计划均补充Git/Docker排除规则，但仍需放项目外并限制权限。

## 测试及边界

本轮64项测试全部通过，含新增10项安全测试，Windows ACL夹具测试实际执行而非跳过；四个workspace类型检查和构建通过。

覆盖默认生产阻断、精确端口/协议、test禁止生产、生产确认绑定、无TTY拒绝、旧凭据及环境混用、联网/建库前拒绝、策略变化及重定向；生产成功路径仅用模拟fetch，没有DNS或云端请求。原有同步回归使用显式随机本机白名单。

ACL覆盖Plan/WhatIf只预览、Apply/Verify、恢复原DACL且文件字节不变、新建WAL/凭据继承、错误哈希、文件/清单变化、根目录/junction/硬链接拒绝。测试链接在验证后只移除新建链接，保留目标文件。未验证真实目录的中途失败、恶意并发替换或跨账号实际登录。

真实.env内容和权限、真实v3数据库未改，未生成真实生产确认、启动常驻同步、操作云端或Git。云端自动清理仍关闭。

## 文件与后续授权

新增 tools/windows-acl.ps1、local-agent/src/network-policy.ts、两份策略示例、backend/test/sync-security.test.ts及本文。
调整 local-agent/src/{cli,transport,runner}.ts、原同步测试的随机端口白名单、忽略规则、README/增量同步说明/FILES。没有新增外部依赖、数据库迁移或常驻服务。

后续需要用户分别授权：审阅SID/路径/计划后执行真实ACL Apply；确认目标环境和精确地址并在本机交互确认production；另行批准真实v3→v4迁移和受控配对。授权前仅Check/Plan/WhatIf，不自行处理。

## ACL 失败后的隔离修复（2026-10-16）

真实 Apply 曾因备份根目录缺少 WRITE_DAC 失败；后续只读审计发现 56 个对象仅 Allow ACE 顺序变化。此节只说明代码修复，不表示真实 ACL 已修复或重新执行。本次没有更改旧 Plan、真实 ACL 或数据库。

EquivalentDacl 比较 DACL 控制标志、ACL revision 及每条 ACE 的完整二进制内容（包含 SID、权限、继承标志及重复次数）。仅全为普通非回调 Allow ACE 时按多重集合比较，允许换序；含 Deny/其他 ACE 时保留顺序，不把可能改变访问语义的换序认作等价。Apply 原状态检查及 Restore 后置检查复用该比较；所有者仍独立严格检查，PlanHash 校验不变。

执行前通过 Windows CreateFileW 对清单中每一个对象以 WRITE_DAC、OPEN_EXISTING 和允许读写删除共享方式打开句柄，再关闭；支持目录，避免跟随最终重解析点，不读取或写入文件正文。使用当前令牌的内核权限检查，不以“是否管理员”或拥有 Modify 推断权限。任何目标失败时汇总路径和 Win32 错误，以 ACL_WRITE_DAC_PREFLIGHT_FAILED_ZERO_CHANGES 终止，尚未写任何目标 DACL或执行日志；ShouldProcess/WhatIf 前同样执行预检。Restore 亦执行相同安全预检，但本次不对真实对象执行 Restore。

回归在新建合成夹具中验证：Allow 换序等价；权限位、继承/保护标志、重复数变化与 Deny 换序不等价；等价计划实际 Apply 成功；最后一个文件通过 OWNER RIGHTS 明确拒绝 WRITE_DAC 时，即使其他目标可写，整个操作仍零修改终止，原 DACL/文件正文一致、无成功日志。测试不改变所有者、不提权，也不调用真实设备/模型服务。

限制：预检不是文件系统事务，检查后权限、路径或其他进程状态可能变化；不能保证后续 DACL 写入、回滚或成功日志写入一定成功。未实现保留全量句柄锁定、持久化失败日志或恢复机制重构。现有计划仍只绑定计划字节，不绑定脚本版本。真实旧 Plan 因后续新增隔离测试对象已不能直接使用，必须先审查再决定新计划，不能自动重试。
本次实际结果：定向安全测试 13/13 通过；完整回归 67/67 通过，0 失败、0 跳过；四工作区 typecheck 和 build 均通过，git diff --check 通过。外部 fetch 受本机白名单拦截，未调用真实模型或云端。旧真实 Plan SHA256 仍为 c293b70f1787acec209b8d9f7df23183030aca164e0198f45f0bcf55400d052c。未提交或推送 Git。
