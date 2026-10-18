# M0-2 手机 Chat UI｜工作分支候选交付

日期：2026-10-18。分支 `m0-2-mobile-chat-ui`，起点 `056251d`（已含初版 MobileChatPreview）。仅 M0-2 UI/独立只读测试候选；未部署、未调用模型，不代表手机首通或 M0-3/M0-4/M0-5 完成。

## 权威依据与同步

已读取 GitHub main 的 `docs/00-唯一开发任务书.md`，main 为 `327f70c`。切换前校验工作分支同文件 blob 为 `b5eb70142ba7a30fe84800c33041add859acb2a9`，与 main 完全一致。保留现有 README 和六个前端历史备份的未提交状态；已复制并比对 SHA-256，不覆盖、不混入提交。

本轮没有合并/更新 main，没有另立任务书。唯一任务书保持原文与未完成勾选，不能在尚无 iPhone 实机和独立公网部署证据时勾选正式完成；后续状态由 Chat 按其双端同步规则更新。此文件是交付证据，不是平行任务书。

Git 代理首次 fetch 出现 TLS 中断；使用单次网络参数及直连恢复同步，没有改全局 Git 配置、reset、stash 或覆盖工作区。

## 实际实现

- `/m0/chat` 由 M0Boundary → 原 AuthenticationGate → MobileChatPreview 接线；保留登录、session、CSRF 与退出。未复用 `/demo/chat-group` 的公开预览例外。
- 页面移出旧 Layout 的网站大标题和八项导航，采用已确认 Home/Chat/World、手机先列表后聊天、居中私聊标题、无顶栏头像、消息侧头像、详情页和推开式侧栏。Home/World、新建、回收站及尚未接通的操作禁用/明示。
- 从 ChatWorkspace 原样提取复用 ConversationRow；复用 Timeline 的气泡、长按、复制、头像和输入区，增加默认关闭的 M0 只读呈现。不实例化合成 ChatWorkspace，不导入或调用其 initialWorkspace 作为 M0 数据。
- 真实调用受认证的旧 v4 `GET /api/chat/config`、`/conversations`、`/conversations/:id/messages`，按 API 返回内容、UUID 和 revision 展示。模型未启用就显示“模型未启用”，不虚构模型名、Token/缓存或 AI 回复。
- 实现列表搜索（仅已加载会话）、列表分页、历史分页、详情内刷新、错误/空态、慢响应竞态隔离、断网提示、查询参数定位、返回和刷新读取。分页在 React 布局提交后恢复原消息的像素锚点；阅读历史时键盘视口变化不强制跳到底。
- 切换会话时保留本页内独立草稿、已加载历史和滚动位置；重新打开仍先向服务端请求验证权限。缓存仅在本次 React 生命周期内，退出即卸载；刷新不承诺恢复草稿/滚动，M0-4 尚未实施。
- 输入可编辑以验收键盘与多行草稿，发送/暂存/附件/编辑/引用/重生成未开放；Enter 不创建气泡或发请求。长按仅允许复制当前已保存来源，其余操作禁用。
- 使用 VisualViewport 的 resize/scroll、窗口变化和焦点事件测量视口，保留 `viewport-fit=cover`、safe-area padding、16px 输入、聊天内部滚动；键盘收起恢复底部导航，键盘模拟展开时隐藏底部导航以保留输入区。支持浅色/深色，样式限定 M0。

## 独立测试配置与数据真实性

`tools/m0-test-server.mjs` 是独立本地运行器：

