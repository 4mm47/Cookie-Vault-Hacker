/**
 * Cookie Vault - background service worker (Manifest V3).
 *
 * Responsibilities
 *   1. Resolve the context of the active tab (used as the default export scope).
 *   2. READ cookies through the chrome.cookies API. Cookies are never written,
 *      edited or deleted by this extension.
 *   3. Turn cookie objects into documented, genuinely useful payload formats.
 *   4. Serve popup requests over chrome.runtime messaging.
 *
 * Privacy contract
 *   This file performs NO network requests (no fetch/XHR/WebSocket), has no
 *   telemetry, and never writes cookie data anywhere except the local file the
 *   user explicitly saves from the popup.
 *
 * Testability
 *   The pure helpers and the message router are published on
 *   `globalThis.CookieVault` so `tests/run-tests.js` can exercise them under Node
 *   with a stubbed `chrome` object, without a browser.
 */

'use strict';

/** Message types accepted from the popup. Keep in sync with popup.js. */
const MESSAGE = Object.freeze({
  PING: 'PING',
  SCAN_COOKIES: 'SCAN_COOKIES',
  EXPORT_COOKIES: 'EXPORT_COOKIES'
});

/** Export scopes, from narrowest to broadest. */
const SCOPES = Object.freeze(['tab', 'site', 'all']);
const DEFAULT_SCOPE = 'tab';

/** Hard ceiling so a pathological profile cannot stall the service worker. */
const MAX_COOKIES = 5000;

const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every export format is described once here: the popup renders this list, and
 * the builders below are keyed by the same ids.
 */
const FORMATS = Object.freeze({
  netscape: {
    id: 'netscape',
    label: 'Netscape cookies.txt (curl / wget / yt-dlp)',
    extension: 'txt',
    mimeType: 'text/plain;charset=utf-8'
  },
  json: {
    id: 'json',
    label: 'JSON (structured audit record)',
    extension: 'json',
    mimeType: 'application/json;charset=utf-8'
  },
  csv: {
    id: 'csv',
    label: 'CSV (spreadsheet review)',
    extension: 'csv',
    mimeType: 'text/csv;charset=utf-8'
  },
  header: {
    id: 'header',
    label: 'Cookie header string (dev tools / curl -b)',
    extension: 'txt',
    mimeType: 'text/plain;charset=utf-8'
  },
  jssnippet: {
    id: 'jssnippet',
    label: 'JavaScript document.cookie lines',
    extension: 'js',
    mimeType: 'text/javascript;charset=utf-8'
  }
});
const FORMAT_IDS = Object.freeze(Object.keys(FORMATS));
const DEFAULT_FORMAT = 'netscape';

/** Error codes that the popup maps to friendly, actionable copy. */
const ERROR_CODES = Object.freeze({
  NO_TAB: 'NO_TAB',
  UNSUPPORTED_URL: 'UNSUPPORTED_URL',
  BAD_REQUEST: 'BAD_REQUEST',
  NO_COOKIES: 'NO_COOKIES',
  READ_FAILED: 'READ_FAILED',
  UNEXPECTED: 'UNEXPECTED'
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Extension version, read from the manifest so it never drifts. */
function getVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_error) {
    return '0.0.0';
  }
}

/** An error carrying a stable `code` that the popup can branch on. */
function vaultError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Tab/newline characters would corrupt row-based formats, so flatten them. */
function cleanField(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

/** RFC 4180 style CSV escaping. */
function escapeCsvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

/** Cookie expiry is seconds since the epoch; the DOM works in milliseconds. */
function isExpired(cookie, nowMs) {
  if (!cookie || cookie.session || !cookie.expirationDate) return false;
  return cookie.expirationDate * 1000 <= nowMs;
}

/** Approximate on-the-wire size of a name=value pair, in bytes. */
function cookieBytes(cookie) {
  const name = cookie && cookie.name ? String(cookie.name) : '';
  const value = cookie && cookie.value ? String(cookie.value) : '';
  return name.length + value.length;
}

function toIsoString(epochSeconds) {
  if (!epochSeconds) return null;
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "in 3 days" / "in 4 h" / "in 12 min" / "expired" - for humans, not parsers. */
function humanizeExpiry(cookie, nowMs) {
  if (!cookie || cookie.session || !cookie.expirationDate) return 'session (until browser closes)';
  const deltaMs = cookie.expirationDate * 1000 - nowMs;
  if (deltaMs <= 0) return 'expired';
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 60) return 'in ' + minutes + ' min';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return 'in ' + hours + ' h';
  return 'in ' + Math.round(hours / 24) + ' days';
}

/** Masked preview: keeps the length visible (useful) but not the secret. */
function maskValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length === 0) return '(empty)';
  const shown = Math.min(text.length, 18);
  return '\u2022'.repeat(shown) + (text.length > shown ? ' (' + text.length + ' chars)' : '');
}

