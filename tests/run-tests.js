#!/usr/bin/env node
'use strict';

/**
 * Cookie Vault test suite - zero dependencies, plain Node.
 *
 *   node tests/run-tests.js
 *
 * It exercises background.js and popup.js inside a VM with a stubbed `chrome`
 * object, then statically verifies the manifest, the icons and the contracts that
 * used to be broken (popup <-> background message shape, element ids, and the DOM
 * injection guard).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const readFile = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

/**
 * Fixtures expire relative to the real clock, because the message handlers call
 * Date.now() internally - anchoring them to a hard-coded date made the suite
 * fail simply because time had passed.
 */
const NOW_MS = Date.now();
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

/** Fixed local-time date for the deterministic filename assertions. */
const FILENAME_DATE = new Date(2026, 8, 24, 12, 0, 0);

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  [pass] ' + name);
  } catch (error) {
    failures.push({ name: name, error: error });
    console.log('  [FAIL] ' + name);
    console.log('         ' + (error && error.message ? error.message : String(error)));
  }
}

function section(title) {
  console.log('\n' + title);
}

/** Remove comments so security greps do not trip over documentation. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCookies() {
  return [
    {
      name: 'sessionid',
      value: 'SECRET-VALUE-abc123',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: false,
      session: false,
      sameSite: 'lax',
      expirationDate: NOW_SECONDS + 86400
    },
    {
      name: 'theme',
      value: 'dark',
      domain: 'shop.example.com',
      path: '/',
      secure: false,
      httpOnly: false,
      hostOnly: true,
      session: true,
      sameSite: 'unspecified'
    },
    {
      name: 'tracking',
      value: 'x=1,y=2 "quoted"',
      domain: '.example.com',
      path: '/',
      secure: false,
      httpOnly: false,
      hostOnly: false,
      session: false,
      sameSite: 'no_restriction',
      expirationDate: NOW_SECONDS + 3600,
      partitionKey: { topLevelSite: 'https://example.com' }
    },
    {
      name: 'stale',
      value: 'gone',
      domain: '.example.com',
      path: '/old',
      secure: false,
      httpOnly: false,
      hostOnly: false,
      session: false,
      sameSite: 'strict',
      expirationDate: NOW_SECONDS - 60
    },
    {
      name: 'weird\tname',
      value: 'line1\nline2',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: false,
      hostOnly: false,
      session: true,
      sameSite: 'strict'
    }
  ];
}

/** Fresh background.js instance with a configurable chrome stub. */
function loadBackground(config) {
  const settings = config || {};
  const listeners = [];
  const downloads = [];

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '2.0.0' }),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener: () => {} }
    },
    tabs: {
      query: async () => {
        if (settings.tabsError) throw new Error('tabs unavailable');
        return settings.tabs === undefined ? [{ id: 1, url: 'https://shop.example.com/cart', title: 'Cart' }] : settings.tabs;
      }
    },
    cookies: {
      getAll: async (filter) => {
        if (settings.cookiesError) throw new Error('cookie store locked');
        const all = settings.cookies || makeCookies();
        if (filter && filter.url) {
          // Mirror Chrome: the tab scope returns cookies that are applicable to
          // that URL (host plus its parent domains).
          return settings.tabCookies || all.filter((cookie) => /(^|\.)example\.com$/.test(cookie.domain));
        }
        return all;
      }
    },
    downloads: {
      download: async (options) => {
        downloads.push(options);
        return downloads.length;
      }
    }
  };

  const sandbox = {
    chrome: chrome,
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    URL: URL
  };

  vm.createContext(sandbox);
  vm.runInContext(readFile('background.js'), sandbox, { filename: 'background.js' });

  return { api: sandbox.CookieVault, listeners: listeners, downloads: downloads, sandbox: sandbox };
}

