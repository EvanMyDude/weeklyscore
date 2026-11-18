import {
  weekKeyForDate,
  isWeekKey,
  addWeeks,
  formatWeekLabel,
  formatWeekRange,
} from './week.js';

// Supabase project. The publishable key is meant to ship in client code: it
// only identifies the project, and every function behind it checks the
// access key from the embed URL (see supabase/schema.sql).
const SUPABASE_URL = 'https://uapcjhbsxvbwhhyieslb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_n5Ah4b4s5eTzcgIIYG1Dmg_4z6XgUeR';

const THEME_STORAGE_KEY = 'weeklyscore-theme'; // same key theme.js reads
const TEXT_SAVE_DELAY_MS = 600;
const CLEAR_CONFIRM_MS = 4000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;
const REFRESH_MIN_INTERVAL_MS = 10000;
const STATUS_FLASH_MS = 1500;
const KEEPALIVE_MAX_BYTES = 60000;

const NO_SCORE = {
  title: 'No score yet.',
  body: 'Pick the honest number. Future-you gets the saved snapshot.',
};
const SCORE_BANDS = [
  { max: 3, title: 'Rough week.', body: 'Name what got in the way, then pick the one fix.' },
  { max: 6, title: 'Mixed week.', body: 'Some progress, some drag. Find what would have tipped it.' },
  { max: 8, title: 'Solid week.', body: 'Good momentum. Write down what drove it so you can repeat it.' },
  { max: 10, title: 'Strong week.', body: 'Capture exactly what worked while it is fresh.' },
];

const STATUS = {
  loading: { text: 'Loading…', tone: 'busy' },
  saving: { text: 'Saving…', tone: 'busy' },
  saved: { text: 'Autosaved', tone: 'ok' },
  retrying: { text: 'Not saved, retrying', tone: 'bad' },
  failed: { text: 'Not saved', tone: 'bad' },
  copied: { text: 'Copied', tone: 'ok' },
};

const BLOCKED = {
  nokey: {
    title: 'Access key missing.',
    body: 'Open this page from your Notion embed. Its link ends in ?k= followed by your access key.',
    retry: false,
  },
  auth: {
    title: 'Access key not recognized.',
    body: 'Check that the embed link has the whole key after ?k=. If you rotated the key, update the link.',
    retry: false,
  },
  network: {
    title: "Can't reach the database.",
    body: 'Check your connection. If Supabase paused the project for inactivity, restore it from the Supabase dashboard, then retry.',
    retry: true,
  },
};

// ws_save parameter -> row field
const FIELD_FOR_PARAM = {
  p_score: 'score',
  p_moved_needle: 'moved_needle',
  p_one_change: 'one_change',
};

/* ---------- API ---------- */

class ApiError extends Error {
  // kind: 'auth' (wrong key), 'network' (worth retrying), 'rejected' (bad input)
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

async function rpc(name, body) {
  const json = JSON.stringify(body);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: json,
      // Lets a save finish even if Notion unloads the embed mid-request.
      // Browsers refuse keepalive bodies over 64 KB, so very long text skips it.
      keepalive: new Blob([json]).size < KEEPALIVE_MAX_BYTES,
    });
  } catch (err) {
    throw new ApiError('network', err.message);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return data;
  if (data?.code === '28000') throw new ApiError('auth', data.message);
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new ApiError('network', data?.message || `HTTP ${res.status}`);
  }
  throw new ApiError('rejected', data?.message || `HTTP ${res.status}`);
}

function readAccessKey() {
  const fromQuery = new URLSearchParams(window.location.search).get('k');
  if (fromQuery) return fromQuery;
  return new URLSearchParams(window.location.hash.slice(1)).get('k') || null;
}

/* ---------- State ---------- */

const $ = (id) => document.getElementById(id);
const el = {
  themeToggle: $('theme-toggle'),
  blocked: $('blocked'),
  blockedTitle: $('blocked-title'),
  blockedBody: $('blocked-body'),
  retry: $('retry'),
  app: $('app'),
  weekInput: $('week-input'),
  weekRange: $('week-range'),
  weekPrev: $('week-prev'),
  weekNext: $('week-next'),
  scores: $('scores'),
  scoreButtons: [...document.querySelectorAll('.score')],
  panelTitle: $('panel-title'),
  panelBody: $('panel-body'),
  meterFill: $('meter-fill'),
  moved: $('moved-needle'),
  change: $('one-change'),
  copy: $('copy'),
  clear: $('clear'),
  copyFallback: $('copy-fallback'),
  copyText: $('copy-text'),
  copyDone: $('copy-done'),
  status: $('status'),
  historyTitle: $('history-title'),
  historyEmpty: $('history-empty'),
  historyList: $('history-list'),
};

