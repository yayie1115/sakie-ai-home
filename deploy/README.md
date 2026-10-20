# 正式 Chat 配置入口（未部署）

`/chat` 复用 v11 布局与已有 `/api/chat` 的单条文本、会话和 turn 接口；需要原有密码登录及 CSRF。`/m0/chat` 保留独立只读能力探测，不因正式接线放开写入。正式聊天不接 lab API、假模型或合成消息。

`chat.compose.yaml` 是单独选择的模板，不自动修改现有 Compose 或主机 Nginx。仅前端绑定回环 3402，后端不发布端口；一个后端实例独占云数据库。`/ws` 尚未实现，明确返回 404；回复通过已有 turn 状态 API 读取。

部署前须另行批准并核对：

1. 现有域名 vhost、证书、3402 端口与实际云端数据唯一写入者。不能用新容器同时打开正在运行的旧后端数据库。
2. 按 `.env.example` 在仓库外填写 Compose 配置。外部数据、备份目录必须已存在，容器 node UID/GID 1000 按需读写；owner 身份文件只读。不要挂载 Windows 长期主库、测试库或合成身份。目录缺失不会自动创建。
3. 私有 `backend.env` 中配置 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、已批准的 `CHAT_SYSTEM_PROMPT` 和需要的上下文/超时参数；不得上传 Git。未配置模型时页面仍可读历史，发送禁用。默认人格不代表用户已批准的谢亦言人格。
4. 使用现有 activation RUNBOOK 的备份/候选迁移/恢复闸门。现有库若版本落后会拒绝启动，不能以空卷、删库或自动迁移绕过。此模板不运行迁移、不创建身份、不启用 Agent。
5. 仅在授权部署时，以仓库根为工作目录审阅 `docker compose --env-file /path/to/private-compose.env -f deploy/chat.compose.yaml config --quiet`，再构建/启用。检查宿主 Nginx 时将 `chat.host.nginx.conf` 合并进获批的主域 vhost，不能直接覆盖旧配置或创建重复 server_name；容器内 HTTPS 代理模板由 Compose 只读挂载。若使用其他回环端口，两份配置须一致。主机证书、HTTP 重定向/续期沿用已审核配置，不改 phos、www、DNS。
6. 健康检查只证明数据库可查询。还须验证登录、Secure Cookie、CSRF、模型配置、持久卷以及 iPhone Safari 的发送/回复/刷新、键盘与滚动。真实模型调用需另行授权。代码构建不代表手机验收通过。

回退：恢复此前获批的主域代理配置，停止此 Compose 项目的容器（不使用 `down -v`）；保留数据与备份。含新消息的数据库不能用旧快照直接覆盖。当前未接入正式多气泡提交、编辑/版本/重生成、群聊、媒体或记忆，这些控件不冒充可用。

完成授权部署后打开 **https://sakiehome.icu/chat**，使用既有私人访问密码登录。
