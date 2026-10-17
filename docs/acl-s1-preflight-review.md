# S1 单文件受控维护：事前审阅材料

> 版本管理脱敏：实际运行用户 SID 已替换为 `<CURRENT_USER_SID>`；文中 SDDL 为审阅示例，不能直接执行。原始文本保留在本地保护快照。

日期：2026-10-16。唯一候选修改对象：E:\sakie-ai-home\backend\.env。

本文件是Chat审阅方案，不是正式Plan、实际ACL修改批准或已完成验收。本轮未读取、解析、显示或哈希.env正文；未生成真实Plan、写ACL、提权、停服务、创建真实审计目录、修改配置、启动后端/local-agent或操作数据库。本轮仅保存本文、更新文件清单并检查文档格式。

## 1. 本轮只读核对的实际状态

当前账户：艺11\hhdn，SID <CURRENT_USER_SID>，当前令牌未提升。

| 对象 | Owner | 继承保护 | 当前权限要点 |
| --- | --- | --- | --- |
| E:\ | SYSTEM | 未保护 | Users、Authenticated Users显式ReadAndExecute，并向子目录/文件继承；SYSTEM/Administrators完全控制 |
| E:\sakie-ai-home | Administrators | 未保护 | 当前用户显式Modify；普通用户组读取权限从E盘继承，并继续传播 |
| E:\sakie-ai-home\backend | Administrators | 未保护 | 当前用户Modify、Users/Authenticated Users读取、SYSTEM/Administrators完全控制均为继承条目 |
| E:\sakie-ai-home\backend\.env | 艺11\hhdn | 未保护 | 5条继承Allow：当前用户Modify；Users与Authenticated Users ReadAndExecute；SYSTEM与Administrators FullControl |

.env元数据：普通文件，Attributes=Archive，LinkType为空，无ReparsePoint标志；长度1296字节。CreationUtc=2026-10-15T10:03:31.1728696Z，LastWriteUtc=2026-10-15T10:13:24.5923921Z。这里只核对当前文件对象/祖先的可见链接属性，不将其等同于完整NTFS文件身份/所有别名证明。

.env当前DACL（仅权限描述，不含正文）：

~~~text
D:AI(A;ID;0x1301bf;;;<CURRENT_USER_SID>)(A;ID;0x1200a9;;;BU)(A;ID;0x1200a9;;;AU)(A;ID;FA;;;BA)(A;ID;FA;;;SY)
~~~

ID表示继承ACE；BU=Users、AU=Authenticated Users、BA=Administrators、SY=SYSTEM。没有发现Deny。本轮只读访问检查前后，文件大小、LastWriteTime和完整已读取的安全描述符一致；没有进行正文一致性校验。

## 2. 当前令牌有效访问检查

使用CreateFileW(OPEN_EXISTING)申请指定访问权、允许共享并立即关闭句柄，不调用ReadFile/WriteFile/SetSecurityInfo；不打开编辑器，不读取或哈希正文。结果只代表检查时当前令牌，不证明其他账号或未来时刻权限。

| 对象 | 申请权限 | 当前结果 |
| --- | --- | --- |
| .env | READ_DATA、WRITE_DATA、APPEND_DATA、EXECUTE_FILE、DELETE、READ_CONTROL、WRITE_DAC | 全部允许，Win32=0 |
| .env | WRITE_OWNER | 拒绝，Win32=5 |
| backend目录 | ADD_FILE、ADD_SUBDIRECTORY | 允许，Win32=0 |
| backend目录 | DELETE_CHILD、WRITE_DAC | 拒绝，Win32=5 |

结论：S1单文件本身当前具备普通令牌修改DACL的条件；不能由此授权实际修改。父目录缺WRITE_DAC不构成S1阻塞，因为方案不改父目录。无需为S1 takeown、授予运行账户额外权限或开启管理员令牌。

Owner可具有Windows隐含WRITE_DAC。目标FileRead不意味着能够防御账户本人主动修改ACL；本次保护目标是其他普通用户，不是当前账号、SYSTEM或受信任管理员。

## 3. 准确的目标DACL（拟议，未应用）

Owner保持当前SID，不修改Group、SACL、文件属性或正文。文件设置DACL保护，不保留来自backend的继承ACE。恰好保留以下3条显式Allow：

| 主体 | 权限 | 十六进制 | 继承/传播 |
| --- | --- | --- | --- |
| 艺11\hhdn当前SID | Read、Synchronize | 0x120089 | None / None |
| SYSTEM | FullControl | 0x1f01ff | None / None |
| Administrators | FullControl | 0x1f01ff | None / None |

