/**
 * Turn a raw Resend API error message into actionable Chinese guidance.
 *
 * ⚠️ The raw message is always kept in the output: the frontend toasts / tests match on it, and the exact wording is
 * what Resend support asks for. What we add is *what to do about it* — these four cases are the ones that made users
 * believe "Resend 明明显示已验证，应用却说未验证" (the key we send with simply cannot see that domain).
 *
 * Reference: https://resend.com/docs/api-reference/errors
 */

/** Domain part of a `from` value that may be `Name <addr>` — '' when there is no address. */
export function domainOfFrom(from?: string | null): string {
  const s = String(from ?? '').trim();
  const m = /<([^>]+)>/.exec(s);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  return at > 0 && at < addr.length - 1 ? addr.slice(at + 1) : '';
}

/** Mask a secret for display: `re_abcd…wxyz` (never prints the whole key). */
export function maskSecret(secret: string): string {
  const s = String(secret || '');
  if (s.length <= 10) return s ? '***' : '';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export interface ResendErrorContext {
  /** The `from` value we tried to send with (send errors only) — used to name the offending domain. */
  from?: string;
}

/**
 * Append an actionable hint to a Resend error message when we recognize it; otherwise return it unchanged.
 */
export function explainResendError(raw: string, ctx: ResendErrorContext = {}): string {
  const msg = String(raw ?? '').trim();
  if (!msg) return msg;

  // 401 restricted_api_key — sending-only key used for domain management.
  if (/restricted to only send emails/i.test(msg)) {
    return `${msg}（提示：这把 Resend API Key 是「仅发送」权限，创建/读取/验证域名需要 Full access 的 Key。请到 Resend → API Keys 新建一把 Full access 的 Key 后重试。）`;
  }

  // 403 validation_error — the `from` domain is not verified *for this key*.
  if (/not\s+verified/i.test(msg)) {
    const d = domainOfFrom(ctx.from);
    const who = d ? `发信域 ${d}` : '发信域';
    return `${msg}（提示：${who} 对**这把** API Key 不可用。Resend 控制台显示已验证还不够，请依次核对：①控制台里验证的域名与发信域完全相同（子域 / 根域不能混用，例如验证了 mail.example.com 却用 @example.com 发信）；②这把 Key 与该控制台属于同一个 Team / 账号；③该 Key 不是被限制到其它域名的 Sending access Key。用「域名自检」可以看到这把 Key 实际能识别哪些域。）`;
  }

  // 403 validation_error — no verified domain on the account at all.
  if (/only send testing emails to your own email address/i.test(msg)) {
    return `${msg}（提示：该账号下这把 Key 还没有任何已验证的发信域名，Resend 只允许发给自己的邮箱。请先在 Resend 添加并验证域名，或改用已验证域名下的地址发信。）`;
  }

  // 401 / deleted key.
  if (/api key is invalid|missing api key/i.test(msg)) {
    return `${msg}（提示：Resend API Key 无效、已删除或未配置。请到 Resend → API Keys 复制一把有效的 Key，在「⟳ 自检 → 修改发信 Key」里保存（数据库优先，环境变量只作兜底）。）`;
  }

  return msg;
}
