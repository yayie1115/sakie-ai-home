# Chat v11 候选源码交付核对

2026-10-18。依据既有 `2026-10-18-chat-v11-frontend.md` 与提交 `0de311f` 中实际文件 `2026-10-18-chat-v11-submit-integration.md`。仓库确认 Private，main 起点 `0de311f`；已 fetch 核对无远程新增差异。开始前 29 个未提交文件逐一复制并校验至忽略目录，未 pull/reset/stash、清理工作区或覆盖其他工作。

## 分类与安全范围

- 本轮提交：下列 18 个 Chat 源码/测试文件，加本报告，共 19 个文件；既有两份报告保留历史快照，不重写先前测试记录。
- 排除并原样保留：MEM-04 两个提取模块、43 项测试及其报告（共 4 个文件），README 历史大幅替换（1 个），路由/入口/旧预览的 `.bak` 与 `.v11-backup`（6 个）。这些不属于此次审核后的 Chat 源码交付。
- 未纳入：`.env`、密钥/凭据、数据库/WAL/SHM、真实聊天/媒体、备份、日志、浏览器配置、node_modules 与 dist；项目外的数据/备份目录不在 Git 范围。
- 对全部候选文件执行路径白名单、内容审阅、常见 Token/私钥格式扫描与暂存预览；演示密码仅为源码定义的公开合成值 `demo-only-sakie-v11`。只按精确文件清单暂存，不使用全量 add。

## 准确提交文件清单

1. `backend/src/modules/chat/v11-lab/codec.ts`
2. `backend/src/modules/chat/v11-lab/routes.ts`
3. `backend/src/modules/chat/v11-lab/store.ts`
4. `frontend/src/app/router.tsx`
5. `frontend/src/main.tsx`
6. `frontend/src/modules/chat/GroupChatPreview.tsx`
7. `frontend/src/modules/chat/group-chat-preview.css`
8. `frontend/src/modules/chat/v11/ChatWorkspace.tsx`
9. `frontend/src/modules/chat/v11/LinkedChatDemo.tsx`
10. `frontend/src/modules/chat/v11/Timeline.tsx`
11. `frontend/src/modules/chat/v11/state.ts`
12. `frontend/src/modules/chat/v11/submission.ts`
13. `frontend/src/modules/chat/v11/useLongPress.ts`
14. `packages/contracts/src/chat-v11.d.ts`
15. `packages/contracts/src/index.d.ts`
16. `tools/chat-v11.acceptance.mjs`
17. `tools/chat-v11-lab.mjs`
18. `tools/chat-v11-linked.acceptance.mjs`
19. `docs/reviews/2026-10-18-chat-v11-source-delivery.md`

路由/入口是可运行交付必需的相关改动，已单独审核：仅增加隔离预览路径，不替换 `/chat`。入口另修正一处安全问题：通过 `useLocation` 在站内导航时重新判断免登录预览例外，离开 `/demo/chat-group` 后恢复 owner AuthenticationGate；不是只在首次载入判断 window.location。没有改后端认证逻辑。测试补充首次运行创建自身忽略目录，未删除旧夹具。

## 实际验证

- `npm run typecheck`：四工作区通过。
- `npm run build --workspace backend` 与 `npm run build --workspace frontend`：通过。
- `node --import tsx --test tools/chat-v11.acceptance.mjs`：**14/14 通过**，原 13 项交互证据继续通过，新增预览→真实 Chat 站内导航认证门禁测试。
- `node --import tsx --test tools/chat-v11-linked.acceptance.mjs`：**15/15 通过**，认证/CSRF/Origin、规范批次、并发/丢回执重放、UUID冲突、原子 outbox 故障回滚、来源引用版本核验、旧协议归档、重启持久性及手机视口真实 Edge 联调均通过。
- 使用暂存索引导出独立候选目录（既有 main + 精确 19 文件清单），确认其中没有未提交的 MEM-04 提取模块；在导出中再次完成四工作区 typecheck、前后端 build、14 项 UI 和 15 项联调测试，全部通过。复用了本机现有锁定依赖，未做全新 npm ci；不是生产资源或部署验证。

未重做 UI/批提交闭环，未重跑 132 项旧回归或真实公网验收。测试全部是新的合成库、假模型、回环服务和独立浏览器配置，不等于生产验收。没有连接正式数据库、执行生产迁移、部署、修改 ACL/DNS/备份或调用真实模型。

## 可复现入口

Node.js 24；安装仓库锁定依赖后，运行前后端 build。合成联调：`node tools/chat-v11-lab.mjs --no-build`，仅回环 `5191`，网页 `/demo/chat-group?lab=1`，按界面使用公开合成密码登录。它只创建新合成库，不打开正式主库。纯 UI 用 Vite 打开 `/demo/chat-group`，不加 lab 参数；普通 Vite 页面误带 lab 参数会在发任何认证请求前停止。两组测试需要本机 Edge，不静默跳过缺失浏览器。不要在演示输入私人内容。

## 剩余开发顺序与兼容风险

1. **正式气泡与版本**：先在合成 SQLite 验证追加 bubble/version 表及 legacy 映射；保留原消息 UUID、turn、messageSeq、内容哈希和既有迁移。活动版本指针、单泡/整回合重生成、幂等请求、搜索/上下文版本一致性一并设计。当前 envelope 只是合成兼容候选：旧客户端/普通模型会看到编码原文，不可直接启用真实聊天；现有 chat_message_state 不是完整版本历史。
2. **群聊成员权限**：在版本/会话边界稳定后加入可信 persona、成员关系、membershipRevision 与同事务门禁。共用人格/模型不代表可跨会话读取；新成员仅可读本群获准全历史，撤权即时限制读取、引用和生成接纳。不能把 owner 登录或客户端 actor 列表当作 AI 权限。
3. **统一回收站**：复用同一会话有效性门禁，追加软删/恢复元数据，覆盖读取/提交/生成中断结果、同步和恢复再核验。30 天不等于自动物理清除所有副本；原 outbox 未确认前不可清理。新事件必须先做消费者能力/协议兼容，不可让旧 local-agent 收到无法处理的新 kind。
4. **记忆联动**：只在稳定的 bubble/version/权限/软删契约上复用现有 memory-next。来源需明确 parent messageId、bubbleId、active version/revision 与授权范围；编辑/撤权/回收站要在检索时即时失效，恢复重新审核，多源结论按仍有效证据重算。不得把 envelope 直接当自然语言来源，也不重做已有提取批次和版本失效机制。

上述顺序是后续开发，不是本轮已实现。当前仍是合成私聊批提交；群聊权限、真实版本、统一回收站传播和记忆接入未完成。其余已确认 v11 媒体、语音、未读定位、真实操作日志等需求保留，不能因本轮未做而删除。

本轮不推进任何生产启用。后续真实数据备份/迁移、正式 ACL、部署和付费调用须另行明确授权；纯合成代码验证可继续按既定边界实施。
