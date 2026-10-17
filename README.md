# sakie-ai-home

Private AI companion system

长期维护的个人 AI 系统基础工程。前端 React + TypeScript + Vite + React Router，后端 Node.js + TypeScript + Express。使用 npm workspaces 统一安装依赖，前后端独立构建、独立运行。已实现 SQLite 基础数据层和 Memory、Diary、Dream、Activity 的创建、查询、删除 API。第二阶段第一部分已加入 DeepSeek 文本聊天适配器和最简聊天页；真实模型需在后端配置，其他模块仍为基础 API 或占位页面。详细模型、API 请求格式和备份说明见 [基础数据层](docs/data-layer.md)。

## 目录

```text
sakie-ai-home/
├── frontend/
│   ├── src/
│   │   ├── app/              # 路由及公共布局
│   │   ├── modules/          # chat/memory/diary/dream/activity/music/device
│   │   ├── main.tsx
│   │   └── styles.css
│   ├── index.html
│   ├── vite.config.ts       # 开发服务器及 /api 代理
│   ├── tsconfig.json
│   ├── package.json
│   ├── Dockerfile
│   └── nginx.conf           # SPA 路由回退及 /api 反向代理
├── backend/
│   ├── src/
│   │   ├── config/env.ts    # 环境配置及启动校验
│   │   ├── database/       # SQLite 连接、版本化迁移和仓储层
│   │   ├── modules/        # 四类数据模块及其余预留模块
│   │   ├── app.ts          # HTTP 应用、健康检查、错误处理
│   │   └── server.ts       # 启动及优雅关闭
│   ├── test/app.test.ts
│   ├── .env.example
│   ├── tsconfig.json
│   ├── package.json
│   └── Dockerfile
├── .env.example            # Docker 发布端口
├── .gitignore
├── .dockerignore
├── package.json
├── package-lock.json       # 提交此文件，确保依赖安装可重复
└── compose.yaml
```

七个模块在前后端均有独立目录及 README。前端路径为 `/chat`、`/memory`、`/diary`、`/dream`、`/activity`、`/music`、`/device`。后端已注册 `/api/memories`、`/api/diaries`、`/api/dreams`、`/api/activities`。

完整文件列表见 `FILES.txt`。`.github/workflows/ci.yml` 在 push 和 pull request 时执行类型检查、测试、前后端构建以及 Docker 配置检查和镜像构建。此工作流需要推送到 GitHub 后才能运行。

## 正式启用前安全工具

已实现Windows ACL检查/计划/验证工具，以及代理内建test/production隔离、精确白名单和生产人工确认。真实权限和v3库未改；见 [安全方案](docs/sync-security.md)。

## 第二阶段增量归档

已实现独立设备认证、Windows出站增量拉取、本地事务游标及持久ACK，清理保持关闭。详见 [实施、风险与隔离验收步骤](docs/incremental-sync.md)。本轮未升级真实v3库；新代码需v4，真实启用须另行备份/迁移授权。

## 第二阶段文本聊天

本轮基于第一阶段提交 2cf90cc，新增 v3 数据库迁移、可靠消息入库和 DeepSeek 适配器。配置、API、迁移步骤、测试及限制见 [文本聊天说明](docs/phase2-text-chat.md)。已有 v2 数据库不会自动升级，启动前必须按说明在停写状态完成备份及迁移。

## 本地运行

第一阶段首次运行请先阅读 [身份、迁移与备份说明](docs/phase1-implementation.md)。原 API 现需登录；旧库先备份并导入外部运行副本，原库保留不动。由用户在本机执行一次 npm run auth:setup -w backend 配置访问密码。

安装 Node.js 24.x 和 npm，在 `E:\sakie-ai-home` 项目根目录执行（保持开发终端运行才能访问网页）：

```bash
npm ci
npm run dev
```

访问 http://localhost:5173 。后端监听 http://127.0.0.1:3000 ，前端开发服务器将 `/api` 转发给后端。验证健康检查：

```bash
curl http://localhost:5173/api/health
```

返回 `{"status":"ok","service":"sakie-ai-home"}`。开发进程用 Ctrl+C 停止。

需要修改后端配置时，将 `backend/.env.example` 复制为 `backend/.env`。默认不需要复制；`NODE_ENV` 默认 development，`HOST` 默认 127.0.0.1，`PORT` 默认 3000。改变 API 端口时同步修改 `frontend/vite.config.ts` 中的代理目标。

也可在根目录用两个终端独立启动：

```bash
npm run dev -w backend
npm run dev -w frontend
```

## 检查及生产构建

```bash
npm run typecheck
npm test
npm run build
```

输出分别在 `frontend/dist` 和 `backend/dist`。构建后可以执行 `npm run start -w backend` 启动 API，`npm run preview -w frontend` 仅用于预览前端静态构建，不提供开发服务器的 `/api` 代理。完整生产运行使用下面的 Docker 配置。

## Linux VPS Docker 部署

**第一阶段部署提示：以下是原始部署流程，不可直接用于本轮生产升级。新增认证要求显式 PUBLIC_ORIGIN=https://sakiehome.icu、外部备份路径和身份配置；原 v1 数据卷必须先备份与副本演练。当前没有修改线上配置。详见 docs/phase1-implementation.md。**

准备 Docker Engine 和 Docker Compose v2，将整个项目（包含 package-lock.json）上传到 VPS。无需在 VPS 安装 Node.js。

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:8080/api/health
```

访问 `http://<VPS-IP>:8080`。前端 Nginx 对外监听 8080；后端仅在 Compose 内部网络中提供 3000 端口。浏览器直接打开或刷新 `/chat` 等路径均由 Nginx 回退到入口页面。Compose 等待后端健康检查通过后再启动前端。

