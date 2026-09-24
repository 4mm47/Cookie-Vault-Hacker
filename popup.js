// popup.js - Cookie Vault popup controller.
//
// Rendering rules that matter here:
//   * Cookie names/values come from websites (i.e. from untrusted input), so the
//     DOM is built exclusively with createElement/textContent. Markup strings are
//     never assembled or injected - that is how a privileged extension page gets
//     XSSed, which the previous popup.js did with its status line.
//   * Everything long-running shows a busy state and reports through the single
//     aria-live status region.

'use strict';

/** Message types shared with background.js. */
const MESSAGE = Object.freeze({
  PING: 'PING',
  SCAN_COOKIES: 'SCAN_COOKIES',
  EXPORT_COOKIES: 'EXPORT_COOKIES'
});

const PREFS_KEY = 'cookieVault.prefs';

const DEFAULT_PREFS = Object.freeze({
  scope: 'tab',
  format: 'netscape',
  hideValues: false,
  includeExpired: false,
  askWhere: false
});

/** Rows rendered at once; the rest stay reachable through the filter box. */
const RENDER_LIMIT = 300;

const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Chrome handles short data: URLs perfectly and they stay valid even if this
 * popup closes mid-download (useful when "Ask where to save" is on). Beyond this
 * size we switch to an object URL, which has no length limit but is tied to this
 * document's lifetime.
 */
const DATA_URL_LIMIT = 512 * 1024;

const PREVIEW_LIMIT = 4000;

/** Actionable hints for the error codes background.js returns. */
const ERROR_HINTS = Object.freeze({
  NO_TAB: 'Open a website tab, then reopen the popup.',
  UNSUPPORTED_URL: 'Browser pages (chrome://, edge://), the Web Store and extension pages expose no cookies. Switch to a normal website.',
  NO_COOKIES: 'Sign in to the site first, or widen the scope to "Whole site" or "Everything".',
  READ_FAILED: 'Reload the extension from chrome://extensions and try again.',
  BAD_REQUEST: 'Reload the extension: the popup and the background worker are out of sync.',
  MESSAGING: 'The background worker did not answer. Reload the extension from chrome://extensions.',
  UNEXPECTED: 'Open chrome://extensions > Cookie Vault > "service worker" to see the console error.'
});

const state = {
  prefs: Object.assign({}, DEFAULT_PREFS),
  context: null,
  stats: null,
  rows: [],
  scopeLabel: '',
  truncated: false,
  filter: 'all',
  query: '',
  expanded: Object.create(null),
  lastPayload: null,
  busy: false
};

/** Cached element references, filled by cacheElements(). */
const el = {};

const FILTERS = Object.freeze(['all', 'session', 'persistent', 'secure', 'httponly', 'expiring']);

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function normalizePrefs(raw) {
  const source = Object.assign({}, DEFAULT_PREFS, raw || {});
  const prefs = {
    scope: source.scope,
    format: source.format,
    hideValues: Boolean(source.hideValues),
    includeExpired: Boolean(source.includeExpired),
    askWhere: Boolean(source.askWhere)
  };

  if (prefs.scope !== 'tab' && prefs.scope !== 'site' && prefs.scope !== 'all') prefs.scope = DEFAULT_PREFS.scope;
  if (typeof prefs.format !== 'string' || prefs.format.length === 0) prefs.format = DEFAULT_PREFS.format;
  return prefs;
}

async function loadPrefs() {
  try {
    const stored = await chrome.storage.local.get(PREFS_KEY);
    return normalizePrefs(stored && stored[PREFS_KEY]);
  } catch (_error) {
    return Object.assign({}, DEFAULT_PREFS); // storage is a nicety, not a requirement
  }
}

function savePrefs() {
  try {
    const payload = {};
    payload[PREFS_KEY] = state.prefs;
    chrome.storage.local.set(payload);
  } catch (_error) {
    /* Preferences are best-effort only. */
  }
}

// ---------------------------------------------------------------------------
// Messaging, status and busy state
// ---------------------------------------------------------------------------

/**
 * Send one message to the background worker and normalise the reply into the
 * `{ok, ...}` envelope, so the caller never has to reason about null responses.
 */
async function send(type, payload) {
  const request = Object.assign({ type: type }, payload || {});
  try {
    const response = await chrome.runtime.sendMessage(request);
    if (!response || typeof response !== 'object') {
      return {
        ok: false,
        error: { code: 'MESSAGING', message: 'The background worker returned an empty response.' }
      };
    }
    return response;
  } catch (error) {
    return {
      ok: false,
      error: { code: 'MESSAGING', message: (error && error.message) || String(error) }
    };
  }
}

