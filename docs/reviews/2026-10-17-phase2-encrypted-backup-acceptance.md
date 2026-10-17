# 第二阶段：文件级加密备份实现与合成恢复验收

2026-10-17。基线私有main `012302ba0eb7f00971c177452e5cecc6634974a8`；开始工作区干净、与远程一致，已保存源码/history bundle到本轮忽略目录。读取了共同状态、activation RUNBOOK与F盘准备报告，没有重复旧132项、公网同步或首尔部署验收。

**用户新决定已落实：F盘虽加密100%，但保护关闭、无保护器，不把它视为有效存储加密；不修改BitLocker/微软账户。改用标准age文件认证加密。F真实目录仍未创建/写入，本轮只用新合成夹具。**

## 可运行交付与安全检查

- 新 `tools/backup/{encrypted,cli,prompt}.mjs`，npm入口 `backup:encrypted`；复用已有 createBackup / verifyBackup / restoreBackup，未改业务代码、schema或同步协议。操作说明在 [工具README](../../tools/backup/README.md)。根开发依赖锁定age-encryption0.3.1、tar-stream3.2.2，完整传递依赖锁定于package-lock，不引入常驻服务/付费服务。
- 使用 [age官方TypeScript实现typage](https://github.com/FiloSottile/typage) 和 [age标准格式](https://c2sp.org/age)：库负责scrypt、随机盐/file-key/payload nonce、ChaCha20-Poly1305及header认证；没有自创密码算法。采用scrypt工作因子18（N=2^18,r=8,p=1，约256MiB算法工作内存），解密前限制为本工具的单scrypt-18 profile，拒绝恶意高工作因子。不是实际内存峰值测量。
- SQLite一致性快照、manifest、获批媒体及元数据全部在tar+age内；F只存密文，无明文伴随清单。每份随机盐/nonce独立；密文长度/age头/自选输出名可见。密码仅本机TTY隐藏输入，创建时两次确认；拒绝密码参数/环境密码/普通密码文件/管道，不打印或保存恢复凭据，不依赖微软登录。密码丢失无重置后门，用户须事先在独立离线密码管理器或封存纸质记录保存。
- 创建：私有E临时SQLite快照→流式加密partial→fsync→完整解密认证/原verify校验→同卷hard-link排他发布→本次明文清理。恢复：完整认证/安全tar解析/校验后才排他创建新E目标，逐文件复制/校验/fsync；保留恢复隔离标记，不启动/迁移/解除隔离。现有输出/目标及并发创建内容不覆盖。
- 持久pending标记先于明文；取消/普通失败只清理本次owned对象，强杀/损坏标记阻止重试。cleanup-abandoned要求已证明PID死亡、ownership/精确范围一致及交互确认，不清理未知状态、活跃/复用PID、未知文件或F残留partial。CLI要求workspace/恢复目标在E、私有目录检查通过；F根/游戏权限不动。CLI预检估算后的20GiB余量，单批解包上限30GiB；不是磁盘配额或持续监控，总保留预算及并发其他写入仍需人工核算/监视。
- `.gitignore`排除.age/.partial/agekey及作业标记；release-audit增加age私钥特征。只提交源码、文档及下面的脱敏结果，**不提交任何合成或真实备份、密码/密钥、数据库、日志或测试目录**。

## 实际验证

| 检查 | 结果与边界 |
| --- | --- |
| 新加密定向套件 | **24/24通过，0失败，0跳过**，约38.0秒；命令 `npm run test:backup:encrypted` |
| 实际恢复演练（合成） | 原生SQLite保持未检查点的已提交WAL，备份加密后恢复；全表逻辑指纹、UUID/正文、BLOB及媒体逐字节一致，integrity=ok；会话撤销/归档核对标记仍为true；源库与已有目标保持 |
| 认证与恶意输入 | 错误密码、头/载荷损坏、截断、尾随追加、恶意KDF因子拒绝；认证后的tar路径穿越、链接、重复/大小写冲突拒绝；没有发布恢复目标 |
| 故障与并发 | 注入可用空间0、写入首块后ENOSPC、取消、恢复复制失败；真实子进程在snapshot-created阶段SIGKILL；阻止盲重试、活跃PID清理与未知记录清理；并发输出/目标及无关workspace文件保留。**没有真的填满磁盘或切断电源** |
| 输入与权限 | 隐藏提示不回显、Ctrl-C恢复终端状态、分块UTF-8；真实CLI经过合成私有目录门槛后拒绝管道输入。新夹具ACL仅本轮对象；未在人工真实密码终端完成正式流程 |
| 工程与依赖 | 四工作区typecheck及生产build通过；官方npm registry的audit返回0项，新增crypto依赖0项。镜像站不支持audit接口，改为仅该命令指定官方registry，没有改系统/项目registry配置 |

[脱敏证据](evidence/2026-10-17-encrypted-backup/result.json)。原生DB、媒体、密文、故障夹具全部留在忽略的 `.phase1-work/encrypted-backup-lab-*`；密码仅进程内存，未写入夹具。本轮未执行原先132项回归或任何真实数据恢复。

## 尚存限制，不冒充已解决

1. **E盘短暂明文与强杀残留**：复用SQLite备份需要E私有临时快照；正常/可处理失败已验证清理，SIGKILL/断电可能留下明文。pending只阻止误用、不等于安全擦除；SSD残留、页面文件、JS字符串内存无法保证清零。若要求绝无明文落盘，须另行批准可验证的加密临时存储，当前不能承诺。原有明文库/旧备份从不自动删除。
2. **仅合成验收**：未写F，未测试F实际创建/硬链接权限、真实盘断电、真实主库/当前写入端、独立上游age工具互通或真实密码手动输入；标准格式与现库恢复已验证不等于这些也通过。未做外部独立密码学审计，npm无公告也不是安全证明。
3. **运行与恢复职责**：解密副本只在E，目标必须全新并保持隔离；新copy半途强杀可留下未完成目标，先pending/ownership核对，不直接启动。已有迁移工具仍可能产生E盘明文回滚/演练副本，需要下一阶段单独的私有范围与封装/清理授权，本轮未扩展迁移逻辑。
4. **可用性**：age能发现篡改、不能修复被删密文；私有ACL仍必需。在线同机E/F不能抵御同账户勒索/整机损毁，不是离线异地方案。总30GiB预算/保留周期与实际媒体范围仍人工核定，不自动删游戏/旧备份。

## 下一轮真实备份：一次集中授权的精确范围

1. 确定全部真实小家写入端并批准短停写窗口；来源仅 `E:\sakie-ai-home-data\cloud\sakie.db`及必要WAL/SHM访问，显式核定媒体根。遗留 `E:\sakie-ai-home\backend\data\sakie.db`若批准，独立legacy批次，不合并。不得由文件时间推定停写，不碰其他服务/游戏。
2. 仅创建并私有化新 `E:\sakie-ai-home-data\backup-work\<batch>`、`E:\sakie-ai-home-data\backup-restore-check\<batch>`及必要私有审计子目录；F仅新 `F:\sakie-ai-home-backups\verified\<batch>`及其新父目录。先审核继承/有效权限，再落数据；不改E/F根、旧ACL/Plan、游戏、旧夹具或BitLocker。workspace必须独立、不能混放其他资产。用户须知并接受E短暂明文/残留边界，否则先解决加密临时存储。
3. 用户在独立位置保存恢复密码，然后自己通过本机隐藏TTY输入。固定私有release执行 `create --database <精确主库> --output F:\sakie-ai-home-backups\verified\<batch>\cloud.tar.age --workspace E:\sakie-ai-home-data\backup-work\<batch>`；授权包括该新密文partial、成功文件及正常失败时仅本次owned临时区清理，不包括其他数据删除。最新容量/20GiB余量/30GiB总预算先核算。
4. 同一工具 `verify --input <上述密文> --workspace <同E目录>`；随后 `restore --input <上述密文> --target E:\sakie-ai-home-data\backup-restore-check\<batch>\cloud --workspace <同E目录>`。只在新目标内部做完整性/逻辑指纹/媒体核验，保留恢复隔离，禁止迁移、覆盖、自动启用或真实设备配对。私有审计仅记录密文SHA/长度与通过状态，不记录正文/密码。
5. 任何错误/未知pending/权限/容量变化即停；强杀残留必须按PID/ownership单独审查后才授权清理，F残留partial不自动扫除。原库与历史备份不动；恢复原指定写入端须包含在维护授权中，不能在失败不明时盲启。真实备份、正式ACL和生产部署仍未获本轮授权。

本轮没有创建F目录、读取真实库/凭据/恢复密钥、改变正式ACL/BitLocker/分区/设备/云端/DNS或安装任务；只更改源码、锁文件、工具/文档和全新合成夹具。完成提交后停止，等待Chat审核。
