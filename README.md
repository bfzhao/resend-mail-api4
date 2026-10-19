# Zero cost multi-domain Mailer

Collect mail for your own domains into a **self-hosted** web inbox:

- **Inbound**: Cloudflare Email Routing receives mail and **never loses mail**.
- **Outbound**: send through [Resend](https://resend.com) (HTML + attachments supported).
- **Web UI**: a simplified Gmail-style interface with read / unread / star / delete (trash) / compose / reply / multi-address switching / search.

All data lives in **your own** Cloudflare account (D1 / R2 / Queue), and the Resend key is stored in your own D1 — no secrets leave your account.

---

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bfzhao/resend-mail-api)

> On click, Cloudflare clones this repo **into your GitHub account**, provisions D1 / R2 / Queue from `wrangler.toml`, and deploys it to your Cloudflare account.

### Prerequisites

- **Cloudflare account** (Free plan is fine)
- **A domain** whose DNS is hosted on Cloudflare (nameservers pointed at Cloudflare)
- **Resend account** (Free plan is fine; used for outbound and domain verification)
- **GitHub account** (the Deploy Button clones the repo into your account)

### After deploy: follow the in-app wizard

1. Open the URL Cloudflare gives you: `https://<your-worker>.<subdomain>.workers.dev`
2. The first visit opens the setup wizard:
   - **Step 1 · Set up admin**: choose a username and password (used to sign in afterwards).
   - **Step 2 · Connect your domain**: enter the domain + Cloudflare API Token + Resend API Key.
     Clicking "Start setup" then automatically: finds the zone → enables Email Routing and points catch-all at this Worker → creates the sending domain in Resend → writes DKIM/SPF/DMARC into your DNS → triggers Resend verification.
3. Done — you can now receive, compose, and reply.

**Cloudflare API Token — four zone permissions.** The wizard's **"Open the Cloudflare authorisation page"** button opens Cloudflare's token UI (a "token template URL", see `CF_TOKEN_PERMS`) with the first three pre-selected; the fourth needs one click:

- Auto-selected: `Zone → Read`, `DNS → Edit`, `Zone Settings → Edit`
- **One manual click**: `Zone → Email Routing Rules → Edit` (Cloudflare does not allow pre-selecting this one from a link; the wizard tells you to use "+ Add more")
- `Zone Resources` defaults to All zones — change it to `Include → your domain` to authorise just that zone

If the token lacks a permission, the wizard step says "this operation needs the xxx permission" instead of failing silently.

**Resend API Key — Full access.** A sending-only key can send but cannot create / read / verify domains (`This API key is restricted to only send emails`).

| Setting | Where it lives / how to change it |
|---|---|
| Resend key | **Per domain** (`domains.resend_api_key`). There is **no global database key** — env `RESEND_API_KEY` is only the fallback, which is why two domains in two different Resend accounts both work |
| Cloudflare token | Used once during setup, **never stored** |
| Changing a key | No redeploy needed: click the **health marker** after the domain name → *Edit the sending key for* `<domain>` → *Save and re-check* |