// Browsers without a week picker (Safari, the Notion iOS app) downgrade the
// input to text; there it shows the label read-only and ‹ › do the picking.
const hasNativeWeekInput = el.weekInput.type === 'week';

const state = {
  key: readAccessKey(),
  week: weekKeyForDate(new Date()),
  rows: new Map(), // week -> { week, score, moved_needle, one_change, updated_at }
  pending: new Map(), // week -> unsaved ws_save params, merged
  flushing: null, // promise of the running save loop
  clearing: null, // promise of a running ws_clear
  textTimer: 0,
  retryTimer: 0,
  retryDelay: 0,
  clearTimer: 0,
  flashTimer: 0,
  status: 'loading',
  blocked: null,
  lastLoadAt: 0,
};

const emptyRow = (week) => ({ week, score: null, moved_needle: '', one_change: '', updated_at: null });
const rowFor = (week) => state.rows.get(week) ?? emptyRow(week);
const hasContent = (row) =>
  row.score != null || row.moved_needle.trim() !== '' || row.one_change.trim() !== '';

function withPatch(row, patch) {
  const next = { ...row };
  for (const [param, value] of Object.entries(patch)) next[FIELD_FOR_PARAM[param]] = value;
  return next;
}

/* ---------- Saving ---------- */

// Records an edit to the selected week locally and queues it for saving.
function edit(patch) {
  const week = state.week;
  state.pending.set(week, { ...state.pending.get(week), ...patch });
  state.rows.set(week, withPatch(rowFor(week), patch));
  disarmClear();
}

function flush() {
  clearTimeout(state.textTimer);
  clearTimeout(state.retryTimer);
  state.textTimer = 0;
  state.retryTimer = 0;
  if (state.flushing) return state.flushing; // the running loop picks up new edits
  if (!state.pending.size || state.blocked) return Promise.resolve();
  state.flushing = saveLoop()
    .then((rejected) => {
      state.retryDelay = 0;
      setStatus(rejected ? 'failed' : 'saved');
    })
    .catch(onSaveError)
    .finally(() => {
      state.flushing = null;
      if (state.pending.size && !state.retryTimer && !state.blocked) flush();
    });
  return state.flushing;
}

// Sends one week's merged edits at a time, oldest first, until nothing is left.
// Resolves to true if the server rejected an edit as invalid.
async function saveLoop() {
  setStatus('saving');
  await state.clearing;
  let rejected = false;
  while (state.pending.size) {
    const [week, patch] = state.pending.entries().next().value;
    state.pending.delete(week);
    try {
      acceptServerRow(await rpc('ws_save', { k: state.key, p_week: week, ...patch }));
    } catch (err) {
      if (err.kind === 'rejected') {
        rejected = true;
        continue;
      }
      // Put it back under any edits made while it was in flight.
      state.pending.set(week, { ...patch, ...state.pending.get(week) });
      throw err;
    }
  }
  return rejected;
}

function onSaveError(err) {
  if (err.kind === 'auth') {
    block('auth');
    return;
  }
  state.retryDelay = Math.min(Math.max(RETRY_MIN_MS, state.retryDelay * 2), RETRY_MAX_MS);
  setStatus('retrying');
  state.retryTimer = setTimeout(flush, state.retryDelay);
}

function acceptServerRow(saved) {
  if (!saved?.week) return;
  const pending = state.pending.get(saved.week);
  state.rows.set(saved.week, pending ? withPatch(saved, pending) : saved);
  render();
}

/* ---------- Loading ---------- */

async function load({ background = false } = {}) {
  if (!state.key) {
    block('nokey');
    return;
  }
  // A list fetched mid-save could briefly show the pre-save values.
  if (background && (state.flushing || state.pending.size || state.clearing)) return;
  state.lastLoadAt = Date.now();
  if (!background) setStatus('loading');
  el.retry.disabled = true;
  let list;
  try {
    list = await rpc('ws_list', { k: state.key });
  } catch (err) {
    if (err.kind === 'auth') block('auth');
    else if (!background) block('network');
    return;
  } finally {
    el.retry.disabled = false;
  }
  const rows = new Map((list ?? []).map((row) => [row.week, row]));
  for (const [week, patch] of state.pending) {
    rows.set(week, withPatch(rows.get(week) ?? emptyRow(week), patch));
  }
  state.rows = rows;
  unblock();
  render();
  if (!state.flushing && !state.pending.size && !state.retryTimer) setStatus('saved');
}