/** Replacement used when the user asks for value-free exports. */
function redactValue(value) {
  const length = value === null || value === undefined ? 0 : String(value).length;
  return '[hidden: ' + length + ' chars]';
}

/** Hostnames are not valid in filenames, so normalise to a safe slug. */
function sanitizeFilenamePart(value) {
  const slug = String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug.slice(0, 60) || 'unknown';
}

/** Local timestamp that sorts chronologically inside a filename. */
function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/**
 * Reduce a chrome.cookies.Cookie to the fields worth exporting. Dropping the
 * API-only properties (id, storeId, ...) keeps exports stable and diff-friendly.
 */
function pickCookie(cookie) {
  const partitionKey = cookie.partitionKey && cookie.partitionKey.topLevelSite
    ? cookie.partitionKey.topLevelSite
    : null;
  return {
    name: cookie.name || '',
    value: cookie.value || '',
    domain: cookie.domain || '',
    path: cookie.path || '/',
    session: Boolean(cookie.session),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: Boolean(cookie.hostOnly),
    sameSite: cookie.sameSite || 'unspecified',
    expiresEpoch: cookie.session ? null : cookie.expirationDate || null,
    expiresIso: cookie.session ? null : toIsoString(cookie.expirationDate),
    sizeBytes: cookieBytes(cookie),
    partitioned: Boolean(partitionKey),
    partitionTopLevelSite: partitionKey
  };
}

/** Row shape handed to the popup for rendering the cookie table. */
function toRow(cookie, nowMs) {
  const picked = pickCookie(cookie);
  return {
    name: picked.name,
    value: picked.value,
    maskedValue: maskValue(picked.value),
    domain: picked.domain,
    path: picked.path,
    session: picked.session,
    secure: picked.secure,
    httpOnly: picked.httpOnly,
    hostOnly: picked.hostOnly,
    sameSite: picked.sameSite,
    expiresEpoch: picked.expiresEpoch,
    expiresIso: picked.expiresIso,
    expiresHuman: humanizeExpiry(cookie, nowMs),
    expired: isExpired(cookie, nowMs),
    sizeBytes: picked.sizeBytes,
    partitioned: picked.partitioned
  };
}

/** Aggregate numbers shown on the popup's stat cards. */
function summarize(cookies, nowMs) {
  const stats = {
    total: cookies.length,
    session: 0,
    persistent: 0,
    expired: 0,
    secure: 0,
    httpOnly: 0,
    hostOnly: 0,
    sameSiteNone: 0,
    expiringSoon: 0,
    partitioned: 0,
    totalBytes: 0,
    domains: 0,
    largest: null
  };
  const domains = new Set();

  cookies.forEach((cookie) => {
    if (cookie.session || !cookie.expirationDate) stats.session += 1;
    else stats.persistent += 1;
    if (isExpired(cookie, nowMs)) stats.expired += 1;
    if (cookie.secure) stats.secure += 1;
    if (cookie.httpOnly) stats.httpOnly += 1;
    if (cookie.hostOnly) stats.hostOnly += 1;
    if (cookie.sameSite === 'no_restriction') stats.sameSiteNone += 1;
    if (cookie.partitionKey && cookie.partitionKey.topLevelSite) stats.partitioned += 1;

    const bytes = cookieBytes(cookie);
    stats.totalBytes += bytes;
    if (!stats.largest || bytes > stats.largest.sizeBytes) {
      stats.largest = { name: cookie.name, sizeBytes: bytes };
    }

    if (!cookie.session && cookie.expirationDate) {
      const deltaMs = cookie.expirationDate * 1000 - nowMs;
      if (deltaMs > 0 && deltaMs <= EXPIRING_SOON_MS) stats.expiringSoon += 1;
    }

    domains.add(cookie.domain || '(none)');
  });

  stats.domains = domains.size;
  return stats;
}