**The domain chip** · **✓ / ? / !** right after the name is the automatic check (✓ passed · ? not checked yet · ! problem — click it for that domain's tables and key settings)

The check runs **by itself** (on page load, then at most every 30 minutes): using the key that actually sends, it reads the domain's Resend status and then verifies MX / DKIM / SPF / DMARC over public DNS (no token needed).

---

## Self-hosting / local development

```bash
npm install
npm run typecheck

# Local database (sqlite at .wrangler/state)
npm run db:migrate:local

# Put local secrets in .dev.vars (not committed)
# RESEND_API_KEY=re_xxx
# API_USERNAME=admin
# API_PASSWORD=change-me

npm run dev            # http://localhost:8787
```

> `RESEND_API_KEY` in `.dev.vars` are **bootstrap only**: they are imported into the local D1 on the
> first request, after which D1 wins (edit them in-app from the domain chip: health marker → Edit the sending key). `API_USERNAME` / `API_PASSWORD` stay env-only.

To self-host on your own Cloudflare account, use the **local config file** (gitignored, never made public):

```bash
# fill in your own database_id etc. in wrangler.local.toml
wrangler deploy -c wrangler.local.toml
```

> `wrangler.toml` is a **template** for the Deploy Button: its D1 `database_id` is the placeholder `<DATABASE_ID>`, which is created and filled in automatically on cloud deploy. Keep your own production ids in `wrangler.local.toml`.

### Schema (auto-created on a fresh DB)

After deploying to a brand-new empty D1, **the Worker creates the tables automatically on first request** (idempotent) — no manual migration needed. The source of truth is [`schema.sql`](./schema.sql); `src/schema-sql.ts` is its inlined form (used at runtime). After editing `schema.sql`, run:

```bash
npm run schema:sync
```

(`test/schema-sql-sync.test.js` checks that the two stay in sync.)

---

## Architecture

```
Cloudflare Email Routing ──(email)──┐
   (MX = mx.cloudflare.net)         │  ① stream the raw .eml to R2 + register inbound_raw
                                    ▼
                              Worker (src/index.ts)
                 ├─ R2: raw messages + attachments
                 ├─ D1: messages / attachments / inbound_raw / delivery_events / drafts / app_config / users …
                 ├─ Queue: async parsing (never-lose stage 2)
                 └─ Resend API: send / reply (outbound)
                                    ▲
                   Browser SPA (public/, served via ASSETS)
                   Folders: Inbox / Starred / Sent / Trash
```

- Inbound and outbound share one `messages` table, distinguished by `direction` (inbound / outbound); folders are just query views.
- Deleted = soft delete (`deleted=1`); the trash can either restore or permanently delete (which also removes the R2 attachments).
- `thread_id` groups by the root Message-ID of the References chain (**the Sent folder is not grouped** — one row per message); `mailbox` records the receiving address, enabling multi-address switching. Drafts are never narrowed by the mailbox/domain filters: a draft belongs to the sender you picked.
- Cloudflare Email Routing is a router and **does not store mail**, so the first thing we do on receive is persist to R2 + register, then enqueue for async parsing; a `*/15` cron re-enqueues anything left unparsed to self-heal.

## Layout

```
public/            SPA (no build step): index.html / app.css / app.js
src/
  index.ts         routing: /webhook/*, /api/*, /api/setup/*, static asset fallback
  auth.ts          auth (env Basic / D1 session)
  session.ts       PBKDF2 password hashing + session cookie
  setup.ts         setup wizard: domain + automatic DNS + send/receive auth + self-check
  cloudflare.ts    Cloudflare API (DNS / Email Routing)
  resend-domains.ts Resend domain API
  resend-errors.ts Resend error messages → actionable hints (key / domain / permissions)
  schema.ts        ensureSchema: idempotent table creation on first request for a fresh DB
  schema-sql.ts    inlined form of schema.sql (generated by npm run schema:sync)
  webhook.ts       Resend webhook signature verification, inbound receipt, outbound receipts
  inbound-email.ts CF Email Routing inbound (persist to R2 + enqueue + async parse + self-heal)
  repo.ts          D1/R2 access, folder queries, sessions, batch operations
  receiving.ts     Resend Received Emails API
  send.ts          send via Resend (with attachments)
  util.ts          address parsing / time / base64 / encoding, etc.
schema.sql         table schema (single source of truth)
scripts/sync-schema.js  generates src/schema-sql.ts from schema.sql
migrations/        incremental migrations for existing DBs (001 … 012)
wrangler.toml      Deploy Button template config
wrangler.local.toml self-host config (gitignored)
```

## Security

- Inbound HTML bodies are sanitized with a front-end allowlist before rendering; the attachment proxy sends non-images with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`.
- The admin password is hashed with PBKDF2-SHA256 (100k iterations) and stored in D1; sessions are HMAC-signed cookies.
- Webhooks verify a 5-minute timestamp window; `webhook_deliveries` provides idempotency.
- In production, configure via env vars / the wizard; never put secrets in `wrangler.toml`.

## Known limitations

- Cloudflare Email Routing enforces a 25 MiB inbound limit (larger mail is rejected), so practical attachment size is ~18–19 MB.
- Replies don't quote inline images, only plain-text quoting.
- Single admin account only.

## License

MIT
