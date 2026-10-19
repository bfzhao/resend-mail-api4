'use strict';

/* =============================================================================
 * Independent regression verification of three inbox UI defect classes (real jsdom + real DOM events + real app.js)
 *
 * Run:
 *   NODE_PATH='<NODE_PATH>' \
 *     node test/inbox-ui.regression.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed; 2 = environment missing (jsdom not found).
 * This file only reads source under public/ and makes no modifications.
 *
 * Covers defects:
 *   BUG-1  row selection highlight lingering (multiple .list-item.active at once)
 *   BUG-1b "select all on this page" checkbox state lingering
 *   BUG-2  a list row still shows unread after being read (the 0->1 transition not written back locally)
 *   BUG-3a the account dropdown is silently rewritten (state.mailbox decoupled from sel.value)
 *   BUG-3c the account unread count goes stale after reading (doesn't re-request /api/mailboxes)
 *   BUG-3d dropdown items / list title number semantics unlabeled
 *   BUG-4  periodic sync clears the list (the force path doesn't reset offset -> requests page 2 -> an empty page overwrites everything)
 *   BUG-5  under the localStorage restore path the specific account selection is silently reset (dropdown/request/list all lost)
 *
 * Note: assertions are all based on "the correct behavior described by the requirement spec" and the public functions that actually
 * exist in app.js (openFolder / openMessage / closeMessagePane / renderMailboxSelect / loadMailboxes /
 *  renderSelectBar), driven by real DOM events, not relying on invented private function names.
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('无法加载 jsdom。请用 NODE_PATH 指向 jsdom 所在 node_modules（Windows 反斜杠写法）：');
  console.error("  NODE_PATH='<NODE_PATH>' node test/inbox-ui.regression.test.js");
  console.error(String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
// QA_APP_JS is only for "mutation verification": points to a hand-crafted defective app.js, to confirm this test really catches the defect.
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
// QA_INDEX_HTML is only for "mutation verification": points to a hand-crafted defective index.html (the variant lives outside the repo).
// Without this hook, the HTML variant would "run the repo's original file while thinking it ran the variant" -> the variant is never caught (false negative).
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');
const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');

const FINGERPRINT = {
  md5: crypto.createHash('md5').update(APP_JS).digest('hex'),
  mtime: fs.statSync(APP_JS_PATH).mtime.toISOString(),
  bytes: Buffer.byteLength(APP_JS),
};

/**
 * The local snapshot's version number is **read live from app.js**, not written again here.
 *
 * The consequence of hard-coding `v: 1`: once CACHE_VERSION is bumped, readPersisted() would deem the snapshot expired and
 * silently take the empty path -- yet T4b/T4c/T4d verify exactly the "restore path", which would become "snapshot rejected -> nothing restored"
 * (or worse: the assertion happens to still hold -> the restore path was never actually tested). Taking the live value avoids the mismatch.
 * Also assert in T0 that it really parsed, to avoid silently becoming NaN when the regex fails.
 */
const CACHE_VERSION_IN_APP = Number((/const CACHE_VERSION = (\d+);/.exec(APP_JS) || [])[1]);

/* ---------------------------------------------------------------------------
 * fetch stub (jsdom doesn't implement fetch; without a stub api() silently swallows it as a "network error")
 * -------------------------------------------------------------------------*/

function makeStub(cfg = {}) {
  const calls = [];
  const counters = { account: 0, mailboxes: 0, counts: 0, folders: 0, detail: 0, batch: 0, patch: 0 };
  const store = {
    mailboxes: cfg.mailboxes || [],
    folders: cfg.folders || {},
    messages: cfg.messages || {},
    counts: cfg.counts || { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 },
  };
  // honorPaging: real backend semantics, slices by limit/offset (required for BUG-4, otherwise "page 2 is empty" can't be reproduced)
  const honorPaging = !!cfg.honorPaging;
  // foldersByMailbox: return a different dataset per mailbox query param (used by BUG-5; missing hit with non-empty mailbox -> empty page)
  const foldersByMailbox = cfg.foldersByMailbox || null;
  // holdDetail: hold the detail response; the test releases it explicitly via releaseDetail() (FIFO).
  // Used to observe the intermediate state "header rendered, body still downloading", and to verify stale responses aren't adopted.
  // Can be toggled at runtime via setHoldDetail(): usually off during boot, turned on during the click phase.
  let holdDetail = !!cfg.holdDetail;
  const heldDetails = [];

  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url, method, body: init.body });
    const pathOnly = url.split('?')[0];
    const qs = new URLSearchParams(url.split('?')[1] || '');

    if (pathOnly === '/api/account') {
      counters.account++;
      return Promise.resolve(jsonRes({ can_send: true, from_name: 'Me', from_address: 'me@example.com' }));
    }
    if (pathOnly === '/api/mailboxes') {
      counters.mailboxes++;
      return Promise.resolve(jsonRes({ mailboxes: store.mailboxes }));
    }
    if (pathOnly === '/api/counts') {
      counters.counts++;
      return Promise.resolve(jsonRes(store.counts));
    }
    const fm = /^\/api\/folders\/([a-z]+)$/.exec(pathOnly);
    if (fm) {
      counters.folders++;
      let d = store.folders[fm[1]] || { items: [], total: 0 };
      if (foldersByMailbox) {
        const mb = qs.get('mailbox') || '';
        d = Object.prototype.hasOwnProperty.call(foldersByMailbox, mb)
          ? foldersByMailbox[mb]
          : { items: [], total: 0 }; // unknown account -> empty page (real backend semantics)
      }
      if (honorPaging) {
        const limit = Number(qs.get('limit') || 50);
        const offset = Number(qs.get('offset') || 0);
        return Promise.resolve(jsonRes({ folder: fm[1], items: d.items.slice(offset, offset + limit), total: d.total }));
      }
      return Promise.resolve(jsonRes({ folder: fm[1], items: d.items, total: d.total }));
    }
    if (pathOnly === '/api/messages/batch' && method === 'POST') {
      counters.batch++;
      return Promise.resolve(jsonRes({ changed: 1 }));
    }
    const mm = /^\/api\/messages\/([^/]+)$/.exec(pathOnly);
    if (mm) {
      const id = decodeURIComponent(mm[1]);
      if (method === 'PATCH') {
        counters.patch++;
        return Promise.resolve(jsonRes({ ok: true }));
      }
      counters.detail++;
      const d = store.messages[id];
      if (!d) return Promise.resolve(jsonRes({ error: '邮件不存在' }, 404));
      if (holdDetail) {
        return new Promise((resolve) => { heldDetails.push({ id, resolve: () => resolve(jsonRes(d)) }); });
      }
      return Promise.resolve(jsonRes(d));
    }
    return Promise.resolve(jsonRes({}));
  };

  return {
    fetchImpl, calls, counters, store,
    /** Release a detail response held by holdDetail. Pass an id to release that one, or omit it to release the earliest. Returns whether it released one. */
    releaseDetail(id) {
      const idx = id === undefined ? 0 : heldDetails.findIndex((h) => h.id === id);
      if (idx < 0 || idx >= heldDetails.length) return false;
      const [h] = heldDetails.splice(idx, 1);
      h.resolve();
      return true;
    },
    /** List of currently held (not yet released) detail request ids, in arrival order. */
    heldDetailIds: () => heldDetails.map((h) => h.id),
    /** Runtime toggle for "hold the detail response". */
    setHoldDetail(v) { holdDetail = !!v; },
  };
}

/* ---------------------------------------------------------------------------
 * Fixtures (each case builds a fresh object to avoid cross-case pollution)
 * -------------------------------------------------------------------------*/

function msg(id, read, extra = {}) {
  return Object.assign({
    id,
    direction: 'inbound',
    from_name: '发件人' + id,
    from_email: id.toLowerCase() + '@x.com',
    subject: '主题 ' + id,
    to_emails: ['me@x.com'],
    received_at: 1700000000 + id.charCodeAt(0),
    read,
    starred: 0,
    status: 'received',
    attachments_count: 0,
    preview: '预览 ' + id,
    mailbox: 'alpha@x.com',
  }, extra);
}

/**
 * Detail response: the server has already set read to 1 before responding (the real behavior of src/index.ts getMessageDetail).
 * thread optional: thread-panel cases need real thread items, defaulting to an empty array (same as the original behavior).
 */
function detail(m, read, thread = []) {
  return {
    message: Object.assign({}, m, {
      read,
      body_text: '正文 ' + m.id,
      body_html: null,
      thread_id: 't-' + m.id,
      cc: [],
      bcc: [],
      reply_to: [],
      mailbox: m.mailbox || 'alpha@x.com',
    }),
    attachments: [],
    thread,
  };
}

/**
 * The list's first item C is a "read" placeholder mail: init()'s maybeAutoOpen() auto-opens the first item.
 * Use it to block auto-open, so A/B's initial unread state isn't incidentally changed by auto-open.
 */
