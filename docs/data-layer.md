# 基础数据层

## 数据库

SQLite 单文件数据库，使用 Node.js 24 的内置 node:sqlite / DatabaseSync，不增加第三方数据库驱动，也不需要独立数据库服务。该接口在 Node.js 24 系列仍属实验性 API；当前项目固定 Node.js 24，未来升级时需重新验证。同步访问适用于当前个人系统的小规模数据，未来高并发时可替换仓储层。

本地默认数据库路径：E:/sakie-ai-home/backend/data/sakie.db。路径由后端模块位置推导，开发与构建后的服务使用同一文件。首次启动自动创建目录和表；DATABASE_PATH 可覆盖路径。相对路径按启动工作目录解析，使用 npm workspace 命令时为 backend 目录。

SQLite 启用 WAL 和 5 秒 busy_timeout。迁移使用事务和 PRAGMA user_version 管理，当前版本为 1；数据库版本高于应用版本时拒绝启动。查询使用绑定参数，表名和列名来自内部定义。

Docker 数据库位于 /app/data/sakie.db，持久化到 Compose 命名卷 sakie-data。docker compose down 保留数据；不要使用 docker compose down -v，除非明确要删除数据。备份时先停止后端，再复制本地整个 backend/data 目录或备份 Docker 数据卷；WAL 模式下不要只复制运行中的主 db 文件。

## 模型

| 模型 | 字段 |
| --- | --- |
| Memory | id（UUID）、content（内容）、type（类型）、createdAt（创建时间）、importance（重要程度，1–5 整数） |
| Diary | id、date（日期）、content |
| Dream | id、date、content、source（ai / user，AI生成 / 用户记录） |
| Activity | id、time（时间）、type、content |

id 自动生成；Memory.createdAt 使用服务器当前 UTC 时间，客户端无需传入。Diary/Dream.date 为有效 YYYY-MM-DD 日历日期；同一天允许多条记录。Activity.time 必须包含时区，如 2026-10-14T20:00:00+08:00，存储及返回时规范化为 UTC。content 为非空字符串，最多 100000 字符；type 为非空字符串，最多 100 字符。字符串首尾空白会去除。

source=ai 仅作为记录来源标记，可用于未来导入历史记录，当前没有调用任何 AI。

## API

基础地址：开发前端代理 http://localhost:5173/api 或直连 http://127.0.0.1:3000/api；Docker 为 http://localhost:8080/api。

| 操作 | Method | 路径 |
| --- | --- | --- |
| 创建长期记忆 | POST | /api/memories |
| 查询长期记忆列表 / 单条 | GET | /api/memories 或 /api/memories/:id |
| 删除长期记忆 | DELETE | /api/memories/:id |
| 创建日记 | POST | /api/diaries |
| 查询日记列表 / 单条 | GET | /api/diaries 或 /api/diaries/:id |
| 删除日记 | DELETE | /api/diaries/:id |
| 创建梦境 | POST | /api/dreams |
| 查询梦境列表 / 单条 | GET | /api/dreams 或 /api/dreams/:id |
| 删除梦境 | DELETE | /api/dreams/:id |
| 创建活动 | POST | /api/activities |
| 查询活动列表 / 单条 | GET | /api/activities 或 /api/activities/:id |
| 删除活动 | DELETE | /api/activities/:id |

创建请求使用 Content-Type: application/json，返回 201、记录对象和 Location 头。列表参数 limit 默认 20（1–100），offset 默认 0（非负整数）。列表返回 { items, total, limit, offset }，按创建时间、日期或活动时间倒序，并按 id 倒序确定同时间记录顺序。单条查询返回 200；删除成功返回 204 无正文；查询或删除不存在的记录返回 404；参数错误返回 400，包含 error 和校验 message。数据库内部错误返回 500，不暴露 SQL 和路径。

创建请求示例：

~~~json
{"content":"喜欢安静的工作环境","type":"preference","importance":4}
~~~

~~~json
{"date":"2026-10-14","content":"今天开始建立个人系统。"}
~~~

~~~json
{"date":"2026-10-14","content":"梦见一座海边城市。","source":"user"}
~~~

~~~json
{"time":"2026-10-14T20:00:00+08:00","type":"coding","content":"完成基础数据层。"}
~~~

PowerShell 创建记忆示例：

~~~powershell
$body = @{ content = '喜欢安静的工作环境'; type = 'preference'; importance = 4 } | ConvertTo-Json
$record = Invoke-RestMethod -Method Post -Uri 'http://localhost:5173/api/memories' -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
Invoke-RestMethod 'http://localhost:5173/api/memories?limit=20&offset=0'
Invoke-RestMethod -Method Delete -Uri ('http://localhost:5173/api/memories/' + $record.id)
~~~

## 验证

npm run typecheck、npm test、npm run build。测试覆盖四类记录的创建/分页/单条查询/删除、数据库关闭重开后的数据保留和删除持久化、SQL 特殊内容及错误参数。测试数据库在 E 盘 backend/test 下临时创建，结束后清理，不使用真实数据库。

前端继续保留占位页面，本次通过 API 使用数据层。当前无认证，仅用于本地或可信网络；公开部署并存储个人数据前需要加入认证。

参考：https://nodejs.org/docs/latest-v24.x/api/sqlite.html