如需修改对外端口，将根目录 `.env.example` 复制为 `.env`，调整 `HTTP_PORT` 后重新执行 `docker compose up -d`。VPS 防火墙需开放该端口。

```bash
docker compose logs -f
docker compose up -d --build   # 更新代码后重建部署
docker compose down          # 停止服务
```

当前仅提供 HTTP；使用域名长期部署时下一步配置 HTTPS 反向代理。个人数据功能上线前再加入身份认证与访问控制。

## 后续维护约定

- 业务代码放入所属模块，公共布局位于 `frontend/src/app`，基础设施位于后端 `config`、`database` 等目录。
- 前端通过同源 `/api` 访问后端，保持本地代理和生产反向代理一致。
- 数据库使用 SQLite，迁移位于 `backend/src/database/migrations.ts`，公共仓储位于 `repository.ts`。数据目录不提交到 Git。
- 提交 lockfile；升级依赖后执行类型检查、测试和构建。
- 环境文件不提交，新增配置同步更新 `.env.example` 和文档。

建议下一步加入个人系统身份认证及数据库备份，再逐步实现前端记录页面。

技术参考：[Vite](https://vite.dev/guide/)、[React Router](https://reactrouter.com/start/declarative/installation)、[Express](https://expressjs.com/en/starter/installing/)。

## E 盘开发和数据存储

所有开发操作在 E:/sakie-ai-home 进行，依赖位于 node_modules，构建位于 frontend/dist 和 backend/dist，数据库默认位于项目外的 E:/sakie-ai-home-data/cloud/sakie.db。本机 .npmrc 将 npm 缓存固定在 E:/sakie-ai-home/.npm-cache；该机器专用文件不提交也不放入 Docker 镜像，Linux CI 和 VPS 保持默认缓存配置。Docker 数据使用 sakie-data 持久卷。模型和 API 详情见 docs/data-layer.md。

## 第一阶段交付

- [实施、测试、回退与已知限制](docs/phase1-implementation.md)
- [同步协议基础（仅设计）](docs/sync-protocol-v1.md)
- [架构审查基线](docs/architecture-review.md)

当前没有接入真实模型或实现双端同步。

第二阶段同步的编译产物端到端验收：在项目根运行 `npm run test:sync:e2e`。命令先构建 backend/local-agent，再启动独立后端与代理 CLI，以假模型、回环白名单和全新 E 盘合成库验证断网、进程中断、ACK/游标恢复及撤销。不会读取 backend/.env 或调用真实模型；不代表正式双端已启用。

完整源码公开前运行 `npm run release:audit`：只在 `.phase1-work` 生成候选文件/哈希与文档待审清单，不暂存、不提交或推送。机器审计文档默认不进入源码候选；公开仓库需要用户另行明确授权。

生产交付另有独立 `compose.release.json`（不要与旧 compose.yaml 合并使用）：必须私下配置 `PUBLIC_ORIGIN`、`BACKEND_ENV_FILE`、`OWNER_CREDENTIAL_FILE_HOST`、`SAKIE_DATA_VOLUME`、`SAKIE_BACKUP_VOLUME`。卷必须预先存在并核验数据来源/运行账户权限，模板不创建或迁移真实数据；身份只读挂载，网页仅回环8080。授权后的隔离Docker验收需先运行 `docker compose -f compose.release.json config --quiet`，再验证镜像、挂载、Nginx与HTTPS；本地JSON策略检查不代替容器验收。当前仍需另行批准正式启用。

### 本机合成聊天演示（不使用真实模型或运行库）

运行 `npm run demo:chat`，打开 `http://127.0.0.1:5180/demo/chat`，使用演示密码 `demo-only-sakie` 登录。
仅绑定回环地址；假模型注入仅存在于独立工具，不改变生产模型配置。首次运行在项目外创建全新 `sakie-ai-home-data/chat-demo-*` 合成库；不要在此演示输入私人信息。
刷新会保留已入库历史。停止后运行 `npm run demo:chat -- --resume chat-demo-实际运行名` 可重新打开同一演示库；仅接受工具创建并带合成标记的直接子目录。启动输出包含运行名；Ctrl+C 停止，不删除数据。
`npm run test:chat-demo` 使用已构建的前后端及本机 Edge，在新建合成目录验证登录、单时间线、假模型回复、刷新、服务重启及消息/outbox 持久性；先运行前后端 build。测试不静默跳过缺失浏览器。
原 `/chat` 会话界面继续保留，单时间线位于 `/demo/chat`；该路由复用正常认证与 API，本身不会将生产模型切换成假模型。只有本工具创建的本机服务使用假模型。

### 第二阶段正式启用准备（尚未安装）

`npm run activation:checkpoint` 创建无远程的独立本地 Git 检查点及可实际克隆恢复的 bundle，不改变当前仓库索引/分支，也不会上传源码。`npm run activation:rehearse` 仅操作已登记的冻结历史副本及新隔离候选，不打开当前正式主数据库。`npm run test:activation` 运行新增运行配置/锁/恢复激活门槛测试。
运行配置、普通用户登录后任务、配对/撤销及精确授权范围见 tools/activation/RUNBOOK.md；没有安装服务、注册任务或启用真实数据。UI 继续遵循产品规范 v1.1，已否决 HTML 样稿不使用。