/**
 * Apply the user's export options to a cookie list.
 * @param {Array} cookies raw chrome.cookies.Cookie objects
 * @param {{hideValues: boolean, includeExpired: boolean}} options
 * @param {number} nowMs
 */
function prepareForExport(cookies, options, nowMs) {
  const opts = options || {};
  const keepExpired = Boolean(opts.includeExpired);
  const hideValues = Boolean(opts.hideValues);
  let dropped = 0;

  const prepared = cookies
    .filter((cookie) => {
      if (!keepExpired && isExpired(cookie, nowMs)) {
        dropped += 1;
        return false;
      }
      return true;
    })
    .map((cookie) => {
      const picked = pickCookie(cookie);
      if (hideValues) picked.value = redactValue(picked.value);
      return picked;
    });

  return { cookies: prepared, droppedExpired: dropped, valuesHidden: hideValues };
}

// ---------------------------------------------------------------------------
// Payload builders
//
// Each builder receives the already-prepared cookie records plus a `meta` object
// ({generator, version, exportedAt, scopeLabel, sourceUrl, valuesHidden, summary})
// and returns the exact text that is written to disk / clipboard.
// ---------------------------------------------------------------------------

/** Shared "#" comment banner so every exported file explains itself. */
function buildCommentHeader(meta, extraLines) {
  const lines = [
    '# =====================================================================',
    '# ' + meta.generator + ' v' + meta.version + ' - cookie export',
    '# Generated : ' + meta.exportedAt,
    '# Scope     : ' + meta.scopeLabel,
    '# Source    : ' + (meta.sourceUrl || '(not a web page)'),
    '# Records   : ' + meta.count
  ];
  if (meta.valuesHidden) {
    lines.push('# NOTE      : cookie VALUES are redacted in this export.');
  }
  if (extraLines && extraLines.length) {
    extraLines.forEach((line) => lines.push('# ' + line));
  }
  lines.push(
    '#',
    '# WARNING   : cookie values are live session credentials. Anyone holding',
    '#             this file may be able to impersonate the affected logins.',
    '#             Store it securely and delete it when you are finished.',
    '# ====================================================================='
  );
  return lines;
}

/**
 * Netscape / Mozilla cookie jar - the format curl, wget, yt-dlp, python-requests
 * and many other clients can actually import.
 * Seven TAB separated fields: domain, includeSubdomains, path, secure,
 * expires (epoch seconds, 0 = session), name, value.
 * HttpOnly cookies use the `#HttpOnly_` domain prefix that curl understands.
 */
function buildNetscape(cookies, meta) {
  const lines = buildCommentHeader(meta, [
    'Format    : Netscape HTTP Cookie File (7 TAB separated fields)',
    'Reference : https://curl.se/docs/http-cookies.html'
  ]);
  lines.push('');

  cookies.forEach((cookie) => {
    const domain = cookie.httpOnly ? '#HttpOnly_' + cookie.domain : cookie.domain;
    const includeSubdomains = cookie.domain && cookie.domain.indexOf('.') === 0 ? 'TRUE' : 'FALSE';
    const path = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = cookie.session || !cookie.expiresEpoch ? 0 : Math.floor(cookie.expiresEpoch);
    lines.push(
      [
        cleanField(domain || 'localhost'),
        includeSubdomains,
        cleanField(path),
        secure,
        String(expires),
        cleanField(cookie.name),
        cleanField(cookie.value)
      ].join('\t')
    );
  });

  return lines.join('\n') + '\n';
}

/** Machine-readable audit record: metadata plus normalised cookie objects. */
function buildJson(cookies, meta) {
  return (
    JSON.stringify(
      {
        generator: meta.generator,
        version: meta.version,
        exportedAt: meta.exportedAt,
        scope: meta.scopeLabel,
        sourceUrl: meta.sourceUrl || null,
        valuesHidden: Boolean(meta.valuesHidden),
        count: cookies.length,
        summary: meta.summary || null,
        cookies: cookies
      },
      null,
      2
    ) + '\n'
  );
}

