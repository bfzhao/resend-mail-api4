/* =============================================================================
 * Bilingual UI (中文 / English) with a one-click switch.
 *
 * Why a DOM layer instead of t() calls everywhere: the whole frontend is build-less vanilla JS that composes display
 * text inline (`textContent = ...`, template strings, toast messages). This file keeps **one dictionary** (Chinese →
 * English) and translates the rendered DOM, so there is a single place to maintain, no risk of a missed call site, and
 * adding a screenshot-level check ("no Chinese left in English mode") is possible.
 *
 * How it works
 *   · `translate()` rewrites a rendered string: long phrases first, `{name}` = "any text" (interpolated values are
 *     carried over untouched, so numbers / addresses / domains survive).
 *   · Each text node / attribute remembers its **original** (Chinese) value in a WeakMap; switching back to 中文
 *     restores it verbatim, so the switch is lossless in both directions.
 *   · A MutationObserver translates nodes as they appear, so dynamically rendered mail rows, toasts and dialogs are all
 *     covered without touching app.js.
 *   · Mail content is never translated: bodies, quotes, subjects, sender names/addresses, the composer and the
 *     attachment preview are skipped (they are the user's data, not the interface).
 *
 * Loaded before /app.js by index.html; the language lives in localStorage (`ui-lang`), default 中文.
 * ============================================================================= */