/** Compose a user-facing sentence for a failure envelope. */
function describeError(envelope) {
  const error = (envelope && envelope.error) || {};
  const code = error.code || 'UNEXPECTED';
  const hint = ERROR_HINTS[code];
  const message = error.message || 'Unknown failure.';
  return hint ? message + '\n' + hint : message;
}

let toastTimer = null;

function showToast(message, kind) {
  if (!el.statusRegion) return;
  el.statusRegion.textContent = message;
  el.statusRegion.className = 'toast is-visible' + (kind ? ' is-' + kind : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.statusRegion.className = 'toast';
  }, kind === 'error' ? 9000 : 4500);
}

function setBusy(busy, label) {
  state.busy = busy;
  [el.scanBtn, el.exportBtn, el.copyBtn].forEach((button) => {
    if (button) button.disabled = busy;
  });
  if (busy && label) showToast(label, 'busy');
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/** Short label for the table's "Expires" column. */
function shortExpiry(row) {
  if (row.session) return 'session';
  if (row.expired) return 'expired';
  return String(row.expiresHuman || '').replace(/^in /, '');
}

function isExpiringSoon(row, nowMs) {
  if (!row || row.session || row.expired || !row.expiresEpoch) return false;
  return row.expiresEpoch * 1000 - nowMs <= EXPIRING_SOON_MS;
}

/** Apply the active chip filter plus the free-text query. */
function filterRows(rows, filter, query, nowMs) {
  const needle = String(query || '').trim().toLowerCase();
  const now = typeof nowMs === 'number' ? nowMs : Date.now();

  return (rows || []).filter((row) => {
    if (filter === 'session' && !row.session) return false;
    if (filter === 'persistent' && row.session) return false;
    if (filter === 'secure' && !row.secure) return false;
    if (filter === 'httponly' && !row.httpOnly) return false;
    if (filter === 'expiring' && !isExpiringSoon(row, now)) return false;

    if (!needle) return true;
    return (
      row.name.toLowerCase().indexOf(needle) !== -1 ||
      String(row.value).toLowerCase().indexOf(needle) !== -1 ||
      String(row.domain).toLowerCase().indexOf(needle) !== -1 ||
      String(row.path).toLowerCase().indexOf(needle) !== -1
    );
  });
}

/**
 * Build the URL handed to chrome.downloads.download.
 * @returns {{url: string, strategy: string, revoke: boolean}}
 */
function buildDownloadUrl(text, mimeType, dataUrlLimit) {
  const limit = typeof dataUrlLimit === 'number' ? dataUrlLimit : DATA_URL_LIMIT;
  const dataUrl = 'data:' + mimeType + ',' + encodeURIComponent(text);

  if (dataUrl.length <= limit) {
    return { url: dataUrl, strategy: 'data-url', revoke: false };
  }
  return {
    url: URL.createObjectURL(new Blob([text], { type: mimeType })),
    strategy: 'blob-url',
    revoke: true
  };
}

function truncateForPreview(text, limit) {
  const max = typeof limit === 'number' ? limit : PREVIEW_LIMIT;
  if (text.length <= max) return { text: text, truncated: false, total: text.length };
  return { text: text.slice(0, max), truncated: true, total: text.length };
}

// ---------------------------------------------------------------------------
// Header, stats and table rendering
// ---------------------------------------------------------------------------

function setText(node, text) {
  if (node) node.textContent = text;
}

function updateContextHeader(context) {
  if (context) {
    setText(el.siteHost, context.host || 'unknown host');
    setText(el.siteTitle, context.title || context.url || '');
    if (el.siteFavicon) {
      if (context.favIconUrl) {
        el.siteFavicon.src = context.favIconUrl;
        el.siteFavicon.hidden = false;
      } else {
        el.siteFavicon.hidden = true;
        el.siteFavicon.removeAttribute('src');
      }
    }
    if (el.siteBadge) el.siteBadge.hidden = true;
    return;
  }

  // Pre-scan fallback: read the tab directly so the popup is never blank.
  chrome.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => {
      const tab = tabs && tabs[0];
      const url = (tab && (tab.url || tab.pendingUrl)) || '';
      const isWeb = /^https?:\/\//i.test(url);
      let host = 'unknown host';
      if (isWeb) {
        try {
          host = new URL(url).hostname;
        } catch (_error) {
          host = url;
        }
      }
      setText(el.siteHost, isWeb ? host : 'Not a web page');
      setText(el.siteTitle, isWeb ? tab.title || url : 'Cookie inspection needs a normal http/https site.');
      if (el.siteBadge) el.siteBadge.hidden = isWeb;
    })
    .catch(() => {
      setText(el.siteHost, 'Current tab unavailable');
    });
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;

  setText(el.statTotal, stats.total);
  setText(el.statSession, stats.session);
  setText(el.statPersistent, stats.persistent);
  setText(el.statSecure, stats.secure);
  setText(el.statHttpOnly, stats.httpOnly);
  setText(el.statExpiring, stats.expiringSoon);
  setText(el.statsScope, state.scopeLabel ? '- ' + state.scopeLabel : '');

  const parts = [
    stats.domains + (stats.domains === 1 ? ' domain' : ' domains'),
    formatBytes(stats.totalBytes) + ' of cookie data'
  ];
  if (stats.sameSiteNone) parts.push(stats.sameSiteNone + ' SameSite=None');
  if (stats.partitioned) parts.push(stats.partitioned + ' partitioned (CHIPS)');
  if (stats.expired) parts.push(stats.expired + ' already expired');
  if (stats.largest) {
    parts.push('largest: ' + stats.largest.name + ' (' + formatBytes(stats.largest.sizeBytes) + ')');
  }
  if (state.truncated) parts.push('list capped for safety');
  setText(el.statsExtra, parts.join(' \u00b7 '));
}