/** Spreadsheet-friendly audit table. */
function buildCsv(cookies, meta) {
  const header = [
    'name',
    'value',
    'domain',
    'path',
    'session',
    'expires_iso',
    'expires_epoch',
    'secure',
    'http_only',
    'host_only',
    'same_site',
    'partitioned',
    'size_bytes'
  ];
  const lines = [
    '# ' + meta.generator + ' v' + meta.version + ' cookie export',
    '# Generated: ' + meta.exportedAt + ' | Scope: ' + meta.scopeLabel + ' | Records: ' + meta.count,
    '# WARNING: values are live session credentials - protect this file.',
    header.join(',')
  ];

  cookies.forEach((cookie) => {
    lines.push(
      [
        escapeCsvField(cookie.name),
        escapeCsvField(cookie.value),
        escapeCsvField(cookie.domain),
        escapeCsvField(cookie.path),
        cookie.session ? 'true' : 'false',
        escapeCsvField(cookie.expiresIso || ''),
        cookie.expiresEpoch ? String(Math.floor(cookie.expiresEpoch)) : '0',
        cookie.secure ? 'true' : 'false',
        cookie.httpOnly ? 'true' : 'false',
        cookie.hostOnly ? 'true' : 'false',
        escapeCsvField(cookie.sameSite),
        cookie.partitioned ? 'true' : 'false',
        String(cookie.sizeBytes)
      ].join(',')
    );
  });

  return lines.join('\n') + '\n';
}

/** Ready-to-paste value for a `Cookie:` request header. */
function buildHeader(cookies, meta) {
  // A Cookie header must be one physical line, so control characters inside
  // values are flattened instead of being allowed to break the header apart.
  const pairs = cookies.map((cookie) => cleanField(cookie.name) + '=' + cleanField(cookie.value));
  const lines = [
    '# ' + meta.generator + ' v' + meta.version + ' - Cookie header value',
    '# Generated: ' + meta.exportedAt + ' | Scope: ' + meta.scopeLabel + ' | Records: ' + cookies.length,
    '# Usage    : curl -H "Cookie: <value on the last line>" https://...',
    '# WARNING  : live session credentials - protect this file.',
    ''
  ];
  return lines.join('\n') + pairs.join('; ') + '\n';
}

/**
 * document.cookie assignments.
 * HttpOnly cookies are emitted as comments because JavaScript physically cannot
 * set them. The original project advertised this format as "injection ready"
 * without mentioning that limitation.
 */
function buildJsSnippet(cookies, meta) {
  const lines = [
    '// ' + meta.generator + ' v' + meta.version + ' - document.cookie export',
    '// Generated: ' + meta.exportedAt + ' | Scope: ' + meta.scopeLabel,
    '// WARNING: live session credentials - never paste these into untrusted pages.',
    ''
  ];

  cookies.forEach((cookie) => {
    const parts = [cookie.name + '=' + cookie.value, 'path=' + (cookie.path || '/')];
    if (cookie.domain && !cookie.hostOnly) parts.push('domain=' + cookie.domain);
    if (cookie.secure) parts.push('Secure');
    if (cookie.sameSite === 'lax') parts.push('SameSite=Lax');
    if (cookie.sameSite === 'strict') parts.push('SameSite=Strict');
    if (cookie.sameSite === 'no_restriction') parts.push('SameSite=None');
    if (cookie.expiresIso) parts.push('expires=' + cookie.expiresIso);

    if (cookie.httpOnly) {
      lines.push('// [HttpOnly - JavaScript cannot set this] ' + cookie.name);
    } else {
      lines.push('document.cookie = ' + JSON.stringify(parts.join('; ')) + ';');
    }
  });

  return lines.join('\n') + '\n';
}

const BUILDERS = Object.freeze({
  netscape: buildNetscape,
  json: buildJson,
  csv: buildCsv,
  header: buildHeader,
  jssnippet: buildJsSnippet
});

/**
 * Build a complete export payload: the text plus the filename/mime type to use.
 * @returns {{format: string, text: string, filename: string, mimeType: string, bytes: number, count: number}}
 */
function formatPayload(cookies, meta, formatId, date) {
  const format = FORMATS[formatId] || FORMATS[DEFAULT_FORMAT];
  const builder = BUILDERS[format.id];
  const enrichedMeta = Object.assign({}, meta, { count: cookies.length });
  const text = builder(cookies, enrichedMeta);
  const stamp = timestampForFilename(date || new Date());
  const scopeSlug = sanitizeFilenamePart(meta.scopeSlug || 'cookies');

  return {
    format: format.id,
    text: text,
    filename: 'cookies_' + scopeSlug + '_' + format.id + '_' + stamp + '.' + format.extension,
    mimeType: format.mimeType,
    bytes: text.length,
    count: cookies.length
  };
}

