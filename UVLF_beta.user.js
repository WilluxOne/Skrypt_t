// ==UserScript==
// @name         UVLF_beta
// @namespace    uvlf
// @version      0.1.0
// @description  Uniwersalny wykrywacz realnych URL-i wideo (direct/m3u8/mpd/embed) z UI i kopiowaniem.
// @author       UVLF
// @match        *://*/*
// @allFrames    true
// @run-at       document-start
// @grant        GM_setClipboard
// @updateURL    https://raw.githubusercontent.com/WilluxOne/Skrypt_t/main/UVLF_beta.user.js
// @downloadURL  https://raw.githubusercontent.com/WilluxOne/Skrypt_t/main/UVLF_beta.user.js
// ==/UserScript==

(function () {
  'use strict';

  const SETTINGS_KEY = 'uvlf_beta_settings_v1';
  const CANDIDATE_LIMIT = 80;
  const QUERY_KEYS = ['file', 'src', 'source', 'url', 'play', 'stream', 'hls', 'm3u8'];
  const DIRECT_EXT = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv', 'mpg', 'mpeg'];
  const EMBED_HOST_HINTS = ['voe', 'vidmoly', 'streamtape', 'dood', 'filemoon', 'uqload', 'mixdrop', 'ok.ru', 'vtube', 'luluvdo'];
  const MANIFEST_HINTS = ['manifest', 'playlist', 'hls', 'dash', 'master'];
  const JUNK_PATTERNS = [
    /recaptcha/i,
    /facebook\.com\/plugins/i,
    /analytics|googletagmanager|doubleclick|pixel/i,
    /\/account|\/profile|\/premium|\/logout|\/login|\/signup/i,
    /\/tag\//i,
    /\/category\//i,
    /\/help\//i,
    /search\?/i,
    /\.(?:css|js|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot)(?:$|[?#])/i,
  ];

  const defaultSettings = {
    autoScanOnPlay: true,
    showLowConfidence: false,
    preferM3U8: true,
    autoCopyOnPlay: false,
  };

  const state = {
    settings: loadSettings(),
    candidates: new Map(),
    hooks: { fetchInstalled: false, xhrInstalled: false },
    ui: null,
    best: null,
    bestEmbed: null,
    lastStatus: 'Gotowy',
    initialized: false,
    didPlayScan: false,
    transportHints: [],
  };

  window.__UVLF_BETA_STATE = state;

  function loadSettings() {
    try {
      return Object.assign({}, defaultSettings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch (_e) {
      return Object.assign({}, defaultSettings);
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function normalizeUrl(value, base) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('data:')) return null;
    try {
      return new URL(trimmed, base || location.href).href;
    } catch (_e) {
      return null;
    }
  }

  function classifyUrl(url) {
    const l = url.toLowerCase();
    const directRegex = new RegExp(`\\.(${DIRECT_EXT.join('|')})(?:$|[?#])`, 'i');

    if (directRegex.test(l)) return 'direct';
    if (/\.m3u8(?:$|[?#])|format=m3u8|hls/i.test(l)) return 'm3u8';
    if (/\.mpd(?:$|[?#])|format=mpd|dash/i.test(l)) return 'mpd';
    if (MANIFEST_HINTS.some((h) => l.includes(h))) return 'manifest';
    if (/\/embed\/|\/e\//i.test(l) || isKnownEmbedHost(url)) return 'embed';
    return 'other';
  }

  function isKnownEmbedHost(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return EMBED_HOST_HINTS.some((h) => host.includes(h));
    } catch (_e) {
      return false;
    }
  }

  function looksJunk(url) {
    if (!url) return true;
    if (/^blob:/i.test(url)) return false;
    if (url === location.href || url === `${location.href}#` || url === `${location.href}#!`) return true;
    return JUNK_PATTERNS.some((p) => p.test(url));
  }

  function baseScore(type) {
    if (state.settings.preferM3U8) {
      if (type === 'm3u8') return 120;
      if (type === 'direct') return 115;
    }
    if (type === 'direct') return 120;
    if (type === 'm3u8') return 110;
    if (type === 'mpd') return 100;
    if (type === 'manifest') return 85;
    if (type === 'embed') return 70;
    return 30;
  }

  function scoreBySource(source) {
    if (source === 'video.currentSrc' || source === 'video.src') return 45;
    if (source === 'source[src]') return 35;
    if (source === 'fetch' || source === 'xhr') return 30;
    if (source === 'performance') return 20;
    if (source === 'iframe[src]' || source === 'embed[src]' || source === 'object[data]') return 22;
    if (source === 'inline-script' || source === 'query-param' || source === 'data-*') return 14;
    return 8;
  }

  function wrapperPenalty(url) {
    try {
      const u = new URL(url);
      if (u.origin === location.origin && /\/watch|\/video|\/film|\/series|\/episode/i.test(location.pathname) && classifyUrl(url) === 'other') {
        return -25;
      }
    } catch (_e) {}
    return 0;
  }

  function addCandidate(raw, source, extra) {
    const url = normalizeUrl(raw, location.href);
    if (!url) return;

    if (looksJunk(url)) return;

    const type = classifyUrl(url);
    let score = baseScore(type) + scoreBySource(source) + wrapperPenalty(url);

    if (type === 'embed' && isKnownEmbedHost(url)) score += 20;
    if (source === 'iframe[src]' && isKnownEmbedHost(url)) score += 12;

    const existing = state.candidates.get(url);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }

    state.candidates.set(url, {
      url,
      type,
      score,
      confidence: score >= 130 ? 'high' : score >= 90 ? 'medium' : 'low',
      sources: [source],
      note: extra || '',
      ts: Date.now(),
    });
  }

  function extractUrlsFromText(text, source) {
    if (!text) return;

    const absUrlRegex = /https?:\/\/[^\s"'<>]+/gi;
    const relMediaRegex = /(?:\.|\/)[\w\-./%]+\.(?:m3u8|mpd|mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg)(?:\?[^\s"'<>]*)?/gi;

    let m;
    while ((m = absUrlRegex.exec(text)) !== null) addCandidate(m[0], source);
    while ((m = relMediaRegex.exec(text)) !== null) addCandidate(m[0], source);

    for (const key of QUERY_KEYS) {
      const q = new RegExp(`${key}=([^&"'\\s]+)`, 'gi');
      while ((m = q.exec(text)) !== null) {
        const decoded = safeDecode(m[1]);
        addCandidate(decoded, 'query-param', `key=${key}`);
      }
    }
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_e) {
      return value;
    }
  }

  function scanDom() {
    const videos = Array.from(document.querySelectorAll('video'));
    videos.forEach((video) => {
      if (video.currentSrc) addCandidate(video.currentSrc, 'video.currentSrc');
      if (video.src) addCandidate(video.src, 'video.src');
      video.querySelectorAll('source[src]').forEach((srcEl) => addCandidate(srcEl.getAttribute('src'), 'source[src]'));

      if (state.settings.autoScanOnPlay && !video.__uvlfPlayHook) {
        video.__uvlfPlayHook = true;
        video.addEventListener('play', async () => {
          if (state.didPlayScan) return;
          state.didPlayScan = true;
          await runScan('PLAY event');
          if (state.settings.autoCopyOnPlay && state.best) copyToClipboard(state.best.url);
          setTimeout(() => { state.didPlayScan = false; }, 2500);
        }, true);
      }
    });

    document.querySelectorAll('iframe[src]').forEach((el) => addCandidate(el.getAttribute('src'), 'iframe[src]'));
    document.querySelectorAll('embed[src]').forEach((el) => addCandidate(el.getAttribute('src'), 'embed[src]'));
    document.querySelectorAll('object[data]').forEach((el) => addCandidate(el.getAttribute('data'), 'object[data]'));

    document.querySelectorAll('[data-src],[data-url],[data-file],[data-stream],[data-hls],[data-m3u8]').forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        if (/^data-/i.test(attr.name)) {
          extractUrlsFromText(attr.value, 'data-*');
        }
      });
    });

    document.querySelectorAll('script:not([src])').forEach((scriptEl) => {
      extractUrlsFromText(scriptEl.textContent || '', 'inline-script');
    });
  }

  function scanPerformance() {
    const entries = performance.getEntriesByType('resource');
    entries.forEach((entry) => {
      if (entry && entry.name) addCandidate(entry.name, 'performance');
    });
  }

  function recalcBest() {
    const list = Array.from(state.candidates.values()).sort((a, b) => b.score - a.score || b.ts - a.ts);
    const visible = state.settings.showLowConfidence ? list : list.filter((c) => c.confidence !== 'low' || ['direct', 'm3u8', 'mpd', 'embed'].includes(c.type));
    state.best = visible[0] || null;
    state.bestEmbed = list.find((c) => c.type === 'embed') || null;
    return visible.slice(0, CANDIDATE_LIMIT);
  }

  function installFetchHook() {
    if (!window.fetch || window.fetch.__uvlfWrapped) return;
    const original = window.fetch;
    const wrapped = function (...args) {
      try {
        const req = args[0];
        const url = typeof req === 'string' ? req : req && req.url;
        if (url) addCandidate(url, 'fetch');
      } catch (_e) {}
      return original.apply(this, args).then((res) => {
        try {
          if (res && res.url) addCandidate(res.url, 'fetch', `type=${res.type || ''}`);
        } catch (_e) {}
        return res;
      });
    };
    wrapped.__uvlfWrapped = true;
    wrapped.__uvlfOriginal = original;
    window.fetch = wrapped;
    state.hooks.fetchInstalled = true;
  }

  function installXhrHook() {
    if (!window.XMLHttpRequest || window.XMLHttpRequest.prototype.open.__uvlfWrapped) return;
    const openOrig = window.XMLHttpRequest.prototype.open;
    const sendOrig = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__uvlfUrl = url;
      if (url) addCandidate(url, 'xhr');
      return openOrig.call(this, method, url, ...rest);
    };

    window.XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        if (this.responseURL) addCandidate(this.responseURL, 'xhr');
      }, { once: true });
      return sendOrig.apply(this, args);
    };

    window.XMLHttpRequest.prototype.open.__uvlfWrapped = true;
    state.hooks.xhrInstalled = true;
  }

  function installHooksPersistently() {
    installFetchHook();
    installXhrHook();

    setInterval(() => {
      if (!window.fetch || !window.fetch.__uvlfWrapped) installFetchHook();
      if (!window.XMLHttpRequest || !window.XMLHttpRequest.prototype.open.__uvlfWrapped) installXhrHook();
    }, 2000);
  }

  function hasBlobVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos.some((v) => /^blob:/i.test(v.currentSrc || '') || /^blob:/i.test(v.src || ''));
  }

  async function runScan(reason) {
    state.lastStatus = `Skanowanie: ${reason}`;
    render();

    scanDom();
    scanPerformance();

    if (hasBlobVideo()) {
      state.transportHints.push('blob-video');
      await wait(2400);
      scanDom();
      scanPerformance();
      await wait(1800);
      scanPerformance();
    } else {
      await wait(700);
      scanPerformance();
    }

    recalcBest();
    state.lastStatus = state.best ? `Gotowy: ${state.best.type.toUpperCase()}` : 'Brak pewnego trafienia';
    render();
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function copyToClipboard(value) {
    if (!value) return;
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(value, 'text');
      } else {
        navigator.clipboard.writeText(value).catch(() => {});
      }
      state.lastStatus = 'Skopiowano do schowka';
    } catch (_e) {
      state.lastStatus = 'Błąd kopiowania';
    }
    render();
  }

  function ensureStyles() {
    if (document.getElementById('uvlf-beta-style')) return;
    const css = `
      #uvlf-beta-root{position:fixed;z-index:2147483647;font-family:Inter,Arial,sans-serif;color:#fff;min-width:260px}
      #uvlf-beta-root .uvlf-bar{display:flex;gap:8px;align-items:center;background:rgba(5,9,14,.88);backdrop-filter:blur(4px);padding:8px;border-radius:14px;border:1px solid rgba(40,255,180,.35);box-shadow:0 0 0 1px rgba(30,200,150,.15),0 8px 18px rgba(0,0,0,.35)}
      #uvlf-beta-root button{all:unset;cursor:pointer;padding:8px 12px;border-radius:10px;background:rgba(10,20,30,.9);border:1px solid rgba(70,90,105,.7);font-size:13px;line-height:1.1}
      #uvlf-beta-root .uvlf-main{display:flex;align-items:center;gap:8px;border-color:rgba(40,255,180,.45)}
      #uvlf-beta-root .uvlf-pill{font-size:11px;padding:2px 7px;border-radius:999px;background:#1c2a34;border:1px solid #2f4859}
      #uvlf-beta-root .uvlf-menu{width:34px;text-align:center;padding:8px}
      #uvlf-beta-panel{margin-top:8px;background:rgba(0,0,0,.82);border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:10px;max-height:40vh;overflow:auto;min-width:320px}
      #uvlf-beta-panel h4{margin:0 0 8px;font-size:13px}
      #uvlf-beta-panel .uvlf-row{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
      #uvlf-beta-panel .uvlf-row button{font-size:12px}
      #uvlf-beta-panel label{display:flex;gap:6px;align-items:center;font-size:12px;background:rgba(255,255,255,.06);padding:4px 7px;border-radius:7px}
      #uvlf-beta-panel .uvlf-item{display:grid;grid-template-columns:auto auto 1fr auto;gap:8px;align-items:center;background:rgba(255,255,255,.05);padding:8px;border-radius:8px;margin-top:6px}
      #uvlf-beta-panel .uvlf-url{font-size:11px;word-break:break-all}
      #uvlf-beta-panel .uvlf-tag{font-size:10px;padding:2px 6px;border-radius:8px;background:#18242f}
    `;
    const style = document.createElement('style');
    style.id = 'uvlf-beta-style';
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  function ensureUi() {
    if (state.ui) return;
    ensureStyles();
    const root = document.createElement('div');
    root.id = 'uvlf-beta-root';

    const bar = document.createElement('div');
    bar.className = 'uvlf-bar';

    const mainBtn = document.createElement('button');
    mainBtn.className = 'uvlf-main';
    mainBtn.innerHTML = '<span>📼 Video</span><span class="uvlf-pill" id="uvlf-best-pill">Skan</span>';
    mainBtn.addEventListener('click', async () => {
      await runScan('Ręczny');
      if (state.best) copyToClipboard(state.best.url);
    });

    const menuBtn = document.createElement('button');
    menuBtn.className = 'uvlf-menu';
    menuBtn.textContent = '☰';

    const panel = document.createElement('div');
    panel.id = 'uvlf-beta-panel';
    panel.style.display = 'none';

    menuBtn.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      render();
    });

    bar.appendChild(mainBtn);
    bar.appendChild(menuBtn);
    root.appendChild(bar);
    root.appendChild(panel);
    document.documentElement.appendChild(root);

    state.ui = { root, panel, mainBtn, menuBtn };
    render();
  }

  function updateUiPosition() {
    if (!state.ui) return;
    const root = state.ui.root;
    const videos = Array.from(document.querySelectorAll('video')).filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 120 && r.height > 80;
    });
    const target = videos[0] || document.querySelector('iframe, embed, object');

    if (target) {
      const rect = target.getBoundingClientRect();
      const width = Math.max(260, Math.min(420, rect.width));
      root.style.left = `${Math.max(8, rect.left + rect.width / 2 - width / 2)}px`;
      root.style.top = `${Math.max(8, rect.top + 8)}px`;
      root.style.width = `${width}px`;
    } else {
      const width = 320;
      root.style.left = `${Math.max(8, window.innerWidth / 2 - width / 2)}px`;
      root.style.top = '10px';
      root.style.width = `${width}px`;
    }
  }

  function render() {
    if (!state.ui) return;
    updateUiPosition();

    const list = recalcBest();
    const pill = state.ui.root.querySelector('#uvlf-best-pill');
    pill.textContent = state.best ? `${state.best.type.toUpperCase()}` : 'Brak';

    const panel = state.ui.panel;
    panel.innerHTML = '';

    const h = document.createElement('h4');
    h.textContent = state.lastStatus;
    panel.appendChild(h);

    const actions = document.createElement('div');
    actions.className = 'uvlf-row';
    actions.append(
      makeButton('Skanuj ponownie', () => runScan('Ponowny')),
      makeButton('Kopiuj najlepszy', () => state.best && copyToClipboard(state.best.url)),
      makeButton('Kopiuj embed host', () => state.bestEmbed && copyToClipboard(state.bestEmbed.url)),
      makeButton('Wyczyść', () => { state.candidates.clear(); state.best = null; state.bestEmbed = null; render(); })
    );
    panel.appendChild(actions);

    const toggles = document.createElement('div');
    toggles.className = 'uvlf-row';
    toggles.append(
      makeToggle('Automatyczny skan po PLAY', 'autoScanOnPlay'),
      makeToggle('Pokaż wyniki o niskiej pewności', 'showLowConfidence'),
      makeToggle('Preferuj M3U8 / HLS', 'preferM3U8'),
      makeToggle('Automatyczne kopiowanie po PLAY', 'autoCopyOnPlay')
    );
    panel.appendChild(toggles);

    list.slice(0, 12).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'uvlf-item';
      row.innerHTML = `
        <span class="uvlf-tag">${escapeHtml(item.type)}</span>
        <span class="uvlf-tag">${escapeHtml(item.confidence)}</span>
        <div class="uvlf-url">${escapeHtml(item.url)}<br><small>przez ${escapeHtml(item.sources.join(', '))}</small></div>
      `;
      row.appendChild(makeButton('Kopiuj', () => copyToClipboard(item.url)));
      panel.appendChild(row);
    });

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'uvlf-url';
      empty.textContent = 'Brak kandydatów. Uruchom skan lub odtwórz wideo.';
      panel.appendChild(empty);
    }
  }

  function makeButton(label, cb) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', cb);
    return b;
  }

  function makeToggle(label, key) {
    const wrap = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!state.settings[key];
    input.addEventListener('change', () => {
      state.settings[key] = input.checked;
      saveSettings();
      render();
    });
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function schedulePositionUpdates() {
    setInterval(updateUiPosition, 900);
    window.addEventListener('resize', updateUiPosition);
    window.addEventListener('scroll', updateUiPosition, true);
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    installHooksPersistently();
    ensureUi();
    schedulePositionUpdates();

    runScan('Start');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