1. 固定绑定 `127.0.0.1`，本地端口 5193；不允许 host、数据库、身份、resume 或模型 CLI 参数。不对局域网/公网监听。
2. 每次在项目外既定 tests 区 `m0-mobile-ui-*` 新建唯一目录和 `m0-test.sqlite`，使用独占 `wx` 文件创建；不接受现有库路径，不覆盖旧测试库。只初始化新空库的既有 v4 结构，不改正式迁移表或生产编号。
3. 默认零会话、零消息、零模型尝试；不导入 `.env`，不创建 DeepSeekProvider，ChatService 的 provider 显式为 null，worker 不启动。没有后台同步或外部连接。
4. 复用现有认证，开发登录材料只用于本次进程/新库；默认本机测试口令是公开非秘密值 `m0-local-readonly-test-only`，**不能用于公网或反向代理暴露**。
5. 认证后仅允许旧 Chat GET/HEAD；业务 POST/PATCH/DELETE 全部拒绝，/sync、/devices、memory 和 lab 操作路由不挂载。auth 登录/退出仅写新测试库的 session，不写聊天。
6. `/m0/chat` HTML 注入独立 marker；前端在请求 auth/chat 前检查 marker 和 `/api/m0/capabilities` 的只读、无模型、v4 能力。普通 Vite 或正式静态页无 marker 会停止；伪 marker/不匹配能力同样停止，避免默认代理误连现有 3000 后端。
7. 自动化测试才能显式传 `fixtureData:true` 和 seed 回调，并严格校验布尔类型。数据通过 ChatStore 写入新夹具，消息均带 `[UI_TEST_FIXTURE]`，列表标记“自动化测试夹具 · 合成记录”。**它们只证明 UI/HTTP，不冒充真实聊天或模型回复**；CLI 默认不提供 seed。

默认空库不能凭空出现谢亦言会话或回复；无会话时显示明确空态。测试中输入区通过标记夹具验证，真实测试会话的创建/模型写入须后续单独接入，不能为了截图填充假内容。

### 本地运行

```powershell
Set-Location E:\sakie-ai-home
node tools/m0-test-server.mjs
```

运行器构建前后端后显示 `http://127.0.0.1:5193/m0/chat`。Windows 本机可登录，默认查看空库。已构建时可加 `--no-build`；Ctrl+C 关闭。这个地址不是 iPhone 可用的公网地址；本轮自动验收服务/浏览器已经关闭，没有安装常驻服务。没有服务器重启复用库功能，不宣称 M0-4 已通过。

## 已执行的验证

| 验证 | 实际结果 |
|---|---|
| 四工作区 `npm run typecheck` | 全部通过 |
| 四工作区 `npm run build` | 全部通过 |
| M0 独立 HTTP/浏览器验收 | 16/16 通过，0 失败、0 跳过 |
| 原 v11/DATA-01/OPS-02/批提交工具回归 | 串行 41/41 通过，0 失败、0 跳过 |
| 原 `chat.test.ts` + `app.test.ts` | 17/17 通过，0 失败、0 跳过 |
| 原 `auth.test.ts` | 6/6 通过，0 失败、0 跳过 |

命令：

```text
npm run typecheck
npm run build
node --test --test-concurrency=1 tools/m0-mobile-chat.acceptance.mjs
node --import tsx --test --test-concurrency=1 tools/chat-ops02.acceptance.mjs tools/chat-data01.acceptance.mjs tools/chat-v11.acceptance.mjs tools/chat-v11-linked.acceptance.mjs
npm exec --workspace backend -- tsx --test test/chat.test.ts test/app.test.ts
npm exec --workspace backend -- tsx --test test/auth.test.ts
```

后两组及旧工具回归显式设置空 dotenv 路径、空模型配置和本轮项目外新测试 DATA_DIR/DATABASE_PATH/BACKUP_DIR/身份路径。没有执行完整后端 259 项、真实公网同步、真实模型、真实 DB、部署或 Safari 实机；旧数字不计入本轮通过。

M0 的 16 项由 6 个独立环境/API/空态用例，加 1 组浏览器父用例及 9 个子用例组成；不把内部步骤重复累计。Edge Chromium 使用 393×852、iPhone UA 及可视视口键盘模拟，另测 1280×900 桌面/深色。验证登录前零 Chat 请求、登录/退出/刷新、精确居中、禁用状态、无横向溢出、多行不提交、输入区位置、原消息锚点、会话隔离、详情和推开侧栏、断网恢复、迟到响应隔离；消息/outbox 原始行前后完全相同、chat_attempts=0。

开发中实际修复了分页锚点丢失、返回会话只重读最新页导致滚动失真，以及隐藏容器滚动事件覆写位置。锚点测试按原可见消息的实际偏移核验；前插记录填入原顶部留白时，新首个可见 ID 可以变化，不据此误判。换行转义和详情刷新新增后的测试断言也已纠正，没有使用失败前数字冒充最终结果。

## 设计原文缺口与未验收项