不保留Users、Authenticated Users、Everyone或其他主体；不新增Deny。普通运行用户不显式获得Write、Append、Delete、ExecuteFile、WRITE_DAC或WRITE_OWNER。Read包含读取内容/扩展属性/属性/READ_CONTROL，Synchronize单列；不将ReadAndExecute误当Read。

可审阅的DACL-only SDDL：

~~~text
D:P(A;;0x120089;;;<CURRENT_USER_SID>)(A;;FA;;;SY)(A;;FA;;;BA)
~~~

在内存中成功解析为3条ACE，未写入文件。Windows也可规范化显示用户权限为FR。纯Allow排序可做等价比较，但主体、权限位、ACE数量、保护位和None继承/传播必须一致；不得宽松接受额外ACE。Windows AutoInherited记账位如保留需单列说明，不等于允许再次继承宽权限；Owner、Group和SACL不得借此改变。

该描述只适用于当前机器SID。SID或Owner变更、文件替换、出现链接等情况必须重新审阅，不能照搬这个字符串继续操作。

## 4. 本批边界与编辑器替换风险

直接修改候选仅.env文件DACL。文件无后代，计划内没有目录级传播。backend、项目根、E盘、其他文件、真实数据库/备份、local-agent、原测试资产和旧Plan全部禁止修改。

父目录保持宽继承，这允许其他普通用户看到目录项，也使当前用户在backend中新建的临时文件可能继承Users/Authenticated Users读取。不能为解决S1临时文件问题而扩大到整个backend的ACL修改。

只读进程检查发现Notepad PID 16292；没有读取其窗口标题、正文、标签或句柄，不能确认是否打开.env，不能据此认定它正在写入，也不能认定编辑器已退出。本轮未关闭、保存或停止任何程序。

后续维护窗口必须人工确认与.env有关的编辑器、自动保存、格式化/同步插件、外部脚本及未关闭句柄，不要求用户发送密钥或编辑器内容。不得自动保存未保存缓冲区到宽权限位置。若需处理缓冲区，由用户在已确认安全的位置和流程下自行决定。

具体风险：

1. 编辑器可能先在backend写含密钥临时文件；即使最终替换失败，临时副本也可能已暴露。事后Verify不能撤销这一风险。
2. 文件替换可能改变Owner、文件身份或DACL，并重新引入父级继承；不能承诺所有编辑器都会保留原私有ACL。
3. 目标FileRead不授予Delete，当前父目录DELETE_CHILD也拒绝，普通保存/替换可能失败；不要为让编辑器保存而自动改回Modify或放宽父目录。
4. ACL变化不等于撤销已打开句柄、进程缓存或先前副本；之后应以新开的检查句柄核验。如果存在明确泄露线索，密钥轮换是独立任务，不能本轮自动做。

S1只是固定现存.env的权限，不包含编辑/轮换密钥、安全临时文件工作流或私有配置路径迁移。未来编辑.env前应另开维护窗口，先确认不会泄露临时内容的方法，再授权修改；不以“保存后补ACL”作为安全方案。

## 5. 真实私有审计目的地的前置条件

本轮不创建目录。拟议候选可为项目外的新唯一目录，例如 E:\sakie-ai-home-data\s1-maintenance-audit-<唯一编号>，但该示例不是已批准路径，也不是指向旧acl-review的替代授权。

启用条件：

- 用户明确批准实际绝对路径；不存在且不落入原测试/旧Plan/真实业务数据库或备份树，不通过链接跨界。
- 创建后先核验独立私有DACL：当前普通账户具备审计写入需求，SYSTEM/Administrators保留管理能力，没有Users/Authenticated Users读取；父data宽权限不能代替这一检查。
- 未经独立私有化确认，不写真实路径清单/原DACL/摘要；实际创建与该新目录ACL设置本身也需要另行授权。
- 采用独占新文件，记录批次、当前SID/令牌、具体对象/目标DACL、工具/步骤版本、写前意图及后置结果，持久写入可验证。不得复用或覆盖旧Plan/审计链。
- 操作员在第二处保留审阅哈希/批次及最后确定步骤；不将真实证据附件提交Git或粘贴含秘密内容的截图。
- 审计权限、存储或持久写入检查失败，S1目标零修改退出。已有审计不可写时不能靠“先做再补日志”继续。

选择人工Windows权限界面路线时也需写前持久证据和明确目标，不得点击“替换全部子对象权限”或修改父目录。旧工具的FileRwd profile不是本批FileRead目标，合成执行入口也不能改路径就处理此文件；具体执行手段仍须审核。

## 6. 前后核验与内容一致性的边界

### 6.1 执行前（未来另行批准）

