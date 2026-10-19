'use strict';

/* =========================================================
 * Mail inbox frontend (no build, pure vanilla)
 * Layout: message list on the left + detail on the right (Yahoo-like / common clients)
 * Features: multiple recipient addresses · conversation context · attachment sending · rich text
 * Performance: local persistent cache (localStorage) render-first + background revalidate + silent refresh + periodic sync
 * ========================================================= */

const FOLDERS = [
  { key: 'inbox', label: '收件箱' },
  { key: 'drafts', label: '草稿' },
  { key: 'starred', label: '已加星标' },
  { key: 'sent', label: '已发送' },
  { key: 'trash', label: '已删除' },
];

const PAGE_SIZE = 50;
const MAX_FILE_BYTES = 40 * 1024 * 1024;

const TTL = { folder: 45 * 1000, message: 3 * 60 * 1000, counts: 20 * 1000, mailboxes: 10 * 1000 };
// Background sync interval: 60s → 5min. Reason: counts/list TTL is 20~45s, so a 60s cycle refetches almost every round;
// list/counts only need refreshing when something "changed", and 5min already covers the "page left open for a long time" case,
// and when the page becomes visible again visibilitychange still forces an immediate sync as a fallback.
const SYNC_MS = 5 * 60 * 1000;

/* Local persistent cache: after a page refresh, the first paint needs 0 requests to show the list / count badges / account dropdown. */
const CACHE_KEY = 'inbox-cache-v1';
// v2: conversation items gained `copy_ids`, and order changed from ascending to descending (see src/repo.ts listThread).
// Old snapshots' thread arrays carry the **old order and duplicate rows**, and are not revalidated within the TTL;
// not bumping the version would leave the "already-fixed conversation panel" still showing old results after refresh (one full refetch buys immediate correctness).
// v3: root-cause fix for conversation grouping (Resend's References is JSON array text, the old parsing produced malformed thread_id)
//     —— old snapshots' thread arrays were assembled from wrong groupings and must be discarded wholesale;
//     also added the "drafts" folder and the drafts_total field to counts.
// v4: list rows' thread_count changed to the count "after folding loop-back duplicates" (see src/repo.ts applyFoldedThreadCounts),
//     aligned with the conversation panel's definition. Old snapshots' list badges still hold the raw pre-folding row count (e.g. 3 vs 2),
//     and the list revalidate fingerprint does not include thread_count, so not bumping the version would keep showing the old badge.
const CACHE_VERSION = 5;
const PERSIST_DEBOUNCE_MS = 300;

/* In-memory LRU for opened message bodies: max 40 messages or 2MB total, whichever comes first. */
const MSG_CACHE_MAX = 40;
const MSG_CACHE_BYTES = 2 * 1024 * 1024;

/*
 * Persisted bodies have **no separate count/byte limit**: whatever is in the in-memory LRU gets persisted (the LRU itself is already capped at 40 messages / 2MB).
 * The real fallback is localStorage's hard quota (usually 5MB/origin) —— see the halving retry in writePersisted.
 * This way "read messages don't need re-downloading after refresh" covers all recently read messages, not just the most recent 12.
 */

/** The backend puts rows with empty/NULL mailbox into this explicit group; must match src/repo.ts's UNKNOWN_MAILBOX. */
const UNKNOWN_MAILBOX = '(未识别)';

/*
 * Background body prefetch: after the list renders, sequentially fetch the bodies of the current list that are **not yet cached** while idle.
 * Goal: when the user opens a message the body is already local, so they no longer see "downloading".
 */
const PREFETCH_MAX = 50;             // per-run prefetch cap (exactly one page)
const PREFETCH_START_DELAY_MS = 500; // let the first-paint critical requests finish first, then start prefetching
const PREFETCH_GAP_MS = 100;         // leave a gap between messages so we don't compete with user clicks
const PREFETCH_PERSIST_EVERY = 5;    // persist once every N messages prefetched, so leaving midway doesn't lose everything

const STATUS_LABEL = {
  sent: '已发送',
  delivered: '已送达',
  bounced: '退信',
  failed: '失败',
  draft: '草稿',
  delayed: '延迟',
  queued: '排队中',
  complaint: '投诉',
  received: '已收到',
};

const state = {
  folder: 'inbox',
  mailbox: '',
  mailboxList: [],
  items: [],
  itemsKey: null, // view key that the current state.items corresponds to, used to tell "same-view refresh" apart from clearing the screen and starting over
  selected: new Set(),
  q: '',
  total: 0,
  offset: 0,
  counts: { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0, drafts_total: 0 },
  composing: null, // { mode, originalId, files:[], rich, original, mailbox }
  canSend: false,
  fromAddress: '',
  fromName: '',
  /** Domains ticked in the top bar (empty = all domains). Narrows the list, counts, mailboxes and sender picker. */
  domainSel: [],
  /** All configured domains (from GET /api/account); drives the top-bar domain switcher and the custom-sender validation. */
  domains: [],
  /** Configured default senders (GET /api/account.senders): the default from address + each domain's default address. */
  senders: [],
  /** Unread count per domain for the chip corner badge: { '<domain>': n }. */
  domainUnread: {},
  /** domain -> Cloudflare zone id (from GET /api/domains); lets the authorisation link pre-select the exact zone. */
  zoneIds: {},
  /** Per-domain result of the automatic self-check: { '<domain>': 'ok' | 'bad' }. Missing = not checked yet (gray ?). */
  domainHealth: {},
  /** Which self-check rows failed per domain ({ '<domain>': ['Resend · …'] }), shown in the badge tooltip. */
  domainHealthDetail: {},
  /** When domainHealth was last computed (ms). Drives the 30-minute throttle. */
  domainHealthAt: 0,
  /** Session-only custom sender addresses added via the composer "+" button; they become real (visible in /api/mailboxes) after the first send. */
  customSenders: [],
  /** Local contacts (GET /api/contacts), used for recipient input autocomplete. */
  contacts: [],
  contactsLoaded: false,
  openId: null,
  pendingOpenId: null, // message id to reopen after the list is ready, restored from the local cache
  /** List width (px) set by the user dragging the splitter. null = not customized, uses the CSS default and responsive clamping. */
  listWidth: null,
  loading: false,
  firstOpen: true,
  cache: {
    folders: new Map(),
    messages: new Map(),
    countsAt: 0,
    mailboxesAt: 0,
    mailboxesLoading: false,
    mailboxesPending: false,
  },
};

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const readEl = $('#read-message');

/* ---------------- Mobile layout (single column + drawer) ----------------
 * The breakpoint must stay in sync with `@media (max-width: 768px)` in app.css.
 */
const MOBILE_MAX_W = 768;

/**
 * Viewport width.
 *
 * Uses `globalThis` instead of `window`: the sandboxes of two vm suites (compose-guard / mail-merge)
 * have **no window**, and a bare access would throw `ReferenceError` and take down the whole suite; `globalThis` is
 * window in the browser and the sandbox itself in the sandbox, safe on both sides.
 */
function viewportWidth() {
  const w = globalThis.innerWidth;
  return typeof w === 'number' && w > 0 ? w : 1024;
}

/**
 * Whether to use the mobile (single column + drawer) layout.
 *
 * matchMedia preferred: on real devices it also senses rotation / split screen, and doesn't depend on
 * innerWidth read at an arbitrary moment. When missing, fall back to innerWidth —— jsdom doesn't implement
 * matchMedia (measured: `typeof window.matchMedia` is `undefined`), and without this feature check, the 4 jsdom suites would throw in init() and all fail.
 *
 * ⚠️ Don't judge mobile by "touch capability": in jsdom `'ontouchstart' in window` is **true**,
 * which would misclassify all tests as mobile; `navigator.maxTouchPoints` is undefined in jsdom, equally unreliable.
 * Only trust width.
 */
function isMobile() {
  const mm = globalThis.matchMedia;
  if (typeof mm === 'function') {
    try {
      return mm(`(max-width: ${MOBILE_MAX_W}px)`).matches;
    } catch {
      /* matchMedia exists but is unusable (stubbed as an incomplete object, etc.) → fall back to the width check */
    }
  }
  return viewportWidth() <= MOBILE_MAX_W;
}

/** Whether the drawer is open. Only meaningful on mobile. */
let drawerOpen = false;

/**
 * The **single convergence point** for the mobile layout: fully aligns (isMobile, state.openId, drawerOpen) to
 * the state classes on `#app`. Nothing anywhere is allowed to toggle these classes directly, only call this.
 *
 * On desktop these classes have no effect (the corresponding rules are all inside @media), so no extra cleanup is needed when resizing from mobile to desktop;
 * but drawerOpen is still reset to zero here, to avoid the drawer mysteriously being open when shrinking back to mobile.
 */
function syncLayout() {
  const app = $('#app');
  if (!app) return;
  const mobile = isMobile();
  if (!mobile) drawerOpen = false;
  app.classList.toggle('is-mobile', mobile);
  app.classList.toggle('mobile-detail', mobile && state.openId !== null);
  app.classList.toggle('drawer-open', mobile && drawerOpen);
  // Floating geometry of the compose window: on mobile the inline left/top/width/height must be cleared (inline values win over media queries),
  // on desktop the geometry is re-clamped into the new viewport. Putting it here instead of a separate resize listener is so that
  // "breakpoint switching" and "window resizing" share the same convergence point.
  syncComposerWindowLayout();
  // Likewise: list width must be re-clamped for the new viewport (shrinking the window must not squeeze the detail pane away)
  syncListWidth();
}

function setDrawer(open) {
  drawerOpen = !!open;
  syncLayout();
}

/** Collapse the drawer. Calling on desktop has no side effects (drawerOpen is already false). */
function closeDrawer() {
  if (drawerOpen) setDrawer(false);
}

/* ---------------- List / detail splitter (draggable) ----------------
 * In the desktop two-column layout, the user drags the middle vertical line to adjust the list width.
 *
 * Width has only one source of truth: `state.listWidth` (**the width the user wants**),
 * and the only outlet is `applyListWidth()` (writes the CSS variable `--list-w` + adds the `list-w-custom` class).
 * Drag / keyboard / double-click reset / window resize all converge here; nothing anywhere is allowed to write style.width itself.
 *
 * ⚠️ `state.listWidth` stores the desired value, not the clamped actual value: otherwise shrinking the window clamps it once, and enlarging again can't get it back.
 */

const LIST_W_KEY = 'inbox-list-w';
const LIST_W_DEFAULT = 430; // matches the --list-w initial value in :root in app.css
const LIST_W_MIN = 260; // any narrower and both subject and sender get truncated
const LIST_W_MAX_RATIO = 0.7; // at most 70% of the viewport, so the detail pane always keeps its space

/** Maximum list width allowed in the current viewport. */
function listWidthMax() {
  return Math.max(LIST_W_MIN, Math.floor(viewportWidth() * LIST_W_MAX_RATIO));
}

function clampListWidth(px) {
  const n = Math.round(Number(px));
  if (!Number.isFinite(n)) return LIST_W_DEFAULT;
  return Math.min(listWidthMax(), Math.max(LIST_W_MIN, n));
}

/** `px == null` → restore the default (clears the custom class and inline variable, back to CSS's 430px + responsive clamping). */
function applyListWidth(px) {
  const app = $('#app');
  if (!app) return;
  if (px == null) {
    state.listWidth = null;
    app.classList.remove('list-w-custom');
    document.documentElement.style.removeProperty('--list-w');
    return;
  }
  state.listWidth = Math.round(Number(px)) || LIST_W_DEFAULT;
  document.documentElement.style.setProperty('--list-w', `${clampListWidth(state.listWidth)}px`);
  app.classList.add('list-w-custom');
}

/** Re-clamp after the viewport changes (keeps the desired value, doesn't write the "temporary clamp" back to state). */
function syncListWidth() {
  if (state.listWidth == null) return;
  applyListWidth(state.listWidth);
}

function loadListWidth() {
  try {
    const raw = localStorage.getItem(LIST_W_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function saveListWidth() {
  try {
    if (state.listWidth == null) localStorage.removeItem(LIST_W_KEY);
    else localStorage.setItem(LIST_W_KEY, String(state.listWidth));
  } catch {
    /* storage unavailable (private mode / quota full): still effective within this session */
  }
}

/** Current actual list width, used as the base for keyboard stepping. */
function currentListWidth() {
  const pane = $('#list-pane');
  const w = pane && typeof pane.getBoundingClientRect === 'function' ? pane.getBoundingClientRect().width : 0;
  return w > 0 ? w : (state.listWidth ?? LIST_W_DEFAULT);
}

let splitDrag = null;

function onSplitterDown(e) {
  if (isMobile()) return;
  if (e.button != null && e.button !== 0) return;
  const sp = $('#splitter');
  if (!sp) return;
  // Double-click reset: during repeated clicks pointerdown's detail increments (2 on the second one).
  // Not using dblclick because the preventDefault below would interfere with the click sequence.
  if (e.detail >= 2) {
    applyListWidth(LIST_W_DEFAULT);
    saveListWidth();
    e.preventDefault();
    return;
  }
  splitDrag = { x: e.clientX, start: currentListWidth(), id: e.pointerId };
  const app = $('#app');
  if (app) app.classList.add('resizing');
  // Pointer capture: while dragging, move/up keep arriving even when the pointer passes over the detail area
  if (e.pointerId != null && typeof sp.setPointerCapture === 'function') {
    try {
      sp.setPointerCapture(e.pointerId);
    } catch {
      /* if capture is unavailable, degrade to the normal event stream, functionality unaffected */
    }
  }
  e.preventDefault();
}

function onSplitterMove(e) {
  if (!splitDrag) return;
  if (splitDrag.id != null && e.pointerId != null && e.pointerId !== splitDrag.id) return;
  applyListWidth(splitDrag.start + (e.clientX - splitDrag.x));
}

function onSplitterUp(e) {
  if (!splitDrag) return;
  if (splitDrag.id != null && e.pointerId != null && e.pointerId !== splitDrag.id) return;
  splitDrag = null;
  const app = $('#app');
  if (app) app.classList.remove('resizing');
  saveListWidth();
}

/** Keyboard adjustment (splitter is focusable): ← → step, Shift to accelerate, Home to reset. */
function onSplitterKey(e) {
  const step = e.shiftKey ? 50 : 16;
  if (e.key === 'ArrowLeft') applyListWidth(currentListWidth() - step);
  else if (e.key === 'ArrowRight') applyListWidth(currentListWidth() + step);
  else if (e.key === 'Home') applyListWidth(LIST_W_DEFAULT);
  else return;
  saveListWidth();
  e.preventDefault();
}

function setupSplitter() {
  const sp = $('#splitter');
  if (!sp) return;
  sp.addEventListener('pointerdown', onSplitterDown);
  sp.addEventListener('pointermove', onSplitterMove);
  sp.addEventListener('pointerup', onSplitterUp);
  sp.addEventListener('pointercancel', onSplitterUp);
  sp.addEventListener('keydown', onSplitterKey);
}

/* ---------------- API ---------------- */

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch {
    throw new Error('网络错误，请检查 Worker 是否可访问');
  }
  if (res.status === 401) {
    // Session mode (wizard install): show the login box, don't reload (reload causes a 401 loop).
    if (gateMode === 'session') {
      showLogin();
      throw new Error('unauthorized');
    }
    showToast('认证失败，请刷新页面重新登录', true);
    setTimeout(() => location.reload(), 800);
    throw new Error('unauthorized');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : null;
  if (!res.ok) {
    throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  }
  return data;
}

/* ---------------- Cache ---------------- */

function folderKey() {
  return `${domainParam()}|${state.mailbox}|${state.folder}|${state.q}`;
}

/**
 * The top-bar domain filter as the API expects it: comma-separated (the backend accepts a list and matches
 * `mailbox_domain IN (…)`). Empty string = all domains, i.e. "no checkbox ticked".
 */
function domainParam() {
  return (Array.isArray(state.domainSel) ? state.domainSel : []).join(',');
}

/** Lightweight fingerprint: first/last id + total + per-row read/starred, used for "don't re-render if data hasn't changed". */
function folderFingerprint(items, total) {
  let s = `${total}|${items.length}`;
  for (const it of items) s += `|${it.id}${it.read ? 'r' : 'u'}${it.starred ? 's' : ''}`;
  return s;
}

function storeFolderCache(items, total, fp) {
  state.cache.folders.set(folderKey(), {
    items: [...items],
    total,
    at: Date.now(),
    fp: fp || folderFingerprint(items, total),
  });
}

function findItem(id) {
  for (const it of state.items) if (it.id === id) return it;
  for (const c of state.cache.folders.values()) {
    const f = c.items.find((it) => it.id === id);
    if (f) return f;
  }
  const mc = state.cache.messages.get(id);
  if (mc && mc.message) return mc.message;
  return null;
}

/**
 * Aligns the "currently open" highlight from a single source: at most the one row matching state.openId is active.
 * Must iterate over all rows for a full realignment, otherwise active remains on old rows and multiple blue selection marks appear (BUG-1).
 * Only toggles class, doesn't re-render the whole table, to avoid losing scroll position.
 */
function syncActiveRow() {
  for (const row of Array.from(document.querySelectorAll('.list-item[data-id]'))) {
    row.classList.toggle('active', row.dataset.id === state.openId);
  }
}

function syncRowUI(id) {
  const item = findItem(id);
  for (const row of Array.from(document.querySelectorAll('.list-item[data-id]'))) {
    if (row.dataset.id !== id) continue;
    row.classList.toggle('unread', !!(item && !item.read));
    const star = row.querySelector('.star-btn');
    if (star) {
      star.classList.toggle('starred', !!(item && item.starred));
      star.textContent = item && item.starred ? '★' : '☆';
    }
  }
  syncActiveRow();
}

function applyLocalPatch(id, patch) {
  const apply = (obj) => {
    if (!obj || obj.id !== id) return;
    for (const k of Object.keys(patch)) obj[k] = patch[k];
  };
  for (const c of state.cache.folders.values()) c.items.forEach((it) => apply(it));
  state.items.forEach((it) => apply(it));
  if (currentMessage && currentMessage.id === id) {
    for (const k of Object.keys(patch)) currentMessage[k] = patch[k];
  }
  for (const c of state.cache.messages.values()) {
    if (c.message && c.message.id === id) {
      for (const k of Object.keys(patch)) c.message[k] = patch[k];
    }
    if (Array.isArray(c.thread)) {
      const t = c.thread.find((x) => x.id === id);
      if (t) for (const k of Object.keys(patch)) t[k] = patch[k];
    }
  }
  if (Array.isArray(currentThread)) {
    const t = currentThread.find((x) => x.id === id);
    if (t) for (const k of Object.keys(patch)) t[k] = patch[k];
  }
  syncRowUI(id);
  persistSoon();
}

function invalidateFolderCaches() {
  state.cache.folders.clear();
}

/* ---------------- In-memory LRU for opened message bodies ---------------- */

function entryBytes(entry) {
  const m = entry.message || {};
  return String(m.body_html || '').length + String(m.body_text || '').length + 512;
}

/** Store and mark as most recently used; when over the limit (40 messages / 2MB), evict from the least recently used end. */
function putMessageCache(id, entry) {
  const e = { ...entry, bytes: entryBytes(entry) };
  state.cache.messages.delete(id);
  state.cache.messages.set(id, e);
  let total = 0;
  for (const v of state.cache.messages.values()) total += v.bytes || 0;
  while (state.cache.messages.size > MSG_CACHE_MAX || total > MSG_CACHE_BYTES) {
    const oldest = state.cache.messages.keys().next().value;
    if (oldest === undefined || oldest === id) break;
    total -= state.cache.messages.get(oldest).bytes || 0;
    state.cache.messages.delete(oldest);
  }
}

/** On a hit, refresh the LRU order (a Map's insertion order is its usage order). */
function touchMessageCache(id) {
  const v = state.cache.messages.get(id);
  if (!v) return;
  state.cache.messages.delete(id);
  state.cache.messages.set(id, v);
}

/* ---------------- Background body prefetch ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prefetchGen = 0;      // incrementing invalidates the previous prefetch round
let prefetchActive = null; // view token currently being prefetched (same view won't start twice)

/**
 * While idle, sequentially prefetch the not-yet-cached bodies in the current list, writing them to the message LRU (persisted along with snapshots).
 *
 * Constraints (each maps to a regression test):
 *  - Only handles the **current list** `state.items`, skipping ones already cached; capped at PREFETCH_MAX;
 *  - Sequential + spaced out, so it doesn't compete with user clicks; pauses immediately when the page is hidden (document.hidden);
 *  - View switches (folder/mailbox/q) are invalidated at once via token comparison;
 *  - **Never touches state.openId / detailSeq / the right pane** —— prefetch is purely a background activity
 *    and changes nothing the user sees. Actually opening a message follows openMessage's own path.
 */
function prefetchBodies() {
  if (document.hidden) return;
  const token = folderKey();
  if (prefetchActive === token) return; // same view is already prefetching, don't restart
  prefetchActive = token;
  const gen = ++prefetchGen;
  void (async () => {
    try {
      await sleep(PREFETCH_START_DELAY_MS);
      if (gen !== prefetchGen || token !== folderKey()) return;
      // Scan state.items with a cursor rather than taking a snapshot up front:
      // "load more" appends new pages into state.items, and the cursor scan naturally picks them up.
      let cursor = 0;
      let done = 0; // counts only requests actually issued, used to enforce the cap
      while (done < PREFETCH_MAX) {
        if (gen !== prefetchGen || token !== folderKey()) return; // view has switched
        if (document.hidden) return;                              // page hidden, pause
        const ids = state.items.map((it) => it.id);
        if (cursor >= ids.length) break; // current list is exhausted
        const id = ids[cursor++];
        if (state.cache.messages.has(id)) continue; // already cached (or filled in by another path meanwhile)
        done++;
        try {
          const data = await api(`/api/messages/${encodeURIComponent(id)}`);
          putMessageCache(id, {
            message: data.message,
            attachments: data.attachments || [],
            thread: data.thread || [],
            at: Date.now(),
          });
        } catch {
          // Prefetch failure doesn't bother the user: opening it for real will re-request and show an error state
        }
        if (done % PREFETCH_PERSIST_EVERY === 0) persistSoon();
        await sleep(PREFETCH_GAP_MS);
      }
      persistSoon();
    } finally {
      // Only clear the marker when "still this round": when superseded by a new view / new prefetch, must not clear the newcomer's marker
      if (prefetchGen === gen && prefetchActive === token) prefetchActive = null;
    }
  })();
}

/* ---------------- Local persistent cache (localStorage, debounced + try/catch along the whole path) ---------------- */

let persistTimer = null;

/** Read the local snapshot. Version mismatch / corrupt JSON / localStorage disabled in private mode all safely degrade to null. */
function readPersisted() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== CACHE_VERSION) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Collect the bodies to persist: **whatever is in the in-memory LRU** (the LRU itself is already capped at 40 messages / 2MB).
 * A Map's iteration order is its LRU order (least recently used first), so iterating directly yields
 * "least recently used → most recently used"; on restore, setting them in order restores the LRU order.
 * No budget is set here —— yielding on over-quota is handled uniformly by writePersisted (halving retry).
 */
function collectPersistMessages() {
  const out = [];
  for (const [id, entry] of state.cache.messages) {
    if (entry && entry.message) out.push([id, entry]);
  }
  return out;
}

/** Write a snapshot once. Returns true on success; false in private mode / over quota (QuotaExceededError). */
function tryWritePersisted(payload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the current view (list + counts + account list + openId + recently read bodies) to local storage.
 * Empty lists are not written (to avoid persisting the loading state). state.selected is not persisted: keeping the selection across refreshes would be confusing.
 *
 * On over-quota, **halve and retry** (keeping the newer half) rather than dropping everything at once:
 * otherwise a user who has read dozens of large bodies couldn't cache a single body once over the limit, contradicting the "no limit" intent.
 * When even one body no longer fits, finally write only the list —— **the list cache is never sacrificed for bodies**.
 */
function writePersisted() {
  if (!state.items.length) return;
  const base = {
    v: CACHE_VERSION,
    at: Date.now(),
    folderKey: folderKey(),
    mailbox: state.mailbox,
    domainSel: state.domainSel,
    folderName: state.folder,
    q: state.q,
    folder: { items: state.items, total: state.total },
    counts: state.counts,
    mailboxes: state.mailboxList,
    openId: state.openId,
  };
  // Order is "least recently used → most recently used", so keeping the tail = keeping the newer ones
  let messages = collectPersistMessages();
  while (messages.length) {
    if (tryWritePersisted({ ...base, messages })) return;
    messages = messages.slice(Math.ceil(messages.length / 2));
  }
  tryWritePersisted(base);
}

/** Debounced write, to avoid high-frequency JSON.stringify blocking the main thread during reading / paging / batch operations. */
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writePersisted, PERSIST_DEBOUNCE_MS);
}

/**
 * On startup, **synchronously** restore the local snapshot and render immediately (0 requests).
 * Only restores the list matching the current default view (inbox / no search); counts and the account list are always available.
 * The body cache is independent of list restoration —— even if the list is unavailable (last time in another folder / search state),
 * previously read messages can still open immediately without re-downloading.
 * Any exception safely degrades to "no cache", never a blank screen. Returns whether list content was restored.
 */
function restorePersisted() {
  const p = readPersisted();
  if (!p) return false;
  try {
    if (p.counts && typeof p.counts === 'object') state.counts = { ...state.counts, ...p.counts };
    if (Array.isArray(p.mailboxes)) state.mailboxList = p.mailboxes;
    if (typeof p.mailbox === 'string') state.mailbox = p.mailbox;
    if (Array.isArray(p.domainSel)) state.domainSel = p.domainSel.map((d) => String(d).toLowerCase()).filter(Boolean);
    if (typeof p.openId === 'string') state.openId = p.openId;
    // Persisted order is "least recently used → most recently used"; setting them in order restores the LRU order
    if (Array.isArray(p.messages)) {
      for (const pair of p.messages) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [id, entry] = pair;
        if (typeof id !== 'string' || !entry || typeof entry !== 'object' || !entry.message) continue;
        putMessageCache(id, entry); // reuse the same count/byte caps and LRU logic
      }
    }
    const listOk =
      p.folder && Array.isArray(p.folder.items) && p.folder.items.length > 0 &&
      p.folderName === state.folder && p.q === '' && p.folderKey === folderKey();
    if (!listOk) return false;
    state.items = p.folder.items;
    state.itemsKey = folderKey();
    state.total = Number(p.folder.total) || p.folder.items.length;
    state.offset = p.folder.items.length;
    state.cache.folders.set(folderKey(), {
      items: [...p.folder.items],
      total: state.total,
      at: p.at || Date.now(),
      fp: folderFingerprint(p.folder.items, state.total),
    });
    return true;
  } catch {
    return false;
  }
}