function refreshSoon() {
  if (state.blocked === 'network') {
    load();
    return;
  }
  if (state.blocked || Date.now() - state.lastLoadAt < REFRESH_MIN_INTERVAL_MS) return;
  load({ background: true });
}

/* ---------- Rendering ---------- */

function render({ forceText = false } = {}) {
  const row = rowFor(state.week);

  // Only write on change, so a save landing mid-edit doesn't reset the picker.
  const weekValue = hasNativeWeekInput ? state.week : formatWeekLabel(state.week);
  if (el.weekInput.value !== weekValue) el.weekInput.value = weekValue;
  el.weekRange.textContent = formatWeekRange(state.week);

  for (const button of el.scoreButtons) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.score) === row.score));
  }

  const band = row.score == null ? NO_SCORE : SCORE_BANDS.find((b) => row.score <= b.max);
  el.panelTitle.textContent = row.score == null ? band.title : `${row.score}/10 · ${band.title}`;
  el.panelBody.textContent = band.body;
  el.meterFill.style.width = row.score == null ? '' : `${row.score * 10}%`;

  syncText(el.moved, row.moved_needle, forceText);
  syncText(el.change, row.one_change, forceText);

  renderHistory();
}

// Never overwrite the box being typed in, except when the week changes.
function syncText(textarea, value, force) {
  if (textarea.value === value) return;
  if (force || document.activeElement !== textarea) textarea.value = value;
}

function renderHistory() {
  el.clear.disabled = !hasContent(rowFor(state.week)) && el.clear.dataset.armed !== 'true';

  const rows = [...state.rows.values()]
    .filter(hasContent)
    .sort((a, b) => (a.week < b.week ? 1 : -1));
  el.historyTitle.hidden = rows.length === 0;
  el.historyEmpty.hidden = rows.length > 0;

  const focusedWeek = document.activeElement?.closest?.('.history-item')?.dataset.week;
  el.historyList.replaceChildren(...rows.map(historyItem));
  if (focusedWeek) el.historyList.querySelector(`[data-week="${focusedWeek}"]`)?.focus();
}

function historyItem(row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'history-item';
  button.dataset.week = row.week;
  if (row.week === state.week) button.setAttribute('aria-current', 'true');

  const score = textSpan('history-score', row.score == null ? 'No score' : `${row.score}/10`);
  if (row.score == null) score.dataset.empty = 'true';
  button.append(
    textSpan('history-week', formatWeekLabel(row.week)),
    textSpan('history-range', formatWeekRange(row.week)),
    score,
  );

  const item = document.createElement('li');
  item.append(button);
  return item;
}

function textSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function setStatus(name, text) {
  clearTimeout(state.flashTimer);
  state.status = name;
  el.status.textContent = text ?? STATUS[name].text;
  el.status.dataset.tone = STATUS[name].tone;
}

function flashStatus(name) {
  const previous = { name: state.status, text: el.status.textContent };
  setStatus(name);
  state.flashTimer = setTimeout(() => {
    if (state.status === name) setStatus(previous.name, previous.text);
  }, STATUS_FLASH_MS);
}

function block(kind) {
  state.blocked = kind;
  const message = BLOCKED[kind];
  el.blockedTitle.textContent = message.title;
  el.blockedBody.textContent = message.body;
  el.retry.hidden = !message.retry;
  el.blocked.hidden = false;
  el.app.hidden = true;
}

function unblock() {
  state.blocked = null;
  el.blocked.hidden = true;
  el.app.hidden = false;
  el.app.disabled = false;
}

function renderThemeToggle() {
  const isLight = document.documentElement.dataset.theme === 'light';
  el.themeToggle.textContent = isLight ? 'Dark mode' : 'Light mode';
}

/* ---------- Actions ---------- */

function selectWeek(week) {
  if (!isWeekKey(week)) {
    render();
    return;
  }
  if (week === state.week) return;
  flush();
  state.week = week;
  disarmClear();
  hideCopyFallback();
  render({ forceText: true });
}

