# 项目邮箱

代码集中在本目录：`index.ts` 注册 Pi 工具、管理轮询及 TG 通知；`imap.py` 使用 Python 标准库连接只读 IMAP，无新增 npm/Python 依赖。扩展由项目 Pi 自动发现，重新加载后生效。运行期间首次检查延迟 10 秒，之后每次检查结束等待 60 秒。

## 绑定账号

编辑项目根目录下 `.pi/agent/config/mail/accounts.json`。已建立 QQ、163、Gmail 三个停用条目。每个条目填写完整 `email`、`password`，再将 `enabled` 改成 `true`。`id` 用英文、数字、下划线或连字符，各账号唯一；可以复制条目绑定同类多个账号。配置仅在项目内保存，文件权限 0600，已由 `.pi/agent/` 忽略规则保护。不要把授权码发到聊天里。

```json
{
  "accounts": [
    {
      "id": "my_qq",
      "provider": "qq",
      "enabled": true,
      "email": "你的完整QQ邮箱地址",
      "password": "你的QQ邮箱授权码"
    }
  ]
}
```

QQ 在邮箱网页端开启 IMAP，填客户端授权码。163 同样开启 IMAP，填客户端授权码；客户端发送固定 IMAP ID 兼容网易识别。固定服务器分别为 `imap.qq.com:993`、`imap.163.com:993`，使用 TLS 证书校验。目前针对个人 163 邮箱，不包含网易企业邮自定义服务器。

Gmail 固定 `imap.gmail.com:993`。简单绑定方式是开启两步验证后创建应用专用密码，填入 `password`；组织政策或账号保护可能禁止此方式。也支持已有 OAuth 配置：在 Gmail 条目中添加 `oauth`，包含 `clientId`、`clientSecret`、`refreshToken`，会自动刷新访问令牌。令牌需授权 `https://mail.google.com/` 范围。本版本不提供浏览器 OAuth 授权向导，不会自动取得这些凭据。

官方参考：[Gmail IMAP/OAuth](https://developers.google.com/workspace/gmail/imap/imap-smtp)、[Google 应用专用密码](https://support.google.com/accounts/answer/185833)、[腾讯邮箱服务器配置](https://main.qcloudimg.com/raw/document/product/pdf/1270_46586_cn.pdf)。网易帮助站本次检索未取得可读的官方说明，实际客户端兼容仍须绑定后验证。

## 使用

在 TG 问“查看邮箱连接状态”，模型调用 `mail_status`；问“收取最新邮件”，调用 `mail_sync`；问“列出最新邮件”，调用 `mail_list`；问“读取文件名对应的邮件”，调用 `mail_read`。这些是模型工具，不新增斜杠命令。只启用账号不能证明连接成功，以最近同步结果为准。

首次绑定同步最近 10 封，建立 UID 基线，不推送旧邮件。后续每次最多同步 30 封，积压留到下轮；使用 UIDVALIDITY 和账号身份避免 UID 混淆。只打开 INBOX，BODY.PEEK 不标记已读，不移动、删除或发送邮件。

新邮件通过 TG 当前实例目标发送发件人、主题、时间和文件名，正文不会主动发出，也不主动调用模型。邮件正文按需读取；工具定义会加入 Pi 的工具列表。附件不保存，原始邮件只取前 2 MiB，超过时提示内容可能不完整。

## 数据与故障

- `.pi/agent/mail/inbox/`：所有账号的邮件 JSON，文件名前缀区分账号。保留上一版本本地邮件。
- `.pi/agent/mail/state/`：各账号 UID 进度，原子保存。
- `.pi/agent/mail/status.json`：最近同步状态和错误类型。
- `.pi/agent/mail/events.jsonl`：同步、通知失败等事件，北京时间，不记录密钥和邮件正文。

单个账号失败不阻止其他账号。网络操作有超时，子进程整体 120 秒超时；运行过程中修改配置，下一轮读取新配置。失败邮件不推进 UID，重启继续；通知失败保留 notificationPending 并重试。投递成功但写回状态前进程退出时可能重复通知，当前不是严格恰好一次投递。停用账号不再发其待通知邮件。

Pi 关闭或切换会话时取消收取、清理定时器；新会话重新启动。没有另外创建系统服务，常驻依赖已有项目 Pi 启动方案。WSL 必须能直连对应 IMAP TLS 服务器；HTTP 代理不等于 IMAP TCP 代理。