/* ---------------- Common ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function showToast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

/**
 * Normalizes a field that may be an already-parsed array or JSON text stored in the DB into an array.
 *
 * ⚠️ **The two APIs have different shapes, and both must be handled**:
 *  - The list API `/api/folders/*` returns the DB columns `to_emails` / `cc` / `bcc` as-is ——
 *    they are **JSON text** (`'["a@x.com"]'`);
 *  - The detail / conversation APIs return an **already-parsed array**.
 *
 * The old implementation only accepted arrays (`Array.isArray(v) ? v : []`), so recipients in the list were always empty ——
 * confirmed by test: outbound rows and draft rows all displayed as "to (unknown)" "(no recipients)".
 * This stays consistent with jsonArr in `src/util.ts` (use it if parseable, treat as an empty array if not).
 */
function jsonArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function timeLong(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** List/conversation rows show an explicit time: YYYY-MM-DD HH:MM. */
function fmtDateTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function senderLabel(item) {
  const name = item.from_name;
  const email = item.from_email;
  if (name) return name;
  if (email) return email;
  return '(未知发件人)';
}

function recipientsLabel(toList) {
  return jsonArr(toList).join(', ');
}

/** Recipient role labels (used for the "you are cc / you are bcc" badge in the envelope card summary row). */
const ROLE_LABEL = { to: '收件人', cc: '抄送', bcc: '密送' };

/**
 * The role in which "I" received this **inbound** message → `'to' | 'cc' | 'bcc' | null`.
 *
 * ⚠️ The check order must be **cc → bcc → to**, never the reverse. Reason: rows stored before the fix
 * had `to_emails` holding the **delivery address (envelope recipient)**, which necessarily contains our address —— checking to first
 * would mark a "merely cc'd" message as "to" (this is exactly the symptom users reported).
 * The `cc` / `bcc` columns always store the real headers, so checking them first avoids misjudgment.
 *
 * Rows stored after the fix have `to_emails` as the real `To:` header, so order doesn't matter; both generations use the same rule.
 */
function myRecipientRole(m) {
  const mine = String(m.mailbox || '').trim().toLowerCase();
  if (!mine) return null;
  const has = (list) => jsonArr(list).some((x) => String(x).trim().toLowerCase() === mine);
  if (has(m.cc)) return 'cc';
  if (has(m.bcc)) return 'bcc';
  if (has(m.to_emails)) return 'to';
  return null;
}

/**
 * The "recipients" list to show in inbound message details (= the real `To:` header).
 *
 * Two generations of data:
 *  - Stored after the fix: the detail API provides `delivered_to` (delivery address), and `to_emails` is the real To header, use it directly;
 *  - Stored before the fix: `delivered_to` is explicitly `null`, and `to_emails` is actually the delivery address with the real To header not stored
 *    → we can only **subtract cc/bcc** from the delivery address (envelope = To∩local-domain ∪ Cc∩local-domain ∪ Bcc∩local-domain).
 *    If nothing remains, return an empty array —— better to show "—" than to show ourselves as a recipient again.
 *
 * List items (optimistic render) have no `delivered_to` field (`undefined`, not `null`),
 * and cc/bcc aren't available yet either, so subtraction is moot and we return it as-is.
 */
function inboundRecipients(m) {
  const tos = jsonArr(m.to_emails);
  if (m.delivered_to !== null) return tos;
  const others = new Set(
    [...jsonArr(m.cc), ...jsonArr(m.bcc)].map((x) => String(x).trim().toLowerCase())
  );
  return tos.filter((x) => !others.has(String(x).trim().toLowerCase()));
}

/** Text for the "recipients" line in inbound message details (an empty list leaves the placeholder to the caller). */
function inboundRecipientsLabel(m) {
  return recipientsLabel(inboundRecipients(m));
}

/**
 * The single source of truth for the "sender/recipient pair" shared by conversation rows / envelope cards → `[sender, recipient]`.
 *
 * ⚠️ Read these two before changing this (both have been tripped over):
 *  1) The recipient field name on **conversation items** returned by the detail API is `to` (see thread.map in src/index.ts),
 *     while **the message itself** uses `to_emails`. Historically only `t.to_emails` was read → always undefined
 *     → conversation rows always showed "me → ?". Both field names must be handled.
 *  2) Outbound must not use the literal "me": the user needs to see the **actual sending mailbox**, otherwise with multiple identities you can't tell which mailbox sent it.
 */
function endpointsOf(item) {
  const mine = String(item.mailbox || '').trim();
  const tos = jsonArr(item.to_emails !== undefined ? item.to_emails : item.to);
  if (item.direction === 'inbound') {
    // The other party (prefer name if present) → the mailbox we received at (mailbox is authoritative, fall back to the first recipient address)
    return [senderLabel(item), mine || tos[0] || '?'];
  }
  // Our actual sending mailbox → recipient list (full, not truncated to the local part of the first address)
  return [String(item.from_email || '').trim() || mine || '?', tos.join(', ') || '?'];
}

/** Envelope card's second line: inbound "other mailbox · received at <my mailbox>", outbound "to <recipient list>". */
function envelopeSubLine(m, pending) {
  if (m.direction === 'inbound') {
    const from = String(m.from_email || '').trim();
    const mine = String(m.mailbox || '').trim();
    const parts = [];
    if (from) parts.push(from);
    // For a message you sent to yourself the two are identical, avoid showing it twice
    if (mine && mine.toLowerCase() !== from.toLowerCase()) parts.push(`收至 ${mine}`);
    return parts.join(' · ');
  }
  return `致 ${recipientsLabel(m.to_emails) || (pending ? '…' : '')}`;
}

function avatarChar(item) {
  // No "我" marker any more: with several managed domains that send to each other, both sides would be "me".
  // Always show the real address's first letter.
  const addr = String((item.direction === 'outbound' ? item.from_email || item.mailbox : item.from_email) || '').trim();
  const name = item.direction === 'inbound' ? String(item.from_name || '') : '';
  const ch = name.trim()[0] || addr[0] || '?';
  return ch.toUpperCase();
}

/* ---------------- Sidebar / multiple mailboxes ---------------- */

function renderMailboxSelect() {
  const wrap = $('#mailbox-wrap');
  const sel = $('#mailbox-select');
  const list = state.mailboxList;
  // Show the selector as soon as *anything* is configured. It used to disappear whenever no mail had arrived yet, which
  // made a freshly added domain look like a broken sidebar (and left no way to narrow to one address later).
  if (list.length < 1 && !(Array.isArray(state.domains) && state.domains.length)) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  // The source of truth is state.mailbox; sel.value is only its derived display, and on the startup restore path the DOM may still be empty.
  // '' = "all mailboxes", a legitimate selection that must be preserved as-is.
  const prev = state.mailbox || '';
  sel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  // The list is a list of **accounts** (addresses), not of mails: when it is empty there is simply no account yet.
  allOpt.textContent = list.length ? '全部邮箱' : '全部邮箱（未发现账号）';
  sel.appendChild(allOpt);
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.mailbox;
    opt.textContent = `${m.mailbox}${m.inbox_unread ? ` (${m.inbox_unread} 未读)` : ''}`;
    sel.appendChild(opt);
  }

  // Only fall back when the current selection truly no longer exists (account deleted/renamed);
  // on fallback, update both the dropdown display and state.mailbox, the two never get decoupled (BUG-3a).
  const keep = prev === '' || list.some((m) => m.mailbox === prev);
  const target = keep ? prev : (list.find((m) => m.inbox_unread > 0) || list[0] || { mailbox: '' }).mailbox;
  sel.value = target;
  state.mailbox = target;
}

/* ---------------- Top-bar domain switcher (multi-domain) ---------------- */

/** Domain part of an address (lowercased), or '' when absent. */
function addrDomain(addr) {
  const s = String(addr || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at > 0 && at < s.length - 1 ? s.slice(at + 1) : '';
}

/* ---------------- Per-domain colour ----------------
 * A domain's colour comes from a **fixed qualitative palette** (hue + saturation per slot) rather than a hash-derived
 * hue: hashing produced neighbouring hues that were impossible to tell apart at a glance (user feedback), while a small
 * hand-picked palette keeps every pair clearly distinct. Lightness is fixed per usage (list tint / left bar / dot), so
 * text contrast never depends on which slot a domain got.
 *
 * The slot is the domain's **position in the configured domain list**, so the first domains always get different colours;
 * a domain that is not in the list yet (or beyond the palette) falls back to a stable hash-based slot.
 */
const DOMAIN_PALETTE = [
  { h: 210, s: 62 }, // 蓝
  { h: 25, s: 82 }, // 橙
  { h: 145, s: 48 }, // 绿
  { h: 340, s: 68 }, // 红
  { h: 265, s: 52 }, // 紫
  { h: 175, s: 55 }, // 青
  { h: 100, s: 45 }, // 橄榄
  { h: 310, s: 50 }, // 品红
];

/** Palette slot of a domain (-1 when there is no domain at all). */
function domainSlot(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return -1;
  const list = state && Array.isArray(state.domains) ? state.domains : [];
  const i = list.indexOf(d);
  if (i >= 0) return i % DOMAIN_PALETTE.length;
  // Not configured (yet): keep a stable slot so the colour does not jump around.
  let h = 0;
  for (let k = 0; k < d.length; k++) h = (h * 31 + d.charCodeAt(k)) % 997;
  return h % DOMAIN_PALETTE.length;
}

/** The domain's palette entry, or null when the domain is unknown. */
function domainColor(domain) {
  const slot = domainSlot(domain);
  return slot < 0 ? null : DOMAIN_PALETTE[slot];
}

/** Kept for the tests / callers that only need the hue. */
function domainHue(domain) {
  const c = domainColor(domain);
  return c === null ? null : c.h;
}

/** The domain a message belongs to: our mailbox's domain (same for outbound and inbound). */
function itemDomain(item) {
  return addrDomain(String((item && item.mailbox) || ''));
}

/** Set `--dom-h` / `--dom-s` (and the marker class) on an element; false when the domain is unknown. */
function setDomainHue(el, domain) {
  if (!el) return false;
  const c = domainColor(domain);
  if (c === null) {
    el.classList.remove('has-dom-color');
    el.style.removeProperty('--dom-h');
    el.style.removeProperty('--dom-s');
    return false;
  }
  el.classList.add('has-dom-color');
  el.style.setProperty('--dom-h', String(c.h));
  el.style.setProperty('--dom-s', `${c.s}%`);
  return true;
}

/**
 * One **delegated** click listener for the whole domain bar.
 *
 * The chips are re-rendered on every toggle, so a listener attached per chip is easy to lose (and the browser's implicit
 * `<label> → checkbox` activation is fragile: a click that lands on the text or the colour dot must flip the filter just
 * like a click on the 13px box). Delegation keeps exactly one handler alive for the bar itself, and the toggle is applied
 * explicitly (`preventDefault` + `toggleDomain`) so every click flips the filter exactly once.
 */
function installDomainBarDelegation(bar) {
  if (!bar || bar.dataset.delegated === '1') return;
  bar.dataset.delegated = '1';
  bar.addEventListener('click', (e) => {
    const chip = e.target && e.target.closest ? e.target.closest('.domain-chip') : null;
    if (!chip || !bar.contains(chip)) return;
    const d = String(chip.dataset.domain || '').toLowerCase();
    if (!d) return;
    // The inline health marker is a button of its own: it opens the self-check panel and must not toggle the filter.
    if (e.target && e.target.closest && e.target.closest('.domain-status')) {
      e.preventDefault();
      showDomainCheck(d);
      return;
    }
    // Toggle relative to the **state**, never relative to `input.checked`: the checkbox's activation steps flip
    // `checked` *before* click handlers run, so reading it would invert the result for a click on the box itself.
    const selected = Array.isArray(state.domainSel) ? state.domainSel : [];
    const on = !selected.includes(d);
    e.preventDefault(); // never rely on the label's implicit activation; the toggle is applied below
    const box = chip.querySelector('input[type="checkbox"]');
    if (box) box.checked = on;
    toggleDomain(d, on);
  });
}

/** Render the domain list next to the search box. Hidden only when no domain is configured. */
function renderDomainBar() {
  const bar = $('#domain-bar');
  if (!bar) return;
  const list = Array.isArray(state.domains) ? state.domains : [];
  if (list.length < 1) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  installDomainBarDelegation(bar);
  bar.innerHTML = '';
  const sep = document.createElement('span');
  sep.className = 'domain-sep';
  sep.setAttribute('aria-hidden', 'true');
  bar.appendChild(sep);

  const sel = Array.isArray(state.domainSel) ? state.domainSel : [];
  for (const d of list) {
    const on = sel.includes(d);
    const wrap = document.createElement('span');
    wrap.className = 'domain-chip-wrap';
    const chip = document.createElement('label');
    chip.className = 'domain-chip' + (on ? ' on' : '');
    chip.dataset.domain = d;
    chip.title = on
      ? '已勾选：只看该域（可多选）；取消全部勾选 = 不显示邮件'
      : '勾选可只看某些域（支持多选）；都不勾选 = 不显示邮件';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.addEventListener('change', () => toggleDomain(d, box.checked));
    const text = document.createElement('span');
    text.className = 'domain-name';
    text.textContent = d;
    chip.appendChild(box);
    chip.appendChild(text);
    setDomainHue(chip, d);
    // Health marker: inline **after the domain name** (user request) — clicking it opens the self-check panel and must
    // not tick the filter, which the bar's delegated handler takes care of.
    const badge = document.createElement('span');
    badge.className = 'domain-status';
    badge.dataset.domain = d;
    badge.setAttribute('role', 'button');
    badge.tabIndex = 0;
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showDomainCheck(d);
      }
    });
    chip.appendChild(badge);
    // New-mail badge: the chip's top-right corner shows this domain's unread count (99+ beyond that).
    const count = document.createElement('span');
    count.className = 'domain-count hidden';
    count.dataset.domain = d;
    wrap.appendChild(chip);
    wrap.appendChild(count);
    bar.appendChild(wrap);
  }
  renderDomainHealth();
  renderDomainCounts();
}

/** Unread count per domain, as the chip's corner badge (`99+` above 99). */
function renderDomainCounts() {
  for (const el of document.querySelectorAll('#domain-bar .domain-count')) {
    const d = el.dataset.domain || '';
    const n = Number((state.domainUnread && state.domainUnread[d]) || 0);
    el.classList.toggle('hidden', !(n > 0));
    el.textContent = n > 99 ? '99+' : String(n);
    el.title = n > 0 ? `${d}：${n} 封未读` : '';
  }
}

/**
 * Refresh the per-domain unread counts (chip corner badge). Cheap D1 GROUP BY; throttled so a burst of folder loads
 * does not hammer it.
 */
let domainCountsAt = 0;
async function refreshDomainCounts(force = false) {
  if (!force && Date.now() - domainCountsAt < 5000) return;
  try {
    const data = await api('/api/domains');
    domainCountsAt = Date.now();
    state.domainUnread = data && data.unread && typeof data.unread === 'object' ? data.unread : {};
    const ids = {};
    for (const row of Array.isArray(data && data.domains) ? data.domains : []) {
      const name = String((row && row.domain) || '').trim().toLowerCase();
      const zone = String((row && row.zone_id) || '').trim();
      if (name && zone) ids[name] = zone;
    }
    state.zoneIds = ids;
    renderDomainCounts();
  } catch {
    /* badge is informational: keep the previous numbers on failure */
  }
}

/** Tick / untick one domain in the filter: re-fetch the list, counts and mailbox list for the new selection. */
function toggleDomain(domain, on) {
  const d = String(domain || '').toLowerCase();
  if (!d) return;
  const wanted = new Set(Array.isArray(state.domainSel) ? state.domainSel : []);
  if (on) wanted.add(d);
  else wanted.delete(d);
  // Keep the configured order (not the click order) so the filter string is stable for caching.
  const next = (Array.isArray(state.domains) ? state.domains : []).filter((x) => wanted.has(x));
  if (next.join(',') === (Array.isArray(state.domainSel) ? state.domainSel : []).join(',')) return;
  state.domainSel = next;
  state.selected.clear();
  // The mailbox filter only survives when it still belongs to one of the ticked domains.
  if (state.mailbox && next.length && !next.includes(addrDomain(state.mailbox))) state.mailbox = '';
  state.cache.countsAt = 0;
  state.cache.mailboxesAt = 0;
  closeMessagePane();
  renderDomainBar();
  renderMailboxSelect();
  renderListTitle(); // the ticked domains are part of the title, so the filter is visible immediately
  void loadMailboxes(true);
  void refreshCounts(true);
  void loadFolder();
  persistSoon();
}

/* ---------------- Domain health (automatic self-check, no button) ----------------
 * The self-check runs **by itself**, at most once every 30 minutes, and each domain chip shows the result at its
 * top-right corner: blue ✓ = fine, gray ? = not checked yet, red ! = a problem (click the badge for details / settings).
 * The last result is cached in localStorage, so a page refresh shows the known state immediately instead of "?".
 */
const DOMAIN_HEALTH_TTL = 30 * 60 * 1000;  // at most one automatic check per 30 minutes
const DOMAIN_HEALTH_TICK = 5 * 60 * 1000;  // re-evaluate the throttle every 5 min (a tab can stay open for hours)
const DOMAIN_HEALTH_KEY = 'domain-health-v1';
/** Advisory rows that must not turn the badge red: a missing DMARC does not stop mail from being delivered. */
const DOMAIN_HEALTH_ADVISORY = /^DMARC\b/;

let domainHealthTimer = null;

function domainHealthOf(domain) {
  const st = state.domainHealth && state.domainHealth[domain];
  return st === 'ok' || st === 'bad' ? st : 'unknown';
}

/** Map the self-check items onto per-domain states. Items are named `<label> · <domain>`; everything else is global. */
function domainHealthFromCheck(data) {
  const items = Array.isArray(data && data.items) ? data.items : [];
  const map = {};
  const detail = {};
  for (const d of state.domains) {
    // Every check row is per domain (`<label> · <domain>`); DMARC is advisory and excluded from the badge.
    const mine = items.filter(
      (i) => typeof i.name === 'string' && i.name.endsWith(` · ${d}`) && !DOMAIN_HEALTH_ADVISORY.test(i.name)
    );
    if (!mine.length) { map[d] = 'unknown'; detail[d] = []; continue; }
    const failed = mine.filter((i) => !i.ok).map((i) => String(i.name));
    map[d] = failed.length ? 'bad' : 'ok';
    detail[d] = failed;
  }
  return { map, detail };
}

function persistDomainHealth() {
  try {
    localStorage.setItem(
      DOMAIN_HEALTH_KEY,
      JSON.stringify({ at: state.domainHealthAt, map: state.domainHealth, detail: state.domainHealthDetail })
    );
  } catch {
    /* storage disabled / quota: the state simply isn't cached */
  }
}