function renderFlags(row) {
  const wrapper = document.createDocumentFragment();
  const add = (label, className, title) => {
    const span = document.createElement('span');
    span.className = 'flag' + (className ? ' ' + className : '');
    span.textContent = label;
    if (title) span.title = title;
    wrapper.appendChild(span);
  };

  if (row.secure) add('Secure', 'flag-secure', 'Only sent over HTTPS');
  if (row.httpOnly) add('HttpOnly', 'flag-httponly', 'Not readable from JavaScript');
  if (row.sameSite === 'lax') add('Lax', '', 'SameSite=Lax');
  if (row.sameSite === 'strict') add('Strict', '', 'SameSite=Strict');
  if (row.sameSite === 'no_restriction') add('None', '', 'SameSite=None (sent cross-site)');
  if (row.hostOnly) add('host', '', 'Host-only: not shared with sub-domains');
  if (row.partitioned) add('CHIPS', '', 'Partitioned cookie');
  if (row.expired) add('expired', '', 'Already expired - excluded from exports unless you include them');

  if (!wrapper.hasChildNodes()) add('none', '', 'No flags set');
  return wrapper;
}

/** Build the expandable detail row for one cookie. */
function buildDetailRow(row, index) {
  const tr = document.createElement('tr');
  tr.className = 'detail-row';
  tr.dataset.detailFor = String(index);

  const td = document.createElement('td');
  td.colSpan = 4;

  const value = document.createElement('div');
  value.className = 'detail-value';
  value.textContent = row.value.length ? row.value : '(empty value)';
  td.appendChild(value);

  const meta = document.createElement('p');
  meta.className = 'detail-meta';
  meta.textContent =
    'domain ' + row.domain + ' | path ' + row.path + ' | ' + row.sizeBytes + ' bytes' +
    (row.expiresIso ? ' | expires ' + row.expiresIso : ' | session cookie');
  td.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'preview-actions';

  const copyValue = document.createElement('button');
  copyValue.type = 'button';
  copyValue.className = 'btn btn-tiny';
  copyValue.dataset.action = 'copy-value';
  copyValue.dataset.index = String(index);
  copyValue.textContent = 'Copy value';

  const copyPair = document.createElement('button');
  copyPair.type = 'button';
  copyPair.className = 'btn btn-tiny';
  copyPair.dataset.action = 'copy-pair';
  copyPair.dataset.index = String(index);
  copyPair.textContent = 'Copy name=value';

  actions.appendChild(copyValue);
  actions.appendChild(copyPair);
  td.appendChild(actions);

  tr.appendChild(td);
  return tr;
}

function updateResultsMeta(visibleCount) {
  const total = state.rows.length;
  const shown = Math.min(visibleCount, RENDER_LIMIT);
  let text = 'Showing ' + shown + ' of ' + total + ' cookie' + (total === 1 ? '' : 's');
  if (visibleCount > RENDER_LIMIT) {
    text += ' - narrow the filter to reach the remaining ' + (visibleCount - RENDER_LIMIT);
  }
  setText(el.resultsMeta, text);
}

