# 文本聊天（第二阶段第一部分）

已实现认证后的会话、消息、轮次状态与显式重试 API，DeepSeek 非流式文本适配器、近期上下文，以及事务型待归档事件。

- config.ts：后端配置及资源参数校验。
- provider.ts / deepseek.ts：可替换模型协议、DeepSeek 官方兼容接口；不自动重试、不记录原始错误正文。
- schema.ts / store.ts：v3 增量表、消息幂等键、后端序号、原文及 outbox 同事务持久化。
- context.ts：有界近期完整轮次，稳定人格与记忆不可用声明分离。
- service.ts：单进程单并发持久任务处理，超时与中断状态、调用记录、显式重试。
- routes.ts：沿用用户登录、CSRF 和 Origin 保护。

详见 [文本聊天说明](../../../../docs/phase2-text-chat.md)（项目根目录 docs 下）；本轮没有完整同步或记忆召回实现。