function restoreDomainHealth() {
  try {
    const raw = localStorage.getItem(DOMAIN_HEALTH_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return;
    if (p.map && typeof p.map === 'object') state.domainHealth = p.map;
    if (p.detail && typeof p.detail === 'object') state.domainHealthDetail = p.detail;
    if (typeof p.at === 'number') state.domainHealthAt = p.at;
  } catch {
    /* corrupt cache: start from "unknown" */
  }
}

/** Update the corner badges in place (no re-render, so focus / scroll of the bar are untouched). */
function renderDomainHealth() {
  for (const badge of document.querySelectorAll('#domain-bar .domain-status')) {
    const d = badge.dataset.domain || '';
    const st = domainHealthOf(d);
    const failed = (state.domainHealthDetail && state.domainHealthDetail[d]) || [];
    badge.classList.remove('ok', 'bad', 'unknown');
    badge.classList.add(st);
    // "!" rather than "✕": a cross reads as a close button.
    badge.textContent = st === 'ok' ? '✓' : st === 'bad' ? '!' : '?';
    badge.title =
      st === 'ok'
        ? `${d}：自动自检正常（Resend 已验证、收发信 DNS 齐全）。点击查看详情`
        : st === 'bad'
          ? `${d}：自检发现问题${failed.length ? `（${failed.join('、')}）` : ''}。点击查看详情 / 修改发信 Key 与默认发件人`
          : `${d}：还没有检查过。点击立即检查`;
    badge.setAttribute('aria-label', badge.title);
  }
}

/** Store one check payload (used by both the background check and the details panel). */
function applyDomainHealth(data) {
  const { map, detail } = domainHealthFromCheck(data || {});
  state.domainHealth = map;
  state.domainHealthDetail = detail;
  state.domainHealthAt = Date.now();
  persistDomainHealth();
  renderDomainHealth();
}

/** Automatic self-check. `force` skips the 30-minute throttle (after adding a domain / saving settings). */
async function refreshDomainHealth(force = false) {
  if (!Array.isArray(state.domains) || !state.domains.length) return;
  if (!force && Date.now() - (state.domainHealthAt || 0) < DOMAIN_HEALTH_TTL) return;
  try {
    const data = await api('/api/setup/check');
    applyDomainHealth(data);
  } catch {
    /* network / auth hiccup: keep the last known state instead of flashing "?" everywhere */
  }
}

function startDomainHealthTimer() {
  if (domainHealthTimer) return;
  domainHealthTimer = setInterval(() => void refreshDomainHealth(), DOMAIN_HEALTH_TICK);
  // A background tab can sleep for hours: re-check when it becomes visible again (the TTL still applies).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshDomainHealth();
  });
}

function renderNav() {
  const nav = $('#folder-nav');
  nav.innerHTML = '';
  for (const f of FOLDERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'folder-item' + (f.key === state.folder ? ' active' : '');
    btn.dataset.folder = f.key;

    const label = document.createElement('span');
    label.className = 'folder-label';
    label.textContent = f.label;
    btn.appendChild(label);

    // Inbox badge = unread count; drafts badge = draft count (drafts have no "unread" semantics, the two definitions aren't mixed)
    const badgeN = f.key === 'inbox'
      ? Number(state.counts.inbox_unread) || 0
      : f.key === 'drafts'
        ? Number(state.counts.drafts_total) || 0
        : 0;
    if (badgeN > 0) {
      const badge = document.createElement('span');
      badge.className = 'folder-badge';
      badge.textContent = badgeN > 999 ? '999+' : String(badgeN);
      btn.appendChild(badge);
    }
    btn.addEventListener('click', () => openFolder(f.key));
    nav.appendChild(btn);
  }
  renderTitle();
}

/**
 * Browser tab title: shows "(N) Inbox" when there are new messages, falls back to plain "Inbox" when there are no unread.
 *
 * The data source is the **same** `state.counts.inbox_unread` as the sidebar badge, driven uniformly by `renderNav()` ——
 * count changes land in only one place, so the title never disagrees with the badge (and isn't overwritten back to the default when switching folders).
 * Truncated at 999 with the same convention as the badge, to avoid blowing up the title.
 */
function renderTitle() {
  const n = Number(state.counts.inbox_unread) || 0;
  document.title = n > 0 ? `(${n > 999 ? '999+' : n}) 收件箱` : '收件箱';
}

function countQuery() {
  const params = new URLSearchParams();
  if (state.mailbox) params.set('mailbox', state.mailbox);
  // Always present: '' = nothing ticked = zero counts (see fetchFolderPage).
  params.set('domain', domainParam());
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function refreshCounts(force = false) {
  const c = state.cache;
  if (!force && Date.now() - c.countsAt < TTL.counts) return;
  try {
    const next = await api(`/api/counts${countQuery()}`);
    c.countsAt = Date.now();
    state.counts = next;
    renderNav();
    void refreshDomainCounts();
    persistSoon();
  } catch (e) {
    reportLoadError(e);
  }
}

/**
 * Fetch the receiving-address list. After operations that change count state (read/star/delete/batch/send), call with force=true
 * to keep the "unread" number in the dropdown in sync with reality (BUG-3c); non-forced calls go through the TTL, and only one in-flight request
 * is allowed at a time, with requests arriving meanwhile merged into a single re-fetch to avoid high frequency.
 */
async function loadMailboxes(force = false) {
  const c = state.cache;
  if (!force && Date.now() - c.mailboxesAt < TTL.mailboxes) return;
  if (c.mailboxesLoading) {
    c.mailboxesPending = true;
    return;
  }
  c.mailboxesLoading = true;
  try {
    // '' = nothing ticked -> no addresses at all (same rule as the list / counts).
    const data = await api(`/api/mailboxes?domain=${encodeURIComponent(domainParam())}`);
    state.mailboxList = data.mailboxes || [];
    c.mailboxesAt = Date.now();
    renderMailboxSelect();
    persistSoon();
  } catch {
    /* Keep the existing list: one network blip shouldn't empty the selector */
  } finally {
    c.mailboxesLoading = false;
    if (c.mailboxesPending) {
      c.mailboxesPending = false;
      void loadMailboxes(true);
    }
  }
}

/* ---------------- List ---------------- */

/**
 * Surface a failed background fetch instead of silently keeping the previous view.
 * A filter change that looks like it "does nothing" is usually an API error being swallowed by a bare `catch {}`;
 * deduplicated by message so a flapping endpoint cannot spam toasts.
 */
let lastLoadError = { msg: '', at: 0 };
function reportLoadError(e) {
  const msg = (e && e.message) || String(e || '');
  if (!msg) return;
  if (window.console) console.warn('[load]', msg);
  const now = Date.now();
  if (msg === lastLoadError.msg && now - lastLoadError.at < 30000) return;
  lastLoadError = { msg, at: now };
  try {
    showToast(msg, true);
  } catch {
    /* no toast container (e.g. a bare headless harness): the console warning above is enough */
  }
}

function folderLabel() {
  const f = FOLDERS.find((x) => x.key === state.folder);
  return f ? f.label : state.folder;
}

function renderListTitle() {
  // Explicitly label the definition: this is "the folder's total count", semantically different from the "unread" in the sidebar/dropdown, and not forcibly unified (BUG-3d).
  const extra = state.total ? ` · 共 ${state.total} 封` : '';
  const q = state.q ? `：搜索“${state.q}”` : '';
  // Only the folder + total (user request): the active domain filter is already visible as ticked chips, and the
  // empty state explains "no domain selected" when nothing is shown.
  $('#list-title').textContent = `${folderLabel()}${q}${extra}`;
}

function openFolder(folder) {
  state.folder = folder;
  state.selected.clear();
  state.q = '';
  const input = $('#search-input');
  if (input) input.value = '';
  state.offset = 0;
  closeMessagePane();
  closeDrawer(); // Mobile: collapse the drawer after picking a folder, otherwise it keeps covering the just-switched list
  renderNav();
  renderListTitle();
  renderSelectBar();
  void loadFolder();
}

function renderList() {
  listEl.innerHTML = '';
  for (const item of state.items) listEl.appendChild(itemRow(item));
}

function afterListRender() {
  renderListTitle();
  const empty = $('#list-empty');
  if (state.items.length === 0) {
    const noDomain = !(Array.isArray(state.domainSel) && state.domainSel.length);
    empty.textContent = state.loading
      ? '加载中…'
      : state.folder === 'drafts'
        ? '这里还没有邮件'
        : noDomain
          ? '未选择域名：勾选上方的域名后显示邮件'
          : '这里还没有邮件';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
  const more = $('#list-more');
  const hasMore = state.items.length < state.total;
  more.classList.toggle('hidden', !hasMore);
  more.textContent = hasMore ? `已显示 ${state.items.length} / ${state.total} 封，点击加载更多` : '';
}

/**
 * Render the list area (list + empty/more + batch bar).
 * Convergence point: called only once per stage within a load, avoiding duplicate DOM rebuilds of "once for loading + once for data + once more in finally".
 */
function paintList() {
  renderList();
  afterListRender();
  renderSelectBar();
  prefetchBodies(); // once the list is painted, conveniently prefetch the bodies (idle, cancellable, doesn't touch the UI)
}

/** Comparison baseline for background revalidate: the fingerprint of this view in the in-memory cache. */
function cachedFolderFingerprint(token) {
  const c = state.cache.folders.get(token);
  return c ? c.fp : null;
}

function fetchFolderPage(offset) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (state.q) params.set('q', state.q);
  // Drafts belong to the sender you picked, not to the address/domain you are browsing: never narrow them by filters,
  // otherwise a draft written from another address looks lost.
  if (state.folder !== 'drafts') {
    if (state.mailbox) params.set('mailbox', state.mailbox);
    // Always sent, even when empty: an empty value means "no domain ticked", which must show **nothing** rather than
    // everything (that is the whole point of the top-bar filter).
    params.set('domain', domainParam());
  }
  return api(`/api/folders/${state.folder}?${params}`);
}

/**
 * Fetch page 1 of the current view.
 * - first=true: no usable cache, show the loading state (first paint waits for it), render once data arrives.
 * - first=false: background stale-while-revalidate refresh; do nothing if the fingerprint is unchanged.
 */
async function revalidateFolder(token, first) {
  let data;
  try {
    data = await fetchFolderPage(0);
  } catch (e) {
    if (token !== folderKey()) return;
    state.loading = false;
    if (first) paintList();
    reportLoadError(e);
    return;
  }
  if (token !== folderKey()) return; // view switched, discard stale response
  state.loading = false;
  const fp = folderFingerprint(data.items, data.total);
  if (!first && fp === cachedFolderFingerprint(token)) return; // data unchanged: skip re-render
  state.items = data.items;
  state.itemsKey = token;
  state.total = data.total;
  state.offset = data.items.length;
  storeFolderCache(state.items, state.total, fp);
  paintList();
  maybeAutoOpen();
  persistSoon();
}

async function loadFolder(append = false, force = false) {
  if (append) {
    if (state.loading) return;
    const token = folderKey();
    state.loading = true;
    try {
      const data = await fetchFolderPage(state.offset);
      if (token !== folderKey()) return;
      state.items = state.items.concat(data.items);
      state.total = data.total;
      state.offset += data.items.length;
      storeFolderCache(state.items, state.total);
      paintList();
      persistSoon();
    } catch (e) {
      reportLoadError(e);
    } finally {
      if (token === folderKey()) state.loading = false;
    }
    return;
  }

  const token = folderKey();
  const cached = state.cache.folders.get(token);

  if (!force && cached && cached.items.length) {
    // cache-first (no longer require "fresh"): render immediately, revalidate in background
    const painted = state.itemsKey === token && folderFingerprint(state.items, state.total) === cached.fp;
    if (!painted) {
      state.items = cached.items;
      state.itemsKey = token;
      state.total = cached.total;
      state.offset = cached.items.length;
      paintList();
    }
    state.loading = false;
    maybeAutoOpen();
    persistSoon();
    void revalidateFolder(token, false);
    return;
  }

  const sameView = state.itemsKey === token && state.items.length > 0;
  if (!sameView) {
    state.items = [];
    state.itemsKey = null;
    state.total = 0;
    state.offset = 0;
    state.loading = true;
    paintList(); // render the loading state once (clear screen)
  }
  await revalidateFolder(token, true);
}

/** Auto-open the latest message when first entering the inbox, so the detail pane is visible. */
function maybeAutoOpen() {
  if (state.firstOpen && !state.openId && !state.q && state.folder === 'inbox' && state.items.length) {
    state.firstOpen = false;
    void openMessage(state.items[0].id);
  }
}

function starBtn(item) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'star-btn' + (item.starred ? ' starred' : '');
  b.title = item.starred ? '取消星标' : '加星标';
  b.textContent = item.starred ? '★' : '☆';
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void toggleStar(item, b);
  });
  return b;
}

async function toggleStar(item, btn) {
  try {
    await api(`/api/messages/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ starred: !item.starred }),
    });
    const next = !item.starred;
    applyLocalPatch(item.id, { starred: next });
    btn.classList.toggle('starred', next);
    btn.textContent = next ? '★' : '☆';
    btn.title = next ? '取消星标' : '加星标';
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // starred count feeds account counts (BUG-3c)
  } catch (e) {
    showToast(e.message, true);
  }
}

function itemRow(item) {
  // Drafts and normal mail share the same list structure (the server returns drafts as rows of the same shape, direction='draft'),
  // with only three divergences: the checkbox (drafts have no batch-action semantics), the sender slot shows recipients, and opening shows the composer.
  const isDraft = item.direction === 'draft';
  // thread_unread is a backend aggregate field; it may be absent in old caches/fixtures, so fall back to the single row's read state.
  const threadUnread = item.thread_unread !== undefined ? item.thread_unread : (item.read ? 0 : 1);
  const hasUnread = threadUnread > 0;
  const row = document.createElement('div');
  row.className = 'list-item' + (hasUnread ? ' unread' : '') + (item.id === state.openId ? ' active' : '');
  row.dataset.id = item.id;
  // Domain colour: the tint (and the left bar) tells at a glance which domain this mail belongs to.
  setDomainHue(row, itemDomain(item));

  if (!isDraft) {
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'li-check';
    chk.checked = state.selected.has(item.id);
    chk.addEventListener('click', (ev) => ev.stopPropagation());
    chk.addEventListener('change', () => {
      if (chk.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
      renderSelectBar();
    });
    row.appendChild(chk);
  }

  const main = document.createElement('div');
  main.className = 'li-main';
  const av = document.createElement('span');
  av.className = 'li-avatar';
  av.textContent = isDraft ? '稿' : avatarChar(item);
  main.appendChild(av);
  const sender = document.createElement('span');
  sender.className = 'li-sender';
  if (isDraft) sender.textContent = recipientsLabel(item.to_emails) || '(无收件人)';
  else if (item.direction === 'inbound') sender.textContent = senderLabel(item);
  else sender.textContent = `致 ${recipientsLabel(item.to_emails) || '(未知)'}`;
  main.appendChild(sender);
  if (item.direction === 'outbound' || isDraft) {
    const chip = document.createElement('span');
    chip.className = 'li-status ' + esc(item.status || 'sent');
    chip.textContent = STATUS_LABEL[item.status] || item.status || 'sent';
    main.appendChild(chip);
  }
  row.appendChild(main);

  const sub = document.createElement('div');
  sub.className = 'li-sub';
  const subject = document.createElement('span');
  subject.className = 'li-subject';
  subject.textContent = item.subject || '(无主题)';
  sub.appendChild(subject);
  const tc = item.thread_count || 1;
  if (tc > 1) {
    const badge = document.createElement('span');
    badge.className = 'li-thread-badge';
    badge.textContent = String(tc);
    sub.appendChild(badge);
  }
  if (item.attachments_count > 0) {
    const af = document.createElement('span');
    af.className = 'li-attach';
    af.textContent = '[附件]';
    sub.appendChild(af);
  }
  const preview = (item.preview || '').trim();
  if (preview) {
    const p = document.createElement('span');
    p.className = 'li-preview';
    p.textContent = preview;
    sub.appendChild(p);
  }
  row.appendChild(sub);

  const time = document.createElement('div');
  time.className = 'li-time';
  time.textContent = fmtDateTime(item.received_at);
  row.appendChild(time);

  const starWrap = document.createElement('span');
  starWrap.className = 'li-star';
  if (isDraft) {
    // Drafts have no "star" concept, so this slot holds a delete button instead (avoids a separate inline action set for drafts)
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'star-btn draft-del';
    del.title = '删除草稿';
    del.textContent = '×';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void deleteDraftItem(item.id);
    });
    starWrap.appendChild(del);
  } else {
    starWrap.appendChild(starBtn(item));
  }
  row.appendChild(starWrap);

  row.addEventListener('click', () => {
    if (isDraft) void openDraftComposer(item.id);
    else void openMessage(item.id);
  });
  return row;
}

/** Delete a draft (the × button in the list). */
async function deleteDraftItem(id) {
  try {
    await api(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.cache.folders.clear(); // draft list and sidebar counts both changed
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadFolder(false, true);
    showToast('草稿已删除');
  } catch (e) {
    showToast(e.message, true);
  }
}

/**
 * One-way derive #select-all's checked state from state.selected, eliminating "select-all checkbox checked desyncs from the selected set" (BUG-1b).
 * #select-all no longer holds independent truth: every entry point only mutates state.selected, then renderSelectBar() reconciles the UI.
 * Rule: pageIds = ids of .list-item[data-id] on the current page; sel = state.selected.
 */
function syncSelectAll() {
  const box = $('#select-all');
  if (!box) return;
  const pageIds = Array.from(document.querySelectorAll('.list-item[data-id]')).map((r) => r.dataset.id);
  const sel = state.selected;
  const checked = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  box.checked = checked;
  box.indeterminate = !checked && pageIds.some((id) => sel.has(id));
}

function renderSelectBar() {
  const bar = $('#list-bulk');
  const hasSel = state.selected.size > 0;
  bar.classList.toggle('hidden', !hasSel);
  if (hasSel) {
    $('#selected-count').textContent = `已选择 ${state.selected.size} 封`;

    const actions = $('#bulk-actions');
    actions.innerHTML = '';
    const mk = (label, action, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', () => void bulk(action));
      actions.appendChild(b);
    };
    if (state.folder === 'trash') {
      mk('还原', 'restore');
      mk('彻底删除', 'delete', 'btn-danger');
    } else {
      mk('已读', 'read');
      mk('未读', 'unread');
      mk('星标', 'star');
      mk('取消星标', 'unstar');
      mk('删除', 'trash');
    }
  }
  syncSelectAll(); // convergence point: every path that mutates state.selected syncs the select-all box here
}

async function bulk(action) {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    await api('/api/messages/batch', {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    });
    state.selected.clear();
    invalidateFolderCaches();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // batch read/star/delete all change account counts (BUG-3c)
    await loadFolder(false, true);
  } catch (e) {
    showToast(e.message, true);
  }
}

/* ---------------- Read pane ---------------- */

let currentMessage = null;
let currentAttachments = [];
let currentThread = [];

/**
 * Placeholder state for the detail pane's "body downloading / download failed".
 * The list item already carries subject, sender, time, star, direction, and attachment count, enough to draw the envelope card immediately;
 * only the body / attachment details / thread context must wait for the detail endpoint. So after a click, render the header **synchronously** first,
 * hand the body slot to this placeholder state, and swap it in place once details arrive — without blocking the click.
 * Shaped like { id, phase: 'loading' | 'error', message? }
 */
let detailPending = null;

/**
 * Detail request sequence number. When the user rapidly clicks several messages, an earlier response may arrive later;
 * stale responses must be discarded, or the later-selected message would be overwritten by the earlier-selected one.
 * closeMessagePane() also increments it, making "reopened by a finished load after closing" impossible.
 */
let detailSeq = 0;

function closeMessagePane() {
  detailSeq++; // invalidate in-flight detail responses
  detailPending = null;
  state.openId = null;
  currentMessage = null;
  currentAttachments = [];
  currentThread = [];
  $('#read-message').classList.add('hidden');
  $('#read-placeholder').classList.remove('hidden');
  syncActiveRow(); // clear leftover active highlight after closing (BUG-1)
  syncLayout(); // mobile: leave the single-column detail view and let the list fill again
}

function isReadMode() {
  return state.openId !== null;
}

/**
 * Sync the "read" state after opening a detail (BUG-2).
 * The server sets read to 1 on GET detail and returns the new value; if the frontend tests with `!currentMessage.read` it is always false,
 * skipping the whole local patch and leaving the list row showing unread. Here it is made idempotent and independent of the server return value:
 * unconditionally write read:1 into state.items / all folder caches / the message cache / the current row DOM;
 * whether to refresh counts depends only on "was unread actually observed locally before opening" (prior null means unknown, treated as unread).
 */
function syncOpenedReadState(message, prior) {
  if (!message || message.direction !== 'inbound') return;
  const observed = prior || findItem(message.id);
  const wasUnread = !observed || !observed.read;
  applyLocalPatch(message.id, { read: 1 });
  if (wasUnread) {
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // account unread count updates together with reading (BUG-3c)
  }
}

async function openMessage(id) {
  const cached = state.cache.messages.get(id);

  // Cache hit: the body is immutable, so **render first no matter how old the cache is** (reading is not blocked by the network),
  // then revalidate in the background if needed. This makes reopening a read message after a page refresh instant.
  if (cached && cached.message) {
    const cacheFresh = Date.now() - cached.at < TTL.message;
    // If an inbound message is still unread in the cache (the user manually marked it unread), the server must be asked to persist it as "read",
    // otherwise the next list refresh reverts it to unread.
    const mustRecordRead = cached.message.direction === 'inbound' && !cached.message.read;

    detailSeq++; // cache already paints instantly, invalidate any in-flight old request
    detailPending = null;
    touchMessageCache(id);
    currentMessage = cached.message;
    currentAttachments = cached.attachments || [];
    currentThread = cached.thread || [];
    state.openId = id;
    syncOpenedReadState(cached.message); // patch the local read state before rendering so button labels are correct
    renderRead();
    persistSoon();
    if (!cacheFresh || mustRecordRead) void revalidateMessage(id);
    return;
  }

  const prior = findItem(id); // local state before opening, used to tell whether a real 0→1 transition occurred

  // Optimistic render: draw the header from the list item first, show "downloading" in the body slot.
  // This makes click feedback synchronous, not stuck on the detail request round trip.
  if (prior) {
    state.openId = id;
    currentMessage = prior;
    currentAttachments = [];
    currentThread = [];
    detailPending = { id, phase: 'loading' };
    renderRead();
    syncActiveRow();
    persistSoon();
  }

  const seq = ++detailSeq;
  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    // Stale response (user switched away / closed / clicked another message) is discarded and does not overwrite the current view
    if (seq !== detailSeq) return;
    applyDetailToView(id, data, prior);
  } catch (e) {
    if (seq !== detailSeq) return;
    if (prior) {
      // Keep the already-drawn header, only swap the body slot to error state + retry, leaving no blank body
      detailPending = { id, phase: 'error', message: e.message };
      renderRead();
    }
    showToast(e.message, true);
  }
}

/** Write the detail response into the cache and update the current view (body slot goes from "downloading" to real content). */
function applyDetailToView(id, data, prior) {
  currentMessage = data.message;
  currentAttachments = data.attachments || [];
  currentThread = data.thread || [];
  detailPending = null;
  state.openId = id;
  putMessageCache(id, {
    message: currentMessage,
    attachments: currentAttachments,
    thread: currentThread,
    at: Date.now(),
  });
  syncOpenedReadState(currentMessage, prior);
  renderRead();
  persistSoon();
}

/**
 * Background detail revalidation. The body is already rendered from cache, so this is **non-blocking and silent on failure**.
 * Purposes: ① cache expired (read / starred / status may have changed) ② an inbound unread must be persisted as "read" on the server.
 * If the user has switched away, only the cache and list row are updated, not the right pane.
 */
async function revalidateMessage(id) {
  let data;
  try {
    data = await api(`/api/messages/${encodeURIComponent(id)}`);
  } catch {
    return; // background revalidation failure stays silent: the body is already visible
  }
  putMessageCache(id, {
    message: data.message,
    attachments: data.attachments || [],
    thread: data.thread || [],
    at: Date.now(),
  });
  syncOpenedReadState(data.message, findItem(id));
  if (state.openId === id && !detailPending) {
    currentMessage = data.message;
    currentAttachments = data.attachments || [];
    currentThread = data.thread || [];
    renderRead();
  }
  persistSoon();
}

function readBtn(label, fn, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

async function setFlag(key, value) {
  if (!currentMessage) return;
  try {
    await api(`/api/messages/${encodeURIComponent(currentMessage.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ [key]: value }),
    });
    applyLocalPatch(currentMessage.id, { [key]: value, read: key === 'read' ? value : currentMessage.read });
    renderRead();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // account unread count updates together with the flag (BUG-3c)
  } catch (e) {
    showToast(e.message, true);
  }
}