function renderTable() {
  const visible = filterRows(state.rows, state.filter, state.query);
  const fragment = document.createDocumentFragment();
  const limit = Math.min(visible.length, RENDER_LIMIT);

  for (let index = 0; index < limit; index += 1) {
    const row = visible[index];
    const tr = document.createElement('tr');
    tr.dataset.index = String(index);
    tr.tabIndex = 0;
    tr.setAttribute('aria-expanded', state.expanded[index] ? 'true' : 'false');

    const nameCell = document.createElement('td');
    nameCell.className = 'name-cell';
    nameCell.textContent = row.name;

    const valueCell = document.createElement('td');
    valueCell.className = 'value-cell';
    valueCell.textContent = row.maskedValue;
    valueCell.title = 'Select the row to reveal and copy the value';

    const flagCell = document.createElement('td');
    flagCell.appendChild(renderFlags(row));

    const expiryCell = document.createElement('td');
    expiryCell.className = 'expires-cell';
    expiryCell.textContent = shortExpiry(row);
    if (row.expiresIso) expiryCell.title = row.expiresIso;

    tr.appendChild(nameCell);
    tr.appendChild(valueCell);
    tr.appendChild(flagCell);
    tr.appendChild(expiryCell);
    fragment.appendChild(tr);

    if (state.expanded[index]) fragment.appendChild(buildDetailRow(row, index));
  }

  el.cookieTableBody.textContent = '';
  el.cookieTableBody.appendChild(fragment);

  updateResultsMeta(visible.length);

  const isEmpty = visible.length === 0;
  el.emptyState.hidden = !isEmpty;
  if (isEmpty) {
    el.emptyState.textContent =
      state.rows.length === 0 ? 'No cookies in this scope.' : 'No cookie matches the current filter.';
  }
}

// ---------------------------------------------------------------------------
// Clipboard, download and preview
// ---------------------------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_error) {
    return false;
  }
}

async function copyWithFeedback(text, successMessage) {
  const copied = await copyText(text);
  if (copied) {
    showToast(successMessage + ' (' + formatBytes(text.length) + ')', 'ok');
  } else {
    showToast('The clipboard is unavailable here. Use "Download file" instead.', 'error');
  }
  return copied;
}

function renderPreview(payload) {
  const preview = truncateForPreview(payload.text);
  el.previewText.textContent = preview.text;
  setText(
    el.previewMeta,
    payload.filename + ' \u00b7 ' + payload.records + ' records \u00b7 ' + formatBytes(payload.bytes) +
      (preview.truncated
        ? ' \u00b7 showing the first ' + formatBytes(preview.text.length) + ' of ' + formatBytes(preview.total)
        : '')
  );
  el.previewPanel.hidden = false;
}

/** Ask the background worker for a finished payload in the current settings. */
function requestPayload() {
  return send(MESSAGE.EXPORT_COOKIES, {
    scope: state.prefs.scope,
    format: state.prefs.format,
    hideValues: state.prefs.hideValues,
    includeExpired: state.prefs.includeExpired
  });
}

/** Build the payload, then let the browser write it to disk. */
async function downloadExport() {
  if (state.busy) return;
  setBusy(true, 'Building the export\u2026');

  const response = await requestPayload();
  if (!response.ok) {
    setBusy(false);
    showToast(describeError(response), 'error');
    return;
  }

  const payload = response.payload;
  state.lastPayload = payload;
  updateContextHeader(response.context);
  renderPreview(payload);

  const target = buildDownloadUrl(payload.text, payload.mimeType);
  try {
    await chrome.downloads.download({
      url: target.url,
      filename: payload.filename,
      saveAs: state.prefs.askWhere
    });
    showToast('Saved ' + payload.filename + ' \u00b7 ' + payload.records + ' cookies', 'ok');
  } catch (error) {
    showToast(
      'The browser refused the download: ' + ((error && error.message) || error) +
        '. Try again with "Ask where to save" enabled.',
      'error'
    );
  } finally {
    if (target.revoke) setTimeout(() => URL.revokeObjectURL(target.url), 300000);
    setBusy(false);
  }
}