function onTextInput(param, textarea) {
  edit({ [param]: textarea.value });
  setStatus('saving');
  renderHistory();
  clearTimeout(state.textTimer);
  state.textTimer = setTimeout(flush, TEXT_SAVE_DELAY_MS);
}

function onClear() {
  if (el.clear.dataset.armed !== 'true') {
    el.clear.dataset.armed = 'true';
    el.clear.textContent = 'Tap again to clear';
    state.clearTimer = setTimeout(disarmClear, CLEAR_CONFIRM_MS);
    return;
  }
  disarmClear();
  state.clearing = clearWeek(state.week).finally(() => {
    state.clearing = null;
  });
}

function disarmClear() {
  clearTimeout(state.clearTimer);
  if (el.clear.dataset.armed !== 'true') return;
  delete el.clear.dataset.armed;
  el.clear.textContent = 'Clear this week';
  renderHistory();
}

async function clearWeek(week) {
  const previous = state.rows.get(week);
  state.pending.delete(week);
  state.rows.delete(week);
  render({ forceText: true });
  setStatus('saving');
  try {
    await state.flushing; // a save already in flight must land before the delete
    await rpc('ws_clear', { k: state.key, p_week: week });
    // That in-flight save may have put the row back on screen; the delete won.
    if (!state.pending.has(week) && state.rows.delete(week)) render({ forceText: true });
    if (!state.flushing && !state.pending.size && !state.retryTimer) setStatus('saved');
  } catch (err) {
    if (err.kind === 'auth') {
      block('auth');
      return;
    }
    if (previous && !state.rows.has(week)) state.rows.set(week, previous);
    render({ forceText: true });
    setStatus('failed', 'Not cleared, try again');
  }
}

function summaryText() {
  const row = rowFor(state.week);
  const lines = [
    `${formatWeekLabel(state.week)} (${formatWeekRange(state.week)})`,
    `Score: ${row.score == null ? 'not scored' : `${row.score}/10`}`,
  ];
  if (row.moved_needle.trim()) lines.push('', 'Moved the needle:', row.moved_needle.trim());
  if (row.one_change.trim()) lines.push('', 'One change next week:', row.one_change.trim());
  return lines.join('\n');
}

async function onCopy() {
  const text = summaryText();
  if (await writeClipboard(text)) {
    hideCopyFallback();
    el.copy.focus();
    flashStatus('copied');
    return;
  }
  // The embed blocks clipboard access: show the text selected for a manual copy.
  el.copyText.value = text;
  el.copyFallback.hidden = false;
  el.copyText.focus();
  el.copyText.select();
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not allowed in this frame; try the older copy command.
  }
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.readOnly = true;
  scratch.className = 'offscreen';
  document.body.append(scratch);
  scratch.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  scratch.remove();
  return copied;
}

function hideCopyFallback() {
  el.copyFallback.hidden = true;
  el.copyText.value = '';
}

/* ---------- Wiring ---------- */

el.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Storage blocked in this frame; the choice lasts until the page reloads.
  }
  renderThemeToggle();
});

el.retry.addEventListener('click', () => load());

el.weekInput.addEventListener('change', () => {
  if (hasNativeWeekInput) selectWeek(el.weekInput.value);
});
el.weekPrev.addEventListener('click', () => selectWeek(addWeeks(state.week, -1)));
el.weekNext.addEventListener('click', () => selectWeek(addWeeks(state.week, 1)));

el.scores.addEventListener('click', (event) => {
  const button = event.target.closest('.score');
  if (!button) return;
  edit({ p_score: Number(button.dataset.score) });
  render();
  flush();
});

el.moved.addEventListener('input', () => onTextInput('p_moved_needle', el.moved));
el.change.addEventListener('input', () => onTextInput('p_one_change', el.change));
el.moved.addEventListener('blur', () => flush());
el.change.addEventListener('blur', () => flush());

el.copy.addEventListener('click', onCopy);
el.copyDone.addEventListener('click', () => {
  hideCopyFallback();
  el.copy.focus();
});
el.clear.addEventListener('click', onClear);

el.historyList.addEventListener('click', (event) => {
  const item = event.target.closest('.history-item');
  if (item) selectWeek(item.dataset.week);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
  else refreshSoon();
});
window.addEventListener('pagehide', () => flush());
window.addEventListener('focus', refreshSoon);
window.addEventListener('online', () => {
  if (state.blocked === 'network') load();
  else flush();
});

renderThemeToggle();
if (!hasNativeWeekInput) el.weekInput.readOnly = true;
render({ forceText: true });
load();