// ---------------------------------------------------------------------------
// Chrome API layer: tab context and cookie collection
// ---------------------------------------------------------------------------

/**
 * Describe the active tab, or throw a coded error explaining why it cannot be
 * inspected (chrome:// pages, the Web Store, PDF viewers, ...).
 */
async function resolveContext() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];

  if (!tab) {
    throw vaultError(ERROR_CODES.NO_TAB, 'No active tab could be found. Open a website and try again.');
  }

  const url = tab.url || tab.pendingUrl || '';
  if (!/^https?:\/\//i.test(url)) {
    const scheme = url ? url.split(':')[0] : 'unknown';
    throw vaultError(
      ERROR_CODES.UNSUPPORTED_URL,
      'This page (' + scheme + '://) has no inspectable cookies. Open a normal http/https website first.'
    );
  }

  const parsed = new URL(url);
  return {
    tabId: tab.id,
    title: tab.title || parsed.hostname,
    url: url,
    origin: parsed.origin,
    host: parsed.hostname,
    favIconUrl: tab.favIconUrl || ''
  };
}

function normalizeScope(scope) {
  return SCOPES.indexOf(scope) === -1 ? DEFAULT_SCOPE : scope;
}

function normalizeFormat(format) {
  return FORMAT_IDS.indexOf(format) === -1 ? DEFAULT_FORMAT : format;
}

/** Cookies that belong to the same site as `host`, parent domains included. */
function filterBySite(cookies, host) {
  const bare = (domain) => String(domain || '').replace(/^\./, '').toLowerCase();
  const target = String(host || '').toLowerCase();

  return cookies.filter((cookie) => {
    const domain = bare(cookie.domain);
    if (!domain) return false;
    return domain === target || target.endsWith('.' + domain) || domain.endsWith('.' + target);
  });
}

function describeScope(scope, context) {
  if (scope === 'all') {
    return { label: 'Entire browser profile (all domains)', slug: 'all-domains' };
  }
  if (scope === 'site') {
    return { label: 'Site and related domains: ' + context.host, slug: context.host };
  }
  return { label: 'This tab only: ' + context.host, slug: context.host };
}

/**
 * Read the cookies that match a scope.
 * @returns {Promise<{context: Object, scope: string, cookies: Array, truncated: boolean}>}
 */