/** Build the payload, then put it on the clipboard. */
async function copyExport() {
  if (state.busy) return;
  setBusy(true, 'Building the export\u2026');

  const response = await requestPayload();
  setBusy(false);
  if (!response.ok) {
    showToast(describeError(response), 'error');
    return;
  }

  state.lastPayload = response.payload;
  updateContextHeader(response.context);
  renderPreview(response.payload);

  const copied = await copyWithFeedback(response.payload.text, 'Copied the export to the clipboard');
  if (copied && state.prefs.hideValues) {
    showToast('Copied an export with redacted cookie values.', 'ok');
  }
}

// ---------------------------------------------------------------------------
// Scanning and UI state
// ---------------------------------------------------------------------------

function resetResults() {
  state.rows = [];
  state.stats = null;
  state.expanded = Object.create(null);
  el.statsPanel.hidden = true;
  el.resultsPanel.hidden = true;
  el.previewPanel.hidden = true;
  el.cookieTableBody.textContent = '';
}

function populateFormats(formats) {
  if (!formats || !formats.length) return;
  const previous = el.formatSelect.value || state.prefs.format;

  el.formatSelect.textContent = '';
  formats.forEach((format) => {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = format.label;
    el.formatSelect.appendChild(option);
  });

  const ids = formats.map((format) => format.id);
  el.formatSelect.value = ids.indexOf(previous) !== -1 ? previous : ids[0];
  state.prefs.format = el.formatSelect.value;
}

async function scan() {
  if (state.busy) return;
  setBusy(true, 'Reading cookies\u2026');

  const response = await send(MESSAGE.SCAN_COOKIES, { scope: state.prefs.scope });
  setBusy(false);

  if (!response.ok) {
    resetResults();
    updateContextHeader(null);
    showToast(describeError(response), 'error');
    return;
  }

  state.context = response.context;
  state.stats = response.stats;
  state.rows = response.rows;
  state.scopeLabel = response.scopeLabel;
  state.truncated = response.truncated;
  state.expanded = Object.create(null);

  updateContextHeader(response.context);
  populateFormats(response.formats);

  el.statsPanel.hidden = false;
  el.resultsPanel.hidden = false;
  renderStats();
  renderTable();

  if (response.stats.total === 0) {
    showToast('No cookies found for ' + response.context.host + '. Are you signed in?', 'error');
  } else {
    showToast('Found ' + response.stats.total + ' cookies for ' + response.context.host + '.', 'ok');
  }
}

/** Push the stored preferences into the form controls. */
function applyPrefsToUi() {
  const scopeInput = document.getElementById('scope' + state.prefs.scope.charAt(0).toUpperCase() + state.prefs.scope.slice(1));
  if (scopeInput) scopeInput.checked = true;
  el.optHideValues.checked = state.prefs.hideValues;
  el.optIncludeExpired.checked = state.prefs.includeExpired;
  el.optAskWhere.checked = state.prefs.askWhere;
  if (el.formatSelect.querySelector('option[value="' + state.prefs.format + '"]')) {
    el.formatSelect.value = state.prefs.format;
  }
  el.scopeWarning.hidden = state.prefs.scope !== 'all';
}

function readScopeFromUi() {
  if (el.scopeSite.checked) return 'site';
  if (el.scopeAll.checked) return 'all';
  return 'tab';
}

function setFilter(filter) {
  state.filter = FILTERS.indexOf(filter) === -1 ? 'all' : filter;
  const chips = el.filterChips.querySelectorAll('.chip');
  Array.prototype.forEach.call(chips, (chip) => {
    chip.classList.toggle('is-active', chip.dataset.filter === state.filter);
  });
  state.expanded = Object.create(null);
  renderTable();
}

function toggleDetail(index) {
  if (state.expanded[index]) delete state.expanded[index];
  else state.expanded[index] = true;
  renderTable();
}

function handleTableClick(event) {
  const action = event.target.closest('[data-action]');
  if (action) {
    const index = Number(action.dataset.index);
    const visible = filterRows(state.rows, state.filter, state.query);
    const target = visible[index];
    if (!target) return;

    if (action.dataset.action === 'copy-value') {
      copyWithFeedback(target.value, 'Copied the value of ' + target.name);
    } else if (action.dataset.action === 'copy-pair') {
      copyWithFeedback(target.name + '=' + target.value, 'Copied ' + target.name + '=value');
    }
    return;
  }

  const rowElement = event.target.closest('tr[data-index]');
  if (rowElement) toggleDetail(Number(rowElement.dataset.index));
}

function handleTableKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
  const rowElement = event.target.closest('tr[data-index]');
  if (!rowElement || event.target.closest('[data-action]')) return;
  event.preventDefault();
  toggleDetail(Number(rowElement.dataset.index));
}

// ---------------------------------------------------------------------------
// Wiring and start-up
// ---------------------------------------------------------------------------

const ELEMENT_IDS = [
  'versionLine', 'siteFavicon', 'siteHost', 'siteBadge', 'siteTitle',
  'scopeTab', 'scopeSite', 'scopeAll', 'scopeWarning',
  'formatSelect', 'optHideValues', 'optIncludeExpired', 'optAskWhere',
  'scanBtn', 'exportBtn', 'copyBtn',
  'statsPanel', 'statsScope', 'statTotal', 'statSession', 'statPersistent',
  'statSecure', 'statHttpOnly', 'statExpiring', 'statsExtra',
  'resultsPanel', 'searchInput', 'filterChips', 'resultsMeta',
  'cookieTableBody', 'emptyState',
  'previewPanel', 'previewMeta', 'previewText', 'copyPreviewBtn', 'closePreviewBtn',
  'helpPanel', 'helpBtn', 'statusRegion'
];

function cacheElements() {
  ELEMENT_IDS.forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function wireEvents() {
  el.scanBtn.addEventListener('click', () => scan());
  el.exportBtn.addEventListener('click', () => downloadExport());
  el.copyBtn.addEventListener('click', () => copyExport());

  el.copyPreviewBtn.addEventListener('click', () => {
    if (state.lastPayload) copyWithFeedback(state.lastPayload.text, 'Copied the export to the clipboard');
  });
  el.closePreviewBtn.addEventListener('click', () => {
    el.previewPanel.hidden = true;
  });

  el.helpBtn.addEventListener('click', () => {
    el.helpPanel.hidden = !el.helpPanel.hidden;
    el.helpBtn.textContent = el.helpPanel.hidden
      ? 'Privacy & responsible use'
      : 'Hide privacy notes';
  });

  el.searchInput.addEventListener('input', () => {
    state.query = el.searchInput.value;
    state.expanded = Object.create(null);
    renderTable();
  });

  el.filterChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip) setFilter(chip.dataset.filter);
  });

  el.cookieTableBody.addEventListener('click', handleTableClick);
  el.cookieTableBody.addEventListener('keydown', handleTableKeydown);

  [el.scopeTab, el.scopeSite, el.scopeAll].forEach((input) => {
    input.addEventListener('change', () => {
      state.prefs.scope = readScopeFromUi();
      el.scopeWarning.hidden = state.prefs.scope !== 'all';
      savePrefs();
      scan();
    });
  });

  el.formatSelect.addEventListener('change', () => {
    state.prefs.format = el.formatSelect.value;
    savePrefs();
  });

  el.optHideValues.addEventListener('change', () => {
    state.prefs.hideValues = el.optHideValues.checked;
    savePrefs();
  });

  el.optIncludeExpired.addEventListener('change', () => {
    state.prefs.includeExpired = el.optIncludeExpired.checked;
    savePrefs();
  });

  el.optAskWhere.addEventListener('change', () => {
    state.prefs.askWhere = el.optAskWhere.checked;
    savePrefs();
  });
}

async function init() {
  cacheElements();
  state.prefs = await loadPrefs();

  setText(el.versionLine, 'Session inspector \u00b7 v' + chrome.runtime.getManifest().version);
  applyPrefsToUi();
  wireEvents();
  updateContextHeader(null);

  const ping = await send(MESSAGE.PING);
  if (ping.ok) populateFormats(ping.formats);

  await scan();
}

// ---------------------------------------------------------------------------
// Entry point + test surface
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

if (typeof globalThis !== 'undefined') {
  globalThis.CookieVaultPopup = {
    MESSAGE: MESSAGE,
    DEFAULT_PREFS: DEFAULT_PREFS,
    DATA_URL_LIMIT: DATA_URL_LIMIT,
    RENDER_LIMIT: RENDER_LIMIT,
    ELEMENT_IDS: ELEMENT_IDS,
    normalizePrefs: normalizePrefs,
    formatBytes: formatBytes,
    shortExpiry: shortExpiry,
    isExpiringSoon: isExpiringSoon,
    filterRows: filterRows,
    buildDownloadUrl: buildDownloadUrl,
    truncateForPreview: truncateForPreview,
    describeError: describeError
  };
}






