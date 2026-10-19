# 零成本多域名邮箱

把自己域名的邮件收进一个**自托管**的网页收件箱：

- **收信**：Cloudflare Email Routing 收下邮件，**绝不丢信**。
- **发信**：通过 [Resend](https://resend.com) 发送（支持 HTML 与附件）。
- **网页界面**：简化版 Gmail 风格，支持已读 / 未读 / 星标 / 删除（回收站）/ 写信 / 回复 / 多地址切换 / 搜索。

所有数据都在**你自己的** Cloudflare 账号里（D1 / R2 / Queue），Resend Key 也存在你自己的 D1 —— 密钥不离开你的账号。

---

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bfzhao/resend-mail-api)

> 点击后，Cloudflare 会把这个仓库**克隆到你的 GitHub 账号**，按 `wrangler.toml` 创建 D1 / R2 / Queue，并部署到你的 Cloudflare 账号。

### 前置条件

- **Cloudflare 账号**（免费版即可）
- **一个域名**，且 DNS 托管在 Cloudflare（NS 已指向 Cloudflare）
- **Resend 账号**（免费版即可；用于发信与域名验证）
- **GitHub 账号**（Deploy Button 会把仓库克隆到你的账号下）

### 部署后：跟着站内向导走

1. 打开 Cloudflare 给你的地址：`https://<你的worker>.<子域>.workers.dev`
2. 首次访问自动进入安装向导：
   - **第 1 步 · 设管理员**：设置用户名与密码（此后用它登录）。
   - **第 2 步 · 连接域名**：填域名 + Cloudflare API Token + Resend API Key。
     点「开始配置」后自动完成：找 zone → 开启 Email Routing 并把 catch-all 指向本 Worker → 在 Resend 建发送域名 → 把 DKIM/SPF/DMARC 写进你的 DNS → 触发 Resend 校验。
3. 完成 —— 现在可以收信、写信、回复了。

**Cloudflare API Token —— 四项区域级权限。** 向导里的 **「打开 Cloudflare 授权页」** 按钮会打开 Cloudflare 的 Token 页面（Cloudflare 的 token template URL，见 `CF_TOKEN_PERMS`），前三项已预选，第四项需手动点一下：

- 自动勾选：`Zone → Read`、`DNS → Edit`、`Zone Settings → Edit`
- **需手动补 1 项**：`Zone → Email Routing Rules → Edit`（Cloudflare 不允许用链接预选这一项；向导里会提示点「+ Add more」）
- `Zone Resources` 默认 All zones —— 改成 `Include → 你的域名` 可只授权这一个 zone

若 Token 缺某项权限，向导那一步会直接报「该操作需要 xxx 权限」，而不是默默失败。

**Resend API Key —— Full access。** 「仅发送」的 Key 能发信，但不能建域 / 读域 / 触发验证（Resend 会回 `This API key is restricted to only send emails`）。

| 配置项 | 存在哪 / 怎么改 |
|---|---|
| Resend Key | **按域绑定**（`domains.resend_api_key`）。**没有「数据库全局 Key」** —— 环境变量 `RESEND_API_KEY` 只是兜底，所以两个域分属不同 Resend 账号也能同时发信 |
| Cloudflare Token | 只在配置时用一次，**不保存** |
| 改 Key | 不用重新部署：点域名后面的**状态标记** → *修改该域的发信 Key* → *保存并重新检查* |

**域名按钮** · 名字后面的 **✓ / ? / !** 是自动自检结果（✓ 通过 · ? 还没检查 · ! 有问题 —— 点它看该域的表格与 Key 设置）

自检**自动运行**（页面加载时一次，之后最多每 30 分钟一次）：用真正发信的那把 Key 读该域的 Resend 状态，再用公共 DNS 核验 MX / DKIM / SPF / DMARC（不需要 Token）。

---

## 自部署 / 本地开发

```bash
npm install
npm run typecheck

# 本地数据库（sqlite，位于 .wrangler/state）
npm run db:migrate:local

# 本地密钥写入 .dev.vars（不提交）
# RESEND_API_KEY=re_xxx
# API_USERNAME=admin
# API_PASSWORD=change-me

npm run dev            # http://localhost:8787
```

> `.dev.vars` 里的 `RESEND_API_KEY` 只作**一次性引导**：首次请求会导入本地 D1，之后以 D1 为准
> （从域名按钮的状态标记进去改发信 Key）。`API_USERNAME` / `API_PASSWORD` 仍只走环境变量。