async function collectCookies(scope, context, limits) {
  const max = (limits && limits.max) || MAX_COOKIES;
  let cookies;

  try {
    if (scope === 'tab') {
      cookies = await chrome.cookies.getAll({ url: context.url });
    } else if (scope === 'site') {
      const everything = await chrome.cookies.getAll({});
      cookies = filterBySite(everything, context.host);
    } else {
      cookies = await chrome.cookies.getAll({});
    }
  } catch (error) {
    throw vaultError(ERROR_CODES.READ_FAILED, 'The browser refused to read cookies: ' + error.message);
  }

  const truncated = cookies.length > max;
  if (truncated) cookies = cookies.slice(0, max);

  return { context: context, scope: scope, cookies: cookies, truncated: truncated };
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleScan(request) {
  const scope = normalizeScope(request && request.scope);
  const context = await resolveContext();
  const collected = await collectCookies(scope, context);
  const nowMs = Date.now();

  return {
    ok: true,
    context: context,
    scope: scope,
    scopeLabel: describeScope(scope, context).label,
    truncated: collected.truncated,
    totalFetched: collected.cookies.length,
    stats: summarize(collected.cookies, nowMs),
    rows: collected.cookies.map((cookie) => toRow(cookie, nowMs)),
    formats: FORMAT_IDS.map((id) => ({ id: id, label: FORMATS[id].label })),
    scannedAt: new Date(nowMs).toISOString()
  };
}

async function handleExport(request) {
  const scope = normalizeScope(request && request.scope);
  const format = normalizeFormat(request && request.format);
  const context = await resolveContext();
  const collected = await collectCookies(scope, context);
  const nowMs = Date.now();
  const describe = describeScope(scope, context);

  const prepared = prepareForExport(
    collected.cookies,
    {
      hideValues: Boolean(request && request.hideValues),
      includeExpired: Boolean(request && request.includeExpired)
    },
    nowMs
  );

  if (prepared.cookies.length === 0) {
    throw vaultError(
      ERROR_CODES.NO_COOKIES,
      collected.cookies.length > 0
        ? 'Every cookie in this scope has already expired. Tick "Include expired cookies" to export them anyway.'
        : 'No cookies were found for this scope. Are you logged in to this site?'
    );
  }

  const meta = {
    generator: 'Cookie Vault',
    version: getVersion(),
    exportedAt: new Date(nowMs).toISOString(),
    scopeLabel: describe.label,
    scopeSlug: describe.slug,
    sourceUrl: context.url,
    valuesHidden: prepared.valuesHidden,
    summary: summarize(collected.cookies, nowMs)
  };

  const payload = formatPayload(prepared.cookies, meta, format, new Date(nowMs));

  return {
    ok: true,
    context: context,
    scope: scope,
    scopeLabel: describe.label,
    payload: payload,
    records: prepared.cookies.length,
    droppedExpired: prepared.droppedExpired,
    valuesHidden: prepared.valuesHidden,
    truncated: collected.truncated
  };
}

const ROUTES = Object.freeze({
  PING: async () => ({
    ok: true,
    version: getVersion(),
    formats: FORMAT_IDS.map((id) => ({ id: id, label: FORMATS[id].label })),
    scopes: SCOPES.slice()
  }),
  SCAN_COOKIES: handleScan,
  EXPORT_COOKIES: handleExport
});

/**
 * Route one popup message. Always resolves to a `{ok: true, ...}` or
 * `{ok: false, error: {code, message}}` envelope. The original background
 * returned a bare string while the popup checked `response.success`, so every
 * genuine success was reported to the user as a failure.
 */
async function handleMessage(request) {
  if (!request || typeof request !== 'object' || typeof request.type !== 'string') {
    return { ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: 'Unrecognised message payload.' } };
  }

  const route = ROUTES[request.type];
  if (!route) return undefined; // Not ours - let any other listener answer.

  try {
    return await route(request);
  } catch (error) {
    const code = error && error.code ? error.code : ERROR_CODES.UNEXPECTED;
    if (code === ERROR_CODES.UNEXPECTED) console.error('[Cookie Vault] unexpected failure', error);
    return {
      ok: false,
      error: { code: code, message: error && error.message ? error.message : String(error) }
    };
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    const result = handleMessage(request);
    if (result === undefined) return false; // Another listener may own this.

    result
      .then((response) => {
        if (response !== undefined) sendResponse(response);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: { code: ERROR_CODES.UNEXPECTED, message: String(error) }
        });
      });

    return true; // Keep the message channel open for the async reply.
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    console.info(
      '[Cookie Vault] v' +
        getVersion() +
        ' ' +
        details.reason +
        ' - read-only cookie inspection. No data ever leaves this browser.'
    );
  });
}

// Surface the pure helpers for `tests/run-tests.js` and for console debugging in
// the service worker inspector. Nothing here touches the network.
if (typeof globalThis !== 'undefined') {
  globalThis.CookieVault = {
    MESSAGE: MESSAGE,
    SCOPES: SCOPES,
    FORMAT_IDS: FORMAT_IDS,
    ERROR_CODES: ERROR_CODES,
    getVersion: getVersion,
    cleanField: cleanField,
    escapeCsvField: escapeCsvField,
    isExpired: isExpired,
    cookieBytes: cookieBytes,
    humanizeExpiry: humanizeExpiry,
    maskValue: maskValue,
    redactValue: redactValue,
    sanitizeFilenamePart: sanitizeFilenamePart,
    timestampForFilename: timestampForFilename,
    pickCookie: pickCookie,
    toRow: toRow,
    summarize: summarize,
    prepareForExport: prepareForExport,
    buildNetscape: buildNetscape,
    buildJson: buildJson,
    buildCsv: buildCsv,
    buildHeader: buildHeader,
    buildJsSnippet: buildJsSnippet,
    formatPayload: formatPayload,
    filterBySite: filterBySite,
    normalizeScope: normalizeScope,
    normalizeFormat: normalizeFormat,
    describeScope: describeScope,
    collectCookies: collectCookies,
    handleMessage: handleMessage
  };
}