async function deleteFromRead() {
  if (!currentMessage) return;
  try {
    await api(`/api/messages/${encodeURIComponent(currentMessage.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ deleted: true }),
    });
    invalidateFolderCaches();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // deletion changes account counts (BUG-3c)
    showToast('已移入已删除');
    closeMessagePane();
    void loadFolder(false, true);
  } catch (e) {
    showToast(e.message, true);
  }
}

function envelopeDetailToggle(btn, lines) {
  const show = !lines.classList.contains('show');
  lines.classList.toggle('show', show);
  btn.textContent = show ? '收起详情' : '查看详情';
}

function metaLines() {
  const m = currentMessage;
  const lines = document.createElement('div');
  lines.className = 'env-detail-lines';
  const add = (k, v) => {
    const d = document.createElement('div');
    const kk = document.createElement('span');
    kk.className = 'k';
    kk.textContent = k;
    d.appendChild(kk);
    const vv = document.createElement('span');
    vv.textContent = v || '—';
    d.appendChild(vv);
    lines.appendChild(d);
  };
  if (m.direction === 'inbound') {
    add('发件人', m.from_name ? `${m.from_name} <${m.from_email || ''}>` : (m.from_email || ''));
    // ⚠️ Don't show to_emails directly: in pre-fix data it is the delivery address (envelope) and would display as the user themselves.
    // Always go through inboundRecipients() (the real To: header) for consistency.
    add('收件人', inboundRecipientsLabel(m));
    // List cc/bcc only when present — same rule as the outbound branch. The vast majority of inbound mail has no cc,
    // so listing unconditionally would add a useless "cc —" line to every message.
    if (jsonArr(m.cc).length) add('抄送', jsonArr(m.cc).join(', '));
    if (jsonArr(m.bcc).length) add('密送', jsonArr(m.bcc).join(', '));
    // ⛔ There used to be three more lines here, removed on 2026-10-08 (third round) at the user's request (all pure duplication, no lost information):
    //   · "Delivery address" = m.mailbox —— the envelope card subtitle already shows "to <mailbox>" (`envelopeSubLine()`,
    //      and it is omitted automatically when sending to yourself); the sidebar/inbox context already says which mailbox this is.
    //   · "Your identity" = ROLE_LABEL[role] —— when cc'd/bcc'd, the default-visible summary line already shows
    //      the "you are cc / you are bcc" chip; when you are a recipient, the "recipient" line contains you. Both paths fully covered.
    //   · "Time" = timeLong() —— the envelope card's top-right fmtDateTime() renders the **same string in the same format**
    //      (the two functions are character-for-character identical implementations), zero incremental information.
    //   ⚠️ ROLE_LABEL / myRecipientRole() are still used by the summary-line chip, **do not delete them along with this**.
  } else {
    add('发件人', m.from_email || m.mailbox || '');
    add('收件人', jsonArr(m.to_emails).join(', '));
    // List cc/bcc only when present, avoiding two extra "—" lines on every message
    if (jsonArr(m.cc).length) add('抄送', jsonArr(m.cc).join(', '));
    if (jsonArr(m.bcc).length) add('密送', jsonArr(m.bcc).join(', '));
    add('状态', STATUS_LABEL[m.status] || m.status || '—');
  }
  return lines;
}

function renderRead() {
  const m = currentMessage;
  if (!m) return;
  const isInbound = m.direction === 'inbound';
  // Whether the body is still downloading (or failed). Header fields come from the list item; only the body/attachment details depend on the detail endpoint.
  const pending = detailPending && detailPending.id === m.id ? detailPending : null;

  $('#read-placeholder').classList.add('hidden');
  $('#read-message').classList.remove('hidden');
  readEl.innerHTML = '';
  const isOpen = () => state.openId === m.id && currentMessage === m;

  // Subject
  const subjectWrap = document.createElement('div');
  subjectWrap.className = 'mail-subject';
  const h1 = document.createElement('h1');
  h1.textContent = m.subject || '(无主题)';
  subjectWrap.appendChild(h1);
  const sStar = document.createElement('button');
  sStar.type = 'button';
  sStar.className = 'subj-star' + (m.starred ? ' starred' : '');
  sStar.textContent = m.starred ? '★' : '☆';
  sStar.title = m.starred ? '取消星标' : '加星标';
  sStar.addEventListener('click', () => {
    if (!isOpen()) return;
    void setFlag('starred', !m.starred);
  });
  subjectWrap.appendChild(sStar);
  readEl.appendChild(subjectWrap);

  // Close the attachment preview overlay when switching messages: renderRead is the **sole exit** for detail content, so placing it here never misses
  closeAttachmentPreview();

  // Thread context
  if (currentThread.length > 1) readEl.appendChild(threadPanel());

  // Envelope card
  const env = document.createElement('div');
  env.className = 'mail-card mail-envelope';
  setDomainHue(env, itemDomain(m));

  const top = document.createElement('div');
  top.className = 'env-top';

  const avatar = document.createElement('span');
  avatar.className = 'env-avatar';
  avatar.textContent = avatarChar(m);
  top.appendChild(avatar);

  const who = document.createElement('div');
  who.className = 'env-who';
  const nameRow = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'who-name';
  // Outbound shows the **actual sending mailbox** (not the literal "me"), inbound shows the other party; always go through endpointsOf for consistency.
  name.textContent = endpointsOf(m)[0];
  nameRow.appendChild(name);
  if (!isInbound && m.status) {
    const chip = document.createElement('span');
    chip.className = 'mail-status-chip ' + esc(m.status);
    chip.textContent = STATUS_LABEL[m.status] || m.status;
    nameRow.appendChild(chip);
  }
  who.appendChild(nameRow);
  const emailLine = document.createElement('div');
  emailLine.className = 'who-email';
  emailLine.textContent = envelopeSubLine(m, pending);
  who.appendChild(emailLine);
  top.appendChild(who);

  const date = document.createElement('div');
  date.className = 'env-date';
  date.textContent = fmtDateTime(m.received_at);
  top.appendChild(date);
  env.appendChild(top);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'env-actions';
  // A message we sent to one of our own addresses is stored twice: the thread keeps the outbound copy and folds the
  // received one into `copy_ids`, so "incoming" mail from a managed domain would show no reply button. Treat any
  // message that also arrived as incoming and reply to that inbound copy.
  const inboundCopyId = isInbound ? '' : inboundCopyIdOf(m);
  if (isInbound || inboundCopyId) {
    actions.appendChild(readBtn('回复', () => { if (isOpen()) openReplyComposer(inboundCopyId || undefined); }, 'btn-primary'));
  }
  // Forwarding is available for both inbound / outbound mail (you can forward your own sent mail to others too)
  actions.appendChild(readBtn('转发', () => { if (isOpen()) openForwardComposer(); }));
  actions.appendChild(readBtn(m.read ? '标为未读' : '标为已读', () => { if (isOpen()) void setFlag('read', !m.read); }));
  actions.appendChild(readBtn('删除', () => { if (isOpen()) void deleteFromRead(); }));
  env.appendChild(actions);

  // Detail summary + expandable lines
  const toLine = document.createElement('div');
  toLine.className = 'env-details';
  const toggle = document.createElement('a');
  toggle.className = 'toggle-detail';
  toggle.textContent = '查看详情';
  const lines = metaLines();
  // Inbound shows the **real To: header** (not the delivery address), otherwise a cc'd message would display as the user themselves
  const toText = isInbound ? inboundRecipientsLabel(m) : recipientsLabel(m.to_emails);
  toLine.innerHTML = `<b>收件人：</b>${esc(toText || (pending ? '…' : '—'))} `;
  // "recipient: —" has only one cause: the message was stored **before the fix** (`delivered_to` is still null, the real To: header was not persisted),
  // and the delivery address minus cc/bcc is empty. Whether it can be recovered depends on upstream retention — Resend keeps only 30 days,
  // and after the 2026-10-08 backfill 10 rows were still past retention and permanently unrecoverable. Add a title explaining this so it isn't repeatedly investigated as a bug.
  if (isInbound && !toText && !pending && m.delivered_to === null) {
    toLine.title = '这封邮件入库时未保存原始收件人（To:）信息，且已超出上游保留期，无法恢复';
  }
  // When I'm only cc'd/bcc'd, show a chip on this default-visible line — the detail lines are collapsed, so hiding it there is as good as saying nothing
  const role = isInbound ? myRecipientRole(m) : null;
  if (role === 'cc' || role === 'bcc') {
    const chip = document.createElement('span');
    chip.className = 'env-role-chip';
    chip.textContent = `你是${ROLE_LABEL[role]}`;
    chip.title = `这封邮件不是发给你的，你是以${ROLE_LABEL[role]}身份收到的`;
    toLine.appendChild(chip);
    toLine.appendChild(document.createTextNode(' '));
  }
  toggle.addEventListener('click', () => envelopeDetailToggle(toggle, lines));
  toLine.appendChild(toggle);
  env.appendChild(toLine);
  env.appendChild(lines);

  // Attachments
  if (currentAttachments.length) {
    const box = document.createElement('div');
    box.className = 'attachments';
    const title = document.createElement('div');
    title.className = 'att-title';
    title.textContent = `${currentAttachments.length} 个附件`;
    box.appendChild(title);
    const list = document.createElement('div');
    list.className = 'att-list';
    for (const a of currentAttachments) {
      list.appendChild(attachmentChip(a));
    }
    box.appendChild(list);
    env.appendChild(box);
  } else if (pending && m.attachments_count > 0) {
    // Attachment details wait on the detail endpoint, but the list item already carries the attachment count: show the count first,
    // otherwise the user would think the message has no attachments while it is downloading.
    const box = document.createElement('div');
    box.className = 'attachments';
    const title = document.createElement('div');
    title.className = 'att-title';
    title.textContent = `${m.attachments_count} 个附件（随正文下载中…）`;
    box.appendChild(title);
    env.appendChild(box);
  }
  readEl.appendChild(env);

  // Body: use the placeholder state while downloading / on failure, rather than rendering a blank body
  const bodyCard = document.createElement('div');
  bodyCard.className = 'mail-body';
  if (pending) {
    bodyCard.classList.add('mail-body-pending');
    bodyCard.appendChild(detailPlaceholder(pending));
  } else {
    bodyCard.innerHTML = buildBodyHtml(m);
    bodyCard.querySelectorAll('a').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }
  readEl.appendChild(bodyCard);

  syncRowUI(m.id);
  // Align the layout after the detail renders. Placed here rather than repeated in every branch of openMessage:
  // renderRead() is the **sole exit** where detail content appears (cache hit / optimistic render / detail return all go through it),
  // so placing it here naturally never misses.
  syncLayout();
}

/**
 * Body-slot placeholder: while downloading show a spinner + text; on failure show the reason + retry.
 * Both cases **keep the envelope card**, so the user can always see subject / sender / time.
 */
function detailPlaceholder(pend) {
  const wrap = document.createElement('div');
  wrap.className = 'body-pending' + (pend.phase === 'error' ? ' is-error' : '');
  if (pend.phase === 'loading') {
    const spin = document.createElement('span');
    spin.className = 'spinner';
    spin.setAttribute('aria-hidden', 'true');
    wrap.appendChild(spin);
  }
  const txt = document.createElement('div');
  txt.className = 'body-pending-text';
  txt.setAttribute('role', 'status');
  txt.textContent = pend.phase === 'error' ? `正文加载失败：${pend.message}` : '正在下载邮件正文…';
  wrap.appendChild(txt);
  if (pend.phase === 'error') {
    wrap.appendChild(readBtn('重试', () => { void openMessage(pend.id); }));
  }
  return wrap;
}

/**
 * Whether this thread row represents "the message currently being viewed".
 *
 * The server folds "loopback copies of the same physical message" (attached to the retained row via `copy_ids`,
 * see foldLoopbackCopies in src/repo.ts) — a typical scenario: I send from dana@ and cc
 * erin@, and the message is delivered back to erin@ on this account, so the DB holds both an outbound copy and an inbound copy.
 * If the user opens exactly the **folded one** (e.g. coming from erin@'s inbox), comparing only id
 * would leave no row in the panel highlighted, looking like "the one I opened is gone".
 */
function isCurrentThreadRow(t) {
  if (!currentMessage) return false;
  if (t.id === currentMessage.id) return true;
  return jsonArr(t.copy_ids).includes(currentMessage.id);
}

/**
 * The id of the **inbound copy** of the currently open message, when it is an outbound row that also arrived
 * (self-sent mail across our own domains / loopback). '' when unknown. Reply must target that inbound row.
 */
function inboundCopyIdOf(m) {
  if (!m) return '';
  const row = currentThread.find((t) => t.id === m.id || jsonArr(t.copy_ids).includes(m.id));
  if (!row || row.direction !== 'outbound') return '';
  const ids = jsonArr(row.copy_ids);
  return ids.length ? String(ids[0]) : '';
}

function threadPanel() {
  const panel = document.createElement('div');
  panel.className = 'mail-card rm-thread';
  const head = document.createElement('div');
  head.className = 't-head';
  head.textContent = `会话 · ${currentThread.length} 封`;
  panel.appendChild(head);

  for (const t of currentThread) {
    const isUnread = !t.read && !t.deleted;
    const isCurrent = isCurrentThreadRow(t);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 't-item' +
      (isCurrent ? ' current' : '') +
      (isUnread ? ' unread' : '');

    if (isUnread) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      btn.appendChild(dot);
    }
    const sender = document.createElement('span');
    sender.className = 't-sender';
    const senderText = displayThreadSender(t);
    sender.textContent = senderText;
    // Thread rows are narrow, so long addresses get truncated with an ellipsis; hover reveals the full sender/recipient pair.
    sender.title = senderText;
    btn.appendChild(sender);

    const tag = document.createElement('span');
    tag.className = 't-tag ' + (t.direction === 'inbound' ? 'inbound' : '');
    tag.textContent = t.direction === 'inbound' ? '收' : '发';
    btn.appendChild(tag);

    const subject = document.createElement('span');
    subject.className = 't-subject';
    subject.textContent = t.subject || '(无主题)';
    btn.appendChild(subject);

    const time = document.createElement('span');
    time.className = 't-time';
    time.textContent = fmtDateTime(t.received_at);
    btn.appendChild(time);

    btn.addEventListener('click', () => {
      // If it's already the current one (including "it is the folded copy"), don't reopen
      if (!isCurrentThreadRow(t)) void openMessage(t.id);
    });
    panel.appendChild(btn);
  }
  return panel;
}

/** Thread row sender/recipient text: `sender → recipient` (see endpointsOf for the rule). */
function displayThreadSender(t) {
  const [from, to] = endpointsOf(t);
  return `${from} → ${to}`;
}

function buildBodyHtml(m) {
  const cidMap = {};
  for (const a of currentAttachments) {
    if (a.content_id) cidMap[a.content_id.toLowerCase()] = a.url;
    cidMap[a.id.toLowerCase()] = a.url;
  }
  if (m.body_html) return sanitizeHtml(m.body_html, cidMap);
  return `<pre class="text">${esc(m.body_text || '')}</pre>`;
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------- Attachments: click to preview + separate download ----------------
 *
 * User request: known formats (image / video / PDF / plain text…) open on a single click, with a separate download button.
 *
 * ⚠️ **Frontend `attachmentKind()` and backend `repo.isInlinePreviewType()` must use the same rule**:
 * the frontend decides "click opens a preview or prompts download", the backend decides whether `Content-Disposition` is
 * inline or attachment. If the two disagree, you get the split of "overlay opened, but the backend makes the browser download".
 * Changing one requires changing the other (the composer-cc-forward suite has an assertion that directly compares the two lists).
 *
 * **SVG is explicitly not previewed**: SVG can embed `<script>`, and inlining it into this app's same-origin context equals XSS.
 * The backend likewise downgrades it to a download.
 */

/** Non image/video/audio types that can be previewed inline (kept consistent with the backend isInlinePreviewType). */
const INLINE_PREVIEW_TYPES = ['application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json'];

/** Attachment type → preview mode: `image | video | audio | pdf | text | none`. */
function attachmentKind(a) {
  const t = String((a && a.content_type) || '').toLowerCase().split(';')[0].trim();
  if (!t) return 'none';
  if (t === 'image/svg+xml') return 'none';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  if (INLINE_PREVIEW_TYPES.indexOf(t) >= 0) return 'text';
  return 'none';
}

/** Preview URL: no parameters; the backend serves inline based on type. */
function attachmentUrl(a) {
  return String((a && a.url) || '');
}

/** Download URL: `?dl=1` forces attachment (otherwise PDF/images would be opened in place by the browser instead of saved). */
function attachmentDownloadUrl(a) {
  const url = attachmentUrl(a);
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'dl=1';
}

/** Attachment chip: filename is clickable (preview), with a separate "Download" button on the right. */
function attachmentChip(a) {
  const kind = attachmentKind(a);
  const chip = document.createElement('span');
  chip.className = 'att-chip';
  chip.dataset.kind = kind;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'att-open';
  open.title = kind === 'none' ? '该格式不支持在线预览，请点右侧「下载」' : '点击预览';
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = a.filename;
  nm.title = a.filename;
  open.appendChild(nm);
  open.addEventListener('click', () => openAttachmentPreview(a));
  chip.appendChild(open);

  const sz = document.createElement('span');
  sz.className = 'sz';
  sz.textContent = fmtSize(a.size);
  chip.appendChild(sz);

  const dl = document.createElement('a');
  dl.className = 'att-dl';
  dl.href = attachmentDownloadUrl(a);
  dl.setAttribute('download', a.filename || '');
  dl.title = '下载';
  dl.textContent = '下载';
  chip.appendChild(dl);

  return chip;
}

/** Preview request sequence number: after closing / switching attachments, old async text callbacks must not write into the overlay. */
let attPreviewSeq = 0;

/** Close the preview overlay. Returns "whether it actually closed this time", for the Esc handler to decide whether to keep propagating. */
function closeAttachmentPreview() {
  const box = $('#att-preview');
  if (!box || box.classList.contains('hidden')) return false;
  box.classList.add('hidden');
  const body = $('#att-preview-body');
  // Clear the content: `<video>` / `<audio>` only stop loading further once removed from the document
  if (body) body.innerHTML = '';
  attPreviewSeq++;
  return true;
}

function openAttachmentPreview(a) {
  const kind = attachmentKind(a);
  if (kind === 'none') {
    showToast('该格式不支持在线预览，请点「下载」保存后打开', true);
    return;
  }
  const box = $('#att-preview');
  const body = $('#att-preview-body');
  if (!box || !body) return;
  const seq = ++attPreviewSeq;

  const name = $('#att-preview-name');
  if (name) name.textContent = a.filename || '';
  const dl = $('#att-preview-dl');
  if (dl) dl.href = attachmentDownloadUrl(a);

  const url = attachmentUrl(a);
  body.innerHTML = '';
  let node;
  if (kind === 'image') {
    node = document.createElement('img');
    node.src = url;
    node.alt = a.filename || '';
  } else if (kind === 'pdf') {
    // Hand PDFs to the browser's built-in viewer: embedded via iframe, without leaving the current page
    node = document.createElement('iframe');
    node.src = url;
    node.title = a.filename || 'PDF 预览';
  } else if (kind === 'video') {
    node = document.createElement('video');
    node.src = url;
    node.controls = true;
  } else if (kind === 'audio') {
    node = document.createElement('audio');
    node.src = url;
    node.controls = true;
  } else {
    // Text types are fetched and rendered ourselves: an iframe would make the browser load it as a standalone page, leaving style and interaction uncontrolled
    node = document.createElement('pre');
    node.className = 'att-preview-text';
    node.textContent = '加载中…';
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((txt) => {
        if (seq === attPreviewSeq) node.textContent = txt;
      })
      .catch(() => {
        if (seq === attPreviewSeq) node.textContent = '（内容加载失败，请用「下载」按钮保存后打开）';
      });
  }
  body.appendChild(node);
  box.classList.remove('hidden');
}

function setupAttachmentPreview() {
  const box = $('#att-preview');
  if (!box) return;
  const close = $('#att-preview-close');
  if (close) close.addEventListener('click', closeAttachmentPreview);
  // Click the overlay blank area (not the content box) to close
  box.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAttachmentPreview();
  });
  // Esc closes the preview. **Must be bound in the capture phase** with stopPropagation:
  // the global Esc handler (close drawer / confirm box / close composer) lives in setupEvents, and those two vm suites
  // extract that whole middle section of setupEvents and run it standalone — calling a function from this module there
  // would throw ReferenceError and crash the suite. Binding in the capture phase has another benefit: the preview is the outermost overlay, so Esc naturally takes priority,
  // and once the preview closes the event no longer propagates down, so it won't also close the drawer.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (closeAttachmentPreview()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

/* ---------------- HTML sanitization ---------------- */

const SAFE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CENTER', 'CODE', 'DD', 'DEL', 'DIV', 'DL', 'DT',
  'EM', 'FONT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'INS', 'LI', 'OL',
  'P', 'PRE', 'Q', 'S', 'SECTION', 'SMALL', 'SPAN', 'STRONG', 'STRIKE', 'SUB', 'SUP',
  'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'TT', 'U', 'UL',
]);
const ATTR_ALLOW = {
  A: new Set(['href', 'title']),
  IMG: new Set(['src', 'width', 'height', 'alt']),
  TABLE: new Set(['border', 'cellpadding', 'cellspacing', 'width', 'align', 'bgcolor']),
  TD: new Set(['colspan', 'rowspan', 'width', 'align', 'valign', 'bgcolor']),
  TH: new Set(['colspan', 'rowspan', 'width', 'align', 'valign', 'bgcolor']),
  TR: new Set(['align', 'valign', 'bgcolor']),
  FONT: new Set(['color', 'size', 'face']),
  BLOCKQUOTE: new Set(['type']),
  P: new Set(['align']),
  DIV: new Set(['align']),
};

function sanitizeHtml(html, cidMap) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.body
    .querySelectorAll('script,style,iframe,frame,object,embed,meta,link,base,form,input,button,select,textarea,svg,math,video,audio,source,track,template,noscript')
    .forEach((el) => el.remove());

  const all = Array.from(doc.body.querySelectorAll('*'));
  for (const el of all.reverse()) {
    const tag = el.tagName.toUpperCase();
    if (!SAFE_TAGS.has(tag)) {
      unwrap(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const allow = ATTR_ALLOW[tag] || new Set();
      if (!allow.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      const value = attr.value;
      if (name === 'href') {
        if (!/^(https?:|mailto:)/i.test(value)) {
          el.removeAttribute('href');
          continue;
        }
        el.setAttribute('href', value);
      }
      if (name === 'src') {
        const trimmed = value.trim();
        const m = /^cid:(.*)$/i.exec(trimmed);
        if (m) {
          const key = m[1].replace(/[<>]/g, '').trim().toLowerCase();
          const url = cidMap[key];
          if (url) el.setAttribute('src', url);
          else el.remove();
        } else if (!/^(https?:|data:image\/)/i.test(trimmed)) {
          el.removeAttribute('src');
        } else {
          el.setAttribute('src', trimmed);
        }
      }
    }
  }
  return doc.body.innerHTML;
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/* ---------------- Compose / reply / attachments / rich text ---------------- */

function plainToHtmlText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => esc(l))
    .join('<br>');
}

function isRich() {
  return state.composing && state.composing.rich === true;
}

/**
 * Parse recipient input: comma / semicolon (including full-width Chinese) / whitespace are all separators,
 * each segment is trimmed then dropped if empty, then deduped case-insensitively (keeping the first spelling).
 * Same convention as the string branch of the backend parseRecipient(), to avoid front/back-end parsing drift.
 */
function parseRecipients(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw == null ? '' : raw).split(/[,;，；\s]+/)) {
    const addr = part.trim();
    const key = addr.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/** Update the "merge send" hint: when checked and recipients > 1, show how many separate emails will be sent; otherwise clear it. */
function updateMergeHint() {
  const n = parseRecipients($('#f-to').value).length;
  $('#merge-hint').textContent = $('#f-merge').checked && n > 1 ? `将分别单独发送给 ${n} 位收件人` : '';
}

/* ---------------- Recipient autocomplete (local contacts) ---------------- */

const RECIPIENT_FIELDS = ['#f-to', '#f-cc', '#f-bcc'];
const SUGGEST_MAX = 8;

/** Current autocomplete state; field being null means the dropdown is not open. */
let addrSuggest = { field: null, items: [], index: -1, query: '', start: 0, end: 0 };

/** Lazily load local contacts; failure only disables autocomplete and must not affect sending, so degrade silently. */
async function loadContacts(force = false) {
  if (state.contactsLoaded && !force) return;
  try {
    const data = await api('/api/contacts');
    state.contacts = data && Array.isArray(data.contacts) ? data.contacts : [];
    state.contactsLoaded = true;
  } catch {
    state.contacts = [];
  }
}

/**
 * Get the address segment at the cursor (comma / semicolon / whitespace as separators).
 * Returns start/end for replacement — after selection only this segment is replaced, the other recipients in the field stay untouched.
 */
function recipientToken(input) {
  const v = String(input.value || '');
  const caret = typeof input.selectionStart === 'number' ? input.selectionStart : v.length;
  const before = v.slice(0, caret);
  let start = 0;
  for (const d of [',', ';', '，', '；', ' ', '\t', '\n']) {
    const i = before.lastIndexOf(d);
    if (i + 1 > start) start = i + 1;
  }
  return { start, end: caret, text: before.slice(start) };
}

/**
 * Autocomplete ranking: name prefix > name contains > email prefix > email contains, ties broken by interaction count descending.
 * When typing lili, people whose name contains lili rank ahead of those whose email merely happens to contain lili.
 */
function contactScore(c, q) {
  const name = String(c.name || '').toLowerCase();
  const email = String(c.email || '').toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (email.startsWith(q)) return 2;
  if (email.includes(q)) return 3;
  return -1;
}

function matchContacts(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  // `|| []`: autocomplete runs on every keystroke, so the input must never throw (contacts not fully loaded is a valid state too)
  for (const c of state.contacts || []) {
    const score = contactScore(c, q);
    if (score < 0) continue;
    hits.push({ c, score });
  }
  hits.sort((a, b) => a.score - b.score || (b.c.count || 0) - (a.c.count || 0) || (a.c.email < b.c.email ? -1 : 1));
  return hits.slice(0, SUGGEST_MAX).map((h) => h.c);
}

/** Escape first, then wrap the matched segment in <mark> (inserting tags before escaping would escape them too). */
function highlightMatch(text, query) {
  const t = String(text == null ? '' : text);
  const q = String(query || '');
  const i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(t);
  return `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`;
}

/**
 * Geometry of the autocomplete dropdown: **width does not follow the input**.
 *
 * On mobile the input is only a bit over a hundred pixels wide (the recipient row also shares width with other controls), and following it would truncate
 * an email like `erin@example.com` out of view. Instead it spans the **content width** of the composer modal
 * (left edge aligned with the content's left edge, right edge aligned with the content's right edge), making one line wide enough for a full email.
 *
 * Extracted as a pure function (only takes numbers, reads no DOM): jsdom has no real layout and clientWidth is always 0,
 * so asserting positionSuggest directly only proves "0px was set" and not the real width strategy.
 */
function suggestBoxGeom({ hostWidth, padLeft, padRight, anchorTop, anchorHeight }) {
  const width = Math.max(0, hostWidth - padLeft - padRight);
  return { left: padLeft, top: anchorTop + anchorHeight + 4, width };
}

function positionSuggest(anchor) {
  const box = $('#addr-suggest');
  const host = $('#composer');
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
  const padLeft = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
  const padRight = cs ? parseFloat(cs.paddingRight) || 0 : 0;
  const g = suggestBoxGeom({
    hostWidth: host.clientWidth || 0,
    padLeft,
    padRight,
    anchorTop: anchor.offsetTop || 0,
    anchorHeight: anchor.offsetHeight || 0,
  });
  box.style.left = `${g.left}px`;
  box.style.top = `${g.top}px`;
  box.style.width = `${g.width}px`;
}

function hideSuggest() {
  addrSuggest = { field: null, items: [], index: -1, query: '', start: 0, end: 0 };
  const box = $('#addr-suggest');
  box.classList.add('hidden');
  box.innerHTML = '';
}

function paintSuggest() {
  const box = $('#addr-suggest');
  if (!addrSuggest.field || !addrSuggest.items.length) {
    hideSuggest();
    return;
  }
  box.innerHTML = '';
  addrSuggest.items.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'addr-suggest-item' + (i === addrSuggest.index ? ' active' : '');
    row.setAttribute('role', 'option');
    const nm = document.createElement('span');
    nm.className = 'nm';
    // When there is no name, use the email as the primary label so every row has a readable main field
    nm.innerHTML = highlightMatch(c.name || c.email, addrSuggest.query);
    row.appendChild(nm);
    if (c.name) {
      const em = document.createElement('span');
      em.className = 'em';
      em.innerHTML = highlightMatch(c.email, addrSuggest.query);
      row.appendChild(em);
    }
    // mousedown + preventDefault: clicking a dropdown item must not steal input focus (otherwise blur would close the dropdown first)
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySuggest(i);
    });
    box.appendChild(row);
  });
  box.classList.remove('hidden');
  positionSuggest(addrSuggest.field);
}

/** Replace the segment at the cursor with the contact's plain email (other recipients preserved as-is). */
function applySuggest(i) {
  const input = addrSuggest.field;
  const item = addrSuggest.items[i];
  if (!input || !item) return;
  const v = String(input.value || '');
  const { start, end } = addrSuggest;
  // When selecting at the end, append a separator to make it easy to type the next recipient
  const insert = end >= v.length ? `${item.email}, ` : item.email;
  input.value = v.slice(0, start) + insert + v.slice(end);
  const caret = start + insert.length;
  hideSuggest();
  input.focus();
  try {
    input.setSelectionRange(caret, caret);
  } catch {
    /* ignored by old browsers */
  }
  // Do not dispatch a synthetic input event (that would immediately re-trigger autocomplete on the just-inserted email); run the chained updates manually
  updateMergeHint();
}

function moveSuggest(step) {
  const n = addrSuggest.items.length;
  if (!n) return;
  addrSuggest.index = (addrSuggest.index + step + n) % n;
  paintSuggest();
}

/** Input changed: recompute the segment at the cursor and show/update/hide the dropdown as needed. */
function refreshSuggest(input) {
  const { start, end, text } = recipientToken(input);
  const items = matchContacts(text);
  if (!items.length) {
    hideSuggest();
    return;
  }
  addrSuggest = { field: input, items, index: 0, query: text.trim(), start, end };
  paintSuggest();
}

/** Keyboard navigation for recipient fields; when the dropdown is closed, always pass through (doesn't interfere with normal typing or swallow Esc for closing the modal). */
function onRecipientKeydown(e) {
  if (!addrSuggest.field || addrSuggest.field !== e.target || !addrSuggest.items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSuggest(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSuggest(-1);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    applySuggest(addrSuggest.index);
  } else if (e.key === 'Escape') {
    // Only hide the dropdown; must not also close the whole composer modal
    e.preventDefault();
    e.stopPropagation();
    hideSuggest();
  }
}

/** Wire up autocomplete on the three recipient fields: input / keyboard navigation / hide on blur / lazy-load contacts on focus. */
function bindRecipientSuggest() {
  for (const sel of RECIPIENT_FIELDS) {
    const input = $(sel);
    input.addEventListener('input', () => refreshSuggest(input));
    input.addEventListener('keydown', onRecipientKeydown);
    input.addEventListener('focus', () => void loadContacts());
    input.addEventListener('blur', () => {
      // Delayed hide: give the dropdown item's mousedown a head start (in the normal click path no blur actually occurs)
      setTimeout(() => {
        if (addrSuggest.field === input) hideSuggest();
      }, 120);
    });
  }
}

/* ---------------- CC / BCC expansion ---------------- */

// Use explicit ids instead of querySelectorAll('.cc-field'): the zero-dependency DOM stub (test/compose-guard.test.js)
// only implements querySelector, not querySelectorAll, so class selectors would make that suite throw.
const CC_ROWS = ['#f-cc-row', '#f-bcc-row'];

function recipientsExpanded() {
  return !$('#f-cc-row').classList.contains('hidden');
}

function setRecipientsExpanded(show) {
  for (const sel of CC_ROWS) $(sel).classList.toggle('hidden', !show);
  $('#f-cc-toggle').textContent = show ? '－ 收起抄送 / 密送' : '＋ 抄送 / 密送';
}

/**
 * Toggle the CC/BCC rows. **Collapsing is not allowed when there is already content** — the collapsed fields still participate in sending,
 * so sending content the user can't see is one of the easiest ways to cause an accidental CC.
 */
function toggleRecipientsExpanded() {
  if (!recipientsExpanded()) {
    setRecipientsExpanded(true);
    return;
  }
  const filled = parseRecipients($('#f-cc').value).length + parseRecipients($('#f-bcc').value).length;
  if (filled) {
    showToast('抄送 / 密送里已有内容，清空后才能收起', true);
    return;
  }
  setRecipientsExpanded(false);
}

/** Reset "merge send" when opening the modal: uncheck and clear the hint. The checkbox isn't user input and doesn't go into the baseline. */
function resetMergePick() {
  $('#f-merge').checked = false;
  updateMergeHint();
}

/** Merge send is only available in compose mode: in reply mode the recipients are derived by the backend from the original email, so showing this control would mislead the user. */
function setMergeRowVisible(visible) {
  $('.merge-row').classList.toggle('hidden', !visible);
}

/* ---------------- Sender (own row, collapsed by default) ---------------- */

/**
 * The collapsed sender state shows only a one-line summary ("Sender xxx@yyy ▾"), and only expands the dropdown when clicked.
 *
 * Key difference from CC / BCC: collapsing **does not lose content** — the current sender is always written in the summary row,
 * and the selected value stays on the select (read as usual when sending). So there's no "can't collapse when it has content"
 * restriction here; collapsing is purely to save space.
 */
function senderExpanded() {
  return !$('#f-mailbox-row').classList.contains('hidden');
}

function setSenderExpanded(show) {
  $('#f-mailbox-row').classList.toggle('hidden', !show);
  const caret = $('#f-sender-caret');
  if (caret) caret.textContent = show ? '▴' : '▾';
  $('#f-sender-toggle').setAttribute('aria-expanded', show ? 'true' : 'false');
}

/** The summary row always reflects the select's current value; when there's only one option, hide the arrow (expanding shows nothing). */
function renderSenderSummary() {
  const list = composerMailboxOptions();
  const row = $('#f-sender-row');
  if (!list.length) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  const solo = list.length < 2;
  row.classList.toggle('sender-solo', solo);
  // With a single address the dropdown row never opens, so the "＋ 自定义" entry has to be visible here instead —
  // otherwise a fresh mailbox offers no way to send from any other address (user-reported).
  const customBtn = $('#f-sender-custom');
  if (customBtn) customBtn.classList.toggle('hidden', !solo);
  $('#f-sender-current').textContent = $('#f-mailbox').value;
}

function toggleSenderExpanded() {
  // With only one sender address there are no options, so expanding does nothing
  if ($('#f-sender-row').classList.contains('sender-solo')) return;
  setSenderExpanded(!senderExpanded());
}

function composerMailboxOptions() {
  // "(unrecognized)" is a display grouping used for aggregation, not a sendable address, so it must not appear in the sender picker.
  const list = state.mailboxList.map((m) => m.mailbox).filter((m) => m && m !== UNKNOWN_MAILBOX);
  const custom = Array.isArray(state.customSenders) ? state.customSenders : [];
  for (const c of custom) if (c && !list.includes(c)) list.push(c);
  // Configured default senders (GET /api/account.senders). A freshly added domain has no message history yet, so without
  // these the list would be empty and the sender row (with the "custom sender" entry) would be hidden entirely,
  // leaving no way to pick a sender — i.e. no way to send at all.
  const senders = Array.isArray(state.senders) ? state.senders : [];
  for (const s of senders) if (s && !list.includes(s)) list.push(s);
  if (state.fromAddress && !list.includes(state.fromAddress.toLowerCase())) list.unshift(state.fromAddress.toLowerCase());
  const def = state.composing && state.composing.mailbox ? state.composing.mailbox : '';
  if (def && !list.includes(def)) list.unshift(def);
  // When one or more domains are ticked, only offer senders on those domains (multi-select aware).
  const sel = Array.isArray(state.domainSel) ? state.domainSel : [];
  const scoped = sel.length ? list.filter((a) => sel.includes(addrDomain(a))) : list;
  if (scoped.length) return scoped;
  // Last resort: a domain is configured but it has neither history nor a stored default sender → offer the canonical
  // default address of that domain (the setup wizard writes noreply@<domain>), instead of leaving the composer unusable.
  const fallbackDomain = sel[0] || (Array.isArray(state.domains) ? state.domains[0] : '');
  return fallbackDomain ? [`noreply@${fallbackDomain}`] : [];
}

/**
 * Add a custom sender on one of the configured domains. Session-only: it does not persist until the first send,
 * after which the address naturally shows up in /api/mailboxes (it is now a real "mailbox").
 */
function addCustomSender() {
  if (!state.composing) return;
  const domains = Array.isArray(state.domains) ? state.domains : [];
  const preferred = (Array.isArray(state.domainSel) ? state.domainSel[0] : '') || domains[0] || '';
  const input = prompt(
    preferred ? `自定义发件人地址（需为 ${preferred} 下的地址）` : '自定义发件人地址',
    preferred ? `noreply@${preferred}` : ''
  );
  if (input === null) return;
  const addr = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(addr)) { alert('地址格式不正确'); return; }
  const d = addrDomain(addr);
  if (domains.length && !domains.includes(d)) { alert(`发件地址的域名必须是：${domains.join(' / ')}`); return; }
  if (!state.customSenders.includes(addr)) state.customSenders.push(addr);
  state.composing.mailbox = addr;
  renderMailboxPicker();
  setSenderExpanded(true);
  renderSenderSummary();
}

function renderMailboxPicker() {
  const list = composerMailboxOptions();
  const sel = $('#f-mailbox');
  if (!list.length) {
    $('#f-mailbox-row').classList.add('hidden');
    $('#f-sender-row').classList.add('hidden');
    return;
  }
  const cur = state.composing ? state.composing.mailbox : (state.mailbox || state.fromAddress || list[0]);
  sel.innerHTML = '';
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  sel.value = list.includes(cur) ? cur : list[0];
  if (state.composing) state.composing.mailbox = sel.value;
  // Reset to collapsed every time the modal opens: one row by default, expand only when changing the sender
  setSenderExpanded(false);
  renderSenderSummary();
}

function resetComposerEditor() {
  const ed = $('#f-body-rich');
  const ta = $('#f-body');
  if (isRich()) {
    ta.classList.add('hidden');
    ed.classList.remove('hidden');
    $('#rich-toolbar').classList.remove('hidden');
  } else {
    ta.classList.remove('hidden');
    ed.classList.add('hidden');
    $('#rich-toolbar').classList.add('hidden');
  }
}

/**
 * Common tail for opening the composer modal. The three entry points (compose / reply / forward) differ only in "what to prefill, which controls to show",
 * while the rest (clearing, rendering the sender, recording the baseline, showing the modal) must be identical — writing them separately would eventually drift into
 * weird mode-specific bugs like "autocomplete works in reply but not forward".
 */
function openComposerShell(opts) {
  const {
    mode, title, to = '', cc = '', bcc = '', subject = '', body = '',
    original = null, originalId = null, mailbox, showMerge, showQuote, focus,
    draftId = null, bodyHtml = '', rich = false,
  } = opts;

  // The draft id is fixed here (new or restored draft): autosave uses upsert, so there's no need to "create first then get the id".
  state.composing = {
    mode,
    originalId,
    files: [],
    rich: rich === true,
    original,
    mailbox,
    draftId: draftId || newDraftId(),
  };
  draftEverSaved = Boolean(draftId); // restored from drafts, so the server already has this record

  $('#composer-title').textContent = title;
  $('#f-to').value = to;
  $('#f-cc').value = cc;
  $('#f-bcc').value = bcc;
  $('#f-subject').value = subject;
  $('#f-body').value = body;
  $('#f-body-rich').innerHTML = bodyHtml;
  $('#f-attach-list').innerHTML = '';
  setRecipientsExpanded(Boolean(cc || bcc));
  $('#f-quote').classList.toggle('hidden', !showQuote);
  $('#f-forward-note').textContent = opts.forwardNote || '';
  hideSuggest();
  renderAttachChips();
  renderMailboxPicker();
  resetComposerEditor();
  hideDiscardConfirm(false);
  resetMergePick();
  setMergeRowVisible(!!showMerge);
  composerLastFocus = null;
  // Record the baseline: prefilled recipients / subject / quoted body don't count as user input
  composerBaseline = {
    to: $('#f-to').value,
    cc: $('#f-cc').value,
    bcc: $('#f-bcc').value,
    subject: $('#f-subject').value,
    body: $('#f-body').value,
    richText: richPlainText($('#f-body-rich')),
    mailbox: $('#f-mailbox').value,
  };
  $('#modal-mask').classList.remove('hidden');
  // Remember the last floating geometry within the session; on mobile / with no geometry this clears the inline values and falls back to CSS layout
  applyComposerGeom();
  closeDrawer(); // Mobile: the composer modal is full-screen, so the drawer must be closed first
  void loadContacts(); // Lazy-load autocomplete data; failure doesn't affect sending
  $(focus).focus();
}

function openComposer() {
  if (!state.canSend) {
    showToast('服务端未配置发送能力（缺少 RESEND_API_KEY / SEND_FROM_ADDRESS）', true);
    return;
  }
  openComposerShell({
    mode: 'compose',
    title: '写信',
    mailbox: state.mailbox || undefined,
    showMerge: true, // Compose mode: show merge send
    showQuote: false,
    focus: '#f-to',
  });
}

function openReplyComposer(inboundCopyId) {
  if (!state.canSend) {
    showToast('服务端未配置发送能力', true);
    return;
  }
  const m = currentMessage;
  if (!m) return;
  // The reply endpoint only accepts inbound mail. For a self-sent message the thread keeps the outbound copy and the
  // received one lives in `copy_ids`, so reply against that copy (same physical mail, correct mailbox/thread).
  const original = inboundCopyId ? Object.assign({}, m, { id: inboundCopyId, direction: 'inbound' }) : m;
  const to = original.reply_to && original.reply_to.length ? original.reply_to[0] : original.from_email;
  openComposerShell({
    mode: 'reply',
    title: '回复',
    original,
    originalId: original.id,
    to: to || '',
    subject: /^\s*re:/i.test(original.subject || '') ? original.subject : `Re: ${original.subject || ''}`,
    mailbox: original.mailbox || undefined,
    showMerge: false, // Reply mode: merge send is meaningless, hide the control to avoid misleading
    showQuote: true,
    focus: '#f-body',
  });
}

/**
 * Forward: emails of **any direction** can be forwarded to any recipient.
 * Unlike reply, the recipients are **not prefilled** (forwarding is inherently to new people), and the body is prefilled with the original quote block.
 */
function openForwardComposer() {
  if (!state.canSend) {
    showToast('服务端未配置发送能力', true);
    return;
  }
  const m = currentMessage;
  if (!m) return;
  const n = forwardAttachmentCount();
  openComposerShell({
    mode: 'forward',
    title: '转发',
    original: m,
    originalId: m.id,
    subject: /^\s*fwd?\s*:/i.test(m.subject || '') ? m.subject : `Fwd: ${m.subject || ''}`,
    body: forwardQuoteText(m),
    mailbox: m.mailbox || undefined,
    showMerge: false,
    showQuote: false, // The body already includes the original quote, so the "quote original" button is no longer needed
    focus: '#f-to',
    forwardNote: n ? `将附带原邮件的 ${n} 个附件` : '',
  });
}

/** Number of original attachments a forward will carry (inline images excluded — the server skips them too). */
function forwardAttachmentCount() {
  return currentAttachments.filter((a) => !a.inline).length;
}

/** The original quote block in the forward body (with the forward header, plain text). */
function forwardQuoteText(m) {
  const from = m.from_name ? `${m.from_name} <${m.from_email || ''}>` : (m.from_email || '—');
  const head = [
    '---------- 转发的邮件 ----------',
    `发件人: ${from}`,
    `收件人: ${jsonArr(m.to_emails).join(', ') || '—'}`,
    `主题: ${m.subject || '(无主题)'}`,
    `时间: ${timeLong(m.received_at)}`,
    '',
  ].join('\n');
  const body = (m.body_text || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `${head}\n${body || '(无内容)'}\n`;
}

/* ---------------- Draft: autosave ----------------
 * Requirement: a half-written email automatically goes into drafts, and closing the modal no longer prompts "discard?".
 *
 * The draft id is generated **when the modal opens** (`newDraftId()`), and saving uses PUT upsert —
 * so autosave doesn't need a "create to get the id" round trip, and a first save failure won't lose later ones.
 *
 * Single source of truth: `state.composing.draftId`. All saves/deletes go through the one exit `flushDraft()`.
 * ⚠️ Attachments are not persisted with the draft (see delivery notes): the in-memory base64 is too large and would blow the D1 single-row limit.
 *    Attachments need to be re-added when restoring a draft, and the modal shows a hint about this.
 */

const DRAFT_SAVE_DEBOUNCE_MS = 1200;

let draftSaveTimer = null;
/**
 * Whether the current draft has **ever been written to the server**.
 * Determines whether closing an empty form should send DELETE — a brand-new modal that was never saved sends no request at all,
 * avoiding a pointless server round trip every time a modal is opened and closed.
 */
let draftEverSaved = false;

/** New draft id. Prefer crypto.randomUUID (secure context), otherwise fall back to timestamp + random string. */
function newDraftId() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* Non-secure context (file:// etc.): use the fallback below */
  }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clearDraftTimer() {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
}

/** Current form → autosave request body. The body is taken from the currently visible editor (same as the send convention). */
function draftPayload() {
  const c = state.composing;
  if (!c) return null;
  const rich = isRich();
  const html = rich ? $('#f-body-rich').innerHTML : '';
  const text = rich ? richPlainText($('#f-body-rich')) : $('#f-body').value;
  return {
    mode: c.mode,
    source_id: c.originalId || null,
    mailbox: $('#f-mailbox').value || '',
    to: $('#f-to').value,
    cc: $('#f-cc').value,
    bcc: $('#f-bcc').value,
    subject: $('#f-subject').value,
    body: text,
    html,
    rich,
  };
}

/**
 * Whether it's worth saving as a draft — the **sole criterion** for "should this go to the DB".
 *
 * It shares the same kernel `contentDiffersFromBaseline()` with `isComposerDirty()`,
 * differing only in the "sender dropdown" item:
 *  - Recipients and subject **prefilled** by reply/forward modals don't count as "half-written" —
 *    otherwise opening a reply and closing it would clutter the drafts with replies the user never wrote;
 *  - Typing only spaces doesn't count; changing only the sender doesn't either (the dropdown position isn't email content, nothing to save);
 *  - Adding attachments counts — although attachments aren't persisted (size exceeds the D1 single-row limit), the user did take action
 *    and needs to know where things went (see the hint in closeComposerWithDraft).
 */
function hasDraftContent() {
  const c = state.composing;
  if (!c) return false;
  if (c.files.length > 0) return true;
  // Without a baseline, fall back to "any non-empty counts" (openComposerShell normally always builds one; this is a safety net)
  if (!composerBaseline) return isComposerDirty();
  return contentDiffersFromBaseline();
}

/** Invalidate the drafts cache and counts after a draft change (needed even when not currently in drafts, or switching there would show a stale list). */
function invalidateDraftCaches() {
  // Defensive: in the vm suite's sandbox state.cache has no folders (only countsAt is stubbed),
  // so a bare access would make the async save path throw an unhandledRejection and crash the whole suite.
  const folders = state.cache && state.cache.folders;
  if (folders && typeof folders.keys === 'function') {
    for (const k of Array.from(folders.keys())) {
      if (k.includes('|drafts|')) folders.delete(k);
    }
  }
  state.cache.countsAt = 0;
  void refreshCounts();
}

/**
 * Persist a draft snapshot: has content → PUT upsert; no content → DELETE (to avoid empty entries in drafts).
 *
 * Two failure strategies (silent failures are the most dangerous bug class in this project, so they can't be swallowed uniformly):
 *  - Autosave (debounced) failure is **silent** — it shouldn't interrupt composing, and the next input will retry;
 *  - A save triggered by manually closing the modal **must speak up** (`surfaceErrors`) — at that point the modal is already closed,
 *    and without a prompt the user's content would truly vanish without a sound.
 */
async function saveDraftSnapshot(id, payload, hasContent, opts) {
  if (!id) return false;
  // Never saved + no content now → nothing to do (opening/closing an empty modal shouldn't produce any request)
  if (!hasContent && !draftEverSaved) return true;
  try {
    if (!hasContent) {
      await api(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      draftEverSaved = false;
    } else {
      await api(`/api/drafts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      draftEverSaved = true;
    }
    invalidateDraftCaches();
    return true;
  } catch (e) {
    if (opts && opts.surfaceErrors) {
      showToast(`草稿保存失败：${e && e.message ? e.message : e}`, true);
    }
    return false;
  }
}