- 再核对当前SID、Owner、非提升令牌、唯一绝对路径、链接/别名/文件身份、原DACL与父DACL、元数据是否仍符合本次审阅。
- 用户确认相关编辑器/写入者已暂停；本轮不代为关闭。维护过程不启动后端/local-agent，不调用数据库CLI、status或模型。
- 当前真实令牌对.env的WRITE_DAC重新通过；无需父目录WRITE_DAC，任何失败停止，不自动提权。
- 审计已私有可持久；原权限与拟议3条Allow及执行方法已经具体授权。写前记录意图，保持最多一个在途对象。

**正文校验需独立明确权限：**本轮禁止读取正文，因此连SHA256也没有计算。大小/时间/ACL相同不能证明正文逐字相同。若未来验收要求完整内容不变，应明确授权可信本机工具只读取原始字节计算摘要、只输出摘要而不解析/显示密钥，分别在写前/写后完成；不把该授权从本轮推断出来。如果仍禁止任何工具读取任何正文字节，只能报告元数据级核验，不得称为完整内容一致性验证。若选择私有内容备份，同样需独立授权和安全目的地，本轮不复制.env。

### 6.2 写入后（未来另行批准）

- 立即重新获取新句柄和安全描述符，Owner/Group/SACL保持原样；Protected=true；3条显式Allow与目标掩码、None继承/传播精确匹配。
- 当前普通令牌READ_DATA/READ_CONTROL/Synchronize应允许，WRITE_DATA/APPEND_DATA/DELETE/EXECUTE_FILE/WRITE_OWNER应拒绝；WRITE_DAC可能因Owner仍允许，不能错判为FileRead失败，也不能把它描述为完全防篡改。
- 父目录原DACL、Owner和继承标志保持原样；不以目录时间变化作为唯一越界证据，不容许父ACL变化。
- 文件大小/创建与修改时间/身份核对；如已获摘要权限，再核对前后摘要。不读配置值、不做真实模型或业务调用来证明可读。
- 追加核验完成记录并保留审计尾边界；只有目标和不变式满足才报告本批完成。人工界面“应用成功”或原生API返回成功本身不等于验收通过。
- 跨普通账号实际拒绝访问尚未验证；如需验证，使用另行获准的已有账号进行不读取内容的访问权检查，不临时创建账号。

## 7. 故障停止与人工处置

| 情形 | 安全处置 |
| --- | --- |
| 文件/Owner/SID/元数据/原DACL不符，出现链接或证据不可写 | 不修改目标，保留差异；不修订基线迎合现状，不提权重试 |
| 编辑器关联不明确或仍可能保存/替换 | 等用户确认；不自动关程序、保存缓冲或修改backend目录权限 |
| 有意图但无结果、进程退出或无法读回 | 状态未知，停止；只读比较原态、批准目标和实际态，不能自动重试 |
| 当前与原态一致 | 只报告当前一致，不证明历史上未改；若再执行需重新确认窗口和授权 |
| 当前符合目标但完成记录缺失 | 保留原日志，独立重审可确认当前目标态；不得伪造原步骤完成 |
| 目标DACL不符、Owner变化、文件身份/内容变化 | 保留现场，不写回旧内容、不删除新副本、不takeown/reset；等待逐项决定 |
| 审计不可写或损坏 | 停止新ACL写入，不修补/覆盖旧链；能安全另存观察则另存，否则明确证据不可持久化 |

本入口不提供自动恢复。恢复原DACL会重新开放普通用户组读取，需要明确说明后另行授权；保持已成功的FileRead可能更安全，但由用户审阅决定。任何恢复仅针对DACL，不更改文件内容、Owner或数据库；不能证明当前状态安全就不恢复。父目录和旧Plan永不作为本批“修复”对象。

## 8. 当前放行状态与下一步授权边界

已具备：现存单文件范围明确；当前普通令牌WRITE_DAC通过；目标3条Allow已在内存解析；不需父目录权限或管理员提升。未具备：相关编辑器确认、获准私有真实审计位置、实际执行手段及本批真实写入授权、正文一致性核验口径。

建议Chat审核后只推进以下有限准备，不重复已验收实验：

1. 确认Notepad等是否关联该文件及后续无并发保存的维护窗口，不要求提供密钥。
2. 批准实际私有审计位置及其初始化（本轮不执行）。
3. 明确是否授权本机前后只输出摘要的字节级校验，或接受仅元数据级的有限结论。
4. 审阅确切单文件操作方法和本目标DACL后，才单独授权S1真实修改；不扩展到父目录、S2—S7、密钥编辑、服务重启或迁移。

## 9. 本轮交付和验证

新增 docs/acl-s1-preflight-review.md、更新FILES.txt；未修改工具、业务、测试或配置。只读访问句柄检查和内存SDDL语法检查实际执行，文档格式检查通过；没有读取/哈希.env正文、生成真实Plan或审计目录。没有运行原实验、typecheck/test/build、服务、数据库操作或Git提交推送。停止等待Chat审核。
