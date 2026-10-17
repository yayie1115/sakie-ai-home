# 加密备份工具（Windows，正式使用须单独授权）

依赖 Node24、固定私有版本的 `npm ci`（含开发依赖）和已构建的 `backend/dist`。不启动后端/Agent，不加载 dotenv，不调用模型。加密由 [age-encryption/typage](https://github.com/FiloSottile/typage) 实现，文件是标准 [age v1](https://c2sp.org/age) 加密的 tar；不是自创密码算法或私有密文格式。直接依赖锁定 age-encryption0.3.1、tar-stream3.2.2；完整传递依赖及校验值在 package-lock。

## 密码与恢复凭据

- 在自己可信的本机交互终端输入；输入不回显。创建时重复确认，至少20个字符、最多1024字符。建议用既有离线密码管理器生成32个随机字符或足够长的独立随机词组；长度规则不是熵保证。工具不生成或打印密码。
- **不支持**密码命令参数、环境变量、密码文件、管道输入。不要把密码粘贴到聊天、脚本、shell命令、Git、日志或普通配置。不要用本轮任何合成测试值。
- 密码就是恢复凭据，没有可重置后门。执行前将它保存在独立于此PC/F盘的既有离线加密密码管理器或封存纸质记录，并验证自己能取回；不要与密文放在同一普通目录。**不依赖微软登录、BitLocker恢复服务、WebAuthn或云账号。** 本轮没有创建/保存真实恢复凭据。
- age 使用每文件随机file-key、随机scrypt盐及16-byte payload nonce；scrypt `N=2^18,r=8,p=1`（约256MiB工作内存），ChaCha20-Poly1305分块认证、header HMAC。实现与随机数由库提供。本工具解密前仅接受单scrypt、工作因子18的标准age头，拒绝过高或其他profile，限制KDF资源；其他profile须用相容工具并单独评审。

## 目录与覆盖范围

`--workspace` 必须是**已存在的E盘私有目录**，普通运行账户/SYSTEM/Administrators限定访问、阻断宽继承；不自动创建或治理真实ACL。输出父目录、恢复父目录也须已私有化，通过现有check-private检查。深层现有文件仍需维护审计；不要把未知资产放入workspace。CLI只允许E盘明文临时区及E盘恢复目标，F只接收密文。

加密覆盖 `database.sqlite`一致性快照、manifest（SHA-256、逻辑指纹、版本、媒体清单）以及显式批准的媒体；全部在tar+age内，**没有明文伴随清单**。只读公开信息是age头、KDF参数、随机盐、密文长度及自选文件名。`.env`、设备凭据、代码、其他数据库/旧备份不被自动收集；主库和遗留库分开执行，不合并。媒体先停写，`--media-quiesced`只是操作者声明，不会替用户停进程。

SQLite备份复用现有createBackup，故E私有workspace会短暂存在明文快照/解密副本；正常完成和可处理的错误/取消会只清理本次带随机ownership标记的子目录。**强杀/断电可留下E盘明文，删除也不是SSD安全擦除；内存/页面文件残留无法保证清零。** 若要求绝无明文落盘，当前实现不满足，必须先另行批准可验证的加密临时存储。旧有明文备份与源库从不删除。本工具不能替代离线/异地副本，也不能抵御已控制同一账户的恶意程序。

## 命令（示例不是生产授权，本轮没有在真实路径运行）

先审阅版本、授权来源/私有目录/维护停写/空间，再运行。占位批次必须替换；workspace应是该批独立目录，不放密码配置。输出必须以`.tar.age`结尾。CLI开始前按估算检查20GiB可用余量（非磁盘配额/持续监控，其他进程并发写盘仍需维护人员监视），单次解包上限30GiB；不会自动轮换、删旧备份或腾游戏空间。

```powershell
# 已获批并私有化的路径；命令里没有密码。
node tools/backup/cli.mjs create --database E:\sakie-ai-home-data\cloud\sakie.db --output F:\sakie-ai-home-backups\verified\<batch>\cloud.tar.age --workspace E:\sakie-ai-home-data\backup-work\<batch>
node tools/backup/cli.mjs verify --input F:\sakie-ai-home-backups\verified\<batch>\cloud.tar.age --workspace E:\sakie-ai-home-data\backup-work\<batch>
node tools/backup/cli.mjs restore --input F:\sakie-ai-home-backups\verified\<batch>\cloud.tar.age --target E:\sakie-ai-home-data\backup-restore-check\<batch>\cloud --workspace E:\sakie-ai-home-data\backup-work\<batch>
# 若有经批准媒体，在create后增加 --media-dir <精确E盘媒体根> --media-quiesced。
```

创建先估算源DB/WAL/媒体空间，SQLite一致性快照→加密tar流→fsync密文partial→在E临时区完整解密认证并复用verifyBackup→同卷hard-link排他发布（不覆盖）→清理本次明文。最终返回密文SHA-256/长度，不打印数据。输出文件若已存在立即拒绝；中断后的partial不是成功备份，不能以存在/大小判定成功。

恢复完整消费认证流，限制总大小/文件数，拒绝路径穿越、链接、大小异常、重复/大小写冲突条目、清单外文件；verifyBackup通过后才创建目标。复用restoreBackup在临时区恢复，再排他复制到新目标、逐文件校验并fsync、写recovery-complete。`restore-info.json`的会话/归档核对标记始终保留，**不迁移/启动/自动激活，不覆盖主库**。有中断标记或不完整恢复目标时禁止使用。普通文件fsync不等于已做NTFS断电持久性认证；原库保留。

## 中断、失败与重试

- 错误密码/损坏/认证尾部缺失/空间不足：没有成功输出或恢复目标；正常异常清理仅本次owned明文与partial，原库、已有输出、并发创建目标及workspace内其他文件保留。无法清理则保留pending并停止，不宣称成功。
- `operation.pending.json`在创建明文前落盘；强杀留下它时，新操作返回PENDING_REVIEW_REQUIRED。`status`只显示job ID/PID/阶段，不展示来源或密钥：
  `node tools/backup/cli.mjs status --workspace <精确E私有工作目录>`。
- 确认是本批、进程已死亡且范围/ownership一致后，可在授权范围运行 `node tools/backup/cli.mjs cleanup-abandoned --workspace <同目录> --job-id <status返回ID>`，手动输入隐藏的`CLEAN <ID>`。PID仍活跃/复用、标记损坏、目录变为链接或内容身份不符均停止，不能删标记绕过。它只清理对应owned E临时作业/未完成owned恢复；**不会自动清除强杀遗留的F密文partial或其他资产**。
- 成功恢复副本不会被当失败临时区删除；目标已存在一律拒绝，即使是上次失败目标。不要以旧备份覆盖已有新消息库。新的输入/输出用新批次，完成文件校验和恢复检查后再人工决定后续迁移。

## 验证

`npm run test:backup:encrypted`：只新建项目`.phase1-work/encrypted-backup-lab-*`合成夹具；测试私有ACL仅用于该新夹具，绝不操作正式ACL/F盘。覆盖WAL/媒体/BLOB真实恢复、篡改/错误密码、空间/ENOSPC/取消/强杀、恶意tar与并发覆盖保护。未独立测试上游Go age跨工具互通、真实密码人工终端输入、真实盘断电或生产数据；这些不能写为通过。