/** Save when the debounce fires: take a fresh snapshot from the current form. */
function flushDraft() {
  clearDraftTimer();
  const c = state.composing;
  if (!c || !c.draftId) return Promise.resolve();
  return saveDraftSnapshot(c.draftId, draftPayload(), hasDraftContent());
}

/** Debounced save on input. */
function scheduleDraftSave() {
  if (!state.composing) return;
  clearDraftTimer();
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    void flushDraft();
  }, DRAFT_SAVE_DEBOUNCE_MS);
}

/**
 * Open the composer modal from drafts to continue editing.
 * First fetch the full draft (the list endpoint only carries a summary); for reply/forward drafts the original email is also fetched —
 * the "quote original" button and forwarded attachments both depend on `original`.
 */
async function openDraftComposer(id) {
  if (!state.canSend) {
    showToast('服务端未配置发送能力（缺少 RESEND_API_KEY / SEND_FROM_ADDRESS）', true);
    return;
  }
  let d;
  try {
    d = (await api(`/api/drafts/${encodeURIComponent(id)}`)).draft;
  } catch (e) {
    showToast(e.message, true);
    return;
  }
  if (!d) return;

  let original = null;
  if (d.source_id && d.mode !== 'new') {
    try {
      original = (await api(`/api/messages/${encodeURIComponent(d.source_id)}`)).message;
    } catch {
      /* The original email may have been deleted: degrade to a plain compose, draft content is not lost */
    }
  }

  const isReply = d.mode === 'reply';
  const isForward = d.mode === 'forward';
  openComposerShell({
    mode: isReply ? 'reply' : isForward ? 'forward' : 'compose',
    title: isReply ? '回复' : isForward ? '转发' : '写信',
    to: (d.to || []).join(', '),
    cc: (d.cc || []).join(', '),
    bcc: (d.bcc || []).join(', '),
    subject: d.subject || '',
    body: d.body_text || '',
    bodyHtml: d.body_html || '',
    rich: d.rich === true,
    original,
    originalId: d.source_id || null,
    mailbox: d.mailbox || undefined,
    showMerge: !isReply && !isForward,
    showQuote: isReply,
    focus: '#f-to',
    draftId: d.id,
  });
  if (isForward && original) {
    const n = forwardAttachmentCount();
    if (n) $('#f-forward-note').textContent = `将附带原邮件的 ${n} 个附件`;
  }
  showToast('已打开草稿');
}