/** Fresh popup.js instance without a DOM (so nothing auto-runs). */
function loadPopup(options) {
  const settings = options || {};
  const sandbox = {
    URL: settings.URL || { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    Blob:
      settings.Blob ||
      class StubBlob {
        constructor(parts, opts) {
          this.parts = parts;
          this.type = opts && opts.type;
        }
      }
  };
  vm.createContext(sandbox);
  vm.runInContext(readFile('popup.js'), sandbox, { filename: 'popup.js' });
  return sandbox.CookieVaultPopup;
}

// __APPEND_MARK__

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('Cookie Vault test suite');

  section('manifest.json');

  const manifestText = readFile('manifest.json');
  let manifest = null;

  await test('is valid strict JSON (the old file had // comments and never loaded)', () => {
    manifest = JSON.parse(manifestText);
    assert.ok(manifest, 'manifest parsed');
  });

  await test('declares MV3 with a popup, a service worker and real icon files', () => {
    assert.strictEqual(manifest.manifest_version, 3);
    assert.strictEqual(manifest.action.default_popup, 'popup.html');
    assert.strictEqual(manifest.background.service_worker, 'background.js');
    assert.strictEqual(typeof manifest.action.default_icon, 'object');
    Object.values(manifest.icons).forEach((iconPath) => assert.ok(exists(iconPath), iconPath + ' is missing'));
  });

  await test('references only files that exist', () => {
    ['popup.html', 'popup.css', 'background.js'].forEach((file) => assert.ok(exists(file), file + ' is missing'));
  });

  await test('requests the minimum permissions the feature set needs', () => {
    ['cookies', 'tabs', 'downloads', 'storage', 'clipboardWrite'].forEach((permission) => {
      assert.ok(manifest.permissions.indexOf(permission) !== -1, 'missing permission: ' + permission);
    });
    assert.deepStrictEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  });

  await test('has no content_scripts (content.js was dead code and has been removed)', () => {
    assert.strictEqual(manifest.content_scripts, undefined);
    assert.ok(!exists('content.js'), 'content.js should no longer exist');
  });

  await test('ships PNG icons with a valid PNG signature', () => {
    Object.values(manifest.icons).forEach((iconPath) => {
      const bytes = fs.readFileSync(path.join(ROOT, iconPath));
      assert.deepStrictEqual(
        Array.from(bytes.subarray(0, 4)),
        [0x89, 0x50, 0x4e, 0x47],
        iconPath + ' is not a PNG'
      );
      assert.ok(bytes.length > 200, iconPath + ' looks empty');
    });
  });

  section('static safety guards');

  await test('popup.js builds DOM nodes only - no markup injection APIs', () => {
    const source = stripComments(readFile('popup.js'));
    ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval('].forEach((forbidden) => {
      assert.ok(source.indexOf(forbidden) === -1, 'popup.js must not use ' + forbidden);
    });
  });

  await test('background.js never talks to the network', () => {
    const source = stripComments(readFile('background.js'));
    ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource'].forEach((forbidden) => {
      assert.ok(source.indexOf(forbidden) === -1, 'background.js must not use ' + forbidden);
    });
  });

  await test('popup.html has no inline scripts or inline event handlers (MV3 CSP)', () => {
    const html = readFile('popup.html');
    const scripts = html.match(/<script\b[^>]*>/g) || [];
    assert.ok(scripts.length > 0, 'expected the popup script tag');
    scripts.forEach((tag) => assert.ok(/\bsrc=/.test(tag), 'inline script found: ' + tag));
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler attribute found');
    assert.ok(!/javascript:/i.test(html), 'javascript: URL found');
  });

  await test('popup.css is structurally sound', () => {
    const css = stripComments(readFile('popup.css'));
    const open = (css.match(/\{/g) || []).length;
    const close = (css.match(/\}/g) || []).length;
    assert.strictEqual(open, close, 'unbalanced braces in popup.css');
    assert.ok(open > 30, 'sanity check: the stylesheet was parsed');
    assert.ok(!/;;/.test(css), 'stray double semicolon');
    assert.ok(!/\n\s*[a-z-]+\s*:\s*$/m.test(css), 'declaration without a value');
  });

  await test('the popup declares a width and height that fit a Chrome popup', () => {
    const css = readFile('popup.css');
    const width = /body\s*\{[^}]*width:\s*(\d+)px/.exec(css);
    const maxHeight = /body\s*\{[^}]*max-height:\s*(\d+)px/.exec(css);
    assert.ok(width, 'popup.css must set an explicit width');
    assert.ok(Number(width[1]) <= 800, 'Chrome caps popup width at 800px');
    assert.ok(maxHeight, 'popup.css must cap the height so the popup never overflows');
    assert.ok(Number(maxHeight[1]) <= 600, 'Chrome caps popup height at 600px');
  });

  section('background.js - export formats');

  const background = loadBackground({});
  const api = background.api;
  const cookies = makeCookies();
  const prepared = api.prepareForExport(cookies, {}, NOW_MS);
  const baseMeta = {
    generator: 'Cookie Vault',
    version: '2.0.0',
    exportedAt: '2026-09-24T12:00:00.000Z',
    scopeLabel: 'This tab only: shop.example.com',
    scopeSlug: 'shop.example.com',
    sourceUrl: 'https://shop.example.com/cart',
    valuesHidden: false
  };

  await test('exposes the documented helper surface', () => {
    ['buildNetscape', 'buildJson', 'buildCsv', 'buildHeader', 'buildJsSnippet', 'formatPayload', 'handleMessage'].forEach(
      (name) => assert.strictEqual(typeof api[name], 'function', 'missing helper: ' + name)
    );
  });

  await test('prepareForExport drops expired cookies and can redact values', () => {
    assert.strictEqual(prepared.cookies.length, 4, 'the expired cookie should be dropped');
    assert.strictEqual(prepared.droppedExpired, 1);

    const keeping = api.prepareForExport(cookies, { includeExpired: true }, NOW_MS);
    assert.strictEqual(keeping.cookies.length, 5);

    const hidden = api.prepareForExport(cookies, { hideValues: true }, NOW_MS);
    hidden.cookies.forEach((cookie) => {
      assert.ok(cookie.value.indexOf('[hidden:') === 0, 'value should be redacted: ' + cookie.value);
      assert.strictEqual(cookie.value.indexOf('SECRET'), -1);
    });
    assert.strictEqual(hidden.valuesHidden, true);
  });

  await test('Netscape output is a real 7-field, TAB separated cookie jar', () => {
    const text = api.buildNetscape(prepared.cookies, baseMeta);
    // "#HttpOnly_..." lines are DATA, every other "#" line is a comment.
    const dataLines = text
      .split('\n')
      .filter((line) => line.length > 0 && (line.indexOf('#') !== 0 || line.indexOf('#HttpOnly_') === 0));

    assert.strictEqual(dataLines.length, 4);
    dataLines.forEach((line) => assert.strictEqual(line.split('\t').length, 7, 'bad field count: ' + line));

    const sessionLine = dataLines.find((line) => line.indexOf('theme') !== -1);
    assert.strictEqual(sessionLine.split('\t')[4], '0', 'session cookies expire at 0');

    const httpOnlyLine = dataLines.find((line) => line.indexOf('sessionid') !== -1);
    assert.ok(httpOnlyLine.indexOf('#HttpOnly_.example.com\tTRUE\t') === 0, 'HttpOnly + sub-domain markers');
    assert.ok(text.indexOf('https://curl.se/docs/http-cookies.html') !== -1, 'documented format reference');
    assert.ok(text.indexOf('WARNING') !== -1, 'exports must carry a warning banner');
  });

  await test('Netscape output stays parseable when a value contains tabs and newlines', () => {
    const text = api.buildNetscape(prepared.cookies, baseMeta);
    const weird = text.split('\n').find((line) => line.indexOf('weird name') !== -1);
    assert.ok(weird, 'the sanitised cookie name should be present');
    assert.strictEqual(weird.split('\t').length, 7);
    assert.ok(weird.indexOf('line1 line2') !== -1, 'newlines are flattened to spaces');
  });

  await test('JSON output is valid JSON with metadata, summary and normalised cookies', () => {
    const json = JSON.parse(
      api.buildJson(prepared.cookies, Object.assign({}, baseMeta, { summary: api.summarize(cookies, NOW_MS) }))
    );
    assert.strictEqual(json.generator, 'Cookie Vault');
    assert.strictEqual(json.count, 4);
    assert.strictEqual(json.summary.total, 5);
    assert.ok(!('storeId' in json.cookies[0]), 'API-only fields should be stripped');
    assert.ok('expiresIso' in json.cookies[0]);
  });

  await test('CSV output escapes quotes and commas (embedded newlines stay inside quotes)', () => {
    const text = api.buildCsv(prepared.cookies, baseMeta);
    const lines = text.split('\n').filter((line) => line.length > 0 && line.indexOf('#') !== 0);

    // 1 header + 4 records, plus one extra physical line because RFC 4180 keeps a
    // quoted value's own newline instead of losing data.
    assert.strictEqual(lines.length, 6);
    assert.strictEqual(lines[0].split(',').length, 13);
    assert.strictEqual(api.escapeCsvField('a,b'), '"a,b"');
    assert.strictEqual(api.escapeCsvField('say "hi"'), '"say ""hi"""');
    assert.strictEqual(api.escapeCsvField('plain'), 'plain');
    assert.ok(text.indexOf('"x=1,y=2 ""quoted"""') !== -1, 'value should be CSV escaped');
  });

  await test('Cookie header output is a single pasteable line', () => {
    const text = api.buildHeader(prepared.cookies, baseMeta);
    const lines = text.trim().split('\n');
    const value = lines.pop();
    assert.strictEqual(lines.length, 4, 'only the comment banner precedes the value');
    assert.ok(value.indexOf('sessionid=SECRET-VALUE-abc123') !== -1);
    assert.ok(value.indexOf('; ') !== -1, 'pairs are joined with "; "');
    assert.ok(value.indexOf('weird name=line1 line2') !== -1, 'control characters are flattened');
  });

  await test('JS snippet comments out HttpOnly cookies instead of pretending they can be set', () => {
    const text = api.buildJsSnippet(prepared.cookies, baseMeta);
    assert.ok(text.indexOf('// [HttpOnly - JavaScript cannot set this] sessionid') !== -1);
    assert.ok(text.indexOf('document.cookie = "theme=dark; path=/";') !== -1);
    assert.strictEqual(text.indexOf('document.cookie = "sessionid='), -1);
  });

  await test('formatPayload names files by scope, format and local timestamp', () => {
    const payload = api.formatPayload(prepared.cookies, baseMeta, 'json', FILENAME_DATE);
    assert.strictEqual(payload.filename, 'cookies_shop.example.com_json_20260924-120000.json');
    assert.strictEqual(payload.mimeType, 'application/json;charset=utf-8');
    assert.strictEqual(payload.bytes, payload.text.length);
    assert.strictEqual(payload.count, 4);
  });

  await test('filename slugging survives hostile hostnames and unknown formats', () => {
    const meta = Object.assign({}, baseMeta, { scopeSlug: 'all-domains' });
    const fallback = api.formatPayload(prepared.cookies, meta, 'does-not-exist', FILENAME_DATE);
    assert.strictEqual(fallback.filename, 'cookies_all-domains_netscape_20260924-120000.txt');

    assert.strictEqual(api.sanitizeFilenamePart('../../etc/pa$$ wd'), 'etc-pa-wd');
    const traversal = api.formatPayload(
      prepared.cookies,
      Object.assign({}, baseMeta, { scopeSlug: '../..' }),
      'csv',
      FILENAME_DATE
    );
    assert.strictEqual(traversal.filename.indexOf('..'), -1, 'no path traversal in filenames');
  });

  await test('summarize reports the numbers the popup shows', () => {
    const stats = api.summarize(cookies, NOW_MS);
    assert.strictEqual(stats.total, 5);
    assert.strictEqual(stats.session, 2);
    assert.strictEqual(stats.persistent, 3);
    assert.strictEqual(stats.expired, 1);
    assert.strictEqual(stats.secure, 2);
    assert.strictEqual(stats.httpOnly, 1);
    assert.strictEqual(stats.sameSiteNone, 1);
    assert.strictEqual(stats.partitioned, 1);
    assert.strictEqual(stats.expiringSoon, 2, 'two persistent fixtures expire within a week (1 h and 24 h)');
    assert.strictEqual(stats.domains, 2);
    assert.ok(stats.totalBytes > 0);
    assert.strictEqual(stats.hostOnly, 1);
  });

  await test('filterBySite matches the host, its sub-domains and its parent domains', () => {
    const all = [
      { domain: '.example.com' },
      { domain: 'shop.example.com' },
      { domain: 'www.shop.example.com' },
      { domain: 'example.com' },
      { domain: '.notexample.com' },
      { domain: '.unrelated.test' }
    ];
    const matches = api.filterBySite(all, 'shop.example.com').map((cookie) => cookie.domain);
    assert.strictEqual(matches.join(','), '.example.com,shop.example.com,www.shop.example.com,example.com');
  });

  await test('scope and format inputs are normalised instead of trusted', () => {
    assert.strictEqual(api.normalizeScope('../../etc'), 'tab');
    assert.strictEqual(api.normalizeScope('all'), 'all');
    assert.strictEqual(api.normalizeFormat('<script>'), 'netscape');
    assert.strictEqual(api.normalizeFormat('csv'), 'csv');
  });

  await test('humanised expiry and masking never leak the raw value', () => {
    assert.strictEqual(api.humanizeExpiry({ session: true }, NOW_MS), 'session (until browser closes)');
    assert.strictEqual(api.humanizeExpiry({ expirationDate: NOW_SECONDS + 7200 }, NOW_MS), 'in 2 h');
    assert.strictEqual(api.humanizeExpiry({ expirationDate: NOW_SECONDS - 5 }, NOW_MS), 'expired');
    assert.strictEqual(api.maskValue('abcd').indexOf('abcd'), -1);
    assert.ok(api.maskValue('abcd').indexOf('\u2022') === 0);
  });

  section('background.js - message routing');

  await test('PING returns the version, formats and scopes', async () => {
    const response = await api.handleMessage({ type: 'PING' });
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.version, '2.0.0');
    assert.strictEqual(response.formats.length, 5);
    // join() instead of deepStrictEqual: arrays created inside the VM have a
    // different Array.prototype than the host realm's.
    assert.strictEqual(response.scopes.join(','), 'tab,site,all');
  });

  await test('SCAN_COOKIES answers with the {ok, rows, stats} envelope the popup renders', async () => {
    const response = await api.handleMessage({ type: 'SCAN_COOKIES', scope: 'tab' });
    assert.strictEqual(response.ok, true, 'the envelope must carry ok:true on success');
    assert.strictEqual(response.context.host, 'shop.example.com');
    assert.strictEqual(Array.isArray(response.rows), true);
    assert.strictEqual(response.rows.length, 5);
    assert.strictEqual(response.stats.total, 5);
    assert.ok(response.rows[0].maskedValue.indexOf('SECRET') === -1, 'the table shows masked values');
    assert.ok(typeof response.rows[0].expiresHuman === 'string');
  });

  await test('EXPORT_COOKIES produces a download-ready payload', async () => {
    const response = await api.handleMessage({ type: 'EXPORT_COOKIES', scope: 'tab', format: 'netscape' });
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.payload.count, 4);
    assert.ok(
      /^cookies_shop\.example\.com_netscape_\d{8}-\d{6}\.txt$/.test(response.payload.filename),
      'unexpected filename: ' + response.payload.filename
    );
    assert.ok(response.payload.text.indexOf('SECRET-VALUE-abc123') !== -1);
    assert.strictEqual(response.droppedExpired, 1);
  });

  await test('EXPORT_COOKIES with hideValues never writes the secret to disk', async () => {
    const response = await api.handleMessage({
      type: 'EXPORT_COOKIES',
      scope: 'tab',
      format: 'json',
      hideValues: true
    });
    assert.strictEqual(response.valuesHidden, true);
    assert.strictEqual(response.payload.text.indexOf('SECRET-VALUE-abc123'), -1);
    assert.ok(response.payload.text.indexOf('[hidden:') !== -1);
  });

  await test('EXPORT_COOKIES reports NO_COOKIES when everything is expired', async () => {
    const instance = loadBackground({
      cookies: [],
      tabCookies: [
        { name: 'a', value: 'b', domain: '.example.com', path: '/', session: false, expirationDate: NOW_SECONDS - 10 }
      ]
    });
    const response = await instance.api.handleMessage({ type: 'EXPORT_COOKIES', scope: 'tab' });
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'NO_COOKIES');
    assert.ok(response.error.message.indexOf('expired') !== -1);
  });

  await test('unsupported pages, missing tabs and read failures return coded errors, not crashes', async () => {
    const restricted = loadBackground({ tabs: [{ id: 1, url: 'chrome://extensions/' }] });
    const restrictedResponse = await restricted.api.handleMessage({ type: 'SCAN_COOKIES', scope: 'tab' });
    assert.strictEqual(restrictedResponse.error.code, 'UNSUPPORTED_URL');

    const noTab = loadBackground({ tabs: [] });
    const noTabResponse = await noTab.api.handleMessage({ type: 'SCAN_COOKIES', scope: 'tab' });
    assert.strictEqual(noTabResponse.error.code, 'NO_TAB');

    const noCookies = loadBackground({ cookiesError: true });
    const failedResponse = await noCookies.api.handleMessage({ type: 'SCAN_COOKIES', scope: 'tab' });
    assert.strictEqual(failedResponse.error.code, 'READ_FAILED');

    const badRequest = await api.handleMessage({ nope: true });
    assert.strictEqual(badRequest.error.code, 'BAD_REQUEST');
  });

  await test('unknown message types stay unanswered so other listeners can handle them', async () => {
    assert.strictEqual(await api.handleMessage({ type: 'NOT_OURS' }), undefined);
    const malformed = await api.handleMessage(null);
    assert.strictEqual(malformed.ok, false);
    assert.strictEqual(malformed.error.code, 'BAD_REQUEST');
  });

  await test('the listener keeps the async reply channel open', () => {
    const listener = background.listeners[0];
    assert.strictEqual(typeof listener, 'function');

    let reply = null;
    const kept = listener({ type: 'PING' }, {}, (value) => {
      reply = value;
    });
    assert.strictEqual(kept, true, 'the listener must return true for async responses');

    return new Promise((resolve) => setTimeout(resolve, 30)).then(() => {
      assert.ok(reply && reply.ok === true, 'sendResponse received the envelope');
    });
  });

  await test('the "all" scope reads the whole profile and the "site" scope filters it', async () => {
    const instance = loadBackground({});
    const all = await instance.api.handleMessage({ type: 'SCAN_COOKIES', scope: 'all' });
    assert.strictEqual(all.scopeLabel, 'Entire browser profile (all domains)');
    assert.strictEqual(all.stats.total, 5);

    const site = await instance.api.handleMessage({ type: 'SCAN_COOKIES', scope: 'site' });
    assert.strictEqual(site.stats.total, 5, 'every fixture cookie belongs to example.com');
    assert.ok(site.scopeLabel.indexOf('Site and related domains') === 0);
  });

  await test('every message type the popup sends is answered by the background', async () => {
    const popupApi = loadPopup();
    const types = Object.values(popupApi.MESSAGE);
    assert.ok(types.length >= 3);
    for (const type of types) {
      const response = await api.handleMessage({ type: type, scope: 'tab', format: 'netscape' });
      assert.ok(response !== undefined, type + ' is not routed by background.js');
      assert.strictEqual(typeof response.ok, 'boolean', type + ' must answer with an ok flag');
    }
  });

  section('popup.js');

  const popupApi = loadPopup();
  const popupSource = readFile('popup.js');
  const popupHtml = readFile('popup.html');

  await test('exposes the pure helpers used by the UI', () => {
    ['filterRows', 'buildDownloadUrl', 'describeError', 'normalizePrefs', 'formatBytes', 'truncateForPreview'].forEach(
      (name) => assert.strictEqual(typeof popupApi[name], 'function', 'missing helper: ' + name)
    );
  });

  await test('loads without a DOM, so its logic can be unit tested', () => {
    assert.ok(popupApi.ELEMENT_IDS.length > 20, 'element ids are declared explicitly');
  });

  await test('every element id it caches exists in popup.html', () => {
    popupApi.ELEMENT_IDS.forEach((id) => {
      assert.ok(popupHtml.indexOf('id="' + id + '"') !== -1, 'popup.html is missing #' + id);
    });
  });

  await test('every el.<name> reference is a declared element id (catches typos)', () => {
    const used = new Set();
    const pattern = /\bel\.([A-Za-z0-9_]+)/g;
    let match = pattern.exec(popupSource);
    while (match) {
      used.add(match[1]);
      match = pattern.exec(popupSource);
    }
    assert.ok(used.size > 10, 'sanity check: references were found');
    used.forEach((name) => {
      assert.ok(popupApi.ELEMENT_IDS.indexOf(name) !== -1, 'el.' + name + ' is not in ELEMENT_IDS');
    });
  });

  await test('every getElementById literal exists in popup.html', () => {
    const pattern = /getElementById\(['"]([A-Za-z0-9_-]+)['"]\)/g;
    let match = pattern.exec(popupSource);
    while (match) {
      assert.ok(popupHtml.indexOf('id="' + match[1] + '"') !== -1, 'popup.html is missing #' + match[1]);
      match = pattern.exec(popupSource);
    }
  });

  await test('the markup declares the radiogroup and the live status region', () => {
    ['scopeTab', 'scopeSite', 'scopeAll'].forEach((id) => {
      assert.ok(popupHtml.indexOf('id="' + id + '"') !== -1, 'missing #' + id);
    });
    assert.ok(/role="radiogroup"/.test(popupHtml));
    assert.ok(/aria-live="polite"/.test(popupHtml), 'the status region must be a live region');
  });

  await test('result rows are keyboard reachable and their expansion is announced', () => {
    assert.ok(popupSource.indexOf('tabIndex') !== -1, 'rows need to be focusable');
    assert.ok(popupSource.indexOf('aria-expanded') !== -1, 'row expansion must be announced');
  });

  await test('filterRows applies the chip filters and the search query', () => {
    const rows = [
      { name: 'sid', value: 'abc', domain: '.a.com', path: '/', session: true, secure: true, httpOnly: true },
      {
        name: 'theme',
        value: 'dark',
        domain: '.a.com',
        path: '/',
        session: false,
        secure: false,
        httpOnly: false,
        expiresEpoch: (NOW_MS + 3600000) / 1000
      },
      {
        name: 'later',
        value: 'x',
        domain: '.a.com',
        path: '/',
        session: false,
        secure: false,
        httpOnly: false,
        expiresEpoch: (NOW_MS + 30 * 86400000) / 1000
      }
    ];

    assert.strictEqual(popupApi.filterRows(rows, 'all', '', NOW_MS).length, 3);
    assert.strictEqual(popupApi.filterRows(rows, 'session', '', NOW_MS).length, 1);
    assert.strictEqual(popupApi.filterRows(rows, 'persistent', '', NOW_MS).length, 2);
    assert.strictEqual(popupApi.filterRows(rows, 'secure', '', NOW_MS).length, 1);
    assert.strictEqual(popupApi.filterRows(rows, 'httponly', '', NOW_MS).length, 1);
    assert.strictEqual(popupApi.filterRows(rows, 'expiring', '', NOW_MS).length, 1);
    assert.strictEqual(popupApi.filterRows(rows, 'all', 'theme', NOW_MS).length, 1);
    assert.strictEqual(popupApi.filterRows(rows, 'all', 'DARK', NOW_MS).length, 1, 'search is case insensitive');
    assert.strictEqual(popupApi.filterRows(rows, 'all', 'nothing-here', NOW_MS).length, 0);
  });

  await test('small payloads download as a self-contained data URL', () => {
    const target = popupApi.buildDownloadUrl('a,b', 'text/csv;charset=utf-8', 100000);
    assert.strictEqual(target.strategy, 'data-url');
    assert.strictEqual(target.revoke, false);
    assert.strictEqual(target.url.indexOf('data:text/csv;charset=utf-8,'), 0);
  });

  await test('large payloads switch to a blob URL that is later revoked', () => {
    const blobApi = loadPopup({
      Blob: class {
        constructor(parts, opts) {
          this.parts = parts;
          this.type = opts.type;
        }
      },
      URL: { createObjectURL: (blob) => 'blob:test/' + blob.parts[0].length }
    });
    const target = blobApi.buildDownloadUrl('x'.repeat(2000), 'application/json;charset=utf-8', 100);
    assert.strictEqual(target.strategy, 'blob-url');
    assert.strictEqual(target.revoke, true);
    assert.strictEqual(target.url, 'blob:test/2000');
  });

  await test('previews are truncated instead of pasting megabytes into the DOM', () => {
    const short = popupApi.truncateForPreview('hello', 10);
    assert.strictEqual(short.truncated, false);

    const long = popupApi.truncateForPreview('abcdefghij', 4);
    assert.strictEqual(long.truncated, true);
    assert.strictEqual(long.text, 'abcd');
    assert.strictEqual(long.total, 10);
  });

  await test('stored preferences are normalised and unknown values rejected', () => {
    const prefs = popupApi.normalizePrefs({ scope: 'evil', format: 42, hideValues: 1, extra: 'x' });
    assert.strictEqual(prefs.scope, 'tab');
    assert.strictEqual(prefs.format, 'netscape');
    assert.strictEqual(prefs.hideValues, true);
    assert.strictEqual(prefs.extra, undefined);
    assert.strictEqual(popupApi.normalizePrefs(null).askWhere, false);
  });

  await test('error hints turn coded failures into actionable text', () => {
    const message = popupApi.describeError({ ok: false, error: { code: 'UNSUPPORTED_URL', message: 'Nope.' } });
    assert.ok(message.indexOf('Nope.') === 0);
    assert.ok(message.indexOf('chrome://') !== -1, 'the hint explains which pages cannot be read');
    assert.ok(popupApi.describeError({}).length > 0, 'an unknown envelope still produces text');
  });

  await test('byte formatting stays readable', () => {
    assert.strictEqual(popupApi.formatBytes(0), '0 B');
    assert.strictEqual(popupApi.formatBytes(512), '512 B');
    assert.strictEqual(popupApi.formatBytes(2048), '2.0 KB');
    assert.ok(popupApi.formatBytes(3 * 1024 * 1024).indexOf('MB') !== -1);
  });

  await test('the popup and the background agree on the shared vocabulary', () => {
    const prefs = popupApi.DEFAULT_PREFS;
    assert.ok(api.SCOPES.indexOf(prefs.scope) !== -1, 'default scope must be a real scope');
    assert.ok(api.FORMAT_IDS.indexOf(prefs.format) !== -1, 'default format must be a real format');
    assert.ok(popupApi.DATA_URL_LIMIT > 0);
    assert.ok(popupApi.RENDER_LIMIT > 0);
    assert.deepStrictEqual(Object.values(popupApi.MESSAGE).sort(), Object.values(api.MESSAGE).sort());
  });

  section('popup.js - end to end in a DOM double');

  const domStub = require('./dom-stub.js');

  /** chrome.* stub that routes popup messages into the real background worker. */
  function launchPopup(options) {
    const settings = options || {};
    const document = domStub.createDocument(readFile('popup.html'));
    const calls = { downloads: [], clipboard: [], stored: [], timers: [] };

    const routed = async (message) => {
      const response = await api.handleMessage(message);
      // JSON round-trip keeps the values plain across the two VM realms.
      return response === undefined ? null : JSON.parse(JSON.stringify(response));
    };

    const chromeStub = {
      runtime: {
        getManifest: () => ({ version: '2.0.0' }),
        sendMessage: (message) => (settings.offline ? Promise.reject(new Error('no worker')) : routed(message))
      },
      tabs: {
        query: async () => [{ id: 1, url: 'https://shop.example.com/cart', title: 'Cart - Example shop' }]
      },
      storage: {
        local: {
          get: async () => settings.storedPrefs || {},
          set: async (payload) => calls.stored.push(payload)
        }
      },
      downloads: {
        download: async (options) => {
          calls.downloads.push(options);
          return calls.downloads.length;
        }
      }
    };

    const sandbox = {
      chrome: chromeStub,
      document: document,
      navigator: { clipboard: { writeText: async (text) => calls.clipboard.push(text) } },
      URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
      Blob: class StubBlob {
        constructor(parts, opts) {
          this.parts = parts;
          this.type = opts && opts.type;
        }
      },
      // Recorded instead of scheduled: a live 4.5 s toast timer would keep Node
      // alive after the suite finishes.
      setTimeout: (fn, ms) => {
        calls.timers.push({ fn: fn, ms: ms });
        return calls.timers.length;
      },
      clearTimeout: () => {}
    };

    vm.createContext(sandbox);
    vm.runInContext(readFile('popup.js'), sandbox);

    return {
      document: document,
      calls: calls,
      api: sandbox.CookieVaultPopup,
      ready: () => document.fire('DOMContentLoaded')
    };
  }

  await test('start-up renders the header, statistics and one row per cookie', async () => {
    const popup = launchPopup();
    await popup.ready();

    assert.strictEqual(popup.document.getElementById('siteHost').textContent, 'shop.example.com');
    assert.strictEqual(popup.document.getElementById('siteTitle').textContent, 'Cart');
    assert.strictEqual(popup.document.getElementById('versionLine').textContent, 'Session inspector \u00b7 v2.0.0');

    assert.strictEqual(popup.document.getElementById('statsPanel').hidden, false);
    assert.strictEqual(popup.document.getElementById('statTotal').textContent, '5');
    assert.strictEqual(popup.document.getElementById('statHttpOnly').textContent, '1');
    assert.strictEqual(popup.document.getElementById('statExpiring').textContent, '2');
    assert.ok(popup.document.getElementById('statsExtra').textContent.indexOf('2 domains') !== -1);

    assert.strictEqual(popup.document.getElementById('cookieTableBody').childNodes.length, 5);
    assert.strictEqual(popup.document.getElementById('resultsMeta').textContent, 'Showing 5 of 5 cookies');
    assert.strictEqual(popup.document.getElementById('emptyState').hidden, true);
    assert.strictEqual(popup.document.getElementById('previewPanel').hidden, true);
    assert.strictEqual(popup.document.getElementById('helpPanel').hidden, true, 'collapsed until asked for');
  });

  await test('the table masks values while the exported file keeps the real ones', async () => {
    const popup = launchPopup();
    await popup.ready();

    const firstRow = popup.document.getElementById('cookieTableBody').childNodes[0];
    assert.strictEqual(firstRow.childNodes[0].textContent, 'sessionid');
    assert.ok(firstRow.childNodes[1].textContent.indexOf('SECRET') === -1, 'the visible column is masked');
    assert.ok(firstRow.childNodes[2].textContent.indexOf('HttpOnly') !== -1, 'flags are announced');

    await popup.document.getElementById('exportBtn').dispatch('click');

    assert.strictEqual(popup.calls.downloads.length, 1);
    const download = popup.calls.downloads[0];
    assert.strictEqual(download.saveAs, false, '"Ask where to save" defaults to off');
    assert.ok(/^cookies_shop\.example\.com_netscape_\d{8}-\d{6}\.txt$/.test(download.filename));
    assert.ok(download.url.indexOf('data:text/plain;charset=utf-8,') === 0);
    assert.ok(decodeURIComponent(download.url).indexOf('SECRET-VALUE-abc123') !== -1);

    assert.strictEqual(popup.document.getElementById('previewPanel').hidden, false);
    assert.ok(popup.document.getElementById('previewText').textContent.indexOf('Netscape HTTP Cookie File') !== -1);
    assert.ok(popup.document.getElementById('statusRegion').className.indexOf('is-ok') !== -1);
  });

  await test('the Copy button puts the export on the clipboard', async () => {
    const popup = launchPopup();
    await popup.ready();

    await popup.document.getElementById('copyBtn').dispatch('click');
    assert.strictEqual(popup.calls.clipboard.length, 1);
    assert.ok(popup.calls.clipboard[0].indexOf('SECRET-VALUE-abc123') !== -1);
    assert.ok(popup.calls.clipboard[0].indexOf('Netscape HTTP Cookie File') !== -1);
  });

  await test('selecting a row reveals its value and offers per-cookie copy buttons', async () => {
    const popup = launchPopup();
    await popup.ready();

    const body = popup.document.getElementById('cookieTableBody');
    await body.dispatch('click', { target: body.childNodes[0], preventDefault() {} });

    // renderTable() rebuilds the table, so the fresh nodes are the ones to check.
    assert.strictEqual(body.childNodes.length, 6, 'a detail row is appended');
    assert.strictEqual(body.childNodes[0].getAttribute('aria-expanded'), 'true');
    assert.ok(body.childNodes[1].textContent.indexOf('SECRET-VALUE-abc123') !== -1, 'the value is revealed');

    const copyButton = body.childNodes[1].querySelectorAll('[data-action]')[0];
    assert.strictEqual(copyButton.textContent, 'Copy value');
    await body.dispatch('click', { target: copyButton, preventDefault() {} });
    assert.strictEqual(popup.calls.clipboard.length, 1);
    assert.strictEqual(popup.calls.clipboard[0], 'SECRET-VALUE-abc123');

    await body.dispatch('click', { target: body.childNodes[0], preventDefault() {} });
    assert.strictEqual(body.childNodes.length, 5, 'clicking again collapses the detail row');
  });

  await test('filter chips narrow the table without changing the export scope', async () => {
    const popup = launchPopup();
    await popup.ready();

    const chips = popup.document.getElementById('filterChips');
    const chipEvent = {
      target: { closest: (selector) => (selector === '.chip' ? { dataset: { filter: 'session' } } : null) },
      preventDefault() {}
    };
    await chips.dispatch('click', chipEvent);

    assert.strictEqual(popup.document.getElementById('cookieTableBody').childNodes.length, 2, 'two session cookies');
    assert.strictEqual(popup.document.getElementById('resultsMeta').textContent, 'Showing 2 of 5 cookies');

    await chips.dispatch('click', {
      target: { closest: (selector) => (selector === '.chip' ? { dataset: { filter: 'all' } } : null) },
      preventDefault() {}
    });
    assert.strictEqual(popup.document.getElementById('cookieTableBody').childNodes.length, 5);
  });

  await test('the search box filters live and reports an empty result honestly', async () => {
    const popup = launchPopup();
    await popup.ready();

    const search = popup.document.getElementById('searchInput');
    search.value = 'theme';
    await search.dispatch('input');
    assert.strictEqual(popup.document.getElementById('cookieTableBody').childNodes.length, 1);

    search.value = 'zzz-nothing';
    await search.dispatch('input');
    assert.strictEqual(popup.document.getElementById('cookieTableBody').childNodes.length, 0);
    assert.strictEqual(popup.document.getElementById('emptyState').hidden, false);
    assert.strictEqual(
      popup.document.getElementById('emptyState').textContent,
      'No cookie matches the current filter.'
    );
  });

  await test('an unreachable background worker produces a readable, actionable error', async () => {
    const offline = launchPopup({ offline: true });
    await offline.ready();

    const toast = offline.document.getElementById('statusRegion');
    assert.ok(toast.className.indexOf('is-error') !== -1, 'an unreachable worker is an error, not a success');
    assert.ok(toast.textContent.indexOf('Reload the extension') !== -1, 'the hint tells the user what to do');
    assert.strictEqual(offline.document.getElementById('resultsPanel').hidden, true, 'no stale results are shown');
    assert.strictEqual(offline.calls.downloads.length, 0);
  });

  await test('stored preferences are applied to the form and written back on change', async () => {
    const popup = launchPopup({
      storedPrefs: { 'cookieVault.prefs': { scope: 'all', format: 'csv', hideValues: true, askWhere: true } }
    });
    await popup.ready();

    assert.strictEqual(popup.document.getElementById('scopeAll').checked, true);
    assert.strictEqual(popup.document.getElementById('optHideValues').checked, true);
    assert.strictEqual(popup.document.getElementById('optAskWhere').checked, true);
    assert.strictEqual(popup.document.getElementById('scopeWarning').hidden, false, 'the broad scope is warned about');

    const hideValues = popup.document.getElementById('optHideValues');
    hideValues.checked = false;
    await hideValues.dispatch('change');

    assert.strictEqual(popup.calls.stored.length, 1);
    assert.strictEqual(popup.calls.stored[0]['cookieVault.prefs'].hideValues, false);
    assert.strictEqual(popup.calls.stored[0]['cookieVault.prefs'].format, 'csv');
  });

  await test('the help panel toggles and keeps its label in sync', async () => {
    const popup = launchPopup();
    await popup.ready();

    const help = popup.document.getElementById('helpPanel');
    assert.strictEqual(help.hidden, true);

    await popup.document.getElementById('helpBtn').dispatch('click');
    assert.strictEqual(help.hidden, false);
    assert.strictEqual(popup.document.getElementById('helpBtn').textContent, 'Hide privacy notes');

    await popup.document.getElementById('helpBtn').dispatch('click');
    assert.strictEqual(help.hidden, true);
    assert.strictEqual(popup.document.getElementById('helpBtn').textContent, 'Privacy & responsible use');
  });

  await test('the preview panel can be hidden again and its copy button reuses the last payload', async () => {
    const popup = launchPopup();
    await popup.ready();

    await popup.document.getElementById('exportBtn').dispatch('click');
    assert.strictEqual(popup.document.getElementById('previewPanel').hidden, false);

    await popup.document.getElementById('copyPreviewBtn').dispatch('click');
    assert.strictEqual(popup.calls.clipboard.length, 1);

    await popup.document.getElementById('closePreviewBtn').dispatch('click');
    assert.strictEqual(popup.document.getElementById('previewPanel').hidden, true);
  });







  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((failure) => {
      console.log(' - ' + failure.name);
      console.log('   ' + (failure.error && failure.error.stack ? failure.error.stack.split('\n')[0] : failure.error));
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('The test runner crashed:', error);
  process.exitCode = 1;
});