自部署到自己的 Cloudflare 账号时，用**本地配置文件**（已被 gitignore，不会公开）：

```bash
# wrangler.local.toml 里填你自己的 database_id 等
wrangler deploy -c wrangler.local.toml
```

> `wrangler.toml` 是给 Deploy Button 用的**模板**：D1 的 `database_id` 是占位符 `<DATABASE_ID>`，云部署时会自动创建并回填。你自己的生产 id 请放在 `wrangler.local.toml`。

### 表结构（全新库自动建表）

部署到一个全新的空 D1 后，**Worker 会在首次请求时自动建表**（幂等）—— 不需要手动迁移。唯一来源是 [`schema.sql`](./schema.sql)；`src/schema-sql.ts` 是它的内联版本（运行时使用）。修改 `schema.sql` 后执行：

```bash
npm run schema:sync
```

（`test/schema-sql-sync.test.js` 会检查两者是否一致。）

---

## 架构

```
Cloudflare Email Routing ──(email)──┐
   (MX = mx.cloudflare.net)         │  ① 原始 .eml 写入 R2 + 登记 inbound_raw
                                    ▼
                              Worker (src/index.ts)
                 ├─ R2: 原始邮件 + 附件
                 ├─ D1: messages / attachments / inbound_raw / delivery_events / drafts / app_config / users …
                 ├─ Queue: 异步解析（绝不丢信第二阶段）
                 └─ Resend API: 发信 / 回复
                                    ▲
                   浏览器 SPA（public/，经 ASSETS 提供）
                   文件夹：收件箱 / 星标 / 已发送 / 回收站
```

- 收发共用一张 `messages` 表，用 `direction`（inbound / outbound）区分；文件夹只是查询视图。
- 删除 = 软删除（`deleted=1`）；回收站里可以还原，也可以彻底删除（同时清掉 R2 附件）。
- `thread_id` 按 References 链的根 Message-ID 归组（**发件箱不做聚合**，每封一行）；`mailbox` 记录收件地址，支持多地址切换。草稿不受信箱/域名筛选影响：草稿属于你选的发件人。
- Cloudflare Email Routing 只是路由器、**不存邮件**，所以收到后第一件事就是写入 R2 + 登记，再入队异步解析；`*/15` 的 cron 会把仍未被解析的重新入队自愈。

## 目录

```
public/            SPA（无构建）：index.html / app.css / app.js
src/
  index.ts         路由：/webhook/*、/api/*、/api/setup/*、静态资源回退
  auth.ts          鉴权（环境变量 Basic / D1 会话）
  session.ts       PBKDF2 口令哈希 + 会话 cookie
  setup.ts         安装向导：域名 + 自动写 DNS + 收发认证 + 自检
  cloudflare.ts    Cloudflare API（DNS / Email Routing）
  resend-domains.ts Resend 域名 API
  resend-errors.ts Resend 错误 → 可操作提示（Key / 域名 / 权限）
  schema.ts        ensureSchema：全新库首次请求时幂等建表
  schema-sql.ts    schema.sql 的内联形式（由 npm run schema:sync 生成）
  webhook.ts       Resend webhook 签名校验、收信落库、发信回执
  inbound-email.ts CF Email Routing 入向（写 R2 + 入队 + 异步解析 + 自愈）
  repo.ts          D1/R2 存取、文件夹查询、会话、批量操作
  receiving.ts     Resend Received Emails API
  send.ts          经 Resend 发信（含附件）
  util.ts          地址解析 / 时间 / base64 / 编码 等
schema.sql         表结构（唯一来源）
scripts/sync-schema.js  由 schema.sql 生成 src/schema-sql.ts
migrations/        针对已有库的增量迁移（001 … 012）
wrangler.toml      Deploy Button 模板配置
wrangler.local.toml 自部署配置（已 gitignore）
```

## 安全

- 入站 HTML 正文在前端按白名单清洗后才渲染；附件代理对非图片一律 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`。
- 管理员口令用 PBKDF2-SHA256（10 万次）哈希后存 D1；会话是 HMAC 签名 cookie。
- Webhook 校验 5 分钟时间戳窗口；`webhook_deliveries` 提供幂等。
- 生产环境请用环境变量 / 向导配置；不要把密钥写进 `wrangler.toml`。

## 已知限制

- Cloudflare Email Routing 入站上限 25 MiB（更大的会被拒），实际可收附件约 18–19 MB。
- 回复不引用内嵌图片，只做纯文本引用。
- 仅支持单管理员账号。

## License

MIT