/* Guard for closing the composer modal (semantics changed from "discard confirmation" to "autosave draft", see requestCloseComposer) */

let discardConfirmPending = false; // whether the confirm box is already shown (re-entrancy guard)
let composerLastFocus = null; // element to return focus to after the confirm box is dismissed
let composerBaseline = null; // form snapshot when the modal was opened, used to detect "actual user input"
let sendInFlight = false; // whether a send is in progress; discarding is forbidden while sending

/** Normalize text input: null/undefined treated as an empty string, and leading/trailing whitespace trimmed. */
function norm(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * Plain-text content of the rich text editor (ignoring tags, <br>, empty divs and &nbsp;).
 * Uses textContent rather than innerText for three reasons:
 * 1) It doesn't depend on rendering, so the guard and the send validation reach the same conclusion on the same content;
 * 2) Test environments like jsdom have no innerText, so only textContent can be genuinely covered by automation;
 * 3) It avoids CSS pseudo-element placeholders (.rich-editor:empty::before) polluting the rendered text.
 */
function richPlainText(el) {
  return String(el.textContent || '').replace(/\u00a0/g, ' ').trim();
}

/**
 * "Has the content really changed relative to the snapshot taken when the modal opened" — **excluding the sender dropdown**.
 *
 * This is the **shared kernel** of `isComposerDirty()` and `hasDraftContent()`:
 * writing the two conventions separately would cause drift (marked dirty but not saved, or not written yet an empty draft saved).
 * Typing only spaces doesn't count as input (norm trims leading/trailing whitespace); the body only counts the currently visible editor,
 * avoiding residue in the hidden editor causing a "false dirty".
 */
function contentDiffersFromBaseline() {
  const b = composerBaseline;
  if (!b) return false;
  if (norm($('#f-to').value) !== norm(b.to)) return true;
  if (norm($('#f-cc').value) !== norm(b.cc)) return true;
  if (norm($('#f-bcc').value) !== norm(b.bcc)) return true;
  if (norm($('#f-subject').value) !== norm(b.subject)) return true;
  if (isRich()) return richPlainText($('#f-body-rich')) !== b.richText;
  return norm($('#f-body').value) !== norm(b.body);
}

/**
 * Whether the user has entered any information (compared against the snapshot taken when the modal opened).
 * If the recipients / subject / sender / currently visible body editor differ from the baseline, or attachments were added,
 * it's considered "dirty". Recipients and subject prefilled by the reply modal are system behavior and don't count as user input.
 * Typing only spaces doesn't count as input; toggling rich text mode itself doesn't count as dirty.
 * It counts one extra item, the "sender dropdown", compared to `hasDraftContent()` — changing the sending identity is a user action,
 * but changing only the sender has no content to persist, so that item doesn't participate in "should a draft be saved".
 */
function isComposerDirty() {
  const c = state.composing;
  if (!c) return false;
  if (c.files.length > 0) return true;
  const b = composerBaseline;
  if (!b) {
    // Safety net: without a baseline, fall back to "any non-empty is dirty"
    if (norm($('#f-to').value) !== '') return true;
    if (norm($('#f-cc').value) !== '') return true;
    if (norm($('#f-bcc').value) !== '') return true;
    if (norm($('#f-subject').value) !== '') return true;
    if (isRich()) return richPlainText($('#f-body-rich')) !== '';
    return norm($('#f-body').value) !== '';
  }
  if (norm($('#f-mailbox').value) !== norm(b.mailbox)) return true;
  return contentDiffersFromBaseline();
}

function showDiscardConfirm() {
  if (discardConfirmPending) return; // already shown; do not show again
  discardConfirmPending = true;
  $('#confirm-text').textContent = '这封邮件还没有发送，确定要放弃吗？已填写的内容将被丢弃。';
  $('#confirm-mask').classList.remove('hidden');
  $('#confirm-ok').focus();
}

/** Hide the confirm dialog (without closing the composer) and restore focus to the user's previous edit position. */
function hideDiscardConfirm(restoreFocus = true) {
  if (!discardConfirmPending && $('#confirm-mask').classList.contains('hidden')) return;
  discardConfirmPending = false;
  $('#confirm-mask').classList.add('hidden');
  if (!restoreFocus) return;
  const el = composerLastFocus;
  if (el && document.body.contains(el) && !el.classList.contains('hidden')) {
    try {
      el.focus();
    } catch {
      /* element can no longer be focused; ignore */
    }
  }
}

/**
 * Request closing the composer: **save the draft then close directly, no more "discard?" prompt**.
 *
 * The mask blank-area click, the cancel button, and Esc all go through here. Since half-written
 * content automatically lands in the drafts folder, "closing the window" is no longer a destructive
 * operation, so there is nothing left for the user to confirm. The only case still blocked is
 * "sending" — closing then would make the user think it wasn't sent.
 */
function requestCloseComposer() {
  if (!state.composing) return;
  if (sendInFlight) {
    showToast('邮件正在发送中，请稍候…');
    return;
  }
  void closeComposerWithDraft();
}

/** Save draft → close window. When there is content, show a hint so the user knows where it went. */
function closeComposerWithDraft() {
  const c = state.composing;
  if (!c) return;
  // The snapshot must be taken **before** closeComposer(): closing clears state.composing and the form state.
  const id = c.draftId;
  const hasContent = hasDraftContent();
  const payload = draftPayload();
  const inDraftsFolder = state.folder === 'drafts';
  // Close synchronously: a click must take effect immediately, not after a network round trip
  closeComposer();
  if (hasContent) showToast('已存入草稿');
  // If currently in the drafts folder, refresh so the just-saved draft appears immediately
  if (inDraftsFolder) void loadFolder(false, true);
  // Save triggered by manual close: failures must be surfaced (the modal is already closed, so silent = content disappears without a sound)
  void saveDraftSnapshot(id, payload, hasContent, { surfaceErrors: true });
}

function closeComposer() {
  clearDraftTimer(); // no in-flight autosave timer may remain after closing
  hideDiscardConfirm(false);
  hideSuggest();
  endComposerDrag(); // if still dragging when closing, clear the drag state too (otherwise the body class lingers)
  composerLastFocus = null;
  composerBaseline = null;
  state.composing = null;
  $('#modal-mask').classList.add('hidden');
}

/* Attachments */

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = String(fr.result || '');
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

async function onPickFiles(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  const c = state.composing;
  if (!c) return;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showToast(`「${file.name}」超过 40MB 上限，已跳过`, true);
      continue;
    }
    try {
      const content = await readFileAsBase64(file);
      c.files.push({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, content });
    } catch (err) {
      showToast(err.message, true);
    }
  }
  renderAttachChips();
}

function renderAttachChips() {
  const box = $('#f-attach-list');
  box.innerHTML = '';
  const files = (state.composing && state.composing.files) || [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const item = document.createElement('span');
    item.className = 'att-item';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = f.name;
    nm.title = f.name;
    item.appendChild(nm);
    const sz = document.createElement('span');
    sz.textContent = fmtSize(f.size);
    item.appendChild(sz);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = '移除';
    rm.addEventListener('click', () => {
      state.composing.files.splice(i, 1);
      renderAttachChips();
    });
    item.appendChild(rm);
    box.appendChild(item);
  }
}

/* Rich text */

function quoteHtml() {
  const m = state.composing && state.composing.original;
  if (!m) return '';
  const who = m.from_name || m.from_email || '';
  const date = timeLong(m.received_at);
  const text = (m.body_text || '')
    .split('\n')
    .map((l) => `&gt; ${esc(l)}`)
    .join('<br>');
  return `<blockquote>${esc(who)} ${esc(date)} 写道：<br>${text || '(无内容)'}</blockquote><br>`;
}

/** Plain-text quoted block for replies (rich text mode uses quoteHtml; both keep the same content). */
function quoteText() {
  const m = state.composing && state.composing.original;
  const who = (m && (m.from_name || m.from_email)) || '';
  const date = m ? timeLong(m.received_at) : '';
  const body = m && m.body_text ? m.body_text.split('\n').map((l) => `> ${l}`).join('\n') : '';
  return `${who} ${date} 写道：\n${body || '(无内容)'}\n`;
}

function insertQuote() {
  const c = state.composing;
  if (!c) return;
  if (isRich()) {
    const ed = $('#f-body-rich');
    ed.insertAdjacentHTML('beforeend', quoteHtml());
    ed.focus();
  } else {
    const ta = $('#f-body');
    const block = quoteText();
    ta.value = ta.value ? `${ta.value}\n\n${block}` : block;
    ta.focus();
  }
}

function toggleRich() {
  const c = state.composing;
  if (!c) return;
  if (!c.rich) {
    const ta = $('#f-body');
    $('#f-body-rich').innerHTML = plainToHtmlText(ta.value);
    c.rich = true;
  } else {
    const ed = $('#f-body-rich');
    $('#f-body').value = ed.innerText;
    c.rich = false;
  }
  resetComposerEditor();
}

function bindToolbar() {
  const bar = $('#rich-toolbar');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    const ed = $('#f-body-rich');
    ed.focus();
    if (cmd === 'createLink') {
      const url = prompt('链接地址 (https://…)');
      if (url) document.execCommand('createLink', false, url);
    } else {
      document.execCommand(cmd);
    }
  });
}

async function sendCompose() {
  const c = state.composing;
  if (!c) return;
  const to = parseRecipients($('#f-to').value);
  const cc = parseRecipients($('#f-cc').value);
  const bcc = parseRecipients($('#f-bcc').value);
  const subject = $('#f-subject').value.trim();
  // any of to / cc / bcc non-empty is enough to send (a BCC-only email is legal)
  if (!to.length && !cc.length && !bcc.length) return showToast('请填写收件人', true);

  let body = $('#f-body').value;
  let html = null;
  let htmlHasText = false;
  if (isRich()) {
    const ed = $('#f-body-rich');
    html = ed.innerHTML;
    body = ed.innerText || '';
    // share the same "has content" definition as isComposerDirty(), to avoid two definitions drifting apart
    htmlHasText = richPlainText(ed) !== '';
  }
  if (!body.trim() && !htmlHasText) return showToast('请填写邮件内容', true);

  // The criterion is "is there a selectable sender address", not "is that row expanded": collapsing
  // just hides the UI, the selected value stays valid and must go into the request body as usual
  // (otherwise changing the sender silently fails).
  const mailbox = composerMailboxOptions().length ? $('#f-mailbox').value : undefined;
  // Hard guard: mail merge only applies to the compose endpoint; never send merge to /reply or /forward
  const merge = c.mode === 'compose' && $('#f-merge').checked;
  // Merge sends one email per recipient; BCC would make each BCC'd recipient get N duplicates → block on the frontend, and the backend rejects it too
  if (merge && bcc.length) return showToast('合并发送不支持密送（BCC），请取消其中一个', true);

  const payload = {
    to,
    subject,
    body: body || undefined,
    html: html && htmlHasText ? html : undefined,
    attachments: c.files.map((f) => ({ filename: f.name, content: f.content, content_type: f.type })),
  };
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;
  if (mailbox) payload.mailbox = mailbox;
  if (merge) payload.merge = true;
  // Include the draft id: the server deletes the matching draft after a successful send (only on full success; kept when merge partially fails)
  if (c.draftId) payload.draft_id = c.draftId;
  // Forward: the server copies the original attachments from R2; the frontend need not download and re-upload them
  if (c.mode === 'forward') payload.include_original_attachments = true;

  const sendBtn = $('#composer-send');
  sendBtn.disabled = true;
  sendInFlight = true; // no discarding while sending, to avoid content loss on failure
  try {
    const url = c.mode === 'reply'
      ? `/api/messages/${encodeURIComponent(c.originalId)}/reply`
      : c.mode === 'forward'
        ? `/api/messages/${encodeURIComponent(c.originalId)}/forward`
        : '/api/messages';
    const res = await api(url, { method: 'POST', body: JSON.stringify(payload) });

    if (merge && res && res.merge) {
      // Merge send: may partially fail. Failed recipients are written back into the recipient box so a
      // retry only targets them, without re-delivering to those who succeeded; the modal stays open and input is kept.
      if (res.failed_count > 0) {
        const failed = res.failed || [];
        $('#f-to').value = failed.map((f) => f.to).join(', ');
        updateMergeHint();
        const first = failed[0] || {};
        showToast(`已发送 ${res.sent_count} 封，${res.failed_count} 封失败：${first.to}（${first.error}）`, true);
        return;
      }
      showToast(`已分别发送给 ${res.sent_count} 位收件人`);
    } else if (c.mode === 'forward' && res && Array.isArray(res.skipped_attachments) && res.skipped_attachments.length) {
      // Missing attachments must be reported; the user must not think the attachments went along
      showToast(`已转发，但有 ${res.skipped_attachments.length} 个原附件读取失败已跳过：${res.skipped_attachments.join('、')}`, true);
    } else {
      showToast(c.mode === 'reply' ? '回复已发送' : c.mode === 'forward' ? '邮件已转发' : '邮件已发送');
    }

    closeComposer();
    invalidateFolderCaches();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true);
    if (state.folder !== 'sent') openFolder('sent');
    else void loadFolder(false, true);
  } catch (e) {
    showToast(`发送失败：${e.message}`, true);
  } finally {
    sendBtn.disabled = false;
    sendInFlight = false;
  }
}

/* ---------------- Composer modal: draggable / resizable / maximizable (desktop only) ----------------
 *
 * Background: when replying / forwarding the modal sits right on top of the original email, making it
 * awkward to write against it. Here the desktop composer becomes a floating window you can drag around,
 * resize, and maximize; mobile keeps the original fullscreen layout.
 *
 * ⚠️ Inline width/height outrank media queries, so when switching to mobile the inline geometry must be
 * cleared, otherwise "the modal is still desktop-sized on the phone". Clearing is driven by syncLayout()
 * (the single convergence point for layout).
 *
 * Geometry state has exactly one source of truth: composerGeom.
 *   null      = not floating — falls back to CSS centering + adaptive height, i.e. the pre-change look;
 *   {left,top,width,height} = floating window, driven by inline styles.
 * Every place that changes geometry must funnel through the single exit applyComposerGeom(); never write style directly.
 */

/** Minimum size of the floating window: any smaller and the "recipients / body / send" blocks don't fit. */
const COMPOSER_MIN_W = 420;
const COMPOSER_MIN_H = 320;
/** Margin left around the edges when maximized, to avoid hugging the screen edge. */
const COMPOSER_MAX_GAP = 12;
/** Minimum movement to count as "actually dragging": below it, it's just a click on the title bar. */
const COMPOSER_DRAG_THRESHOLD = 3;

let composerGeom = null;      // { left, top, width, height } | null (see the note above)
let composerPrevGeom = null;  // geometry before maximizing, used by "restore"
let composerMaximized = false;
let composerDrag = null;      // in-progress drag / resize { mode, x, y, geom, moved }
/**
 * Whether the most recent pointerdown landed inside the modal.
 *
 * Used to distinguish "actually clicked the blank mask" from "pressed inside the modal and released
 * the mouse over the mask" — for the latter the browser dispatches click to the common ancestor (the
 * mask itself), making target === currentTarget true and wrongly closing the modal. Dragging the title
 * bar is naturally this gesture, so the distinction is required.
 */
let composerPressInside = false;

/** Viewport size. Same source as viewportWidth(); falls back to desktop defaults so NaN doesn't infect geometry. */
function viewportSize() {
  const w = globalThis.innerWidth;
  const h = globalThis.innerHeight;
  return {
    width: typeof w === 'number' && w > 0 ? w : 1024,
    height: typeof h === 'number' && h > 0 ? h : 768,
  };
}

/**
 * Clamp any geometry into the viewport. Pure function (numbers only), so the strategy can be verified
 * directly in a layout-less test environment.
 *
 * Position clamping targets "the **whole window** stays within the viewport", not "the title bar peeks
 * out". The size is already clamped to fit the viewport above, so clamping the whole window is feasible
 * — this keeps both the title bar and the bottom-right resize grip always reachable.
 *
 * ⚠️ Don't degrade this into a "guarantee 80px of title bar" form: measured in real Chromium, after
 * dragging the window down 150px the bottom-right corner is pushed offscreen, `elementFromPoint`
 * returns null, and the grip can neither be clicked nor dragged — once dragged to some position the
 * user can **never recover it**. This is the classic floating-window deadlock.
 */