(function () {
  'use strict';

  var CJK = /[\u4e00-\u9fff]/;
  var STORE_KEY = 'ui-lang';
  var DEFAULT_LANG = 'zh';

  /**
   * Chinese → English. Keys are matched inside rendered text (longest first), so a composed string such as
   * `收件箱 · 共 12 封` is covered by `收件箱` + ` · 共 {n} 封` without a dedicated entry.
   * `{n}` / `{x}` placeholders capture the interpolated part and copy it into the English text.
   */
  var DICT = {
    /* ---- Navigation / folders ---- */
    '收件箱': 'Inbox',
    '已发送': 'Sent',
    '草稿': 'Drafts',
    '星标': 'Starred',
    '回收站': 'Trash',
    '未连接': 'Disconnected',
    '全部邮箱（未发现账号）': 'All mailboxes (no account found)',
    '全部邮箱': 'All mailboxes',
    '切换收件地址': 'Switch mailbox',
    '写信': 'Compose',
    '未连接 API': 'API not connected',

    /* ---- Folder header / list ---- */
    ' · 共 {n} 封': ' · {n} total',
    '：搜索“{q}”': ': search “{q}”',
    '（未选择域名）': ' (no domain selected)',
    '未选择域名：勾选上方的域名后显示邮件': 'No domain selected — tick a domain above to show mail',
    '这里还没有邮件': 'No messages here yet',
    '（草稿不随域名筛选）': ' (drafts are not filtered by domain)',
    '全选本页': 'Select page',
    '全选当前页': 'Select all on this page',
    '这里还没有邮件': 'No messages here yet',
    '已选择 {n} 封': '{n} selected',
    '标为已读': 'Mark as read',
    '标为未读': 'Mark as unread',
    '加星标': 'Star',
    '取消星标': 'Unstar',
    '还原': 'Restore',
    '彻底删除': 'Delete permanently',
    '删除': 'Delete',
    '(无主题)': '(No subject)',
    '(未知发件人)': '(Unknown sender)',
    '(未识别)': 'Unrecognized',
    ' · 未读': ' · unread',
    '（{n} 未读）': ' ({n} unread)',
    '（未读）': ' (unread)',
    '↑{n}': '↑{n}',

    /* ---- Message status chips ---- */
    '已送达': 'Delivered',
    '退信': 'Bounced',
    '失败': 'Failed',
    '延迟': 'Delayed',
    '排队中': 'Queued',
    '投诉': 'Complaint',
    '已收到': 'Received',
    '已读': 'Read',
    '未读': 'unread',

    /* ---- Reading pane ---- */
    '← 返回列表': '← Back to list',
    '选择一封邮件以阅读': 'Select a message to read',
    '从左侧列表中选择，或用 ↑ ↓ 键浏览': 'Pick one from the list, or use ↑ ↓',
    '查看详情': 'Show details',
    '收起详情': 'Hide details',
    '回复': 'Reply',
    '转发': 'Forward',
    '收件人：': 'To: ',
    '抄送': 'Cc',
    '密送': 'Bcc',
    '发件人': 'From',
    '收件人': 'To',
    '主题': 'Subject',
    '详情': 'Details',
    '收至': 'received at',
    '致 ': 'To ',
    '附件预览': 'Attachment preview',
    '下载原件': 'Download original',
    '下载': 'Download',
    '关闭': 'Close',
    '最大化': 'Maximize',
    '还原大小': 'Reset size',
    '加载中': 'Loading',
    '加载中…': 'Loading…',
    '正文加载失败：{m}': 'Failed to load the body: {m}',
    '（内容加载失败，请用「下载」按钮保存后打开）': '(Could not load the content — use Download and open it locally)',
    '（随正文下载中…）': ' (downloading with the body…)',
    '会话 · {n} 封': 'Conversation · {n}',
    '{n} 个附件': '{n} attachment(s)',
    '引用原文': 'Quote original',
    '你是{role}': 'You are: {role}',
    '这封邮件不是发给你的，你是以{role}身份收到的': 'This message was not addressed to you — you received it as {role}',
    '这封邮件入库时未保存原始收件人（To:）信息，且已超出上游保留期，无法恢复':
      'The original To: header was not stored for this message and it is past the upstream retention window, so it cannot be recovered',
    '拖动调整邮件列表宽度': 'Drag to resize the message list',

    /* ---- Composer ---- */
    '发送': 'Send',
    '取消': 'Cancel',
    '放弃': 'Discard',
    '＋ 抄送 / 密送': '＋ Cc / Bcc',
    '－ 收起抄送 / 密送': '− Hide Cc / Bcc',
    '＋ 附件': '＋ Attach',
    '＋ 自定义': '＋ Custom',
    '添加附件': 'Add attachment',
    '在此输入邮件正文…': 'Write your message…',
    '抄送，多个用逗号分隔': 'Cc, comma-separated',
    '密送（其他收件人看不到），多个用逗号分隔': 'Bcc (hidden from others), comma-separated',
    'name@example.com，多个用逗号分隔': 'name@example.com, comma-separated',
    '添加自定义发件人': 'Add custom sender',
    '添加自定义发件人（需为同域名地址）': 'Add custom sender (must be on a configured domain)',
    '自定义发件人地址': 'Custom sender address',
    '自定义发件人地址（需为 {d} 下的地址）': 'Custom sender address (must be under {d})',
    '发件地址的域名必须是：{list}': 'The sender domain must be one of: {list}',
    '地址格式不正确': 'Invalid address format',
    '合并发送': 'Send merged',
    '勾选后，将对每个收件人分别单独发送一封邮件（内容与主题相同）':
      'Send one separate email per recipient (same subject and body)',
    '将分别单独发送给 {n} 位收件人': 'Will send {n} separate emails',
    '合并发送不支持密送（BCC），请取消其中一个': 'Merged send does not support Bcc — turn one off',
    '将附带原邮件的 {n} 个附件': 'Will attach {n} attachment(s) from the original',
    '继续编辑': 'Keep editing',
    '已打开草稿': 'Draft opened',
    '草稿保存失败：{m}': 'Could not save the draft: {m}',
    '加粗': 'Bold',
    '斜体': 'Italic',
    '下划线': 'Underline',
    '插入链接': 'Insert link',
    '链接': 'Link',
    '有序列表': 'Numbered list',
    '无序列表': 'Bulleted list',
    '清除格式': 'Clear formatting',
    '切换 HTML 富文本': 'Toggle rich text (HTML)',

    '搜索邮件…': 'Search mail…',
    '发件显示名（留空 = 不显示名字）': 'Display name (empty = no name)',
    '设置任意发件地址（该域下的任意本地部分）': 'Set any sender address (any local part on this domain)',
    '设置任意发件地址': 'Set any sender address',
    '重试': 'Retry',
    '收件地址': 'mailbox',
    '发件地址': 'sender address',
    '=收': 'In',
    '=发': 'Out',

    /* ---- Toasts / errors ---- */
    '邮件已发送': 'Message sent',
    '邮件已转发': 'Message forwarded',
    '回复已发送': 'Reply sent',
    '已加星标': 'Starred',
    '已删除': 'Deleted',
    '网络错误，请重试': 'Network error — please retry',
    '网络错误，请检查 Worker 是否可访问': 'Network error — check that the Worker is reachable',
    '认证失败，请刷新页面重新登录': 'Authentication failed — reload the page and sign in again',
    '服务端未配置发送能力（缺少 RESEND_API_KEY / SEND_FROM_ADDRESS）':
      'Sending is not configured on the server (RESEND_API_KEY / SEND_FROM_ADDRESS missing)',
    '发送失败：{m}': 'Send failed: {m}',
    '「{name}」超过 40MB 上限，已跳过': '"{name}" exceeds the 40 MB limit — skipped',
    '已分别发送给 {n} 位收件人': 'Sent separately to {n} recipient(s)',
    '已发送 {a} 封，{b} 封失败：{c}（{d}）': 'Sent {a}, failed {b}: {c} ({d})',

    /* ---- Domains / self-check ---- */
    '＋ 域名': '＋ Domain',
    '添加域名': 'Add domain',
    '域名已添加': 'Domain added',
    '域名筛选（可多选）': 'Domain filter (multi-select)',
    '已勾选：只看该域（可多选）；全部取消 = 全部域名':
      'Checked: only this domain (multi-select); uncheck all = all domains',
    '勾选可只看某些域（支持多选）；都不勾选 = 全部域名':
      'Check domains to narrow the list (multi-select); none checked = all domains',
    '域名自检 · {d}': 'Domain self-check · {d}',
    '域名自检': 'Domain self-check',
    '检查中': 'Checking',
    '检查中…': 'Checking…',
    '配置中': 'Configuring',
    '配置中…': 'Configuring…',
    '检查失败，请重试': 'Check failed — please retry',
    '保存失败': 'Save failed',
    '重新检查': 'Re-check',
    '保存并重新检查': 'Save and re-check',
    '项目': 'Item',
    '状态': 'Status',
    '发信（Resend）': 'Sending (Resend)',
    '收信（Cloudflare Email Routing）': 'Receiving (Cloudflare Email Routing)',
    '发信': 'Sending',
    '收信': 'Receiving',
    '域名绑定': 'bound to domain',
    '环境变量': 'environment variable',
    '未配置': 'not configured',
    '当前 {masked}{src}（留空不修改）': 'current {masked}{src} (leave empty to keep)',
    '（{src}）': ' ({src})',
    'Resend API Key · {d}（留空则不修改）': 'Resend API Key · {d} (leave empty to keep)',
    'Resend API Key（留空则不修改）': 'Resend API Key (leave empty to keep)',
    '修改 {d} 的 Key / 默认发件人': 'Edit key / default sender for {d}',
    '默认发件人': 'Default sender',
    '默认发件人（可留空，写信时自己选）': 'Default sender (optional — you pick one when composing)',
    '发件显示名': 'Display name',
    '发件人（留空 = 不显示名字）': 'Display name (empty = no name)',
    '发信设置已保存': 'sending settings saved',
    '{d}：自动自检正常（Resend 已验证、收发信 DNS 齐全）。点击查看详情':
      '{d}: self-check passed (Resend verified, sending/receiving DNS present). Click for details',
    '{d}：还没有检查过。点击立即检查': '{d}: not checked yet. Click to check now',
    '{d}：自检发现问题（{list}）。点击查看详情 / 修改发信 Key 与默认发件人':
      '{d}: problems found ({list}). Click for details / to fix the key and sender',
    ' 的发信设置已保存': "'s sending settings saved",
    '，这把 Key 能看到：': '; this key can see: ',
    '（无）': '(none)',

    /* ---- Setup wizard / gate ---- */
    '初始化邮箱': 'Set up mailbox',
    '第 1 步 · 设置管理员账号（用于登录本邮箱）': 'Step 1 · Create the admin account (used to sign in)',
    '用户名': 'Username',
    '密码': 'Password',
    '确认密码': 'Confirm password',
    '至少 6 位': 'at least 6 characters',
    '密码至少 6 位': 'Password must be at least 6 characters',
    '两次输入的密码不一致': 'Passwords do not match',
    '请输入用户名': 'Enter a username',
    '请输入用户名与密码': 'Enter username and password',
    '登录': 'Sign in',
    '登录失败': 'Sign-in failed',
    '输入管理员账号以进入邮箱': 'Sign in to open the mailbox',
    '完成设置后即可登录。域名解析与发信配置将在下一步完成。':
      'You can sign in once this is done. DNS and sending are configured in the next step.',
    '创建并继续': 'Create and continue',
    '创建失败': 'Could not create',
    '请填写域名、Cloudflare Token 与 Resend Key': 'Fill in the domain, Cloudflare token and Resend key',
    '配置未完全成功，请检查上面的步骤后重试': 'Setup did not fully complete — check the steps above and try again',
    '域名': 'Domain',
    '发件人': 'From',
    '保存': 'Save',
    '不会保存': 'not stored',
    'Cloudflare Token 仅用于本次写 DNS 与开启收信路由，': 'The Cloudflare token is only used now, to write DNS records and enable receiving — ',
    '；Resend Key 保存在你自己的 D1（发信需要）。': '; the Resend key is stored in your own D1 (needed for sending).',

    /* ---- Sidebar backend status ---- */
    '后端状态': 'Backend status',
    '存储': 'Storage',
    '队列': 'Queue',
    '发送额度': 'Send quota',
    '存储为估算值': 'storage is an estimate',
    '贴近上限或积压会变色提醒': 'turns colour near a limit or when backed up',
    ' · 月': ' · month',
    '今天已发送': 'sent today',

    /* ---- Backend status rows / titles (composed with <b> tags, so they are fragments) ---- */
    '待解析 / 异常 / 累计收信': 'unparsed / alerts / total received',
    'D1 约 {a} / {b}': 'D1 ~ {a} / {b}',
    'R2 约 {a} / {b} · {n} 个对象': 'R2 ~ {a} / {b} · {n} objects',
    'Resend 今日 {a}/{b} · 本月 {c}/{d}': 'Resend today {a}/{b} · this month {c}/{d}',
    '个对象': 'objects',
    '收件': 'In',
    '发件': 'Out',
    '待处理': 'pending',
    '异常': 'alerts',
    '· 月': '· mo',
    '已显示 {n} / {t} 封，点击加载更多': 'Showing {n} / {t} — click to load more',
    '仍在处理，或邮件过大（免费档 CPU 限制）': 'still processing, or the message is too large (free-plan CPU limit)',
    '查看': 'Show',
    '收起': 'Hide',
    '• 列表': '• List',
    '为当前邮箱增加一个收发域名，自动完成收信路由与发信认证':
      'Add another domain to this mailbox — receiving routes and sending authentication are set up automatically',
    '第 2 步 · 输入域名并授权，自动完成收信路由与发信认证':
      'Step 2 · Enter the domain and authorise — receiving routes and sending authentication are set up automatically',
    're_…（保存在你自己的数据库，用于发信）': 're_… (stored in your own database, used for sending)',
    '已验证': 'verified',
    'Cloudflare 授权（自动勾选 4 项权限）': 'Cloudflare authorisation (4 permissions pre-selected)',
    '打开 Cloudflare 授权页': 'Open the Cloudflare authorisation page',
    'Cloudflare 授权（自动勾选权限）': 'Cloudflare authorisation (permissions pre-selected)',
    '先在上面填写域名，按钮才会激活。': 'Enter the domain above to enable this button.',
    '请先填写域名，再打开 Cloudflare 授权页。': 'Enter the domain first, then open the Cloudflare authorisation page.',
    '已按 {d} 所在的 zone 打开（Zone Resources 已锁定到该域名）。':
      'Opened scoped to the zone of {d} (Zone Resources is locked to that domain).',
    '打开后把 Zone Resources 改成 Include → {d}，只授权这一个域（Cloudflare 的链接只接受 zone id，首次配置时还查不到）。':
      'After it opens, set Zone Resources to Include → {d} to authorise just this zone (the link only accepts a zone id, which is unknown until a token exists).',
    '需要的 4 项权限：': 'The 4 permissions: ',
    '在打开的页面底部点「Continue to summary」→「Create Token」，复制 Token 后粘到下面。':
      'At the bottom of that page click "Continue to summary" → "Create Token", then copy the token and paste it below.',
    '把创建好的 Token 粘贴到这里': 'Paste the token you just created',
    '需要 4 项权限：Zone → Read · DNS → Edit · Zone Settings → Edit · Email Routing Rules → Edit':
      'Four permissions are needed: Zone → Read · DNS → Edit · Zone Settings → Edit · Email Routing Rules → Edit',
    '打开后前 3 项已自动勾选；Email Routing Rules 若没有出现，点 Permissions 下的「+ Add more」→ 选 Zone → Email Routing Rules → Edit（Cloudflare 目前不支持用链接预选这一项）。':
      'The first 3 are pre-selected. If Email Routing Rules is missing, click "+ Add more" under Permissions and pick Zone → Email Routing Rules → Edit (Cloudflare does not let a link pre-select this one).',
    'Zone Resources 默认 All zones；想只授权这一个域，改成 Include → 你的域名。':
      'Zone Resources defaults to All zones; to authorise only this domain change it to Include → your domain.',
    '最后点「Continue to summary」→「Create Token」，把 Token 粘到下面。':
      'Finally click "Continue to summary" → "Create Token" and paste the token below.',
    ' 默认 All zones；想只授权这一个域，改成 ': ' defaults to All zones; to authorise just this domain change it to ',
    '最后点「Continue to summary」→「Create Token」，把 Token 粘到下面。':
      'Finally click "Continue to summary" → "Create Token" and paste the token below.',
    '连接你的域名': 'Connect your domain',
    '开始配置': 'Start setup',
    '暂不设置': 'Not now',
    '添加域名': 'Add domain',
    '发件地址': 'From address',
    '发件显示名（可选）': 'Display name (optional)',
    '{d}：{n} 封未读': '{d}: {n} unread',
    '已勾选：只看该域（可多选）；取消全部勾选 = 不显示邮件':
      'Checked: only this domain (multi-select); uncheck everything = show nothing',
    '勾选可只看某些域（支持多选）；都不勾选 = 不显示邮件':
      'Check domains to narrow the list (multi-select); nothing checked = show nothing',
    '修改 {d} 的 Key / 默认发件人': 'Edit the sending key for {d}',
    '修改发信 Key / 默认发件人': 'Edit the sending key',
    '修改 {d} 的发信 Key': 'Edit the sending key for {d}',
    '修改发信 Key': 'Edit the sending key',
    '1. 列表': '1. List',

    /* ---- Self-check rows: the server sends Chinese details; translate the visible ones ---- */
    '已验证，这把 Key 可以使用该域发信': 'Verified — this key can send as this domain',
    '已生效': 'present',
    '未发现 _dmarc（可选，建议补一条 TXT：v=DMARC1; p=none;）':
      'no _dmarc record (optional; recommended TXT: v=DMARC1; p=none;)',
    '未发现 Cloudflare 邮件路由 MX（收信可能尚未生效）':
      'no Cloudflare Email Routing MX found (receiving may not be live yet)',
    '未发现 send.{d} 的 MX（Resend 会判定域名未验证，无法发信）':
      'no MX for send.{d} (Resend will treat the domain as unverified and refuse to send)',
    '未发现 resend._domainkey.{d}（可能仍在传播中）': 'no resend._domainkey.{d} record (may still be propagating)',
    '未发现 send.{d} 的 SPF': 'no SPF record for send.{d}',
    '没有可用的发信 Key，无法查询': 'no usable sending key — cannot query',
    '该域的 Key 是「仅发送」权限：可以发信，但查不到 Resend 侧域名状态（不影响收发）。':
      "this domain's key is sending-only: it can send, but cannot read the domain status (delivery is unaffected)",
    '查询失败：{m}（无法确认这把 Key 能否使用该域）': 'query failed: {m} (cannot confirm this key may use the domain)',
    '域名绑定：{k}': 'bound to domain: {k}',
    '环境变量兜底：{k}（想让它独立，可在下方给该域绑定一把）':
      'environment fallback: {k} (bind a key to this domain below to make it independent)',
    '这个域没有绑定 Key，环境变量里也没有 → 无法发信（点下方给它绑一把）':
      'no key bound to this domain and none in the environment → cannot send (bind one below)',

    /* ---- Setup wizard steps (server-sent) ---- */
    '查找域名': 'Look up domain',
    '收信路由': 'Receiving routes',
    '发信认证': 'Sending authentication',
    '发信 Key': 'Sending key',
    '写入 DNS {t} {n}': 'Write DNS {t} {n}',
    '{d} 不在该 Cloudflare 账户（或 Token 缺少 Zone:Read）':
      '{d} is not in this Cloudflare account (or the token lacks Zone:Read)',
    '{a} 条记录写入 {b} 条，Resend 状态：{s}': 'wrote {b} of {a} records, Resend status: {s}',
    'catch-all → worker「{w}」': 'catch-all → worker "{w}"',

    /* ---- Misc ---- */
    '有 {n} 封邮件已收到，但还没进入收件箱': '{n} message(s) arrived but are not in the inbox yet',
    '来自 {a}': 'from {a}',
    '投递给 {to}': 'delivered to {to}',
    '待处理': 'Pending',
    '打开文件夹': 'Open folders',
    '拖动调整大小': 'Drag to resize',
    '恢复默认大小与位置': 'Restore default size and position',
    'PDF 预览': 'PDF preview',
    '{who} {date} 写道：': '{who} {date} wrote:',
    '原文结束': 'End of quoted message',
  };

  /* ---- rule compilation: longest key first; `{name}` = capture group ---- */
  var RULES = [];
  var keys = Object.keys(DICT).sort(function (a, b) { return b.length - a.length; });
  keys.forEach(function (key) {
    var en = DICT[key];
    // A leading "=" means **exact match only** (single characters such as 收 / 发 also occur inside other words).
    var exact = key.charAt(0) === '=';
    var zh = exact ? key.slice(1) : key;
    var parts = zh.split(/(\{\w+\})/).filter(Boolean);
    var src = exact ? '^' : '';
    var n = 0;
    parts.forEach(function (p) {
      if (/^\{\w+\}$/.test(p)) {
        n++;
        src += '(.+?)';
      } else {
        src += p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    });
    if ((en.match(/\{\w+\}/g) || []).length !== n) {
      // A dictionary bug (placeholder count mismatch) must not silently break the UI — report it once and skip.
      if (window.console) console.warn('[i18n] placeholder mismatch:', zh, '->', en);
      return;
    }
    // The replacement comes from the **English** text: literal parts escape `$`, placeholders map 1:1 onto $1..$n.
    var rep = '';
    var vi = 0;
    en.split(/(\{\w+\})/).filter(Boolean).forEach(function (p) {
      if (/^\{\w+\}$/.test(p)) rep += '$' + ++vi;
      else rep += p.replace(/\$/g, '$$$$');
    });
    RULES.push({ re: new RegExp(exact ? src + '$' : src, 'g'), rep: rep });
  });

  function translate(src) {
    if (!CJK.test(src)) return src;
    var out = src;
    for (var i = 0; i < RULES.length; i++) out = out.replace(RULES[i].re, RULES[i].rep);
    return out;
  }

  /* ---- DOM translation with per-node originals (lossless switch both ways) ---- */
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-placeholder'];
  // Text content that must stay verbatim: mail bodies, the editor, the attachment preview, raw text areas.
  var SKIP_TEXT_SEL =
    '[data-no-i18n],script,style,textarea,.mail-body,#att-preview-body,.att-preview-body,.rich-editor,[contenteditable="true"]';
  // Attribute translation only skips the user-data containers — a textarea's placeholder IS interface text.
  var SKIP_ATTR_SEL = '[data-no-i18n],.mail-body,#att-preview-body,.att-preview-body';
  var DATA_SEL =
    '.li-sender,.li-subject,.li-preview,.li-time,.li-thread-badge,.li-attach,.t-subject,.who-name,.who-email,.addr-suggest,.env-avatar,.li-avatar,#list-title-subject';

  var origin = new WeakMap(); // node -> original (zh) string
  var applied = new WeakMap(); // node -> the string we last wrote
  var originAttr = new WeakMap(); // element -> {attr: original}
  var appliedAttr = new WeakMap();

  function skippedText(el) {
    if (!el || !el.closest) return false;
    return !!(el.closest(SKIP_TEXT_SEL) || el.closest(DATA_SEL));
  }
  function skippedAttr(el) {
    if (!el || !el.closest) return false;
    return !!(el.closest(SKIP_ATTR_SEL) || el.closest(DATA_SEL));
  }

  function textSource(node) {
    var cur = node.nodeValue;
    if (applied.get(node) !== cur) origin.set(node, cur);
    var o = origin.get(node);
    return o === undefined ? cur : o;
  }

  function applyText(node) {
    if (skippedText(node.parentElement)) return;
    var src = textSource(node);
    var out = LANG === 'en' ? translate(src) : src;
    if (out !== node.nodeValue) node.nodeValue = out;
    applied.set(node, node.nodeValue);
  }

  function applyAttr(el, name) {
    if (skippedAttr(el)) return;
    var cur = el.getAttribute(name);
    if (cur === null) return;
    var store = originAttr.get(el);
    var was = appliedAttr.get(el) || {};
    if (!store) { store = {}; originAttr.set(el, store); }
    if (was[name] !== cur || store[name] === undefined) store[name] = cur;
    var out = LANG === 'en' ? translate(store[name]) : store[name];
    if (out !== cur) el.setAttribute(name, out);
    was[name] = el.getAttribute(name);
    appliedAttr.set(el, was);
  }

  /** Attributes of an element whose text is skipped (textarea / editor) are still interface text. */
  function applyAttrsOnly(el) {
    for (var i = 0; i < ATTRS.length; i++) if (el.hasAttribute(ATTRS[i])) applyAttr(el, ATTRS[i]);
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { applyText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    var el = root.nodeType === 1 ? root : null;
    if (el && el.matches && el.matches(SKIP_TEXT_SEL)) {
      applyAttrsOnly(el);
      return;
    }
    if (el) applyAttrsOnly(el);
    var kids = root.childNodes;
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  }

  /* ---- language state ---- */
  var LANG = DEFAULT_LANG;

  function readStored() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      if (v === 'en' || v === 'zh') return v;
    } catch (e) { /* private mode */ }
    return DEFAULT_LANG;
  }

  function updateButton() {
    var btn = document.getElementById('lang-btn');
    if (!btn) return;
    // The button always shows the language you would switch **to**.
    btn.textContent = LANG === 'zh' ? 'EN' : '中文';
    var label = LANG === 'zh' ? 'Switch to English' : '切换到中文';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  function setLang(next, persist) {
    LANG = next === 'en' ? 'en' : 'zh';
    if (persist) {
      try { localStorage.setItem(STORE_KEY, LANG); } catch (e) { /* ignore */ }
    }
    document.documentElement.setAttribute('lang', LANG === 'en' ? 'en' : 'zh-CN');
    updateButton();
    walk(document.documentElement);
  }

  function start() {
    LANG = readStored();
    document.documentElement.setAttribute('lang', LANG === 'en' ? 'en' : 'zh-CN');
    updateButton();
    var btn = document.getElementById('lang-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        setLang(LANG === 'zh' ? 'en' : 'zh', true);
      });
    }
    if (document.body) walk(document.body);
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'characterData') applyText(r.target);
        else if (r.type === 'attributes') applyAttr(r.target, r.attributeName);
        else for (var k = 0; k < r.addedNodes.length; k++) walk(r.addedNodes[k]);
      }
    });
    var target = document.body || document.documentElement;
    mo.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Test/automation hook (also handy from the console): window.dshI18n.set('en')
  window.dshI18n = {
    get lang() { return LANG; },
    set: function (l) { setLang(l, true); },
    translate: translate,
    dict: DICT,
  };
})();