function inboxFixture() {
  const C = msg('C', 1);
  const A = msg('A', 0);
  const B = msg('B', 1);
  const S1 = msg('S1', 1, { direction: 'outbound', status: 'sent', mailbox: 'alpha@x.com' });
  return {
    mailboxes: [
      { mailbox: 'alpha@x.com', inbox_unread: 1, inbox_total: 2, sent_total: 1 },
      { mailbox: 'beta@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
    ],
    folders: {
      inbox: { items: [C, A, B], total: 3 },
      sent: { items: [S1], total: 1 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages: {
      A: detail(A, 1),
      B: detail(B, 1),
      C: detail(C, 1),
      S1: detail(S1, 1),
    },
    counts: { inbox_unread: 1, inbox_total: 2, sent_total: 1, starred_total: 0, trash_total: 0 },
  };
}

/**
 * Thread panel fixture: regression for "thread rows must show the actual mailboxes of both sender and recipient".
 *
 * ⚠️ Thread item field names must match the **real interface**: the recipient is `to` (see thread.map in src/index.ts),
 * not `to_emails`. Historically the frontend only read `t.to_emails` -> always undefined -> the thread row always showed "me → ?".
 * Here only `to` is provided on purpose, so a wrong field name makes the case fail necessarily (rather than "coincidentally getting it right").
 *
 * ⚠️ The array order must match the **real interface = descending (most recent first)**: repo.listThread()'s
 * `ORDER BY received_at DESC` is the sorting truth; the frontend only renders it as-is.
 * So `threadItems` here is ordered T3(…300) -> T2(…200) -> T1(…100).
 * (Sorting on the backend side is guarded by T12a in test/inbound-ingest.backend.test.js; this suite guards the render order.)
 *
 * The list's first item T3 is **read**: init()'s maybeAutoOpen opens it, and the thread panel (length > 1) renders accordingly.
 */
function threadFixture() {
  const threadItems = [
    { // the other party's latest reply (no name -> falls back to the email address), also the currently opened one; newest time -> first
      id: 'T3', direction: 'inbound', mailbox: 'alpha@x.com',
      from_name: null, from_email: 'bob@partner.com',
      to: ['alpha@x.com'], subject: 'Re: 报价确认',
      preview: '补充', received_at: 1700000300, read: true, deleted: false, current: true,
    },
    { // my reply (outbound, two recipients)
      id: 'T2', direction: 'outbound', mailbox: 'support@x.com',
      from_name: 'support', from_email: 'support@x.com',
      to: ['alice@partner.com', 'bob@partner.com'], subject: 'Re: 报价确认',
      preview: '好的', received_at: 1700000200, read: true, deleted: false, current: false,
    },
    { // the earliest inbound mail (has a name)
      id: 'T1', direction: 'inbound', mailbox: 'alpha@x.com',
      from_name: 'Alice', from_email: 'alice@partner.com',
      to: ['alpha@x.com'], subject: '报价确认',
      preview: '见附件', received_at: 1700000100, read: true, deleted: false, current: false,
    },
  ];

  // List items use the LIST_SELECT shape (recipient is to_emails), consistent with the real list interface.
  const T3 = msg('T3', 1, {
    from_name: null, from_email: 'bob@partner.com', subject: 'Re: 报价确认', mailbox: 'alpha@x.com',
  });
  const T2 = msg('T2', 1, {
    direction: 'outbound', from_name: 'support', from_email: 'support@x.com',
    to_emails: ['alice@partner.com', 'bob@partner.com'], subject: 'Re: 报价确认',
    mailbox: 'support@x.com', status: 'sent',
  });
  // T4 sorts after T3 -> won't be opened by maybeAutoOpen, used to verify "optimistic rendering while the detail hasn't returned".
  const T4 = msg('T4', 1, {
    from_name: 'Carol', from_email: 'carol@partner.com', subject: '另一封信', mailbox: 'beta@x.com',
  });

  return {
    mailboxes: [
      { mailbox: 'alpha@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
      { mailbox: 'beta@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
      { mailbox: 'support@x.com', inbox_unread: 0, inbox_total: 0, sent_total: 1 },
    ],
    folders: {
      inbox: { items: [T3, T4], total: 2 },
      sent: { items: [T2], total: 1 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages: {
      T3: detail(T3, 1, threadItems),
      T2: detail(T2, 1, threadItems),
      T4: detail(T4, 1, []),
    },
    counts: { inbox_unread: 0, inbox_total: 2, sent_total: 1, starred_total: 0, trash_total: 0 },
  };
}

/**
 * Thread-copy fixture: simulates a real online scenario (2026-10-08 production data) --
 * I sent from dana@ and **cc'd erin@**, the same mail was delivered by Resend back to this account's
 * erin@, so the DB has both an outbound copy (T2) and an inbound copy (T2c).
 * The server's `listThread` has already collapsed the inbound copy: the thread **has no T2c**, only T2 with `copy_ids:['T2c']`.
 *
 * This case sets the mail the user opened to the **collapsed copy** T2c (placed into erin@'s inbox at the top of the list,
 * so maybeAutoOpen opens it), verifying the thread panel still marks T2 as the current row --
 * otherwise no row in the panel is highlighted, looking like "the one I opened has disappeared".
 */
function threadCopyFixture() {
  // Descending time: T3(…300) -> T2(…200); T2c and T2 differ by only 2 seconds, same physical mail
  const T3 = msg('T3', 1, {
    from_name: null, from_email: 'bob@partner.com', subject: 'Re: 报价确认',
    mailbox: 'alpha@x.com', received_at: 1700000300,
  });
  const T2c = msg('T2c', 1, {
    from_name: 'support', from_email: 'support@x.com', subject: 'Re: 报价确认',
    mailbox: 'erin@x.com', received_at: 1700000203,
  });
  const threadItems = [
    { // the other party's mail (newest -> first, consistent with the interface's descending order)
      id: 'T3', direction: 'inbound', mailbox: 'alpha@x.com',
      from_name: null, from_email: 'bob@partner.com',
      to: ['alpha@x.com'], subject: 'Re: 报价确认',
      preview: '补充', received_at: 1700000300, read: true, deleted: false, current: false,
    },
    { // outbound copy (retained row): the "other records" of the same physical mail within this account hang on copy_ids
      id: 'T2', direction: 'outbound', mailbox: 'support@x.com',
      from_name: 'support', from_email: 'support@x.com',
      to: ['alice@partner.com'], subject: 'Re: 报价确认',
      preview: '好的', received_at: 1700000201, read: true, deleted: false, current: false,
      copy_ids: ['T2c'],
    },
  ];

  return {
    mailboxes: [
      { mailbox: 'alpha@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
      { mailbox: 'erin@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
      { mailbox: 'support@x.com', inbox_unread: 0, inbox_total: 0, sent_total: 1 },
    ],
    folders: {
      // T2c first -> what maybeAutoOpen opens is this collapsed copy
      inbox: { items: [T2c, T3], total: 2 },
      sent: { items: [], total: 0 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages: {
      T2c: detail(T2c, 1, threadItems),
      T3: detail(T3, 1, threadItems),
    },
    counts: { inbox_unread: 0, inbox_total: 2, sent_total: 1, starred_total: 0, trash_total: 0 },
  };
}

/** BUG-4 fixture: 50 rows, total=50, the stub truly slices by limit/offset -> page 2 is necessarily empty. */
function pagingFixture() {
  const items = [];
  for (let i = 0; i < 50; i++) items.push(msg('P' + String(i).padStart(2, '0'), i === 0 ? 0 : 1));
  const messages = {};
  for (const it of items) messages[it.id] = detail(it, it.read);
  return {
    honorPaging: true,
    folders: {
      inbox: { items, total: 50 },
      sent: { items: [], total: 0 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages,
    mailboxes: [{ mailbox: 'alpha@x.com', inbox_unread: 1, inbox_total: 50, sent_total: 0 }],
    counts: { inbox_unread: 1, inbox_total: 50, sent_total: 0, starred_total: 0, trash_total: 0 },
  };
}

/**
 * Prefetch case fixture: inbox and sent **50 each, non-overlapping ids**.
 * This way "did switching views grab the wrong view / grab twice" is observable --
 * if the new view were an empty list, the prefetch's cursor scan would naturally break, disguising "cancel didn't take effect" as a pass.
 */
function prefetchFixture() {
  const inboxItems = [];
  const sentItems = [];
  const messages = {};
  for (let i = 0; i < 50; i++) {
    const n = String(i).padStart(2, '0');
    const a = msg('P' + n, i === 0 ? 0 : 1);
    const b = msg('S' + n, 1, { direction: 'outbound', status: 'sent' });
    inboxItems.push(a);
    sentItems.push(b);
    messages[a.id] = detail(a, a.read);
    messages[b.id] = detail(b, 1);
  }
  return {
    honorPaging: true,
    folders: {
      inbox: { items: inboxItems, total: 50 },
      sent: { items: sentItems, total: 50 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages,
    mailboxes: [{ mailbox: 'alpha@x.com', inbox_unread: 1, inbox_total: 50, sent_total: 50 }],
    counts: { inbox_unread: 1, inbox_total: 50, sent_total: 50, starred_total: 0, trash_total: 0 },
  };
}

/** BUG-5 fixture: a localStorage snapshot left over from the last session, with the specific account beta selected. */
function seededBetaFixture() {
  const items = [];
  for (let i = 0; i < 7; i++) items.push(msg('B' + i, i === 0 ? 0 : 1, { mailbox: 'beta@x.com' }));
  const messages = {};
  for (const it of items) messages[it.id] = detail(it, it.read);
  const mailboxes = [
    { mailbox: 'alpha@x.com', inbox_unread: 2, inbox_total: 3, sent_total: 0 },
    { mailbox: 'beta@x.com', inbox_unread: 1, inbox_total: 7, sent_total: 0 },
  ];
  const counts = { inbox_unread: 1, inbox_total: 7, sent_total: 0, starred_total: 0, trash_total: 0 };
  return {
    mailboxes,
    counts,
    seedCache: {
      v: CACHE_VERSION_IN_APP,
      at: Date.now(),
      folderKey: 'beta@x.com|inbox|',
      mailbox: 'beta@x.com',
      folderName: 'inbox',
      q: '',
      folder: { items, total: 7 },
      counts,
      mailboxes,
      openId: null,
    },
    // The "all mailboxes" view intentionally has a different row count, to distinguish "took the wrong branch"
    foldersByMailbox: {
      'beta@x.com': { items, total: 7 },
      '': { items: items.slice(0, 3), total: 3 },
      'alpha@x.com': { items: [], total: 0 },
    },
    messages,
  };
}

/** BUG-5 negative-control fixture: the account in the snapshot no longer exists (ghost). */function seededGhostFixture() {
  const items = [];
  for (let i = 0; i < 4; i++) items.push(msg('G' + i, 1, { mailbox: 'ghost@x.com' }));
  const messages = {};
  for (const it of items) messages[it.id] = detail(it, 1);
  const mailboxes = [
    { mailbox: 'alpha@x.com', inbox_unread: 2, inbox_total: 3, sent_total: 0 },
    { mailbox: 'beta@x.com', inbox_unread: 0, inbox_total: 7, sent_total: 0 },
  ];
  const counts = { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 };
  return {
    mailboxes,
    counts,
    seedCache: {
      v: CACHE_VERSION_IN_APP,
      at: Date.now(),
      folderKey: 'ghost@x.com|inbox|',
      mailbox: 'ghost@x.com',
      folderName: 'inbox',
      q: '',
      folder: { items, total: 4 },
      counts: { inbox_unread: 0, inbox_total: 4, sent_total: 0, starred_total: 0, trash_total: 0 },
      mailboxes,
      openId: null,
    },
    foldersByMailbox: {
      'ghost@x.com': { items, total: 4 },
      // The fallback target alpha must have content, otherwise the list would be empty and init's readiness criterion (list has rows) can't be met
      'alpha@x.com': { items: items.slice(0, 2), total: 2 },
      'beta@x.com': { items: [], total: 0 },
    },
    messages,
  };
}

/**
 * T4d fixture: `/api/mailboxes` returns an **empty array** (the server's accounts were cleared).
 * snapshotMailboxes controls the account list in the localStorage snapshot:
 *   - sub-case B: the snapshot contains an account list (the dropdown was populated with options before) -> snapshotMailboxes = [beta]
 *   - sub-case C: the snapshot's mailboxes are empty (the dropdown was never populated)  -> snapshotMailboxes = []
 * In both cases state.mailbox is 'beta@x.com', and the list request must carry mailbox=beta.
 */
function emptyMailboxesFixture(snapshotMailboxes) {
  const items = [];
  for (let i = 0; i < 5; i++) items.push(msg('E' + i, i === 0 ? 0 : 1, { mailbox: 'beta@x.com' }));
  const messages = {};
  for (const it of items) messages[it.id] = detail(it, it.read);
  const counts = { inbox_unread: 1, inbox_total: 5, sent_total: 0, starred_total: 0, trash_total: 0 };
  return {
    mailboxes: [], // <- the server's account list is empty
    counts,
    seedCache: {
      v: CACHE_VERSION_IN_APP,
      at: Date.now(),
      folderKey: 'beta@x.com|inbox|',
      mailbox: 'beta@x.com',
      folderName: 'inbox',
      q: '',
      folder: { items, total: 5 },
      counts,
      mailboxes: snapshotMailboxes,
      openId: null,
    },
    // The "all mailboxes" view intentionally also has rows (otherwise if an implementation drops mailbox, the list would be empty and the case would only time out during boot,
    // failing to report the real cause "request missing mailbox")
    foldersByMailbox: { 'beta@x.com': { items, total: 5 }, '': { items: items.slice(0, 2), total: 2 } },
    messages,
  };
}

/* ---------------------------------------------------------------------------
 * Boot an application instance that "has finished running init()"
 * -------------------------------------------------------------------------*/

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }
const sleep = (ctx, ms) => new Promise((r) => ctx.win.setTimeout(r, ms));

/** Poll until some expression in the page becomes true (default 4s). Use it for async processes like background prefetch, not a fixed sleep to guess the duration. */
async function waitUntil(ctx, expr, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = false;
    try { v = !!evalIn(ctx, expr); } catch { /* script not ready yet */ }
    if (v) return true;
    await sleep(ctx, 40);
  }
  return false;
}

/** Explicitly start one body prefetch. boot() invalidates automatic prefetch by default; only cases that need to verify prefetch use this. */
function startPrefetch(ctx) { evalIn(ctx, 'prefetchBodies()'); }

async function boot(cfg = {}) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  // jsdom defaults document.hidden === true (visibilityState='prerender'),
  // which makes periodicSync() return immediately at `if (document.hidden) return;` and send not a single request.
  // In a real browser a visible tab is visible; align it explicitly here, otherwise the periodic sync path is untestable in jsdom.
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  // seedCache: write the localStorage snapshot **before** injecting app.js (BUG-5's "residual from the last session" scenario)
  if (cfg.seedCache !== undefined) {
    const raw = typeof cfg.seedCache === 'string' ? cfg.seedCache : JSON.stringify(cfg.seedCache);
    win.localStorage.setItem('inbox-cache-v1', raw);
  }
  const stub = makeStub(cfg);
  win.fetch = stub.fetchImpl; // must be before injecting app.js

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  // Readiness criteria: renderNav has rendered 4 folders + loadFolder has rendered list rows + maybeAutoOpen has opened the first mail.
  // All three happen after setupEvents(), so it's equivalent to "events wired, init finished".
  // Also need the detail settled (detailPending cleared), otherwise it stops at the intermediate state "header drawn, body still downloading".
  // Under holdDetail the detail is intentionally held by the test, so this one is exempted automatically.
  const wantDetailSettled = !cfg.holdDetail;
  let ready = false;
  for (let i = 0; i < 600; i++) {
    const nav = win.document.querySelector('#folder-nav');
    const list = win.document.querySelector('#list');
    let openId = null;
    let detailSettled = false;
    try {
      openId = win.eval('typeof state === "object" ? state.openId : null');
      detailSettled = !win.eval('detailPending');
    } catch { /* script not ready yet */ }
    const settledOk = !wantDetailSettled || detailSettled;
    if (nav && nav.children.length > 0 && list && list.children.length > 0 && openId && settledOk) {
      ready = true; break;
    }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 10);

  // Background body prefetch is **time-dependent**: it starts sequentially sending detail requests 500ms after paintList(),
  // making all "request count" assertions flaky (measured: T9's cache-count precondition was disturbed by one extra mail).
  // By default invalidate it at the end of boot, making the test fully deterministic; cases that verify prefetch itself call
  // startPrefetch()/waitUntil() explicitly. Both gen and active must be cleared: only incrementing gen leaves the canceled
  // round still holding prefetchActive, so a later startPrefetch() would be blocked by an early return.
  if (!cfg.keepPrefetch) win.eval('prefetchGen++; prefetchActive = null;');

  return { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
}

/* ---------------------------------------------------------------------------
 * DOM / event helpers
 * -------------------------------------------------------------------------*/

const evalIn = (ctx, expr) => ctx.win.eval(expr);
const el = (ctx, sel) => ctx.doc.querySelector(sel);
const rowFor = (ctx, id) => ctx.doc.querySelector(`.list-item[data-id="${id}"]`);
const activeRows = (ctx) => ctx.doc.querySelectorAll('.list-item.active');
const hidden = (ctx, sel) => el(ctx, sel).classList.contains('hidden');

function clickEl(ctx, node) {
  node.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function clickRow(ctx, id) {
  const r = rowFor(ctx, id);
  if (!r) throw new Error(`找不到列表行: ${id}`);
  clickEl(ctx, r);
}
function setCheckbox(ctx, sel, checked) {
  const n = el(ctx, sel);
  n.checked = checked;
  n.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
}
function setSearch(ctx, value) {
  const n = el(ctx, '#search-input');
  n.value = value;
  n.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
}
/** Restore the list to a clean "no selection, nothing open" state using real user actions. */
async function resetList(ctx) {
  evalIn(ctx, "openFolder('inbox')");
  await ticks(ctx.win, 6);
}

/* ---------------------------------------------------------------------------
 * Test case runner
 * -------------------------------------------------------------------------*/

const results = [];
let currentTest = '(boot)';
let pass = 0;
let fail = 0;

function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  const tail = detail === undefined ? '' : `  [${detail}]`;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${tail}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

async function test(name, fn, cfg) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(cfg || inboxFixture());
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    if (ctx) ctx.close();
  }
}

/* ---------------------------------------------------------------------------
 * BUG-4 / BUG-5 dedicated helpers
 * -------------------------------------------------------------------------*/

/** Extract a query param from a URL recorded by fetch (used to assert the request really carried offset / mailbox). */
function queryParam(url, key) {
  const qs = new URLSearchParams(String(url).split('?')[1] || '');
  return qs.get(key);
}
const folderCalls = (ctx) => ctx.stub.calls.filter((c) => /^\/api\/folders\//.test(c.url));

/**
 * Detail requests (GET /api/messages/:id), can specify a starting index.
 *
 * ⚠️ **Must filter by `c.url`**: `calls` holds **objects** `{ url, method, body }`.
 * If written as `filter((u) => /^\/api\/messages\//.test(u))`, the regex is implicitly coerced from `"[object Object]"`
 * -> **never matches** -> `length === 0` always holds -> the assertion is a **no-op false green**.
 * This isn't hypothetical: T8 "no more detail requests after refresh" initially "passed" this way.
 */
const detailCalls = (ctx, from = 0) => ctx.stub.calls.slice(from).filter((c) => /^\/api\/messages\//.test(c.url));

/**
 * Predicate self-check: confirm the filter above **really identifies detail requests**, not always empty.
 * Without this step, a "expect 0" assertion can't distinguish "indeed sent none" from "the filter is broken".
 * Forms a positive/negative control pair with T10 (same filter, expects exactly 1).
 */
function assertDetailCollectorWorks(ctx) {
  ok(ctx.stub.calls.every((c) => c && typeof c.url === 'string'),
    '谓词自检：calls 里是 {url,...} 对象（必须按 c.url 过滤，不能拿正则直接测对象）');
  const probe = { url: '/api/messages/__probe__', method: 'GET' };
  ok(/^\/api\/messages\//.test(probe.url), '谓词自检：过滤器能识别详情请求 URL');
  ok(!/^\/api\/messages\//.test(probe), '谓词自检：拿正则直接测对象不匹配（即空转写法的症状）');
}

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ===========================================================================
 * Test cases
 * ===========================================================================*/

(async function main() {
  console.log('收件箱 UI 三类缺陷 —— 独立 jsdom 回归验证');
  console.log(`被测版本: app.js md5=${FINGERPRINT.md5}  mtime=${FINGERPRINT.mtime}  bytes=${FINGERPRINT.bytes}`);

  /* ---- T0 environment self-check: ensure the assertions aren't "no-op lucky passes" ---- */
  await test('T0 测试环境自检（harness 可信度）', async (ctx) => {
    ok(typeof ctx.win.openMessage === 'function', 'app.js 已注入且 openMessage 为全局函数');
    ok(typeof ctx.win.openFolder === 'function', 'openFolder 为全局函数');
    ok(typeof ctx.win.loadMailboxes === 'function', 'loadMailboxes 为全局函数');
    ok(el(ctx, '#folder-nav').children.length === 5, 'renderNav 已执行（5 个文件夹：收件箱/草稿/星标/已发送/已删除）', el(ctx, '#folder-nav').children.length);
    ok(ctx.stub.counters.account >= 1, '/api/account 被请求（fetch 打桩生效）', ctx.stub.counters.account);
    ok(ctx.stub.counters.folders >= 1, '/api/folders/* 被请求（列表数据来自打桩）', ctx.stub.counters.folders);
    ok(evalIn(ctx, 'state.items.length') === 3, '列表渲染出 3 行', evalIn(ctx, 'state.items.length'));
    // The snapshot version number is taken from app.js by regex; if the regex fails it silently becomes NaN, and the restore-path cases
    // below would "always deem the snapshot expired", so prove here first that a real value was obtained.
    ok(Number.isInteger(CACHE_VERSION_IN_APP) && CACHE_VERSION_IN_APP > 0,
      'harness 自检：已从 app.js 解析出 CACHE_VERSION（否则恢复路径用例会静默空转）',
      `CACHE_VERSION_IN_APP=${CACHE_VERSION_IN_APP}`);
    ok(!!rowFor(ctx, 'A') && !!rowFor(ctx, 'B'), 'A / B 两行都存在于 DOM');
    ok(!!rowFor(ctx, 'A') && rowFor(ctx, 'A').classList.contains('unread'), 'A 行初始为未读（.unread 存在）');
    ok(!!rowFor(ctx, 'B') && !rowFor(ctx, 'B').classList.contains('unread'), 'B 行初始为已读（无 .unread）');
    // Prove #select-all's change listener is really wired (otherwise later assertions no-op)
    setCheckbox(ctx, '#select-all', true);
    ok(evalIn(ctx, 'state.selected.size') === 3, '勾选 #select-all 后 state.selected.size=3（事件已接线）', evalIn(ctx, 'state.selected.size'));
    ok(!hidden(ctx, '#list-bulk'), '勾选后批量操作条可见');

    // CACHE_VERSION bumping (1->2) relies on "version mismatch -> reject the whole thing"; verify that mechanism directly here.
    // Otherwise "bumping" is just a comment, with nobody guarding that readPersisted() really rejects.
    evalIn(ctx, `localStorage.setItem('inbox-cache-v1', JSON.stringify({ v: ${CACHE_VERSION_IN_APP - 1}, at: Date.now(), folder: { items: [{ id: 'STALE' }], total: 1 } }))`);
    ok(evalIn(ctx, 'readPersisted()') === null,
      '版本不符的快照被整份拒绝（CACHE_VERSION 升版据此让旧快照失效）');
    evalIn(ctx, `localStorage.setItem('inbox-cache-v1', JSON.stringify({ v: ${CACHE_VERSION_IN_APP}, at: Date.now(), folder: { items: [], total: 0 } }))`);
    ok(evalIn(ctx, 'readPersisted()') !== null,
      '负控制：版本相符的快照会被接受（不是「readPersisted 一律返回 null」）');
  });

  /* ---- BUG-1 row selection highlight lingering ---- */
  await test('T1 BUG-1 连续打开两封邮件后只能有 1 个 active 行', async (ctx) => {
    await resetList(ctx);
    ok(activeRows(ctx).length === 0, '负控制基线：重置后没有任何 active 行', activeRows(ctx).length);

    clickRow(ctx, 'A');
    await ticks(ctx.win, 8);
    const afterA = activeRows(ctx).length;
    ok(afterA === 1, '负控制：只打开 A 时 active 数量为 1（不是 0）', afterA);
    ok(afterA === 1 && activeRows(ctx)[0].dataset.id === 'A', 'active 行是 A');

    clickRow(ctx, 'B');
    await ticks(ctx.win, 8);
    const afterB = activeRows(ctx).length;
    ok(afterB === 1, '打开第二封 B 后 active 数量恒为 1（BUG-1 核心）', afterB);
    ok(afterB === 1 && activeRows(ctx)[0].dataset.id === 'B', '唯一的 active 行是 B（A 的残留已清除）',
      afterB === 1 ? activeRows(ctx)[0].dataset.id : Array.from(activeRows(ctx)).map((r) => r.dataset.id).join(','));

    evalIn(ctx, 'closeMessagePane()');
    ok(activeRows(ctx).length === 0, 'closeMessagePane() 之后 active 数量为 0', activeRows(ctx).length);
  });

  /* ---- BUG-1b "select all on this page" checkbox state lingering ---- */
  await test('T1b-1 BUG-1b 切文件夹后 #select-all 必须复位', async (ctx) => {
    await resetList(ctx);
    setCheckbox(ctx, '#select-all', true);
    ok(el(ctx, '#select-all').checked === true, '勾选后 #select-all.checked=true');
    ok(!hidden(ctx, '#list-bulk'), '勾选后批量条可见');

    await ticks(ctx.win, 3);
    ok(el(ctx, '#select-all').checked === true && !hidden(ctx, '#list-bulk'),
      '负控制：勾选后不做任何操作，状态保持不变（功能没被改没）');

    evalIn(ctx, "openFolder('sent')");
    await ticks(ctx.win, 8);
    ok(evalIn(ctx, 'state.selected.size') === 0, '切文件夹后 state.selected 已清空', evalIn(ctx, 'state.selected.size'));
    ok(el(ctx, '#select-all').checked === false, '切文件夹后 #select-all.checked 复位为 false（BUG-1b 核心）',
      el(ctx, '#select-all').checked);
    ok(hidden(ctx, '#list-bulk'), '切文件夹后批量条隐藏');
  });

  await test('T1b-2 BUG-1b 改搜索词后 #select-all 必须复位', async (ctx) => {
    await resetList(ctx);
    setCheckbox(ctx, '#select-all', true);
    ok(el(ctx, '#select-all').checked === true, '勾选后 #select-all.checked=true');

    setSearch(ctx, 'A');
    await sleep(ctx, 700); // setupSearch's 400ms debounce
    await ticks(ctx.win, 8);
    ok(evalIn(ctx, 'state.selected.size') === 0, '搜索后 state.selected 已清空', evalIn(ctx, 'state.selected.size'));
    ok(el(ctx, '#select-all').checked === false, '搜索后 #select-all.checked 复位为 false（BUG-1b）',
      el(ctx, '#select-all').checked);
    ok(hidden(ctx, '#list-bulk'), '搜索后批量条隐藏');
  });

  await test('T1b-3 BUG-1b 完成一次批量操作后 #select-all 必须复位', async (ctx) => {
    await resetList(ctx);
    setCheckbox(ctx, '#select-all', true);
    ok(evalIn(ctx, 'state.selected.size') === 3, '勾选后选中 3 封', evalIn(ctx, 'state.selected.size'));

    const btn = Array.from(el(ctx, '#bulk-actions').querySelectorAll('button')).find((b) => b.textContent === '已读');
    ok(!!btn, '批量条上有「已读」按钮');
    clickEl(ctx, btn);
    await ticks(ctx.win, 10);
    ok(ctx.stub.counters.batch === 1, '批量接口被调用一次', ctx.stub.counters.batch);
    ok(evalIn(ctx, 'state.selected.size') === 0, '批量操作后 state.selected 已清空', evalIn(ctx, 'state.selected.size'));
    ok(el(ctx, '#select-all').checked === false, '批量操作后 #select-all.checked 复位为 false（BUG-1b）',
      el(ctx, '#select-all').checked);
    ok(hidden(ctx, '#list-bulk'), '批量操作后批量条隐藏');
  });

  await test('T1b-4 BUG-1b 切换账号后 #select-all 必须复位', async (ctx) => {
    await resetList(ctx);
    setCheckbox(ctx, '#select-all', true);
    ok(el(ctx, '#select-all').checked === true, '勾选后 #select-all.checked=true');

    const sel = el(ctx, '#mailbox-select');
    sel.value = 'beta@x.com';
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    await ticks(ctx.win, 10);
    ok(evalIn(ctx, 'state.selected.size') === 0, '切账号后 state.selected 已清空', evalIn(ctx, 'state.selected.size'));
    ok(el(ctx, '#select-all').checked === false, '切账号后 #select-all.checked 复位为 false（BUG-1b）',
      el(ctx, '#select-all').checked);
    ok(hidden(ctx, '#list-bulk'), '切账号后批量条隐藏');
  });

  /* ---- BUG-2 a list row still shows unread after being read ---- */
  await test('T2 BUG-2 打开未读邮件后行内 .unread 必须消失且本地状态回写', async (ctx) => {
    await resetList(ctx);
    ok(rowFor(ctx, 'A').classList.contains('unread'), '前置：A 行未读');
    ctx.stub.counters.counts = 0;

    clickRow(ctx, 'A');
    await ticks(ctx.win, 10);

    ok(!rowFor(ctx, 'A').classList.contains('unread'), '打开后 A 行 .unread 已移除（BUG-2 核心）',
      rowFor(ctx, 'A').className);
    ok(evalIn(ctx, "state.items.find((x) => x.id === 'A').read") === 1,
      'state.items 中 A.read 已更新为 1', evalIn(ctx, "state.items.find((x) => x.id === 'A').read"));
    ok(evalIn(ctx, "[...state.cache.folders.values()].some((c) => c.items.some((i) => i.id === 'A' && i.read === 1))") === true,
      '文件夹缓存中 A.read 已更新为 1');
    ok(evalIn(ctx, "state.cache.messages.get('A') && state.cache.messages.get('A').message.read === 1") === true,
      '消息缓存中 A.read 为 1');
    ok(ctx.stub.counters.counts === 1, '发生 0→1 跃迁时恰好请求一次 /api/counts', ctx.stub.counters.counts);
  });

  await test('T2b BUG-2 负控制：本来就是已读的邮件不得额外请求 /api/counts', async (ctx) => {
    await resetList(ctx);
    ok(!rowFor(ctx, 'B').classList.contains('unread'), '前置：B 行已读');
    ctx.stub.counters.counts = 0;
    ctx.stub.counters.mailboxes = 0;

    clickRow(ctx, 'B');
    await ticks(ctx.win, 10);

    ok(ctx.stub.counters.counts === 0, '无 0→1 跃迁时不得请求 /api/counts（防止「无条件刷新」蒙对）',
      ctx.stub.counters.counts);
    ok(ctx.stub.counters.mailboxes === 0, '无 0→1 跃迁时不得请求 /api/mailboxes', ctx.stub.counters.mailboxes);
    ok(!rowFor(ctx, 'B').classList.contains('unread'), 'B 行保持已读');
  });

  await test('T2c BUG-2 命中消息缓存提前 return 分支时行状态依然正确', async (ctx) => {
    await resetList(ctx);
    clickRow(ctx, 'A');
    await ticks(ctx.win, 10);
    ok(evalIn(ctx, "state.cache.messages.has('A')") === true, '前置：A 已进入消息缓存');

    // Manufacture the state "cache already read, but the list row still shows unread" to force openMessage down the early-return branch
    evalIn(ctx, "state.items.find((x) => x.id === 'A').read = 0");
    rowFor(ctx, 'A').classList.add('unread');
    ok(rowFor(ctx, 'A').classList.contains('unread'), '前置：已把 A 行改回未读外观');
    const detailBefore = ctx.stub.counters.detail;

    clickRow(ctx, 'A');
    await ticks(ctx.win, 10);
    info(`提前 return 分支是否复用缓存（详情请求增量=${ctx.stub.counters.detail - detailBefore}）`);
    ok(!rowFor(ctx, 'A').classList.contains('unread'), '缓存分支下打开后 A 行 .unread 仍被清除');
    ok(evalIn(ctx, "state.items.find((x) => x.id === 'A').read") === 1, '缓存分支下 state.items 中 A.read 仍为 1',
      evalIn(ctx, "state.items.find((x) => x.id === 'A').read"));
  });

  /* ---- BUG-3a account dropdown silently rewritten ---- */
  await test('T3 BUG-3a 「全部邮箱」不得被静默改写，state.mailbox 与 sel.value 恒一致', async (ctx) => {
    const sel = el(ctx, '#mailbox-select');
    ok(evalIn(ctx, 'state.mailbox') === sel.value, '初始：state.mailbox === sel.value',
      `${evalIn(ctx, 'state.mailbox')} / ${sel.value}`);

    sel.value = '';
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    await ticks(ctx.win, 8);
    ok(sel.value === '', '把下拉切到「全部邮箱」后 sel.value 为 ""', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === '', '此时 state.mailbox 为 ""', JSON.stringify(evalIn(ctx, 'state.mailbox')));

    evalIn(ctx, 'loadMailboxes(true)');
    await ticks(ctx.win, 8);
    ok(sel.value === '', '再次 loadMailboxes() 后 sel.value 仍为 ""（BUG-3a 核心）', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === sel.value, '不变量：state.mailbox === sel.value',
      `${evalIn(ctx, 'state.mailbox')} / ${sel.value}`);

    evalIn(ctx, 'renderMailboxSelect()');
    ok(sel.value === '', '直接 renderMailboxSelect() 后仍为「全部邮箱」', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === '', 'state.mailbox 仍为 ""');
  });

  await test('T3b BUG-3a 账号已不存在时回退，state.mailbox 与 sel.value 仍必须一致', async (ctx) => {
    const sel = el(ctx, '#mailbox-select');
    // Scenario 1: the user selected alpha@x.com (real path: the change listener syncs state.mailbox to alpha),
    //         then that account disappears from the account list -> must fall back to an account that still exists.
    //         Note: the truth source is state.mailbox (app.js notes this); only changing sel.value without state.mailbox
    //         doesn't constitute "the user picked alpha", so both must be set here, otherwise we'd be testing a fake scenario.
    sel.value = 'alpha@x.com';
    evalIn(ctx, "state.mailbox = 'alpha@x.com'");
    evalIn(ctx, "state.mailboxList = state.mailboxList.filter((m) => m.mailbox !== 'alpha@x.com')");
    evalIn(ctx, 'renderMailboxSelect()');
    const v1 = sel.value;
    const m1 = evalIn(ctx, 'state.mailbox');
    ok(v1 !== '' && v1 !== 'alpha@x.com', '场景一：回退到某个仍然存在的账号', JSON.stringify(v1));
    ok(m1 === v1, '场景一：回退后 state.mailbox === sel.value（不脱钩）', `${JSON.stringify(m1)} / ${JSON.stringify(v1)}`);

    // Scenario 1 note: when only sel.value is changed (without syncing state.mailbox), the truth source is still state.mailbox,
    // so no fallback is triggered. This is the established contract of the current implementation, recorded explicitly to avoid misjudging it as a regression later.
    evalIn(ctx, "state.mailbox = ''");
    sel.value = 'alpha@x.com';
    evalIn(ctx, 'renderMailboxSelect()');
    ok(sel.value === '' && evalIn(ctx, 'state.mailbox') === '',
      '场景一附注：只改 sel.value 不构成用户选择，state.mailbox 仍是真值来源（不变量依然成立）',
      `${JSON.stringify(sel.value)} / ${JSON.stringify(evalIn(ctx, 'state.mailbox'))}`);

    // Scenario 2: state.mailbox points to an account that no longer exists; the dropdown still shows a valid account
    evalIn(ctx, "state.mailbox = 'ghost@x.com'");
    evalIn(ctx, 'renderMailboxSelect()');
    const v2 = sel.value;
    const m2 = evalIn(ctx, 'state.mailbox');
    ok(m2 === v2, '场景二：renderMailboxSelect() 后 state.mailbox === sel.value', `${JSON.stringify(m2)} / ${JSON.stringify(v2)}`);
    ok(v2 !== 'ghost@x.com', '场景二：下拉不会停留在不存在的账号上', JSON.stringify(v2));
  });

  /* ---- BUG-3c account unread count goes stale ---- */
  await test('T3c BUG-3c 读信发生 0→1 跃迁后必须重新请求 /api/mailboxes', async (ctx) => {
    await resetList(ctx);
    ctx.stub.counters.mailboxes = 0;
    clickRow(ctx, 'A');
    await ticks(ctx.win, 10);
    ok(ctx.stub.counters.mailboxes >= 1, '读信跃迁后 /api/mailboxes 被重新请求（BUG-3c）', ctx.stub.counters.mailboxes);
  });

  /* ---- BUG-3d number semantics unlabeled ---- */
  await test('T3d BUG-3d 下拉项与列表标题的数字口径必须自解释', async (ctx) => {
    const opts = Array.from(el(ctx, '#mailbox-select').options);
    info(`下拉项文案: ${opts.map((o) => `${JSON.stringify(o.value)}=>${JSON.stringify(o.textContent)}`).join(' , ')}`);
    const numbered = opts.filter((o) => o.value !== '' && /\d/.test(o.textContent));
    ok(numbered.length >= 1, '前置：存在显示未读数的下拉项', numbered.map((o) => o.textContent).join(' | '));
    for (const o of numbered) {
      ok(o.textContent.includes('未读'), `下拉项「${o.textContent}」用「未读」标注数字含义`);
    }
    const title = el(ctx, '#list-title').textContent;
    info(`列表标题: ${JSON.stringify(title)}`);
    ok(/共\s*\d+\s*封/.test(title), '列表标题明确标注总数口径（形如「共 N 封」，非裸数字）', JSON.stringify(title));
  });

  /* ===========================================================================
   * BUG-4 / BUG-5: two regression classes introduced by the local-cache-first refactor
   * ===========================================================================*/

  /* ---- BUG-4 periodic sync clears the list ---- */
  await test('T4a BUG-4 定时同步必须请求第 1 页、且不得把列表清空', async (ctx) => {
    const win = ctx.win;
    ok(el(ctx, '#list').children.length === 50, '前置：列表渲染 50 行', el(ctx, '#list').children.length);
    ok(evalIn(ctx, 'state.offset') === 50, '前置：state.offset=50（第 1 页已满）', evalIn(ctx, 'state.offset'));

    // Negative control 1: the assertion helper itself works (otherwise "doesn't contain offset=50" might just be a parse failure)
    ok(queryParam('/api/folders/inbox?limit=50&offset=50', 'offset') === '50',
      '负控制：offset 解析工具可用（非空转）', queryParam('/api/folders/inbox?limit=50&offset=50', 'offset'));

    // Negative control 2: with total=50 page 2 is indeed empty -- the old implementation requested offset=50 and got an empty page
    const page2 = await evalIn(ctx, 'fetchFolderPage(50)');
    ok(page2.items.length === 0, '前提：total=50 时第 2 页为空（旧实现 offset=50 会拿到空页）', page2.items.length);

    // Negative control 3: when the empty page overwrites state.items entirely, the list really becomes 0 rows (proving the assertion below can observe the defect)
    evalIn(ctx, 'state.items = []; state.offset = 0; paintList();');
    ok(el(ctx, '#list').children.length === 0, '负控制：空页整体覆盖后列表确实变 0 行', el(ctx, '#list').children.length);
    evalIn(ctx, "openFolder('inbox')");
    await ticks(win, 12);
    ok(el(ctx, '#list').children.length === 50, '前置恢复：重新加载后回到 50 行', el(ctx, '#list').children.length);

    // periodicSync only refreshes the list when not reading, and only when the folder cache exceeds TTL.folder(45s)
    // (the real 60s sync scenario: the last refresh long expired). Age the cache timestamp to trigger the refresh path.
    evalIn(ctx, 'closeMessagePane()');
    evalIn(ctx, 'state.cache.folders.forEach((c) => { c.at = Date.now() - 120000; })');
    await ticks(win, 3);
    const before = ctx.stub.calls.length;
    evalIn(ctx, 'periodicSync()');
    await ticks(win, 20);

    const reqs = ctx.stub.calls.slice(before).filter((c) => /^\/api\/folders\//.test(c.url));
    info(`periodicSync 发出的列表请求: ${reqs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(reqs.length >= 1, 'periodicSync 确实发出了列表请求（否则后面断言会空转）', reqs.length);
    for (const c of reqs) {
      ok(queryParam(c.url, 'offset') === '0', `列表请求必须带 offset=0（实际 ${c.url}）`, queryParam(c.url, 'offset'));
    }
    ok(!reqs.some((c) => queryParam(c.url, 'offset') === '50'), '任何列表请求都不得带 offset=50（BUG-4 根因）');
    ok(el(ctx, '#list').children.length === 50,
      'BUG-4 核心：periodicSync 后列表不得被清空（仍为 50 行）', el(ctx, '#list').children.length);
    ok(evalIn(ctx, 'state.items.length') === 50, 'state.items 仍为 50 条', evalIn(ctx, 'state.items.length'));
    ok(evalIn(ctx, 'state.offset') === 50, 'state.offset 重新落在 50', evalIn(ctx, 'state.offset'));
  }, pagingFixture());

  /* ---- BUG-5 specific account selection silently reset under the restore path ---- */
  await test('T4b BUG-5 恢复路径下具体账号选择不得被静默重置', async (ctx) => {
    const sel = el(ctx, '#mailbox-select');
    info(`恢复后 下拉值=${JSON.stringify(sel.value)}  state.mailbox=${JSON.stringify(evalIn(ctx, 'state.mailbox'))}  行数=${el(ctx, '#list').children.length}`);
    ok(sel.value === 'beta@x.com', '下拉 value 必须恢复为快照里的 beta@x.com', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === 'beta@x.com', 'state.mailbox 必须是 beta@x.com', JSON.stringify(evalIn(ctx, 'state.mailbox')));
    ok(evalIn(ctx, 'state.mailbox') === sel.value, '核心不变量：state.mailbox === sel.value');
    ok(el(ctx, '#list').children.length === 7,
      '列表行数必须保持缓存里的 7 行（不得清空，也不得换成「全部邮箱」视图的 3 行）', el(ctx, '#list').children.length);

    const fcs = folderCalls(ctx);
    info(`列表请求: ${fcs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(fcs.length >= 1, '存在列表请求（否则下面的断言会空转）', fcs.length);
    ok(fcs.some((c) => String(c.url).includes('mailbox=beta%40x.com')),
      '至少一个列表请求的原始 URL 含 mailbox=beta%40x.com',
      fcs.map((c) => c.url).join(' , '));
    ok(fcs.every((c) => queryParam(c.url, 'mailbox') === 'beta@x.com'),
      '不得发出不带 mailbox 的列表请求（那会静默退化成「全部邮箱」）',
      fcs.map((c) => queryParam(c.url, 'mailbox')).join(','));
    ok(queryParam(fcs[0].url, 'mailbox') === 'beta@x.com',
      '第一个列表请求就带 beta（缓存优先，不等网络）', fcs[0].url);
  }, seededBetaFixture());

  await test('T4c BUG-5 负控制：快照账号已不存在时回退，且 state.mailbox 与 sel.value 恒相等', async (ctx) => {
    const sel = el(ctx, '#mailbox-select');
    const values = Array.from(sel.options).map((o) => o.value);
    info(`下拉选项=${JSON.stringify(values)}  当前值=${JSON.stringify(sel.value)}  state.mailbox=${JSON.stringify(evalIn(ctx, 'state.mailbox'))}`);
    ok(!values.includes('ghost@x.com'), '前置：下拉里已没有 ghost@x.com（账号已失效）');
    ok(sel.value !== 'ghost@x.com', '不得停留在已不存在的账号上', JSON.stringify(sel.value));
    ok(sel.value !== '', '回退到某个具体账号，而不是静默变成「全部邮箱」', JSON.stringify(sel.value));
    ok(values.includes(sel.value), '回退目标必须是下拉里真实存在的账号', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === sel.value,
      '核心不变量：state.mailbox === sel.value（二者永不脱钩）',
      `${JSON.stringify(evalIn(ctx, 'state.mailbox'))} / ${JSON.stringify(sel.value)}`);
    ok(evalIn(ctx, 'state.mailbox') === 'alpha@x.com', '回退优先选「有未读的账号」', JSON.stringify(evalIn(ctx, 'state.mailbox')));
  }, seededGhostFixture());

  /* ---- T4d edge: when the account list is empty (/api/mailboxes -> []), the dropdown hides, but state.mailbox remains the sole authority ----
   * Mechanism (app.js:362-375): `if (list.length < 1) { wrap.classList.add('hidden'); return; }` returns early,
   * and `sel.innerHTML = ''` comes **after** it. `.hidden` is just display:none !important (app.css:36),
   * it doesn't reset value/selectedIndex => with an empty list old options linger.
   * Therefore **must not** assert `sel.options.length === 0` (under B it's 2, under C it's 0, this isn't the contract),
   * nor use the DOM-shown value to assert authority; always assert authority via "does the list request carry the mailbox param".
   */
  await test('T4d-B 账号列表被服务端清空后：下拉隐藏，但 state.mailbox 仍驱动请求', async (ctx) => {
    const wrap = el(ctx, '#mailbox-wrap');
    const sel = el(ctx, '#mailbox-select');
    ok(wrap.classList.contains('hidden'), '账号列表为空 ⇒ 下拉被隐藏');
    ok(evalIn(ctx, 'state.mailboxList.length') === 0, 'state.mailboxList 已为空', evalIn(ctx, 'state.mailboxList.length'));
    ok(evalIn(ctx, 'state.mailbox') === 'beta@x.com', 'state.mailbox 仍保留快照账号（未被清空）',
      JSON.stringify(evalIn(ctx, 'state.mailbox')));
    info(`记录（不作为契约）：sel.value=${JSON.stringify(sel.value)}  sel.options.length=${sel.options.length}  wrap.hidden=true`);

    // Authority: the request must carry mailbox
    const fcs = folderCalls(ctx);
    info(`列表请求: ${fcs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(fcs.length >= 1, '存在列表请求（否则后面的断言会空转）', fcs.length);
    ok(fcs.every((c) => queryParam(c.url, 'mailbox') === 'beta@x.com'),
      '所有列表请求都带 mailbox=beta@x.com（权威来源是 state.mailbox）',
      fcs.map((c) => c.url).join(' , '));

    // Negative control: clearing the DOM value (simulating a regressive change "carelessly doing sel.innerHTML = ''") must not affect behavior
    sel.value = '';
    const before = ctx.stub.calls.length;
    evalIn(ctx, "openFolder('inbox')");
    await ticks(ctx.win, 12);
    const reqs = ctx.stub.calls.slice(before).filter((c) => /^\/api\/folders\//.test(c.url));
    info(`负控制（只清 DOM 值）后的列表请求: ${reqs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(reqs.length >= 1, '负控制下仍有列表请求（非空转）', reqs.length);
    ok(reqs.every((c) => queryParam(c.url, 'mailbox') === 'beta@x.com'),
      '负控制：只改 sel.value 不改 state.mailbox ⇒ 请求仍带 mailbox=beta（DOM 不是真值来源）',
      reqs.map((c) => queryParam(c.url, 'mailbox')).join(','));

    // Negative control: the assertion helper itself can observe "missing param"
    ok(queryParam('/api/folders/inbox?limit=50&offset=0', 'mailbox') === null,
      '负控制：不带 mailbox 的 URL 解析为 null（断言确实能观察到缺失）');
  }, emptyMailboxesFixture([{ mailbox: 'beta@x.com', inbox_unread: 1, inbox_total: 5, sent_total: 0 }]));

  await test('T4d-C 快照 mailboxes 为空：下拉从未填充，state.mailbox 仍是唯一权威', async (ctx) => {
    const wrap = el(ctx, '#mailbox-wrap');
    const sel = el(ctx, '#mailbox-select');
    ok(wrap.classList.contains('hidden'), '账号列表为空 ⇒ 下拉被隐藏');
    ok(evalIn(ctx, 'state.mailboxList.length') === 0, 'state.mailboxList 已为空');
    ok(evalIn(ctx, 'state.mailbox') === 'beta@x.com', 'state.mailbox 仍为 beta@x.com', JSON.stringify(evalIn(ctx, 'state.mailbox')));
    info(`记录（不作为契约）：sel.value=${JSON.stringify(sel.value)}  sel.options.length=${sel.options.length}`);
    info('本子情形下 state.mailbox 与 sel.value 不相等，这是允许的：下拉隐藏时 state.mailbox 才是权威。');

    const fcs = folderCalls(ctx);
    info(`列表请求: ${fcs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(fcs.length >= 1, '存在列表请求（否则断言会空转）', fcs.length);
    ok(fcs.every((c) => queryParam(c.url, 'mailbox') === 'beta@x.com'),
      '即使下拉隐藏，列表请求仍带 mailbox=beta@x.com',
      fcs.map((c) => c.url).join(' , '));

    // Negative control: if the truth source wrongly used sel.value (here ''), the request would drop mailbox -- proving the assertion can distinguish the two truth sources
    const before = ctx.stub.calls.length;
    evalIn(ctx, "state.mailbox = document.querySelector('#mailbox-select').value"); // simulate a regressive implementation that "treats the DOM-shown value as truth"
    evalIn(ctx, "openFolder('inbox')");
    await ticks(ctx.win, 12);
    const reqs = ctx.stub.calls.slice(before).filter((c) => /^\/api\/folders\//.test(c.url));
    info(`负控制（以 sel.value 为真值）后的列表请求: ${reqs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(reqs.length >= 1, '负控制下仍有列表请求（非空转）', reqs.length);
    ok(reqs.every((c) => queryParam(c.url, 'mailbox') === null),
      '负控制：以 sel.value（\'\'）为真值 ⇒ 请求丢掉 mailbox 参数（断言确实能观察到差异）',
      reqs.map((c) => c.url).join(' , '));
  }, emptyMailboxesFixture([]));

  /* ---- Detail: clicking isn't blocked by "body not yet downloaded" ---- */

  await test('T5 点开未缓存的邮件：头部同步渲染，正文位显示「下载中」，详情回来后原地替换', async (ctx) => {
    // Precondition: boot completed normally (the first mail C was auto-opened and fully rendered)
    ok(/正文 C/.test(el(ctx, '#read-message .mail-body').textContent), '前置条件：C 已完整渲染');

    // Set the detail interface to "held", so we can observe the intermediate state after clicking
    ctx.stub.setHoldDetail(true);
    clickRow(ctx, 'A'); // A not cached -> detail held, stops at "body downloading"

    ok(evalIn(ctx, 'state.openId') === 'A',
      '点击后 state.openId 立刻切到 A（同步，未等待请求）', JSON.stringify(evalIn(ctx, 'state.openId')));
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 A',
      'A 的主题立刻可见，且来自列表项（详情尚未返回）', el(ctx, '#read-message .mail-subject h1').textContent);
    ok(!!el(ctx, '#read-message .mail-envelope'), '信封卡（发件人/时间/操作按钮）已渲染');
    ok(el(ctx, '#read-message .env-who .who-email').textContent === 'a@x.com · 收至 alpha@x.com',
      '发件人邮箱 + 我方收件信箱立刻可见（乐观渲染，详情尚未返回）',
      el(ctx, '#read-message .env-who .who-email').textContent);

    const ph = el(ctx, '#read-message .mail-body-pending .body-pending');
    ok(!!ph, '正文位显示占位（而不是一块空白正文）');
    ok(!!ph && /正在下载/.test(ph.textContent), '占位文案含「正在下载」', ph && ph.textContent);
    ok(!el(ctx, '#read-message .mail-body pre.text'), '真实正文尚未渲染（否则上面「下载中」的断言会空转）');

    // Release the detail -> the body is replaced in place
    ok(ctx.stub.releaseDetail('A'), '确实放行了被挂起的详情响应（否则下面的断言会空转）');
    await ticks(ctx.win, 10);
    ok(!el(ctx, '#read-message .mail-body-pending'), '详情到达后占位被移除');
    ok(/正文 A/.test(el(ctx, '#read-message .mail-body').textContent), '正文已原地替换为真实内容',
      el(ctx, '#read-message .mail-body').textContent.slice(0, 30));
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 A', '主题保持不变');

    // Negative control: on a cache hit it must render synchronously with no placeholder (proving the placeholder is triggered by "cache miss", not rendered unconditionally)
    // holdDetail is intentionally kept true here -- even if the detail interface is held, a cache hit should have no placeholder.
    clickRow(ctx, 'C');
    ok(evalIn(ctx, 'state.openId') === 'C', '切回 C');
    ok(!el(ctx, '#read-message .mail-body-pending'), '负控制：缓存命中 ⇒ 同步渲染，不出现「下载中」占位');
    ok(/正文 C/.test(el(ctx, '#read-message .mail-body').textContent), '负控制：缓存命中的正文立即可见');
  });

  await test('T6 快速连点：先发的详情响应后到时，不得覆盖后选的邮件', async (ctx) => {
    ctx.stub.setHoldDetail(true);

    clickRow(ctx, 'A');
    clickRow(ctx, 'B');
    info(`被挂起的详情请求（按到达顺序）: ${JSON.stringify(ctx.stub.heldDetailIds())}`);
    ok(ctx.stub.heldDetailIds().join(',') === 'A,B', 'A、B 的详情都被挂起且顺序正确',
      JSON.stringify(ctx.stub.heldDetailIds()));
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 B', '当前显示的是 B 的头部');

    // Release the "earlier-sent" A: it's now a stale response and must be discarded
    ok(ctx.stub.releaseDetail('A'), '放行了 A 的（过期）详情响应');
    await ticks(ctx.win, 10);
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 B',
      '过期响应到达后面板仍是 B（没有被 A 覆盖）', el(ctx, '#read-message .mail-subject h1').textContent);
    ok(evalIn(ctx, 'state.openId') === 'B', 'state.openId 仍为 B', JSON.stringify(evalIn(ctx, 'state.openId')));
    ok(!!el(ctx, '#read-message .mail-body-pending'), 'B 的正文仍显示「下载中」（A 的响应没有被误用）');

    // Release B now: this is the current request and should be adopted
    ok(ctx.stub.releaseDetail('B'), '放行了 B 的详情响应');
    await ticks(ctx.win, 10);
    ok(!el(ctx, '#read-message .mail-body-pending'), 'B 的占位被移除');
    ok(/正文 B/.test(el(ctx, '#read-message .mail-body').textContent), '面板显示 B 的正文',
      el(ctx, '#read-message .mail-body').textContent.slice(0, 30));
  });

  await test('T7 详情加载失败：保留头部，正文位给出错误态与重试', async (ctx) => {
    // B's detail is missing -> stub returns 404, simulating a detail interface failure
    clickRow(ctx, 'B');
    await ticks(ctx.win, 10);
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 B',
      '详情失败时头部仍可见（来自列表项）', el(ctx, '#read-message .mail-subject h1').textContent);
    const err = el(ctx, '#read-message .body-pending.is-error');
    ok(!!err, '正文位显示错误态占位（而不是一块空白正文）');
    ok(!!err && /正文加载失败/.test(err.textContent), '错误态给出失败原因', err && err.textContent);
    ok(!!err && /重试/.test(err.textContent), '错误态提供「重试」按钮');
  }, (() => { const c = inboxFixture(); delete c.messages.B; return c; })());

  /* ---- Body cache survives across refreshes ---- */

  await test('T8 正文跨刷新持久化：刷新后点开读过的邮件不再重新下载', async (ctx) => {
    // First session: read A, wait for the debounced write to hit disk
    evalIn(ctx, "openMessage('A')");
    await ticks(ctx.win, 8);
    await sleep(ctx, 450); // > PERSIST_DEBOUNCE_MS(300)
    const raw = ctx.win.localStorage.getItem('inbox-cache-v1');
    ok(!!raw, '快照已写入 localStorage（否则下面的断言会空转）');
    const snap = JSON.parse(raw);
    ok(Array.isArray(snap.messages), '快照含 messages 字段（正文已落盘）');
    ok(Array.isArray(snap.messages) && snap.messages.some((p) => p[0] === 'A'),
      'A 的正文在落盘列表里', Array.isArray(snap.messages) ? snap.messages.map((p) => p[0]).join(',') : 'null');

    // Second session: cold-start with the snapshot just written, equivalent to "refreshing the page"
    const ctx2 = await boot(Object.assign(inboxFixture(), { seedCache: raw }));
    try {
      const snapIds = snap.messages.map((p) => p[0]);

      // ⚠️ Precondition: init() re-opens the last opened mail at startup. If openId isn't restored, boot won't re-open it at all,
      // and "0 detail requests during boot" below becomes a no-op (nothing tested).
      ok(evalIn(ctx2, 'state.openId') === 'A', '前置：上次打开的邮件已恢复为 A（否则 boot 不会重开）',
        evalIn(ctx2, 'state.openId'));

      // ⭐ Core assertion: re-opening A during boot sends **not a single detail request** -- the body comes entirely from the local snapshot.
      // Measured with a counter (not relying on the URL filter), cross-corroborated with "whether it re-opened".
      ok(ctx2.stub.counters.detail === 0,
        '刷新后重开上次打开的邮件**未发起任何详情请求**（正文来自本地快照，不再重新下载）',
        `boot 期间 detail 计数 = ${ctx2.stub.counters.detail}`);

      // Every mail in the snapshot must return to the in-memory cache; C in particular was never requested in this session, so it can only come from the snapshot.
      ok(snapIds.length >= 1, '前置：快照里至少有 1 封正文（否则下面的「全部恢复」会空转）',
        snapIds.join(','));
      const missing = snapIds.filter((id) => !evalIn(ctx2, `state.cache.messages.has(${JSON.stringify(id)})`));
      ok(missing.length === 0, '快照里的每一封正文都已恢复到内存缓存',
        `快照=[${snapIds.join(',')}] 缺失=[${missing.join(',')}]`);

      const before = ctx2.stub.calls.length;
      const detailBefore = ctx2.stub.counters.detail;
      assertDetailCollectorWorks(ctx2);
      evalIn(ctx2, "openMessage('A')");
      ok(/正文 A/.test(el(ctx2, '#read-message .mail-body').textContent),
        '点开后正文**同步**可读（来自本地缓存）',
        el(ctx2, '#read-message .mail-body').textContent.slice(0, 20));
      ok(!el(ctx2, '#read-message .mail-body-pending'), '不出现「下载中」占位');
      await ticks(ctx2.win, 8);
      // Two independent measures cross-validate: counter (no filter dependency) + URL filter
      ok(ctx2.stub.counters.detail === detailBefore,
        '刷新后点开读过的邮件**不再发起详情请求**（计数器口径）',
        `${detailBefore} → ${ctx2.stub.counters.detail}`);
      const detailReqs = detailCalls(ctx2, before);
      ok(detailReqs.length === 0, '刷新后点开读过的邮件**不再发起详情请求**（URL 口径）',
        detailReqs.map((c) => c.url).join(' , ') || '（无）');
    } finally {
      ctx2.close();
    }
  });

  /**
   * Install a setItem on the Storage **prototype** that "throws a quota error by capacity".
   * ⚠️ jsdom's Storage is a Proxy: `ls.setItem = fn` and `Object.defineProperty(ls, 'setItem', …)`
   * **are both ignored by the get trap** (measured: the wrapper function's call count is always 0, and the data is written anyway).
   * The only effective approach is to override on the prototype. The caller must restore it in finally.
   * @param ctx context
   * @param limitOf returns "the max number of bodies currently acceptable"; exceeding it throws QuotaExceededError
   * @returns { tries, restore } tries records the number of bodies in the snapshot on each attempt
   */
  function installQuotaStub(ctx, limitOf) {
    const ls = ctx.win.localStorage;
    const proto = Object.getPrototypeOf(ls);
    const origSetItem = proto.setItem;
    const tries = [];
    const countMsgs = (v) => {
      try { const o = JSON.parse(v); return Array.isArray(o.messages) ? o.messages.length : 0; } catch { return 0; }
    };
    proto.setItem = function (k, v) {
      if (k !== 'inbox-cache-v1') return origSetItem.call(this, k, v);
      const n = countMsgs(v);
      tries.push(n);
      if (n > limitOf()) throw new Error('QuotaExceededError');
      return origSetItem.call(this, k, v);
    };
    return { tries, restore: () => { proto.setItem = origSetItem; } };
  }

  await test('T9 超配额时对半砍重试：保住较新的正文，列表缓存永不赔进去', async (ctx) => {
    evalIn(ctx, "openMessage('A')");
    await ticks(ctx.win, 8);
    await sleep(ctx, 450);
    ok(evalIn(ctx, 'state.cache.messages.size') === 2,
      '前置条件：内存里有 2 封正文可落盘（C 由自动打开带入、A 由本次点击带入）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    // Simulate a full localStorage: only room for 1 body
    const q = installQuotaStub(ctx, () => 1);
    try {
      evalIn(ctx, 'writePersisted()');
    } finally {
      q.restore();
    }

    // No-op guard: it must really "try 2, fail, cut to 1 and retry"
    ok(q.tries.length === 2, '确实重试了一次（而不是一次性放弃）', q.tries.join(' → '));
    ok(q.tries[0] === 2 && q.tries[1] === 1,
      '第一次带 2 封被拒后，砍到 1 封再试', q.tries.join(' → '));

    const snap = JSON.parse(ctx.win.localStorage.getItem('inbox-cache-v1'));
    ok(Array.isArray(snap.messages) && snap.messages.length === 1,
      '最终快照保留 1 封正文', Array.isArray(snap.messages) ? snap.messages.length : 'null');
    ok(Array.isArray(snap.messages) && snap.messages[0][0] === 'A',
      '保留的是**较新**的那封（A），不是较旧的 C',
      Array.isArray(snap.messages) ? snap.messages.map((p) => p[0]).join(',') : 'null');
    ok(Array.isArray(snap.folder.items) && snap.folder.items.length > 0,
      '列表缓存被保住（没有因为正文太大而一起赔进去）', snap.folder.items.length);
  });

  await test('T9b 连一封正文都写不下时：只写列表，仍然不赔进列表缓存', async (ctx) => {
    evalIn(ctx, "openMessage('A')");
    await ticks(ctx.win, 8);
    await sleep(ctx, 450);
    ok(evalIn(ctx, 'state.cache.messages.size') === 2, '前置条件：内存里有 2 封正文可落盘',
      evalIn(ctx, 'state.cache.messages.size'));

    // Simulate an extreme quota: any write with a body fails
    const q = installQuotaStub(ctx, () => 0);
    try {
      evalIn(ctx, 'writePersisted()');
    } finally {
      q.restore();
    }

    ok(q.tries.join(' → ') === '2 → 1 → 0',
      '一路砍到空（2 → 1 → 0），没有跳过任何一档', q.tries.join(' → '));

    const snap = JSON.parse(ctx.win.localStorage.getItem('inbox-cache-v1'));
    ok(!Object.prototype.hasOwnProperty.call(snap, 'messages'), '最终快照不含正文');
    ok(Array.isArray(snap.folder.items) && snap.folder.items.length > 0,
      '列表缓存仍然被保住', snap.folder.items.length);
  });

  await test('T10 正文缓存过期后：仍然立刻可读，同时后台校验', async (ctx) => {
    evalIn(ctx, "openMessage('A')");
    await ticks(ctx.win, 8);
    ok(evalIn(ctx, "state.cache.messages.has('A')"), '前置条件：A 已进入正文缓存');

    // Push the cache time to 24 hours ago (simulating opening the same mail again the next day)
    evalIn(ctx, "state.cache.messages.get('A').at = Date.now() - 24*3600*1000");
    const before = ctx.stub.calls.length;
    const detailBefore = ctx.stub.counters.detail;
    assertDetailCollectorWorks(ctx);
    evalIn(ctx, "openMessage('A')");
    ok(/正文 A/.test(el(ctx, '#read-message .mail-body').textContent),
      '过期缓存也**同步**渲染，不等网络', el(ctx, '#read-message .mail-body').textContent.slice(0, 20));
    ok(!el(ctx, '#read-message .mail-body-pending'), '不出现「下载中」占位');

    await ticks(ctx.win, 8);
    // This is also T8's positive control: the same filter must catch 1, otherwise T8's 0 is meaningless
    const reqs = detailCalls(ctx, before);
    ok(reqs.length === 1, '同时后台发起了一次校验请求（保证已读态最终一致）',
      reqs.map((c) => c.url).join(' , ') || '（无）');
    ok(ctx.stub.counters.detail === detailBefore + 1, '计数器口径一致：恰好 1 次详情请求',
      `${detailBefore} → ${ctx.stub.counters.detail}`);
  });

  /* ---- Background prefetch of bodies ---- */

  await test('T11 后台预取：不点击也把列表里未缓存的正文抓回来，且不改动用户视图', async (ctx) => {
    // boot auto-opens the first item C -> C is cached; A, B not yet cached
    ok(evalIn(ctx, "state.cache.messages.has('C')"), '前置：C 已因自动打开进入缓存');
    ok(!evalIn(ctx, "state.cache.messages.has('A')") && !evalIn(ctx, "state.cache.messages.has('B')"),
      '前置：A/B 尚未缓存（否则本用例会空转）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    const openIdBefore = evalIn(ctx, 'state.openId');
    const subjectBefore = el(ctx, '#read-message .mail-subject h1').textContent;
    const before = ctx.stub.calls.length;

    startPrefetch(ctx);
    const done = await waitUntil(ctx, "state.cache.messages.has('A') && state.cache.messages.has('B')");
    ok(done, '预取把 A、B 的正文都抓了回来（全程没有任何点击）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    const fetched = detailCalls(ctx, before).map((c) => c.url);
    ok(fetched.includes('/api/messages/A') && fetched.includes('/api/messages/B'),
      '确实是靠后台详情请求拿到的，而不是凭空出现', fetched.join(' , ') || '（无）');

    // Prefetch is a pure background behavior: must not touch the user's view
    ok(evalIn(ctx, 'state.openId') === openIdBefore, '打开中的邮件没有被改变',
      `${openIdBefore} → ${evalIn(ctx, 'state.openId')}`);
    ok(evalIn(ctx, 'detailPending') === null, '预取不得留下「下载中」占位状态',
      String(evalIn(ctx, 'detailPending')));
    ok(el(ctx, '#read-message .mail-subject h1').textContent === subjectBefore,
      '右侧面板仍然显示原来那封', el(ctx, '#read-message .mail-subject h1').textContent);
    ok(!el(ctx, '#read-message .mail-body-pending'), '面板没有出现「下载中」占位');
  });

  await test('T11b 负控制：页面不可见时不预取，恢复可见后继续', async (ctx) => {
    Object.defineProperty(ctx.win.document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(ctx.win.document, 'visibilityState', { value: 'hidden', configurable: true });
    const before = ctx.stub.calls.length;
    startPrefetch(ctx);
    await sleep(ctx, 1200); // far beyond PREFETCH_START_DELAY_MS(500) + one interval
    ok(detailCalls(ctx, before).length === 0, '页面隐藏时一个详情请求都不发',
      detailCalls(ctx, before).map((c) => c.url).join(' , ') || '（无）');
    ok(!evalIn(ctx, "state.cache.messages.has('A')"), '隐藏期间也没有预取到正文');

    // Restore visibility: under the same settings it must really start prefetching, otherwise the 0 above might be "the feature never worked" rather than "gated"
    Object.defineProperty(ctx.win.document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(ctx.win.document, 'visibilityState', { value: 'visible', configurable: true });
    startPrefetch(ctx);
    const done = await waitUntil(ctx, "state.cache.messages.has('A')");
    ok(done, '恢复可见后预取正常进行（证明上面的 0 不是功能失效）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));
  });

  await test('T11b2 运行中转为不可见：预取立即暂停（入口门控之外的循环内门控）', async (ctx) => {
    startPrefetch(ctx);
    const startedOk = await waitUntil(ctx, "state.cache.messages.has('A')", 4000);
    ok(startedOk, '前置：预取已经跑起来（否则「暂停」无从观察）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    Object.defineProperty(ctx.win.document, 'hidden', { value: true, configurable: true });
    await ticks(ctx.win, 2);
    const before = ctx.stub.calls.length;
    await sleep(ctx, 900); // far beyond one interval (100ms)
    ok(detailCalls(ctx, before).length === 0, '转为不可见后不再继续发请求',
      detailCalls(ctx, before).map((c) => c.url).join(' , ') || '（无）');
  });

  await test('T11c 视图切换：预取中途作废 —— 不抓旧视图，也不产生重复请求', async (ctx) => {
    startPrefetch(ctx);
    await sleep(ctx, 800); // 500ms start delay + about 3 mails
    const started = detailCalls(ctx, 0).map((c) => c.url);
    ok(started.length >= 1, '前置：预取确实已经开始（否则「取消」无从观察）', started.join(' , ') || '（无）');

    const beforeSwitch = ctx.stub.calls.length;
    evalIn(ctx, "openFolder('sent')"); // folderKey changes immediately -> invalidates this prefetch round
    await ticks(ctx.win, 6);
    await sleep(ctx, 1400);

    const after = detailCalls(ctx, beforeSwitch).map((c) => c.url);
    const stale = after.filter((u) => /\/api\/messages\/P\d\d$/.test(u));
    ok(stale.length === 0, '切换后不再抓旧视图（收件箱 P##）的正文', stale.join(' , ') || '（无）');

    // ⭐ Key: if cancel didn't take effect, the old round would continue **with its cursor** (from the 4th mail onward),
    // so the first request after switching would be S04 instead of S00. Asserting only "didn't grab the old view" wouldn't catch it:
    // after re-snapshotting state.items, the old round grabs the new view, which also looks "normal".
    const firstNew = after.find((u) => /\/api\/messages\/S\d\d$/.test(u));
    ok(firstNew === '/api/messages/S00',
      '切换后从新视图的**第一封**重新开始预取（说明是干净的新一轮，而不是旧轮带着游标继续跑）',
      firstNew || '（无）');

    const dupes = after.filter((u, i) => after.indexOf(u) !== i);
    ok(dupes.length === 0, '切换后没有任何一封被重复抓（否则说明新旧两轮预取同时在跑）',
      dupes.join(' , ') || '（无）');

    ok(after.some((u) => /\/api\/messages\/S\d\d$/.test(u)),
      '新视图（已发送 S##）的正文有被正常预取',
      after.filter((u) => /S\d\d$/.test(u)).length + ' 条');
  }, prefetchFixture());

  await test('T11d 预取是自动的：列表渲染后无需任何调用/点击，正文自己回来', async (ctx) => {
    // This case does **not** call startPrefetch: it verifies the paintList -> prefetchBodies wiring itself.
    // boot({keepPrefetch:true}) means don't invalidate automatic prefetch.
    const before = ctx.stub.calls.length;
    const done = await waitUntil(ctx, "state.cache.messages.has('A') && state.cache.messages.has('B')", 8000);
    ok(done, '自动预取生效（全程没有任何点击，也没有手动触发）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    const fetched = detailCalls(ctx, before).map((c) => c.url);
    ok(fetched.includes('/api/messages/A') && fetched.includes('/api/messages/B'),
      '确实发了后台详情请求', fetched.join(' , ') || '（无）');
  }, Object.assign(inboxFixture(), { keepPrefetch: true }));

  /* ---- T12 thread rows / envelope card must show the "actual sender/recipient mailboxes" ---- */
  await test('T12 会话行显示收发双方的实际信箱 + 按时间降序（最近在前）', async (ctx) => {
    // Negative control: the thread panel must really be rendered, otherwise everything below no-ops
    ok(!!el(ctx, '.rm-thread'), '会话面板已渲染（currentThread.length > 1）');
    const rows = Array.from(ctx.doc.querySelectorAll('.rm-thread .t-item'));
    ok(rows.length === 3, '会话面板渲染出 3 行', rows.length);
    ok(rows.length === 3 && evalIn(ctx, 'currentThread.length') === 3,
      '面板行数与 currentThread 一致（不是上一轮的渲染残留）', evalIn(ctx, 'currentThread.length'));

    const texts = rows.map((r) => r.querySelector('.t-sender').textContent);
    // ⭐ Order: the server's listThread was changed to received_at DESC, so the panel must present it as-is.
    //   The fixture's three mails have times T3(…300) > T2(…200) > T1(…100).
    ok(texts.join(' || ') === [
      'bob@partner.com → alpha@x.com',                        // T3 newest (no name -> fall back to email)
      'support@x.com → alice@partner.com, bob@partner.com',    // T2 my reply (full recipient list)
      'Alice → alpha@x.com',                                   // T1 earliest
    ].join(' || '),
      '⭐ 会话行按时间降序（最近 → 最早）：T3 → T2 → T1', texts.join(' | '));
    ok(texts[0] !== 'Alice → alpha@x.com',
      '负控制：首行不是最早那封（即「仍是升序」会立刻失败）', texts[0]);

    // The time column must also be descending (cross-corroborating with the sender sequence, to avoid "the array was just reversed")
    const times = rows.map((r) => r.querySelector('.t-time').textContent);
    ok(times.every((t) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)),
      '时间列格式为 YYYY-MM-DD HH:MM（否则下面的降序比较无意义）', times.join(' | '));
    ok(times.join('|') === [...times].sort().reverse().join('|'),
      '时间列逐行递减（最近在前）', times.join(' | '));

    // Symptom of the old implementation: wrong field name read (t.to_emails) -> always "me → ?". The two assertions below lock that symptom down.
    ok(!texts.some((t) => t.includes('?')), '任何会话行都不得出现「?」占位', texts.join(' | '));
    ok(!texts.some((t) => /^我\s*→/.test(t)), '出站行不得用字面量「我」顶替实际发件信箱', texts.join(' | '));

    const titles = rows.map((r) => r.querySelector('.t-sender').title);
    ok(titles[1] === 'support@x.com → alice@partner.com, bob@partner.com',
      '会话行 title 给出完整收发双方（列宽不足被省略号截断时靠它读全）', titles[1]);
    ok(titles.join('|') === texts.join('|'), 'title 与可见文案逐行一致（不因倒序而错位）',
      titles.join(' | '));
  }, threadFixture());

  await test('T12b 信封卡：来信显示「收至 我的信箱」，回信显示实际发件信箱', async (ctx) => {
    ok(evalIn(ctx, 'state.openId') === 'T3', '前置：首项 T3 已被自动打开', evalIn(ctx, 'state.openId'));
    ok(el(ctx, '#read-message .env-who .who-name').textContent === 'bob@partner.com',
      '来信标题：无名字时回退到对方邮箱', el(ctx, '#read-message .env-who .who-name').textContent);
    ok(el(ctx, '#read-message .env-who .who-email').textContent === 'bob@partner.com · 收至 alpha@x.com',
      '来信副行必须能一眼看到「我方收到的信箱」',
      el(ctx, '#read-message .env-who .who-email').textContent);

    // Switch to "sent", open my reply
    evalIn(ctx, "openFolder('sent')");
    await ticks(ctx.win, 10);
    ok(!!rowFor(ctx, 'T2'), '已切到「已发送」且 T2 在列表里（否则下面的点击会空转）');
    clickRow(ctx, 'T2');
    await ticks(ctx.win, 20);
    ok(evalIn(ctx, 'state.openId') === 'T2', '已打开 T2', evalIn(ctx, 'state.openId'));
    ok(el(ctx, '#read-message .env-who .who-name').textContent === 'support@x.com',
      '回信标题是**实际发件信箱**，不再是字面量「我」',
      el(ctx, '#read-message .env-who .who-name').textContent);
    ok(el(ctx, '#read-message .env-who .who-email').textContent === '致 alice@partner.com, bob@partner.com',
      '回信副行是完整收件人清单', el(ctx, '#read-message .env-who .who-email').textContent);
  }, threadFixture());

  await test('T12c 乐观渲染：详情未返回时信封卡已显示「收至 我的信箱」', async (ctx) => {
    ok(evalIn(ctx, 'state.openId') === 'T3', '前置：自动打开的是 T3');
    ctx.stub.setHoldDetail(true);
    clickRow(ctx, 'T4');
    ok(evalIn(ctx, 'state.openId') === 'T4', '点击后同步切到 T4', evalIn(ctx, 'state.openId'));
    ok(!!el(ctx, '#read-message .mail-body-pending'),
      '负控制：详情确实还没回来（否则下面的断言可能是被详情蒙对的）');
    ok(el(ctx, '#read-message .env-who .who-email').textContent === 'carol@partner.com · 收至 beta@x.com',
      '详情未返回时信封卡已经显示我方收件信箱（靠列表项随带的 mailbox，不依赖详情接口）',
      el(ctx, '#read-message .env-who .who-email').textContent);
    ok(ctx.stub.releaseDetail('T4'), '放行被挂起的详情响应');
    await ticks(ctx.win, 10);
  }, threadFixture());

  /* ---- T12d when the collapsed copy is opened, the retained row must still be marked "current" ---- */
  await test('T12d 打开的是被折叠的回环副本时，会话面板仍高亮留存行', async (ctx) => {
    // Negative control: what's actually opened is the copy T2c, not the retained row T2 (otherwise this case verifies nothing)
    ok(evalIn(ctx, 'state.openId') === 'T2c', '前置：自动打开的是被折叠的副本 T2c',
      evalIn(ctx, 'state.openId'));
    const threadIds = evalIn(ctx, 'currentThread.map((t) => t.id).join(",")');
    ok(threadIds === 'T3,T2',
      '负控制：会话里**没有** T2c（服务端已折叠），且顺序为降序 T3 → T2', threadIds);
    ok(evalIn(ctx, 'JSON.stringify(currentThread.find((t) => t.id === "T2").copy_ids)') === '["T2c"]',
      '负控制：留存行 T2 带着 copy_ids=["T2c"]（折叠关系真的传到了前端）',
      evalIn(ctx, 'JSON.stringify(currentThread.find((t) => t.id === "T2").copy_ids)'));

    const rows = Array.from(ctx.doc.querySelectorAll('.rm-thread .t-item'));
    ok(rows.length === 2, '会话面板渲染 2 行（副本已折叠，不是 3 行）', rows.length);
    const currents = Array.from(ctx.doc.querySelectorAll('.rm-thread .t-item.current'));
    ok(currents.length === 1, '⭐ 恰好一行被标为当前（不多不少）', currents.length);
    ok(currents.length === 1 && currents[0].querySelector('.t-sender').textContent === 'support@x.com → alice@partner.com',
      '⭐ 当前行是**留存行** T2（出站），而不是被折叠掉的副本',
      currents.length ? currents[0].querySelector('.t-sender').textContent : '（无 current 行）');
    ok(currents.length === 1 && currents[0] === rows[1],
      '当前行是第 2 行（不是「碰巧第一行」）—— 证明不是靠索引蒙对',
      currents.length ? String(rows.indexOf(currents[0])) : 'n/a');

    // Clicking one's own row must not re-open it (otherwise it would be treated as "switched to another mail" and re-fetch the detail).
    // ⚠️ Check for null before dereferencing: if the "exactly one current" assertion above already failed, dereferencing currents[0] here would throw
    //    and crash the whole case, losing later assertions (hit before). When checking for null, explicitly record FAIL -- never pass off a "skip" as a pass.
    const cur = currents.length === 1 ? currents[0] : null;
    if (!cur) {
      ok(false, `无法验证「点当前行不重复打开」：当前行不唯一（${currents.length} 个），上一组断言已失败`);
    } else {
      const before = ctx.stub.counters.detail;
      clickEl(ctx, cur);
      await ticks(ctx.win, 8);
      ok(ctx.stub.counters.detail === before,
        '点击当前行不再发起详情请求（副本行也算「就是这一封」）',
        `${before} → ${ctx.stub.counters.detail}`);
      ok(evalIn(ctx, 'state.openId') === 'T2c', '点当前行后打开的仍是 T2c（视图没有被切走）',
        evalIn(ctx, 'state.openId'));
    }
  }, threadCopyFixture());

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: app.js md5=${FINGERPRINT.md5}  mtime=${FINGERPRINT.mtime}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);

  const exitCode = fail ? 1 : 0;
  // Write the exit code into a file for independent review (not relying only on the shell's $?)
  const exitFile = path.join(os.tmpdir(), 'qa-inbox-ui.regression.exit');
  try {
    fs.writeFileSync(exitFile, String(exitCode), 'utf8');
    console.log(`退出码已写入: ${exitFile} = ${exitCode}`);
  } catch (e) {
    console.log(`退出码文件写入失败: ${e.message}`);
  }
  process.exit(exitCode);
})();