function clampComposerGeom(g, vp) {
  const maxW = Math.max(COMPOSER_MIN_W, vp.width - COMPOSER_MAX_GAP * 2);
  const maxH = Math.max(COMPOSER_MIN_H, vp.height - COMPOSER_MAX_GAP * 2);
  const width = Math.min(Math.max(g.width, COMPOSER_MIN_W), maxW);
  const height = Math.min(Math.max(g.height, COMPOSER_MIN_H), maxH);
  const maxLeft = Math.max(0, vp.width - width);
  const maxTop = Math.max(0, vp.height - height);
  const left = Math.min(Math.max(g.left, 0), maxLeft);
  const top = Math.min(Math.max(g.top, 0), maxTop);
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * Get the "real element" for #composer.
 * The two vm suites (compose-guard / mail-merge) use minimal DOM stubs whose elements have no style;
 * no style means it's not a browser, so all geometry-related code is skipped (returns null for callers to bail out).
 */
function composerBox() {
  const el = $('#composer');
  return el && el.style ? el : null;
}

/** Add a class to body during dragging (disables text selection). Stub DOMs' body has no classList, so feature-detect. */
function setComposerDragging(on) {
  const b = document.body;
  if (!b || !b.classList) return;
  b.classList.toggle('composer-dragging', !!on);
}

function syncComposerMaxButton() {
  const btn = $('#composer-max');
  if (!btn || !btn.style) return;
  btn.textContent = composerMaximized ? '⤡' : '⤢';
  if (typeof btn.setAttribute === 'function') {
    const label = composerMaximized ? '还原大小' : '最大化';
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  }
}

/**
 * The **sole exit** for geometry: fully align composerGeom to inline styles + state classes.
 * When not floating (mobile / no geometry), clear the inline values so CSS takes over again.
 */
function applyComposerGeom() {
  const el = composerBox();
  if (!el) return;
  const floating = !!composerGeom && !isMobile();
  el.classList.toggle('floating', floating);

  const mask = $('#modal-mask');
  if (mask && mask.classList) mask.classList.toggle('composer-float', floating);

  const grip = $('#composer-resize');
  if (grip && grip.style && grip.classList) {
    grip.classList.toggle('hidden', !floating);
    // The grip uses fixed positioning: it won't scroll away when the modal scrolls internally
    // (absolute positioning follows the content, and once the window is shorter than the content it's unreachable).
    if (floating) {
      grip.style.left = `${composerGeom.left + composerGeom.width - 18}px`;
      grip.style.top = `${composerGeom.top + composerGeom.height - 18}px`;
    } else {
      grip.style.left = '';
      grip.style.top = '';
    }
  }

  if (floating) {
    el.style.left = `${composerGeom.left}px`;
    el.style.top = `${composerGeom.top}px`;
    el.style.width = `${composerGeom.width}px`;
    el.style.height = `${composerGeom.height}px`;
  } else {
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
  }
  syncComposerMaxButton();
}

/**
 * Called by syncLayout() on breakpoint switches / window size changes:
 * re-clamp the geometry and (on mobile) clear inline values so the fullscreen layout takes effect.
 */
function syncComposerWindowLayout() {
  if (!composerGeom) return;
  // On mobile this geometry is merely "not used for now": don't clamp or discard it; restore it as-is
  // when switching back to desktop. If clamped here, a narrow viewport would **permanently shrink** the
  // user's chosen size (clamping is one-way; once shrunk it can't grow back).
  if (!isMobile()) composerGeom = clampComposerGeom(composerGeom, viewportSize());
  applyComposerGeom();
}

/** Start drag / resize: first measure the current (possibly CSS-determined) geometry, and freeze it as floating only on real movement. */
function startComposerDrag(mode, e) {
  if (isMobile()) return false; // mobile is fullscreen and does not participate in floating
  const el = composerBox();
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const r = el.getBoundingClientRect();
  composerDrag = {
    mode,
    x: e.clientX,
    y: e.clientY,
    moved: false,
    geom: clampComposerGeom(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      viewportSize()
    ),
  };
  return true;
}

/** Drag / resize delta mapping. resize only changes the bottom-right corner; move only changes position. */
function dragComposerTo(x, y) {
  const d = composerDrag;
  if (!d) return;
  if (!d.moved) {
    // Just a click on the title bar (no real drag): don't enter floating, so a tap on the mask doesn't dim it
    if (Math.abs(x - d.x) + Math.abs(y - d.y) < COMPOSER_DRAG_THRESHOLD) return;
    d.moved = true;
    composerMaximized = false; // manual drag exits maximize
    composerPrevGeom = null;
    setComposerDragging(true);
  }
  const vp = viewportSize();
  if (d.mode === 'move') {
    composerGeom = clampComposerGeom(
      { left: d.geom.left + (x - d.x), top: d.geom.top + (y - d.y), width: d.geom.width, height: d.geom.height },
      vp
    );
  } else {
    // The resize size cap = available space from the current position to the viewport's bottom-right.
    // Without this step, enlarging first pushes the window offscreen, then clampComposerGeom yanks the
    // whole thing back to the top-left — the user sees "I only dragged the grip down-right, yet the window
    // runs to the top-left by itself" (actually hit this in real Chromium). Pinning the size and keeping
    // the top-left fixed is the intuitive behavior.
    const maxW = Math.max(COMPOSER_MIN_W, vp.width - d.geom.left);
    const maxH = Math.max(COMPOSER_MIN_H, vp.height - d.geom.top);
    composerGeom = clampComposerGeom(
      {
        left: d.geom.left,
        top: d.geom.top,
        width: Math.min(d.geom.width + (x - d.x), maxW),
        height: Math.min(d.geom.height + (y - d.y), maxH),
      },
      vp
    );
  }
  applyComposerGeom();
}

function endComposerDrag() {
  if (!composerDrag) return;
  composerDrag = null;
  setComposerDragging(false);
}

/** Maximize / restore (restore returns to the geometry before maximizing). */
function toggleComposerMax() {
  if (isMobile()) return;
  const el = composerBox();
  if (!el || typeof el.getBoundingClientRect !== 'function') return;
  const vp = viewportSize();
  if (composerMaximized) {
    if (composerPrevGeom) composerGeom = clampComposerGeom(composerPrevGeom, vp);
    composerPrevGeom = null;
    composerMaximized = false;
  } else {
    const r = el.getBoundingClientRect();
    composerPrevGeom = clampComposerGeom(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      vp
    );
    composerGeom = clampComposerGeom(
      { left: COMPOSER_MAX_GAP, top: COMPOSER_MAX_GAP, width: vp.width - COMPOSER_MAX_GAP * 2, height: vp.height - COMPOSER_MAX_GAP * 2 },
      vp
    );
    composerMaximized = true;
  }
  applyComposerGeom();
}

/** Return to the default centered adaptive layout (discard floating geometry). */
function resetComposerGeom() {
  composerGeom = null;
  composerPrevGeom = null;
  composerMaximized = false;
  applyComposerGeom();
}

/**
 * Wiring for drag / resize / maximize. Called from setupEvents().
 * Uses pointer events to unify mouse and touch; mobile bails out via isMobile(), so no platform split is needed here.
 */
function setupComposerWindow() {
  const head = $('#composer-head');
  const grip = $('#composer-resize');
  const maxBtn = $('#composer-max');
  const fitBtn = $('#composer-fit');

  // Buttons on the title bar are "clicks", not "drags"; don't treat a click as a drag start
  const onButton = (e) => {
    const t = e.target;
    return !!(t && typeof t.closest === 'function' && t.closest('button'));
  };

  if (head) {
    head.addEventListener('pointerdown', (e) => {
      if (onButton(e)) return;
      if (e.button != null && e.button !== 0) return;
      if (!startComposerDrag('move', e)) return;
      e.preventDefault();
    });
    head.addEventListener('dblclick', (e) => {
      if (onButton(e)) return;
      toggleComposerMax();
    });
  }
  if (grip) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (!startComposerDrag('resize', e)) return;
      e.preventDefault();
    });
  }
  if (maxBtn) maxBtn.addEventListener('click', toggleComposerMax);
  if (fitBtn) fitBtn.addEventListener('click', resetComposerGeom);

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('pointermove', (e) => dragComposerTo(e.clientX, e.clientY));
    document.addEventListener('pointerup', endComposerDrag);
    document.addEventListener('pointercancel', endComposerDrag);
    // On every press, re-record whether it was inside the modal or on the mask, for the mask's click handler to check
    document.addEventListener('pointerdown', (e) => {
      const t = e.target;
      composerPressInside = !!(t && typeof t.closest === 'function' && t.closest('#composer'));
    }, true);
  }

  // Draft autosave: any input inside the modal triggers it (event delegation, one binding covers all fields and the rich editor).
  // Both input + change events: text boxes / rich text fire input, while the dropdown (sender) and checkboxes only fire change.
  const composerEl = $('#composer');
  if (composerEl && typeof composerEl.addEventListener === 'function') {
    composerEl.addEventListener('input', () => scheduleDraftSave());
    composerEl.addEventListener('change', () => scheduleDraftSave());
  }
}

/* ---------------- Search / keyboard / events / sync ---------------- */

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function setupSearch() {
  const input = $('#search-input');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = input.value.trim();
      state.selected.clear();
      state.offset = 0;
      closeMessagePane();
      void loadFolder(false, true);
    }, 400);
  });
}

function moveSelection(step) {
  if (!state.items.length) return;
  let idx = state.items.findIndex((it) => it.id === state.openId);
  if (idx === -1) idx = step > 0 ? -1 : 0;
  idx = Math.min(Math.max(idx + step, 0), state.items.length - 1);
  const target = state.items[idx];
  if (target) void openMessage(target.id);
}

function setupEvents() {
  $('#compose-btn').addEventListener('click', openComposer);
  $('#composer-cancel').addEventListener('click', requestCloseComposer);
  $('#composer-send').addEventListener('click', () => void sendCompose());
  $('#modal-mask').addEventListener('click', (e) => {
    // When the press is inside the modal and the mouse is released over the mask, the browser dispatches
    // click to the common ancestor (the mask itself); looking only at target === currentTarget would treat
    // it as "click blank to close". Dragging the title bar is exactly this gesture, so the check must also
    // consider where the press began (see composerPressInside).
    if (composerPressInside) return;
    if (e.target === e.currentTarget) requestCloseComposer();
  });

  // Record the last focused element inside the composer, to return focus after the confirm dialog is hidden
  $('#composer').addEventListener('focusin', (e) => {
    composerLastFocus = e.target;
  });

  // Discard confirm: clicking blank area or "continue editing" = keep content; clicking "discard" = actually close
  $('#confirm-cancel').addEventListener('click', () => hideDiscardConfirm());
  $('#confirm-ok').addEventListener('click', closeComposer);
  $('#confirm-mask').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideDiscardConfirm();
  });

  $('#mailbox-select').addEventListener('change', (e) => {
    state.mailbox = e.target.value || '';
    state.selected.clear();
    state.cache.countsAt = 0;
    closeMessagePane();
    void refreshCounts(true);
    void loadFolder();
  });

  $('#select-all').addEventListener('change', (e) => {
    const check = e.target.checked;
    state.selected.clear();
    if (check) for (const it of state.items) state.selected.add(it.id);
    renderList();
    renderSelectBar();
  });

  $('#list-more').addEventListener('click', () => void loadFolder(true));

  $('#f-attachments').addEventListener('change', (e) => void onPickFiles(e));
  $('#f-mode').addEventListener('click', toggleRich);
  $('#f-quote').addEventListener('click', insertQuote);
  $('#f-cc-toggle').addEventListener('click', toggleRecipientsExpanded);
  // Sender: click the summary row to expand/collapse; the summary must update when the selection changes (otherwise collapsing shows the old address)
  $('#f-sender-toggle').addEventListener('click', toggleSenderExpanded);
  $('#f-mailbox').addEventListener('change', renderSenderSummary);
  $('#f-sender-add').addEventListener('click', addCustomSender);
  $('#f-sender-custom').addEventListener('click', addCustomSender);
  // Multi-domain: open the wizard from inside the app to configure an extra domain.
  $('#add-domain-btn').addEventListener('click', openAddDomain);
  // Mail merge: the checked state and recipient count both affect the hint text
  $('#f-merge').addEventListener('change', updateMergeHint);
  $('#f-to').addEventListener('input', updateMergeHint);
  // Recipient autocomplete: the to / cc / bcc fields share one dropdown
  bindRecipientSuggest();
  bindToolbar();

  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    }
  });

  // Esc: the confirm dialog hides first; otherwise request closing the composer (closes directly when empty)
  // Note: does not skip input boxes; Esc works the same while composing
  // Mobile: when the drawer is open, Esc closes the drawer first (the confirm dialog / composer aren't up yet, close the outermost layer)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (drawerOpen) {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (discardConfirmPending) {
      e.preventDefault();
      hideDiscardConfirm();
      return;
    }
    if (!state.composing) return;
    e.preventDefault();
    requestCloseComposer();
  });

  // ---- Mobile: drawer + single-column detail back ----
  $('#drawer-btn').addEventListener('click', () => setDrawer(!drawerOpen));
  $('#drawer-mask').addEventListener('click', closeDrawer);
  // Back to list: closeMessagePane() calls syncLayout() internally
  $('#read-back-btn').addEventListener('click', closeMessagePane);
  // After the mobile sidebar collapses into the drawer, the top bar needs a directly clickable compose entry
  $('#topbar-compose').addEventListener('click', openComposer);
  // Rotation / split screen / desktop window drag: realign layout (syncLayout is idempotent)
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('resize', syncLayout);
  }

  setupSearch();
  // Wiring for composer drag / resize / maximize. Placed **after** setupSearch():
  // the event wiring above is extracted and executed whole by the two vm suites via comment markers, so nothing more is added there.
  setupComposerWindow();
  // Wiring for dragging the list/detail splitter. Likewise placed outside the extraction scope.
  setupSplitter();
  // Attachment preview overlay (close button / click blank to close; Esc is in the global keyboard handler)
  setupAttachmentPreview();
}

/**
 * Periodic background sync: skip entirely when the page is hidden; only refresh caches past their TTL,
 * never force unconditionally; list refresh yields in read mode (to avoid interrupting reading), and
 * when data is unchanged a fingerprint short-circuits, without rebuilding the DOM.
 */
async function periodicSync() {
  if (document.hidden) return;
  void refreshCounts(false); // internally gated by TTL.counts
  void loadMailboxes(false); // internally gated by TTL.mailboxes
  void loadInboundAlerts();  // inbound anomaly alerts (checked every sync so stuck emails get seen)
  void loadBackendStatus();  // backend status (CF storage/inbound + Resend quota; storage uses a TTL cache, very cheap)
  if (isReadMode() || state.loading) return;
  const c = state.cache.folders.get(folderKey());
  if (!c || Date.now() - c.at >= TTL.folder) void loadFolder(false, false);
}

/* ---------------- Inbound anomaly alerts (CF inbound "received but not in inbox") ----------------
 * CF Email Routing doesn't store mail; the receive pipeline is "land in R2 + register, then parse
 * asynchronously"; if parsing fails due to CPU/memory (free tier 10ms), a transient fault, or a large
 * attachment, the email just sits in the backend — the user has no way to know. This exposes it as a top
 * banner: showing sender/subject/size/reason, with "retry / download original" actions. */

let inboundAlertsExpanded = false;

async function loadInboundAlerts() {
  let data;
  try {
    data = await api('/api/inbound/alerts');
  } catch {
    return; // bonus feature: stays silent on fetch failure, doesn't disturb the main flow
  }
  renderInboundAlerts((data && data.alerts) || []);
}

function renderInboundAlerts(alerts) {
  const box = $('#inbound-alerts');
  if (!box) return;
  if (!alerts.length) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.classList.remove('hidden');
  const items = alerts.map((a) => {
    const subject = a.subject
      ? `<span class="ia-subject" title="${esc(a.subject)}">${esc(a.subject)}</span>`
      : '<span class="ia-subject"><span class="ia-empty">（无主题）</span></span>';
    const metaParts = [];
    if (a.from) metaParts.push(`来自 ${esc(a.from)}`);
    if (a.to) metaParts.push(`投递给 ${esc(a.to)}`);
    if (a.size) metaParts.push(fmtSize(a.size));
    if (a.received_at) metaParts.push(fmtDateTime(a.received_at));
    const errText = a.error ? esc(a.error) : '仍在处理，或邮件过大（免费档 CPU 限制）';
    return `<li class="ia-item" data-id="${esc(a.id)}">
        <div class="ia-main">
          ${subject}
          <span class="ia-meta">${metaParts.join(' · ')}</span>
          <span class="ia-error">${errText}</span>
        </div>
        <div class="ia-actions">
          <button class="btn ia-retry" type="button">重试</button>
          <a class="btn" href="/api/inbound/alerts/${encodeURIComponent(a.id)}/raw">下载原件</a>
        </div>
      </li>`;
  }).join('');
  box.innerHTML = `<div class="ia-head">
      <span class="ia-icon" aria-hidden="true">⚠️</span>
      <span class="ia-title">有 ${alerts.length} 封邮件已收到，但还没进入收件箱</span>
      <button class="link-btn ia-toggle" type="button">${inboundAlertsExpanded ? '收起' : '查看'}</button>
    </div>
    <ul class="ia-list"${inboundAlertsExpanded ? '' : ' hidden'}>${items}</ul>`;
  if (!box.dataset.bound) {
    box.dataset.bound = '1';
    box.addEventListener('click', onInboundAlertClick);
  }
}

