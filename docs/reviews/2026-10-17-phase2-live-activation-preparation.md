# Part 2 正式启用准备与集中授权单

2026-10-17。已读取 main 最新 PROJECT-STATUS、真实HTTPS验收报告及产品规范v1.1。合成公网验收结论沿用，不重跑132项回归、此前HTTPS或浏览器测试；本轮没有连接服务器、打开正式主库、读取真实密钥、修改真实ACL、安装常驻任务或改DNS。已否决HTML样稿未采用，前端业务文件未改，完整产品要求不缩减。

## 实际交付

- 开始保护162份未提交源文件/文档和原本地Git历史。新增 tools/activation/{checkpoint,render,agent-host,rehearse,release-candidate}.mjs、activation.test.mjs、RUNBOOK.md；修改package.json/README增加入口，release-audit增加.conf/.xml文本配置扫描，check-private增加严格ReadOnly身份角色。其他原存量业务源码未覆盖，正常暂存区为空。
- **可恢复私有版本已实际完成**：E盘项目 .phase1-work/private-activation-Htzw45，独立无远程Git提交 `63acc2fb88c7c8b90dbbba45cf1ed7864ee9563a`；original-history.bundle、complete-source.bundle、SHA清单齐全，165份审阅源文件实际克隆恢复且逐字节相同。3份机器身份文档不加入新源码覆盖层，原文件/保护快照/已有历史保留。没有公开上传完整源码；本地无远程不等于加密异盘备份。
- **持久运行已编码、未安装**：render生成正式API Compose/Nginx、Windows任务XML、run/policy；草稿产物在开始保护目录的runtime-templates，使用example.invalid和合成SID，不可直接安装。真正安装须从固定私有版本checkout生成并构建，不能让任务跟随可变开发树。
- 云端模板沿用现有生产server入口，持久挂载、只读身份、unless-stopped、有界日志，127.0.0.1:3401。使用普通Compose桥接允许未来模型HTTPS出站，不再依赖验收实例固定容器IP；不改Docker全局配置。512MiB/0.75CPU仅建议上限，未宣称生产实测。
- Windows宿主沿用现有CLI/协议：普通账户InteractiveToken、LeastPrivilege、IgnoreNew；无存储登录密码。协议内部处理断网，进程异常30秒退避；blocked/状态不明安全停止；已证明死亡PID的锁留证后重建，活动/未知PID或损坏锁要求人工处置。**仅用户登录后自动运行；开机未登录不运行，不冒充Windows系统服务。**
- 恢复候选的显式解除隔离工具：必须v4、账本/完整性及批准指纹一致、全新owner使恢复的旧会话失效、无活跃设备，持有SQLite写预留期间先写激活收据再更新标记。仅维护候选、要求全新归档与配对；不会由服务启动自动执行，不能删标记绕过。

## 本轮验证

| 验证 | 实际结果 |
| --- | --- |
| 冻结历史真实数据副本 | 使用既有2026-10-15 v3快照的字节副本，先复制到已核验私有验收目录的新子目录，再SQLite检查；未打开当前主库。2条历史消息/2事件保留，旧表列值/UUID/outbox不变 |
| 迁移及恢复7项 | 来源清单/哈希、注入DDL后中断事务回退、v3→v4保留、重复迁移no-op、v4备份恢复指纹、拒绝覆盖目标、恢复启动隔离，全部通过 |
| 新增运行/激活定向测试 | 3/3通过、0跳过：配置与普通任务边界，危险路径/blocked/锁策略，候选指纹/新owner/设备/重复激活门槛 |
| 权限门槛 | 现有私有副本根Modify检查通过；ReadOnly模式拒绝用户拥有且可写的目录，没有因此重写ACL |
| 版本交付 | 完整bundle实际克隆恢复及165文件哈希通过；git diff --check通过；最终扫描143源码候选、26复核项、0阻断，机器身份文档继续隔离 |

最新私有演练结果：既有sync-acceptance目录中新建 activation-rehearsal-d7w35k/result.json。正式主库的**当前**版本、消息数量和写入端本轮未验证；历史快照不能当作当前备份。未测试实际Task Scheduler安装/注销/整机重启、正式Compose运行或真实候选激活，这些不是已实现即已上线的声明。

## 集中授权单（本轮仅准备，待用户/Chat批准）

| 范围与精确路径 | 授权后的动作/影响 | 失败停止与回退 |
| --- | --- | --- |
| 当前 E:\sakie-ai-home-data\cloud\sakie.db；新 E:\sakie-ai-home-backups\activation-live | 确定全部写入端并停写，一致性备份/校验；只恢复到新候选，推荐**不原地升级旧主库**。独立介质/加密备份目标需指定，同E盘备份不能抵御整盘损坏 | 指纹变化或写入端不明确即停；原库保持原样。新云已写消息后绝不用旧库覆盖 |
| 精确 backend/.env；新 windows-live、identity-live、backups/activation-live；固定私有发布目录 | 普通用户归档/状态Modify；身份配对阶段私有可写，完成后维护所有者+用户只读；旧.env单文件私有化，停编辑并防编辑器替换重继承。只治理新闭合集及该单文件，**不改data/backups根和旧夹具/旧Plan** | 管理员维护仅用于批准对象；权限/所有者/继承不符停。旧文件父目录替换风险必须核验，未来密钥由用户私密外置配置，不让助手读取 |
| 首尔新 /srv/sakie-home/releases/<私有版本>、data、backups、identity；新 /etc/nginx/sites-available/sakie-home-api | 私密部署固定版本、正式恢复候选、新owner/backend.env；独立HTTPS域名与证书待确认（建议home.sakiehome.icu）。仅3401回环，不替换sync-check、phos或主域/www；模型密钥由用户自己私密配置 | 宿主资源/端口/站点基线异常停；只停新增组件、禁新增站点后nginx-t/reload，保留新数据/收据；不操作旧上海/phos/Docker主服务 |
| E:\sakie-ai-home-data\windows-live\archive.db；identity-live内全新agent-credentials-live.json、policy、approval | 用户终端精确生产地址确认；新一次性配对码仅私有文件；创建**全新**归档身份，先once追平核对原始ID/哈希/ACK；不用已撤销合成身份 | 恢复代次/水位不符即停，不重置游标。撤销仅指定正式设备，保留库；重配必须新凭据和新审核绑定 |
| 计划任务 SakieHome-LocalAgent，艺11\hhdn普通令牌 | 从固定私有发布checkout导入XML；登录后运行，不存用户密码、不提权。先确认“登录后启动、未登录视作离线”是否满足本次正式启用要求 | 先停/禁该任务再撤销指定设备；未知锁/永久错误不盲重启。开机前运行若必需，另选账户方案，不能暗中提权 |

正式域名、登录后运行方式及独立备份落点是执行前需要确认的配置；本授权单本身不视为批准。UI仍按v1.1后续实施，此批只准备API/Agent，不能将API就绪称为完整网站上线。下一步批准后按RUNBOOK一次维护批次执行新备份→候选演练/激活→私有固定版本部署→新设备追平→封存身份权限→安装任务；不重新开展大型架构预审。