- 仓库没有完整《01-Chat需求与交互合并版》/Chat UI v3 原文及精确视觉稿；唯一任务书明确其仍是工作稿。本轮依据任务书引用、产品 v1.1、已提交 v11 组件；旧 HTML 没有作为最终稿覆盖这些规则。
- 缺少 v3 最终间距/字号/图标资产、完整颜色 token、iPhone 各屏精确画面及过渡规范；目前继承 v11 雾白/深灰蓝/雾霾蓝变量。没有声称像素级视觉验收。
- 旧 v4 API 没有角色头像 URL、备注字段或实际模型名；保留已有文字头像/真实会话标题，模型关闭时明确未启用。不得凭空造正式角色配置。
- **未用真实 iPhone Safari/WebKit、真实软键盘或刘海安全区实测**。Safari 地址栏伸缩、横竖屏、输入法组合、键盘弹出/收起、触控长按/滚动、密码自动填充仍需 M0-5 实机验证；Chromium UA/高度模拟不是这些结论。
- 没有 M0 公网测试域名/HTTPS 部署和手机真实登录证据；M0-2 仅代码候选，不勾选正式完成。发送/付费模型属于 M0-3，跨服务重启持久性与断线重发属于 M0-4。

## 服务器部署前的隔离配置与风险（仅方案，未执行）

必须另批后才可实施，不可直接把此本机运行器用 Nginx 暴露：

- 独立测试 host `<M0_TEST_HOST>`、TLS 和同源 `/api`；当前真实 Origin 只允许本机 HTTP。公网需明确 HTTPS PUBLIC_ORIGIN、Secure/HttpOnly cookie、独立私有身份 verifier，并移除公开开发口令；这些上线配置尚未实现/应用，不能复制本机配置就称安全。
- 新服务仅绑经核准的回环端口；独立目录建议 `/srv/sakie-m0-test-ui/<RUN_ID>/{data,identity,backups}`（提案，不是已创建路径），不复用 activation-lab 旧库、同步验收路径、Windows 主库或 Phosphene 持久卷。
- 独立 Nginx server block 和证书；先检查配置、端口与现站，再受控 reload。无 WebSocket 实现，不伪装 /ws。不得修改主域/www、phos、同步服务或 DNS；如新测试 host 需要 DNS，另行授权。
- 部署包/测试身份不进 Git；只读/无模型模式仍须保持。设置有限日志与资源预算并实测，不能把本地布局测试当云端内存占用证据。
- 回退仅移除新 M0 server block/服务引用、保留独立测试目录留证；不得覆盖/恢复旧库、停止既有服务或删除数据。本轮没有执行这些变更，也没有 SSH 连接云端。

## 精确修改文件（14）

1. `frontend/index.html`：viewport-fit=cover。
2. `frontend/src/main.tsx`：M0 专用隔离边界，仍要求登录。
3. `frontend/src/app/router.tsx`：M0 移出旧 Layout，其他路由不变。
4. `frontend/src/app/AuthenticationGate.tsx`：复用认证，M0 登录样式/退出入口适配。
5. `frontend/src/app/api.ts`：复用退出动作 context。
6. `frontend/src/modules/chat/MobileChatPreview.tsx`：真实只读页面接线、状态与导航。
7. `frontend/src/modules/chat/m0/M0Boundary.tsx`：误连阻断及可视视口监听。
8. `frontend/src/modules/chat/m0/mobile-chat.css`：M0 独立手机/桌面/安全区样式。
9. `frontend/src/modules/chat/v11/ConversationRow.tsx`：提取原有会话行供复用。
10. `frontend/src/modules/chat/v11/ChatWorkspace.tsx`：调用提取组件，合成逻辑不变。
11. `frontend/src/modules/chat/v11/Timeline.tsx`：可选只读呈现、分页锚点及视口适配，默认模式不变。
12. `tools/m0-test-server.mjs`：独立空库、回环只读测试配置/运行器。
13. `tools/m0-mobile-chat.acceptance.mjs`：HTTP、安全、空态、手机/桌面浏览器验收。
14. `docs/reviews/2026-10-18-m0-2-mobile-chat-ui.md`：本交付证据。

仅这些源码/测试/脱敏报告可提交；构建产物、SQLite/WAL/SHM、浏览器 profile、测试截图/日志和旧未提交工作留在忽略/项目外目录。唯一任务书原文、正式 Chat、后端源码、同步/Agent、memory-next、真实备份和生产数据均未修改。
