# 第一阶段实际修改文件清单

基线：main / 4406ef0。未提交、未推送。architecture-review.md 是本轮开始前已存在的未跟踪报告，本轮保持不变，不计入本清单。

共 44 个新增或修改文件；构建产物、真实数据、测试临时目录和备份不属于源码交付清单。

| 状态 | 项目相对路径 |
| --- | --- |
| 修改 | [.dockerignore](../.dockerignore) |
| 修改 | [.gitignore](../.gitignore) |
| 修改 | [FILES.txt](../FILES.txt) |
| 修改 | [README.md](../README.md) |
| 修改 | [backend/.env.example](../backend/.env.example) |
| 修改 | [backend/Dockerfile](../backend/Dockerfile) |
| 修改 | [backend/package.json](../backend/package.json) |
| 修改 | [backend/src/app.ts](../backend/src/app.ts) |
| 新增 | [backend/src/cli.ts](../backend/src/cli.ts) |
| 修改 | [backend/src/config/env.ts](../backend/src/config/env.ts) |
| 新增 | [backend/src/database/backup.ts](../backend/src/database/backup.ts) |
| 新增 | [backend/src/database/fingerprint.ts](../backend/src/database/fingerprint.ts) |
| 修改 | [backend/src/database/index.ts](../backend/src/database/index.ts) |
| 新增 | [backend/src/database/legacy-schema.ts](../backend/src/database/legacy-schema.ts) |
| 修改 | [backend/src/database/migrations.ts](../backend/src/database/migrations.ts) |
| 修改 | [backend/src/database/repository.ts](../backend/src/database/repository.ts) |
| 新增 | [backend/src/database/upgrade.ts](../backend/src/database/upgrade.ts) |
| 新增 | [backend/src/modules/auth/credentials.ts](../backend/src/modules/auth/credentials.ts) |
| 新增 | [backend/src/modules/auth/routes.ts](../backend/src/modules/auth/routes.ts) |
| 新增 | [backend/src/modules/auth/service.ts](../backend/src/modules/auth/service.ts) |
| 修改 | [backend/src/server.ts](../backend/src/server.ts) |
| 新增 | [backend/src/storage/ports.ts](../backend/src/storage/ports.ts) |
| 新增 | [backend/src/storage/prepare.ts](../backend/src/storage/prepare.ts) |
| 修改 | [backend/test/app.test.ts](../backend/test/app.test.ts) |
| 新增 | [backend/test/auth.test.ts](../backend/test/auth.test.ts) |
| 新增 | [backend/test/helpers.ts](../backend/test/helpers.ts) |
| 修改 | [backend/test/records.test.ts](../backend/test/records.test.ts) |
| 新增 | [backend/test/storage.test.ts](../backend/test/storage.test.ts) |
| 新增 | [backend/tsconfig.test.json](../backend/tsconfig.test.json) |
| 修改 | [docs/data-layer.md](../docs/data-layer.md) |
| 新增 | [docs/phase1-files.md](../docs/phase1-files.md) |
| 新增 | [docs/phase1-implementation.md](../docs/phase1-implementation.md) |
| 新增 | [docs/sync-protocol-v1.md](../docs/sync-protocol-v1.md) |
| 修改 | [frontend/Dockerfile](../frontend/Dockerfile) |
| 新增 | [frontend/src/app/AuthenticationGate.tsx](../frontend/src/app/AuthenticationGate.tsx) |
| 修改 | [frontend/src/main.tsx](../frontend/src/main.tsx) |
| 新增 | [local-agent/package.json](../local-agent/package.json) |
| 新增 | [local-agent/src/index.ts](../local-agent/src/index.ts) |
| 新增 | [local-agent/tsconfig.json](../local-agent/tsconfig.json) |
| 修改 | [package-lock.json](../package-lock.json) |
| 修改 | [package.json](../package.json) |
| 新增 | [packages/contracts/package.json](../packages/contracts/package.json) |
| 新增 | [packages/contracts/src/index.d.ts](../packages/contracts/src/index.d.ts) |
| 新增 | [packages/contracts/tsconfig.json](../packages/contracts/tsconfig.json) |
