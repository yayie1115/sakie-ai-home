# memory-next 候选代码核对与接入门槛 · 2026-10-18

> 当前状态：核对清单；不是候选代码已存在的证明，也不是实施授权。配套 `chat-memory-evidence-contract-v1-draft.md`。

## 已确认
- GitHub 仓库 `yayie1115/sakie-ai-home` 当前分支列表只有 `main`，按 `memory`/`next`/`candidate` 搜索均无匹配分支。
- `main` 中的 `backend/src/modules/memory/routes.ts` 是基础记录 API；`backend/src/modules/chat/context.ts` 明确没有长期记忆检索。
- 当前 GitHub 代码搜索没有找到候选实现，不能推断 Codex 本地、历史提交或未提交补丁不存在。

## 请 Codex 在本地项目只读核对
1. 在 `E:\sakie-ai-home` 查看 `git status --short`、`git branch -a`、`git log --all --oneline --decorate -40`、`git stash list`，**只读**，不得清理、重置或切换覆盖工作区。
2. 查找 `memory-next`、`memory candidate`、`evidence`、`provenance`、`memory_claim` 等文件、类、测试和补丁，排除 `node_modules`、构建产物及私人数据目录。
3. 对每个候选结果给出：相对路径、提交/分支/补丁来源、是否已纳入 Git、核心能力、测试状态、与 `docs/design/chat-memory-evidence-contract-v1-draft.md` 的差距。
4. **不要**读取或操作 `E:\sakie-ai-home-data\cloud\sakie.db`、生产凭据、真实备份或私人记忆内容；只检查源代码和合成测试。
5. 若候选代码存在，先给出安全集成计划，不自动 cherry-pick、merge、stash pop 或覆盖文件。若不存在，明确报告“在已检查范围内未找到”，再按契约拟定最小实现计划。
6. 返回一份简短资产清单和下一步建议，**本任务不编码、不迁移、不部署、不调用真实模型**。

## 验收
- 可区分已在 main、仅在本地、未提交、未找到四种状态。
- 不把设计文档当作已实现能力。
- 对消息版本有效性、证据来源、权限门禁、删除/恢复、跨会话隔离、失败关闭分别说明复用点和缺口。