async function onInboundAlertClick(e) {
  const toggle = e.target.closest('.ia-toggle');
  if (toggle) {
    inboundAlertsExpanded = !inboundAlertsExpanded;
    const list = $('#inbound-alerts .ia-list');
    if (list) list.classList.toggle('hidden', !inboundAlertsExpanded);
    toggle.textContent = inboundAlertsExpanded ? '收起' : '查看';
    return;
  }
  const retry = e.target.closest('.ia-retry');
  if (!retry) return;
  const item = retry.closest('.ia-item');
  const id = item && item.dataset.id;
  if (!id) return;
  retry.disabled = true;
  retry.textContent = '重试中…';
  try {
    await api(`/api/inbound/alerts/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    showToast('已重新入队，稍后会再次尝试解析');
    setTimeout(() => void loadInboundAlerts(), 1500);
  } catch (err) {
    showToast(err.message, true);
    retry.disabled = false;
    retry.textContent = '重试';
  }
}

/* ---------------- Backend basics: CF (storage/inbound queue) + Resend (send quota) ----------------
 * See the backend at a glance: CF free tier D1 500MB / R2 10GB, Resend free tier 100/day · 3000/month.
 * D1/R2 are estimated by the backend and TTL-cached; inbound count and send quota are live. Turns color
 * when near the cap / with an abnormal backlog. */

async function loadBackendStatus() {
  let u;
  try {
    u = await api('/api/usage');
  } catch {
    return; // bonus feature: stays silent on fetch failure, doesn't disturb the main flow
  }
  renderBackendStatus(u);
}

function renderBackendStatus(u) {
  const box = $('#backend-status');
  if (!box || !u || !u.d1 || !u.r2) return;
  const inbound = u.inbound || { pending: 0, alerts: 0 };
  const resend = u.resend || null;
  const percents = [u.d1.percent, u.r2.percent];
  if (resend && resend.configured) percents.push(resend.day.percent, resend.month.percent);
  const max = percents.length ? Math.max(...percents) : 0;
  box.classList.remove('hidden', 'warn', 'danger');
  if (max >= 95) box.classList.add('danger');
  else if (max >= 80) box.classList.add('warn');

  const rows = [
    `<span class="bs-row" title="${esc(`D1 约 ${fmtSize(u.d1.usedBytes)} / ${fmtSize(u.d1.limitBytes)}`)}">D1 <b>${u.d1.percent}%</b></span>`,
    `<span class="bs-row" title="${esc(`R2 约 ${fmtSize(u.r2.usedBytes)} / ${fmtSize(u.r2.limitBytes)} · ${u.r2.objects} 个对象`)}">R2 <b>${u.r2.percent}%</b></span>`,
    `<span class="bs-row${inbound.alerts ? ' bs-attn' : ''}" title="待解析 / 异常 / 累计收信">收件 <b>${inbound.pending}</b> 待处理${inbound.alerts ? ` · <b>${inbound.alerts}</b> 异常` : ''}</span>`,
  ];
  if (resend && resend.configured) {
    rows.push(
      `<span class="bs-row" title="${esc(`Resend 今日 ${resend.day.used}/${resend.day.limit} · 本月 ${resend.month.used}/${resend.month.limit}`)}">发件 <b>${resend.day.used}</b>/${resend.day.limit} · 月 <b>${resend.month.used}</b>/${resend.month.limit}</span>`
    );
  }
  box.innerHTML =
    '<span class="bs-title">后端状态</span>' +
    rows.join('') +
    `<span class="bs-note">${esc(u.approximate ? '存储为估算值' : '')}${u.approximate ? '·' : ''}贴近上限或积压会变色提醒</span>`;
}

/* ---------------- Setup wizard / login gate (gate) ----------------
 * Before the app starts, ask the backend `/api/setup/status`:
 *   mode='none'   → not initialized: show the setup wizard (first step sets the admin password).
 *   mode='session' and not logged in → show the login box.
 *   mode='basic'  or probe failed → fall back to the original browser Basic Auth (no gate).
 */

let gateMode = null;

/** Raw fetch (bypasses api() to avoid the 401 handling logic triggering when not logged in). */
async function probe(path, opts = {}) {
  try {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : null;
    return { res, data };
  } catch {
    return { res: null, data: null };
  }
}

async function bootstrapGate() {
  const { res, data } = await probe('/api/setup/status');
  if (!res || !data || typeof data.mode !== 'string') return true; // probe failed → keep original behavior
  gateMode = data.mode;
  if (data.mode === 'none') {
    showWizard(data);
    return false;
  }
  if (data.mode === 'session' && !data.authenticated) {
    showLogin();
    return false;
  }
  // Logged in but domain/sending not yet configured → continue the domain wizard (the user can skip into the mailbox)
  if (data.authenticated && !data.domain && !localStorage.getItem('setup-skip')) {
    showDomainWizard(data);
    return false;
  }
  return true;
}

function gateRoot() {
  let root = document.getElementById('gate');
  if (!root) {
    root = document.createElement('div');
    root.id = 'gate';
    document.body.appendChild(root);
  }
  root.innerHTML = '';
  root.classList.remove('hidden');
  return root;
}

function gateField(id, label, type, value = '', placeholder = '') {
  return `<label class="gate-field"><span>${label}</span>
    <input id="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" /></label>`;
}

/** Hide the full-screen gate overlay (used when the wizard is opened from inside the app, e.g. "add domain"). */
function hideGate() {
  const root = document.getElementById('gate');
  if (root) {
    root.classList.add('hidden');
    root.innerHTML = '';
  }
}

function showLogin() {
  const root = gateRoot();
  root.innerHTML = `
    <div class="gate-card">
      <div class="gate-title">登录</div>
      <div class="gate-sub">输入管理员账号以进入邮箱</div>
      ${gateField('gate-user', '用户名', 'text', 'admin', '')}
      ${gateField('gate-pass', '密码', 'password', '', '')}
      <div class="gate-error" id="gate-error"></div>
      <div class="gate-actions">
        <button class="btn btn-primary" id="gate-submit" type="button">登录</button>
      </div>
    </div>`;
  const submit = async () => {
    const username = $('#gate-user').value.trim();
    const password = $('#gate-pass').value;
    const err = $('#gate-error');
    err.textContent = '';
    if (!username || !password) {
      err.textContent = '请输入用户名与密码';
      return;
    }
    $('#gate-submit').disabled = true;
    const r = await probe('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (r.res && r.res.ok) {
      location.reload();
      return;
    }
    $('#gate-submit').disabled = false;
    err.textContent = (r.data && r.data.error) || '登录失败';
  };
  $('#gate-submit').addEventListener('click', submit);
  $('#gate-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  $('#gate-user').focus();
}

function showWizard() {
  const root = gateRoot();
  root.innerHTML = `
    <div class="gate-card">
      <div class="gate-title">初始化邮箱</div>
      <div class="gate-sub">第 1 步 · 设置管理员账号（用于登录本邮箱）</div>
      ${gateField('gate-user', '用户名', 'text', 'admin', '')}
      ${gateField('gate-pass', '密码', 'password', '', '至少 6 位')}
      ${gateField('gate-pass2', '确认密码', 'password', '', '')}
      <div class="gate-error" id="gate-error"></div>
      <div class="gate-actions">
        <button class="btn btn-primary" id="gate-submit" type="button">创建并继续</button>
      </div>
      <div class="gate-note">完成设置后即可登录。域名解析与发信配置将在下一步完成。</div>
    </div>`;
  const submit = async () => {
    const username = $('#gate-user').value.trim();
    const password = $('#gate-pass').value;
    const password2 = $('#gate-pass2').value;
    const err = $('#gate-error');
    err.textContent = '';
    if (!username) {
      err.textContent = '请输入用户名';
      return;
    }
    if (password.length < 6) {
      err.textContent = '密码至少 6 位';
      return;
    }
    if (password !== password2) {
      err.textContent = '两次输入的密码不一致';
      return;
    }
    $('#gate-submit').disabled = true;
    const r = await probe('/api/setup/admin', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (r.res && r.res.ok) {
      location.reload();
      return;
    }
    $('#gate-submit').disabled = false;
    err.textContent = (r.data && r.data.error) || '创建失败';
  };
  $('#gate-submit').addEventListener('click', submit);
  $('#gate-pass2').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  $('#gate-user').focus();
}

// Infer the current Worker's script name (Deploy Button lets users rename it; catch-all must point to the real script name).
// Only applies to *.workers.dev production domains; custom domains/preview URLs return an empty string and the server falls back to env.WORKER_NAME.
function detectWorkerName() {
  const parts = (location.hostname || '').toLowerCase().split('.');
  if (parts.length < 3) return '';
  if (parts[parts.length - 2] !== 'workers' || parts[parts.length - 1] !== 'dev') return '';
  let name = parts[0];
  const m = name.match(/^[0-9a-f]{8,}-(.+)$/); // preview URL prefix looks like <light-prefix>-<worker>
  if (m) name = m[1];
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : '';
}

/** Wizard steps 2/3: domain + auto DNS setup + send/receive auth. The CF Token is used once and not saved. */
/**
 * Cloudflare's "API token template URL": opening it pre-selects the permission groups below, so the user only has to
 * review and confirm instead of hunting through the token UI. The four permissions are exactly what the wizard uses:
 *   Zone:Read        → GET /zones?name=…            (find the zone)
 *   DNS:Edit         → /zones/:id/dns_records       (Resend DKIM/SPF/MX + Email Routing records)
 *   Zone Settings:Edit → Email Routing settings      (enable routing for the zone)
 *   Email Routing Rules:Edit → routing rules/catch_all (point catch-all at this Worker)
 * If Cloudflare ever ignores the parameters the page simply opens with the normal token form — the same four
 * permissions are spelled out right next to the button, so the flow still works.
 */
const CF_TOKEN_PERMS = [
  { key: 'zone', type: 'read' },
  { key: 'dns', type: 'edit' },
  { key: 'zone_settings', type: 'edit' },
  { key: 'email_routing_rules', type: 'edit' },
];
/** Normalize a domain typed by the user (lowercase, no scheme/path) — same rule the wizard uses. */
function normDomainInput(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

/** Is this something that can be a zone name? */
function looksLikeDomain(d) {
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(String(d || ''));
}

/**
 * The zone id of a domain the app already knows (its own `domains` table), trying the exact name first and then the
 * registrable-ish apex — the same fallback the wizard's zone lookup uses.
 */
function knownZoneIdFor(domain) {
  const d = normDomainInput(domain);
  if (!d) return '';
  const map = state.zoneIds && typeof state.zoneIds === 'object' ? state.zoneIds : {};
  if (map[d]) return map[d];
  const parts = d.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const apex = parts.slice(i).join('.');
    if (map[apex]) return map[apex];
  }
  return '';
}

/**
 * Cloudflare token template URL.
 *
 * `zoneId` is the only way to pre-select a zone, and Cloudflare accepts a **zone id** (not a name) there. The id can only
 * be discovered with a token — which is exactly what the user is about to create — so:
 *   · domain already configured (its zone id is stored in the app's `domains` table) -> link is scoped to that zone;
 *   · brand-new domain -> `zoneId=all` plus a hint telling the user to switch Zone Resources to that domain.
 */
function cfTokenTemplateUrl(domain) {
  const q = new URLSearchParams();
  q.set('permissionGroupKeys', JSON.stringify(CF_TOKEN_PERMS));
  // Cloudflare's docs mark both scope parameters as required.
  q.set('accountId', '*');
  q.set('zoneId', knownZoneIdFor(domain) || 'all');
  q.set('name', 'Resend Mail API');
  return `https://dash.cloudflare.com/profile/api-tokens?${q.toString()}`;
}

function showDomainWizard(status, opts = {}) {
  const adding = !!opts.adding;
  const submitLabel = adding ? '添加域名' : '开始配置';
  const root = gateRoot();
  root.innerHTML = `
    <div class="gate-card gate-wide">
      <div class="gate-title">${adding ? '添加域名' : '连接你的域名'}</div>
      <div class="gate-sub">${adding ? '为当前邮箱增加一个收发域名，自动完成收信路由与发信认证' : '第 2 步 · 输入域名并授权，自动完成收信路由与发信认证'}</div>
      ${gateField('gate-domain', '域名', 'text', adding ? '' : (status && status.domain) || '', 'example.com')}
      <div class="gate-field cf-auth">
        <span>Cloudflare 授权（自动勾选权限）</span>
        <a class="btn btn-primary cf-auth-btn disabled" id="cf-auth-open" href="#" aria-disabled="true" target="_blank" rel="noopener noreferrer">打开 Cloudflare 授权页</a>
        <div class="cf-zone-hint" id="cf-zone-hint">先在上面填写域名，按钮才会激活。</div>
        <div class="cf-perms" id="cf-perms">
          <div>需要 4 项权限：Zone → Read · DNS → Edit · Zone Settings → Edit · Email Routing Rules → Edit</div>
          <ul class="cf-perms-list">
            <li>打开后前 3 项已自动勾选；Email Routing Rules 若没有出现，点 Permissions 下的「+ Add more」→ 选 Zone → Email Routing Rules → Edit（Cloudflare 目前不支持用链接预选这一项）。</li>
            <li>Zone Resources 默认 All zones；想只授权这一个域，改成 Include → 你的域名。</li>
            <li>最后点「Continue to summary」→「Create Token」，把 Token 粘到下面。</li>
          </ul>
        </div>
      </div>
      ${gateField('gate-cf', '把创建好的 Token 粘贴到这里', 'password', '', 'Cloudflare API Token')}
      ${gateField('gate-resend', 'Resend API Key', 'password', '', 're_…（保存在你自己的数据库，用于发信）')}
      ${adding ? '' : gateField('gate-from', '发件地址', 'text', (status && status.from_address) || '', 'noreply@example.com')}
      ${adding ? '' : gateField('gate-fromname', '发件显示名（可选）', 'text', '', '')}
      <div class="gate-error" id="gate-error"></div>
      <div id="gate-steps" class="gate-steps"></div>
      <div class="gate-actions">
        <button class="btn" id="gate-cancel" type="button">${adding ? '取消' : '暂不设置'}</button>
        <button class="btn btn-primary" id="gate-submit" type="button">${submitLabel}</button>
      </div>
      <div class="gate-note">Cloudflare Token 仅用于本次写 DNS 与开启收信路由，<b>不会保存</b>；Resend Key 保存在你自己的 D1（发信需要）。</div>
    </div>`;

  const domainEl = $('#gate-domain');

  /**
   * Enable the Cloudflare authorisation button only once the domain looks valid, and (re)build its link for exactly that
   * domain: when the app already knows the zone id the token page opens with that zone pre-selected, otherwise the hint
   * tells the user which row to change.
   */
  const syncCfAuth = () => {
    const link = $('#cf-auth-open');
    const hint = $('#cf-zone-hint');
    if (!link || !hint) return;
    const raw = domainEl ? domainEl.value : '';
    const d = normDomainInput(raw);
    const ok = looksLikeDomain(d);
    link.classList.toggle('disabled', !ok);
    link.setAttribute('aria-disabled', ok ? 'false' : 'true');
    if (!ok) {
      link.setAttribute('href', '#');
      hint.textContent = '先在上面填写域名，按钮才会激活。';
      return;
    }
    link.setAttribute('href', cfTokenTemplateUrl(d));
    const zoneId = knownZoneIdFor(d);
    hint.textContent = zoneId
      ? `已按 ${d} 所在的 zone 打开（Zone Resources 已锁定到该域名）。`
      : `打开后把 Zone Resources 改成 Include → ${d}，只授权这一个域（Cloudflare 的链接只接受 zone id，首次配置时还查不到）。`;
  };
  if (domainEl) {
    domainEl.addEventListener('input', syncCfAuth);
    domainEl.addEventListener('change', syncCfAuth);
  }
  const cfLink = $('#cf-auth-open');
  if (cfLink) {
    cfLink.addEventListener('click', (e) => {
      if (cfLink.classList.contains('disabled')) {
        e.preventDefault();
        const err = $('#gate-error');
        if (err) err.textContent = '请先填写域名，再打开 Cloudflare 授权页。';
      }
    });
  }
  syncCfAuth();
  const fromEl = $('#gate-from');
  // When the domain changes, if the from address isn't customized yet, auto-fill noreply@<domain>
  // (setup only; the add-domain flow has no sender fields — senders are derived in the composer).
  domainEl.addEventListener('blur', () => {
    if (!fromEl) return;
    const d = domainEl.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (d && (!fromEl.value || /^noreply@/.test(fromEl.value))) fromEl.value = `noreply@${d}`;
  });

  const renderSteps = (steps) => {
    const box = $('#gate-steps');
    if (!steps || !steps.length) { box.innerHTML = ''; return; }
    box.innerHTML = steps.map((s) => `
      <div class="gate-step ${s.ok ? 'ok' : 'bad'}">
        <span class="gate-step-mark">${s.ok ? '✓' : '✕'}</span>
        <span class="gate-step-name">${esc(s.name)}</span>
        <span class="gate-step-detail">${esc(s.detail)}</span>
      </div>`).join('');
  };

  $('#gate-cancel').addEventListener('click', () => {
    if (adding) { hideGate(); return; }
    localStorage.setItem('setup-skip', '1');
    location.reload();
  });

  $('#gate-submit').addEventListener('click', async () => {
    const domain = domainEl.value.trim();
    const cf_token = $('#gate-cf').value.trim();
    const resend_key = $('#gate-resend').value.trim();
    const from_address = fromEl ? fromEl.value.trim() : '';
    const from_name = $('#gate-fromname') ? $('#gate-fromname').value.trim() : '';
    const err = $('#gate-error');
    err.textContent = '';
    if (!domain || !cf_token || !resend_key) {
      err.textContent = '请填写域名、Cloudflare Token 与 Resend Key';
      return;
    }
    const btn = $('#gate-submit');
    btn.disabled = true;
    btn.textContent = '配置中…';
    const r = await probe('/api/setup/domain', {
      method: 'POST',
      body: JSON.stringify({ domain, cf_token, resend_key, from_address, from_name, worker_name: detectWorkerName() }),
    });
    btn.disabled = false;
    btn.textContent = submitLabel;
    if (!r.res) {
      err.textContent = '网络错误，请重试';
      return;
    }
    const data = r.data || {};
    renderSteps(data.steps);
    if (r.res.ok && data.ok) {
      err.textContent = '';
      if (adding) {
        // Opened from inside the app: close the overlay and refresh the account/domain list instead of a full reload.
        hideGate();
        await loadAccount();
        state.cache.mailboxesAt = 0;
        state.cache.countsAt = 0;
        void loadMailboxes(true);
        void refreshCounts(true);
        void refreshDomainHealth(true); // a new domain must not keep showing the previous badge state
        showToast('域名已添加');
        return;
      }
      localStorage.removeItem('setup-skip');
      setTimeout(() => location.reload(), 700);
    } else {
      err.textContent = data.error || '配置未完全成功，请检查上面的步骤后重试';
    }
  });

  domainEl.focus();
}

/** Open the domain wizard from inside the app, to configure an additional domain after the first one. */
function openAddDomain() {
  showDomainWizard({}, { adding: true });
}

/**
 * Render the self-check result as two tables: **sending (Resend)** and **receiving (Cloudflare Email Routing)**.
 * Row names arrive as `<label> · <domain>`; the domain is already in the title, so the suffix is stripped here.
 */
function renderCheckTables(box, items, only) {
  if (!box) return;
  const rows = (Array.isArray(items) ? items : []).map((i) => {
    const name = String(i.name || '');
    const label = only && name.endsWith(` · ${only}`) ? name.slice(0, -(only.length + 3)) : name.replace(/ · .*$/, '');
    return { label, ok: !!i.ok, warn: !!i.warn, detail: String(i.detail || '') };
  });
  const send = rows.filter((r) => !r.label.startsWith('收信'));
  const recv = rows.filter((r) => r.label.startsWith('收信'));
  const table = (caption, list) => {
    if (!list.length) return '';
    const body = list.map((r) => {
      const cls = r.warn ? 'warn' : r.ok ? 'ok' : 'bad';
      const mark = r.warn ? '!' : r.ok ? '✓' : '✕';
      return `<tr class="${cls}">
        <td class="ct-name">${esc(r.label)}</td>
        <td class="ct-state">${mark}</td>
        <td class="ct-detail">${esc(r.detail)}</td>
      </tr>`;
    }).join('');
    return `<table class="check-table">
      <caption>${esc(caption)}</caption>
      <thead><tr><th>项目</th><th>状态</th><th>详情</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  };
  box.innerHTML = table('发信（Resend）', send) + table('收信（Cloudflare Email Routing）', recv);
}

/**
 * Domain self-check panel. Opened by clicking a domain chip's health badge, so it **always** describes exactly one
 * domain: `GET /api/setup/check` still checks them all (the badges need that), the panel filters to this one.
 */
async function showDomainCheck(domain) {
  const only = String(domain || '').trim().toLowerCase();
  const root = gateRoot();
  root.innerHTML = `
    <div class="gate-card gate-wide gate-check">
      <div class="gate-title">域名自检${only ? ` · ${esc(only)}` : ''}</div>
      <div id="gate-error" class="gate-error"></div>
      <div id="gate-loading" class="gate-loading"><span class="spinner" aria-hidden="true"></span>检查中…</div>
      <div id="gate-tables" class="gate-tables hidden"></div>
      <details class="gate-edit" id="gate-edit">
        <summary>${only ? `修改 ${esc(only)} 的发信 Key` : '修改发信 Key'}</summary>
        <label class="gate-field"><span>${only ? `Resend API Key · ${esc(only)}（留空则不修改）` : 'Resend API Key（留空则不修改）'}</span>
          <input id="set-key" type="password" value="" placeholder="re_…" autocomplete="off" /></label>
        <div class="gate-actions"><button class="btn btn-primary" id="set-save" type="button">保存并重新检查</button></div>
      </details>
      <div class="gate-actions">
        <button class="btn" id="gate-close" type="button">关闭</button>
        <button class="btn btn-primary" id="gate-rerun" type="button">重新检查</button>
      </div>
    </div>`;
  const tables = $('#gate-tables');
  const loading = $('#gate-loading');
  const err = $('#gate-error');
  const rerunBtn = $('#gate-rerun');
  let prefilled = false;
  /** Only this domain's rows (`<label> · <domain>`); the panel describes a single domain. */
  const visibleItems = (items) => {
    const list = Array.isArray(items) ? items : [];
    if (!only) return list;
    return list.filter((i) => typeof i.name === 'string' && (!/ · /.test(i.name) || i.name.endsWith(` · ${only}`)));
  };
  const applyConfig = (config) => {
    if (!config) return;
    const per = (only && config.domains && config.domains[only]) || null;
    const keyEl = $('#set-key');
    if (keyEl) {
      const masked = per ? per.key_masked : '';
      const src = per ? { domain: '域名绑定', env: '环境变量', none: '未配置' }[per.key_source] || '' : '';
      keyEl.placeholder = masked ? `当前 ${masked}${src ? `（${src}）` : ''}（留空不修改）` : 're_…';
    }
  };
  const run = async () => {
    err.textContent = '';
    rerunBtn.disabled = true;
    loading.classList.remove('hidden');
    tables.classList.add('hidden');
    const r = await probe('/api/setup/check');
    // The panel may have been closed while the check was in flight (关闭) — don't touch detached nodes.
    if (!rerunBtn.isConnected) return;
    rerunBtn.disabled = false;
    loading.classList.add('hidden');
    if (!r.res || !r.res.ok || !r.data) {
      err.textContent = (r.data && r.data.error) || '检查失败，请重试';
      return;
    }
    renderCheckTables(tables, visibleItems(r.data.items), only);
    tables.classList.remove('hidden');
    applyDomainHealth(r.data); // keep the corner badges in sync with what the panel just showed
    if (!prefilled) { applyConfig(r.data.config); prefilled = true; }
  };
  $('#set-save').addEventListener('click', async () => {
    const saveBtn = $('#set-save');
    err.textContent = '';
    saveBtn.disabled = true;
    const r = await probe('/api/settings/send', {
      method: 'POST',
      body: JSON.stringify({
        domain: only || undefined, // the key is bound to the domain
        resend_key: $('#set-key').value.trim(),
      }),
    });
    if (!saveBtn.isConnected) return;
    saveBtn.disabled = false;
    if (!r.res || !r.res.ok) {
      err.textContent = (r.data && r.data.error) || '保存失败';
      return;
    }
    const warning = r.data.key_check && (r.data.key_check.warning || '');
    const seen = r.data.key_check && Array.isArray(r.data.key_check.domains)
      ? `，这把 Key 能看到：${r.data.key_check.domains.map((d) => `${d.name}(${d.status})`).join('、') || '（无）'}`
      : '';
    showToast(`${only ? `${only} 的` : ''}发信设置已保存${seen}${warning ? ` · ${warning}` : ''}`);
    $('#set-key').value = '';
    prefilled = false;
    await run();
  });
  $('#gate-close').addEventListener('click', hideGate);
  rerunBtn.addEventListener('click', () => void run());
  await run();
}

/* ---------------- Initialization ---------------- */

async function loadAccount() {
  try {
    const account = await api('/api/account');
    state.canSend = !!account.can_send;
    state.fromAddress = account.from_address;
    state.fromName = account.from_name;
    state.domains = Array.isArray(account.domains) && account.domains.length
      ? account.domains.map((d) => String(d).toLowerCase()).filter(Boolean)
      : (account.domain ? [String(account.domain).toLowerCase()] : []);
    // Configured default senders: needed before a domain has any message history (see composerMailboxOptions).
    state.senders = Array.isArray(account.senders)
      ? account.senders.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : [];
    // Drop restored domain ticks that are no longer configured.
    if (Array.isArray(state.domainSel) && state.domainSel.length) {
      state.domainSel = state.domains.filter((d) => state.domainSel.includes(d));
    }
    renderDomainBar();
  } catch (e) {
    showToast(e.message, true);
  }
}

async function init() {
  // 0) Setup wizard / login gate: not initialized → wizard; session mode not logged in → login box.
  //    On a hit, stop here (don't load mailbox data) and wait for the user to finish, then reload into the app.
  if (!(await bootstrapGate())) return;

  // 1) Synchronously restore local cache → first paint shows the list / count badges / account dropdown with 0 requests
  const restored = restorePersisted();
  restoreDomainHealth(); // last known domain health, so the corner badges paint immediately (may be refreshed below)
  const mailboxAtStart = state.mailbox;
  const domainAtStart = domainParam();

  setupEvents();
  applyListWidth(loadListWidth()); // restore the list width set by the last drag (null if not customized, using the CSS default)
  syncLayout(); // align layout state first (the first paint may already fall within the mobile breakpoint)
  renderNav();
  renderMailboxSelect();
  renderDomainBar();
  renderListTitle();

  if (restored) {
    state.loading = false;
    paintList();
    syncActiveRow();
    if (state.openId && state.items.some((it) => it.id === state.openId)) {
      state.pendingOpenId = state.openId; // reopen on demand later (if the body is already in the local snapshot it renders directly, no request)
    } else {
      state.openId = null;
    }
  } else {
    closeMessagePane();
  }

  // 2) Fire the four requests concurrently, no longer serially awaited (loadFolder uses the cached mailbox; correct it if the account list comes back different)
  await Promise.all([
    loadAccount(),
    loadMailboxes(true),
    refreshCounts(true),
    loadFolder(),
    loadInboundAlerts(),
    loadBackendStatus(),
  ]);

  // 3) Per-domain unread badges + automatic domain health (the health result comes from cache first, then refreshes).
  void refreshDomainCounts(true);
  // Domain health: the badges are already painted from cache; the self-check runs by itself at most every 30 min
  //    (and every 5 minutes the throttle is re-evaluated, so a long-open tab keeps refreshing).
  void refreshDomainHealth();
  startDomainHealthTimer();

  // The restored mailbox/domain filter may have been dropped by loadAccount (no longer configured); refresh with the corrected filter.
  if (state.mailbox !== mailboxAtStart || domainParam() !== domainAtStart) {
    state.cache.mailboxesAt = 0;
    state.cache.countsAt = 0;
    renderMailboxSelect();
    void loadMailboxes(true);
    void refreshCounts(true);
    void loadFolder(false, true);
  }

  // 3) Restore the previously opened email (only if it's still in the current list)
  if (state.pendingOpenId) {
    const id = state.pendingOpenId;
    state.pendingOpenId = null;
    void openMessage(id);
  }

  setInterval(periodicSync, SYNC_MS);
  // On the page becoming visible again, run one more sync (catching up refreshes skipped while hidden) and continue the unfinished body prefetch
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void periodicSync();
      prefetchBodies();
    }
  });
}

init();
