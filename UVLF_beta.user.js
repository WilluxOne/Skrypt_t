// ==UserScript==
// @name         UVLF_beta
// @namespace    https://github.com/WilluxOne/Skrypt_t
// @version      beta 16
// @description  Agresywny detektor strumieni wideo (m3u8, mpd, hls/dash) z kopiowaniem bezpośrednich linków. Szuka w network, dom, data-attrs. Wzorowane na tm-hls-dash-downloader i m3u8-pro-player.
// @author       WilluxOne
// @match        *://*/*
// @allFrames    true
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @updateURL    https://raw.githubusercontent.com/WilluxOne/Skrypt_t/main/UVLF_beta.user.js
// @downloadURL  https://raw.githubusercontent.com/WilluxOne/Skrypt_t/main/UVLF_beta.user.js
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_ID = 'uvlf-beta-agresywny';
  const STORE_KEY = 'uvlf-beta-settings';
  const MAX_DATA_ATTR_ELEMENTS = 500;
  const SCAN_INTERVAL = 2000;
  const DEFAULT_SETTINGS = {
    autoScanOnPlay: true,
    showLowConfidence: true,
    preferM3U8: true,
    autoCopyOnPlay: false,
    enableNetworkHooks: true,
  };

  const state = {
    settings: loadSettings(),
    candidates: new Map(),
    bestCopyable: null,
    bestOverall: null,
    uiReady: false,
    shadow: null,
    host: null,
    refs: {},
    observer: null,
    playBound: new WeakSet(),
    scanTimer: null,
    networkHooks: null,
    blobTimers: new Set(),
    lastBlobSeenAt: 0,
    blobActiveSince: 0,
    blobSeenThisScan: false,
    lastReport: '',
    lastScanReason: 'startup',
    mountedOnce: false,
  };

  const SELECTORS = {
    target: 'video, iframe[src], embed[src], object[data], script, link[href], a[href]',
    video: 'video',
    source: 'video source[src], source[src]',
    containers: 'iframe[src], embed[src], object[data]',
    dataAttrs: [
      'data-src', 'data-url', 'data-file', 'data-video', 'data-stream',
      'data-hls', 'data-m3u8', 'data-mpd', 'data-manifest', 'data-media',
      'data-player', 'data-source', 'data-asset', 'data-content',
    ],
    scripts: 'script[src], script[type="application/ld+json"]',
  };

  const DIRECT_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg)(?:$|[?#])/i;
  const M3U8_RE = /(?:\.m3u8(?:$|[?#]))|(?:[?&](?:hls|m3u8|playlist)=)|(?:#EXTINF|#EXT-X-)/i;
  const MPD_RE = /(?:\.mpd(?:$|[?#]))|(?:[?&](?:mpd|dash)=)|(?:<MPD)/i;
  const MANIFEST_RE = /(?:manifest|playlist|master)(?:[/?#&=_-]|$)|(?:#EXT-X-STREAM-INF)/i;
  const SEGMENT_RE = /\.(?:m4s|ts|cmfv?|cmfa|aac|vtt|key)(?:$|[?#])/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)(?:$|[?#])/i;
  const STATIC_EXT_RE = /\.(css|js|map|woff2?|ttf|otf|eot)(?:$|[?#])/i;
  const GARBAGE_RE = /(analytics|doubleclick|googletagmanager|google-analytics|recaptcha|facebook\.com\/plugins|fonts\.(?:googleapis|gstatic)|fontawesome|gravatar)/i;
  const PAGE_NOISE_RE = /(?:^|\/)(?:profile|profiles|tag|tags|category|categories|premium|logout|search|account|help|support)(?:[/?#]|$)/i;

  function setupNetworkHooks() {
    if (!state.settings.enableNetworkHooks || state.networkHooks) return;

    const originalXHR = window.XMLHttpRequest;
    const originalFetch = window.fetch;

    window.XMLHttpRequest = function() {
      const xhr = new originalXHR();
      const originalOpen = xhr.open;
      xhr.open = function(method, url, ...args) {
        if (url && (M3U8_RE.test(url) || MPD_RE.test(url) || MANIFEST_RE.test(url) || DIRECT_EXT_RE.test(url))) {
          console.log('[uvlf] wykryto network wideo:', url);
          addCandidate(url, { sourceKind: 'xhr-request', exposed: true, note: 'z network hook' });
        }
        return originalOpen.apply(this, [method, url, ...args]);
      };

      xhr.addEventListener('load', function() {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const contentType = this.getResponseHeader('content-type') || '';
            const body = typeof this.responseText === 'string' ? this.responseText : '';
            if (contentType.includes('m3u8') || contentType.includes('xml') || M3U8_RE.test(body) || MPD_RE.test(body)) {
              const bodyUrls = extractUrlsFromText(body);
              bodyUrls.forEach(u => addCandidate(u, { sourceKind: 'xhr-response', exposed: true, note: 'z response manifest' }));
            }
          }
        } catch (_) {}
      });

      return xhr;
    };
    window.XMLHttpRequest.prototype = originalXHR.prototype;

    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url && (M3U8_RE.test(url) || MPD_RE.test(url) || MANIFEST_RE.test(url) || DIRECT_EXT_RE.test(url))) {
        console.log('[uvlf] wykryto fetch wideo:', url);
        addCandidate(url, { sourceKind: 'fetch-request', exposed: true, note: 'z fetch hook' });
      }
      return originalFetch.apply(this, arguments).then(response => {
        try {
          const contentType = response.headers && response.headers.get ? (response.headers.get('content-type') || '') : '';
          if (response.clone && (contentType.includes('m3u8') || contentType.includes('xml') || contentType.includes('mpegurl') || contentType.includes('dash'))) {
            const cloned = response.clone();
            cloned.text().then(text => {
              if (contentType.includes('m3u8') || contentType.includes('xml') || M3U8_RE.test(text) || MPD_RE.test(text)) {
                const bodyUrls = extractUrlsFromText(text);
                bodyUrls.forEach(u => addCandidate(u, { sourceKind: 'fetch-response', exposed: true, note: 'z fetch response' }));
              }
            }).catch(() => {});
          }
        } catch (_) {}
        return response;
      });
    };

    state.networkHooks = true;
    console.log('[uvlf] network hooks aktywne – agresywne wykrywanie włączone');
  }

  function extractUrlsFromText(text) {
    const urls = [];
    const urlRegex = /https?:\/\/[^\s"'<>]+/g;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const u = match[0];
      if (M3U8_RE.test(u) || MPD_RE.test(u) || SEGMENT_RE.test(u) || DIRECT_EXT_RE.test(u)) {
        urls.push(u);
      }
    }
    return [...new Set(urls)];
  }

  function loadSettings() {
    const fallback = { ...DEFAULT_SETTINGS };
    try {
      if (typeof GM_getValue === 'function') {
        const raw = GM_getValue(STORE_KEY, null);
        if (raw && typeof raw === 'object') {
          return { ...fallback, ...raw };
        }
        if (typeof raw === 'string') {
          return { ...fallback, ...JSON.parse(raw) };
        }
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        return { ...fallback, ...JSON.parse(raw) };
      }
    } catch (_) {}
    return fallback;
  }

  function saveSettings() {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORE_KEY, state.settings);
        return;
      }
    } catch (_) {}
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.settings));
    } catch (_) {}
  }

  function scheduleScan(reason, delay) {
    state.lastScanReason = reason;
    clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => {
      runScan(reason);
    }, typeof delay === 'number' ? delay : 0);
  }

  function safeNow() {
    return new Date().toISOString();
  }

  function isTopWindow() {
    try {
      return window.top === window.self;
    } catch (_) {
      return false;
    }
  }

  function text(value) {
    return String(value == null ? '' : value);
  }

  function normalizeUrl(value, baseHref) {
    const raw = text(value).trim();
    if (!raw) return null;
    if (/^(?:javascript:|data:|mailto:|tel:)/i.test(raw)) return null;
    if (/^blob:/i.test(raw)) return { url: raw, isBlob: true };
    try {
      const href = new URL(raw, baseHref || location.href).href;
      return { url: href, isBlob: false };
    } catch (_) {
      return null;
    }
  }

  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (_) {
      return false;
    }
  }

  function looksLikePage(url) {
    try {
      const u = new URL(url, location.href);
      const path = u.pathname || '/';
      if (path === '/' || path === location.pathname) return true;
      if (!/\.[a-z0-9]{2,6}$/i.test(path) && !M3U8_RE.test(url) && !MPD_RE.test(url)) {
        return true;
      }
      return PAGE_NOISE_RE.test(path);
    } catch (_) {
      return false;
    }
  }

  function classifyUrl(url, sourceKind) {
    if (/^blob:/i.test(url)) return 'blob';
    if (SEGMENT_RE.test(url)) return 'segment';
    if (DIRECT_EXT_RE.test(url)) return 'direct';
    if (M3U8_RE.test(url)) return 'm3u8';
    if (MPD_RE.test(url)) return 'mpd';
    if (MANIFEST_RE.test(url)) return 'manifest';
    if (sourceKind === 'iframe[src]' || sourceKind === 'embed[src]' || sourceKind === 'object[data]') return 'container';
    if (IMAGE_EXT_RE.test(url) || STATIC_EXT_RE.test(url)) return 'static';
    if (looksLikePage(url)) return 'page';
    return 'other';
  }

  function scoreCandidate(type, sourceKind, options) {
    const typeBase = {
      direct: 100,
      m3u8: 95,
      mpd: 90,
      manifest: 80,
      segment: 70,
      other: 34,
      container: 26,
      page: 10,
    };
    const sourceBase = {
      'video.currentSrc': 40,
      'video.src': 35,
      'source[src]': 30,
      'data-*': 25,
      'xhr-request': 50,
      'fetch-request': 50,
      'xhr-response': 45,
      'fetch-response': 45,
      performance: 14,
      'iframe[src]': 10,
      'embed[src]': 10,
      'object[data]': 10,
      'script/src': 15,
    };
    let score = (typeBase[type] || 0) + (sourceBase[sourceKind] || 0);
    if (options.visible) score += 6;
    if (options.sameOrigin) score += 10;
    if (options.fromBlobFallback) score += 4;
    if (!options.sameOrigin && sourceKind === 'performance') score -= 80;
    if (state.settings.preferM3U8 && (type === 'm3u8' || type === 'manifest')) score += 10;
    if (type === 'page') score -= 20;
    if (type === 'container') score -= 8;
    if (!options.copyable) score -= 5;
    return score;
  }

  function confidenceLabel(score) {
    if (score >= 130) return 'wysoka';
    if (score >= 80) return 'średnia';
    return 'niska';
  }

  function isGarbageUrl(url) {
    if (!url) return true;
    if (/^blob:/i.test(url)) return false;
    if (GARBAGE_RE.test(url)) return true;
    if (IMAGE_EXT_RE.test(url) || STATIC_EXT_RE.test(url)) return true;
    if (url === location.href || url === location.href + '#' || url === location.href + '#!') return true;
    return false;
  }

  function addCandidate(rawValue, meta) {
    meta = meta || {};
    meta.sourceKind = meta.sourceKind || 'other';

    const normalized = normalizeUrl(rawValue, meta.baseHref || location.href);
    if (!normalized) return;
    if (normalized.isBlob) {
      state.lastBlobSeenAt = Date.now();
      state.blobSeenThisScan = true;
      if (!state.blobActiveSince) state.blobActiveSince = Date.now();
      return;
    }

    const url = normalized.url;
    if (isGarbageUrl(url)) return;

    const type = classifyUrl(url, meta.sourceKind);
    if (type === 'static' || type === 'blob') return;

    const same = sameOrigin(url);
    const sk = meta.sourceKind;
    const copyable = meta.copyable !== false && (meta.exposed === true || same || sk.includes('request') || sk.includes('response') || sk === 'video.currentSrc' || sk === 'video.src' || sk === 'source[src]');
    const score = scoreCandidate(type, sk, {
      visible: meta.visible !== false,
      sameOrigin: same,
      fromBlobFallback: !!meta.fromBlobFallback,
      copyable,
    });

    const existing = state.candidates.get(url);
    const confidence = confidenceLabel(score);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.copyable = existing.copyable || copyable;
      existing.visible = existing.visible || meta.visible !== false;
      existing.sameOrigin = existing.sameOrigin || same;
      if (!existing.sourceKinds.includes(sk)) {
        existing.sourceKinds.push(sk);
      }
      if (meta.note && !existing.notes.includes(meta.note)) {
        existing.notes.push(meta.note);
      }
      existing.lastSeenAt = safeNow();
      existing.type = betterType(existing.type, type);
      existing.confidence = confidenceLabel(existing.score);
    } else {
      state.candidates.set(url, {
        url,
        type,
        score,
        confidence,
        copyable,
        visible: meta.visible !== false,
        sameOrigin: same,
        sourceKinds: [sk],
        notes: meta.note ? [meta.note] : [],
        firstSeenAt: safeNow(),
        lastSeenAt: safeNow(),
      });
    }

    updateBest();
    renderUi();
  }

  function betterType(a, b) {
    const rank = { direct: 7, m3u8: 6, mpd: 5, manifest: 4, segment: 3, other: 2, container: 1, page: 0 };
    return (rank[b] || 0) > (rank[a] || 0) ? b : a;
  }

  function getSortedCandidates() {
    const items = Array.from(state.candidates.values()).sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    return state.settings.showLowConfidence ? items : items.filter(item => item.score >= 80);
  }

  function updateBest() {
    const items = Array.from(state.candidates.values()).sort((a, b) => b.score - a.score);
    state.bestOverall = items[0] || null;
    state.bestCopyable = items.find(item => item.copyable) || null;
    state.lastReport = buildReport();
  }

  function buildReport() {
    const total = state.candidates.size;
    const best = state.bestCopyable || state.bestOverall;
    const blobRecent = state.lastBlobSeenAt && (Date.now() - state.lastBlobSeenAt < 15000);
    return [
      `kandydaci: ${total}`,
      `najlepszy: ${best ? `${best.type} (${best.confidence})` : 'brak'}`,
      `blob: ${blobRecent ? 'tak' : 'nie'}`,
      `powód: ${state.lastScanReason}`,
    ].join(' • ');
  }

  function scanDom() {
    scanVideos();
    scanSources();
    scanContainers();
    scanDataAttrs();
    scanScripts();
    scanLinks();
  }

  function scanVideos() {
    document.querySelectorAll(SELECTORS.video).forEach(video => {
      bindPlay(video);
      if (video.currentSrc) addCandidate(video.currentSrc, { sourceKind: 'video.currentSrc', visible: isVisible(video), exposed: true });
      if (video.src) addCandidate(video.src, { sourceKind: 'video.src', visible: isVisible(video), exposed: true });
      const poster = video.getAttribute('poster');
      if (poster && (M3U8_RE.test(poster) || MPD_RE.test(poster) || DIRECT_EXT_RE.test(poster))) {
        addCandidate(poster, { sourceKind: 'video.src', visible: isVisible(video), exposed: true, note: 'z poster' });
      }
    });
  }

  function scanSources() {
    document.querySelectorAll(SELECTORS.source).forEach(el => {
      const src = el.getAttribute('src');
      if (src) addCandidate(src, { sourceKind: 'source[src]', visible: isVisible(el), exposed: true });
    });
  }

  function scanContainers() {
    document.querySelectorAll(SELECTORS.containers).forEach(el => {
      const attr = el.tagName === 'OBJECT' ? 'data' : 'src';
      const value = el.getAttribute(attr);
      if (value) addCandidate(value, { sourceKind: `${el.tagName.toLowerCase()}[${attr}]`, visible: isVisible(el), exposed: true });
    });
  }

  function scanDataAttrs() {
    const elements = document.querySelectorAll('*');
    let count = 0;
    for (const el of elements) {
      for (const attr of SELECTORS.dataAttrs) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (value) {
          addCandidate(value, { sourceKind: 'data-*', visible: isVisible(el), exposed: true, note: attr });
        }
      }
      count += 1;
      if (count >= MAX_DATA_ATTR_ELEMENTS) break;
    }
  }

  function scanScripts() {
    document.querySelectorAll(SELECTORS.scripts).forEach(script => {
      const src = script.getAttribute('src');
      if (src) addCandidate(src, { sourceKind: 'script/src', visible: false, exposed: true });
      if (!src) {
        const body = script.textContent || '';
        extractUrlsFromText(body).forEach(url => addCandidate(url, { sourceKind: 'script/src', visible: false, exposed: true, note: 'z inline script' }));
      }
    });
  }

  function scanLinks() {
    document.querySelectorAll('a[href], link[href]').forEach(el => {
      const href = el.getAttribute('href');
      if (!href) return;
      if (M3U8_RE.test(href) || MPD_RE.test(href) || MANIFEST_RE.test(href) || DIRECT_EXT_RE.test(href)) {
        addCandidate(href, { sourceKind: 'data-*', visible: isVisible(el), exposed: true, note: 'z href' });
      }
    });
  }

  function scanPerformance() {
    try {
      performance.getEntriesByType('resource').forEach(entry => {
        if (!entry || !entry.name) return;
        const name = entry.name;
        if (M3U8_RE.test(name) || MPD_RE.test(name) || MANIFEST_RE.test(name) || DIRECT_EXT_RE.test(name) || SEGMENT_RE.test(name)) {
          addCandidate(name, { sourceKind: 'performance', visible: false, exposed: false, note: 'z performance API' });
        }
      });
    } catch (_) {}
  }

  function runScan(reason) {
    state.lastScanReason = reason || 'manual';
    state.blobSeenThisScan = false;
    try {
      scanDom();
      scanPerformance();
      updateBest();
      renderUi();
    } catch (error) {
      console.warn('[uvlf] scan error', error);
    }
  }

  function isVisible(el) {
    try {
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    } catch (_) {
      return false;
    }
  }

  function bindPlay(video) {
    if (!video || state.playBound.has(video)) return;
    state.playBound.add(video);
    video.addEventListener('play', () => {
      if (state.settings.autoScanOnPlay) {
        scheduleScan('video-play', 150);
        scheduleScan('video-play-late', 1200);
      }
      if (state.settings.autoCopyOnPlay) {
        window.setTimeout(() => {
          const best = state.bestCopyable || state.bestOverall;
          if (best) copyToClipboard(best.url);
        }, 400);
      }
    }, true);
  }

  async function copyToClipboard(value) {
    const textToCopy = text(value).trim();
    if (!textToCopy) return false;
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(textToCopy, 'text');
        flashStatus('Skopiowano');
        return true;
      }
    } catch (_) {}
    try {
      await navigator.clipboard.writeText(textToCopy);
      flashStatus('Skopiowano');
      return true;
    } catch (_) {}
    flashStatus('Błąd kopiowania');
    return false;
  }

  function ensureUi() {
    if (state.uiReady || !document.documentElement || !isTopWindow()) return;

    const host = document.createElement('div');
    host.id = SCRIPT_ID;
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.top = '12px';
    host.style.right = '12px';
    host.style.zIndex = '2147483647';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          font: 12px/1.35 system-ui, sans-serif;
          color: #eaf2ff;
          width: 360px;
          max-width: calc(100vw - 24px);
          background: rgba(13, 18, 28, .94);
          border: 1px solid rgba(140, 170, 255, .22);
          border-radius: 14px;
          box-shadow: 0 10px 30px rgba(0,0,0,.35);
          backdrop-filter: blur(8px);
          overflow: hidden;
        }
        .head { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.08); display:flex; gap:8px; align-items:center; justify-content:space-between; }
        .title { font-weight: 700; font-size: 13px; }
        .sub { opacity:.72; font-size: 11px; margin-top:2px; }
        .actions, .opts { display:flex; gap:6px; flex-wrap:wrap; }
        button {
          appearance:none; border:1px solid rgba(255,255,255,.12); background:#182033; color:#eef4ff;
          border-radius:9px; padding:6px 9px; cursor:pointer; font:inherit;
        }
        button:hover { background:#202a41; }
        .body { padding: 10px 12px; display:grid; gap:10px; }
        .best { padding: 9px; border: 1px solid rgba(255,255,255,.09); border-radius: 10px; background: rgba(255,255,255,.03); }
        .best .kind { font-weight:600; text-transform:uppercase; letter-spacing:.04em; font-size:11px; opacity:.86; }
        .url { word-break: break-all; margin-top:4px; color:#cfe2ff; }
        .muted { opacity:.7; }
        .list { max-height: 280px; overflow:auto; display:grid; gap:7px; }
        .item { padding:8px; border:1px solid rgba(255,255,255,.08); border-radius:10px; background:rgba(255,255,255,.025); }
        .meta { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:4px; }
        .tag { font-size:10px; padding:2px 6px; border-radius:999px; background:rgba(143,176,255,.14); border:1px solid rgba(143,176,255,.18); }
        .row { display:flex; gap:6px; align-items:center; justify-content:space-between; }
        label { display:flex; gap:5px; align-items:center; cursor:pointer; }
        .status { min-height: 16px; font-size:11px; opacity:.8; }
      </style>
      <div class="wrap">
        <div class="head">
          <div>
            <div class="title">UVLF beta</div>
            <div class="sub" id="report"></div>
          </div>
          <div class="actions">
            <button id="scanBtn">Skanuj</button>
            <button id="copyBtn">Kopiuj</button>
          </div>
        </div>
        <div class="body">
          <div class="best">
            <div class="kind" id="bestKind">Brak</div>
            <div class="url" id="bestUrl">Nie znaleziono jeszcze linku.</div>
          </div>
          <div class="opts">
            <label><input id="optPrefer" type="checkbox"> preferuj M3U8</label>
            <label><input id="optLow" type="checkbox"> pokaż niską pewność</label>
            <label><input id="optPlay" type="checkbox"> skanuj po play</label>
          </div>
          <div class="status" id="status"></div>
          <div class="list" id="list"></div>
        </div>
      </div>
    `;

    state.host = host;
    state.shadow = shadow;
    state.refs = {
      report: shadow.getElementById('report'),
      bestKind: shadow.getElementById('bestKind'),
      bestUrl: shadow.getElementById('bestUrl'),
      list: shadow.getElementById('list'),
      status: shadow.getElementById('status'),
      scanBtn: shadow.getElementById('scanBtn'),
      copyBtn: shadow.getElementById('copyBtn'),
      optPrefer: shadow.getElementById('optPrefer'),
      optLow: shadow.getElementById('optLow'),
      optPlay: shadow.getElementById('optPlay'),
    };

    state.refs.scanBtn.addEventListener('click', () => runScan('manual-click'));
    state.refs.copyBtn.addEventListener('click', () => {
      const best = state.bestCopyable || state.bestOverall;
      if (best) copyToClipboard(best.url);
    });

    state.refs.optPrefer.checked = !!state.settings.preferM3U8;
    state.refs.optLow.checked = !!state.settings.showLowConfidence;
    state.refs.optPlay.checked = !!state.settings.autoScanOnPlay;

    state.refs.optPrefer.addEventListener('change', e => {
      state.settings.preferM3U8 = !!e.target.checked;
      saveSettings();
      runScan('settings-change');
    });
    state.refs.optLow.addEventListener('change', e => {
      state.settings.showLowConfidence = !!e.target.checked;
      saveSettings();
      renderUi();
    });
    state.refs.optPlay.addEventListener('change', e => {
      state.settings.autoScanOnPlay = !!e.target.checked;
      saveSettings();
    });

    document.documentElement.appendChild(host);
    state.uiReady = true;
    state.mountedOnce = true;
    renderUi();
  }

  function flashStatus(message) {
    if (!state.refs.status) return;
    state.refs.status.textContent = message;
    window.clearTimeout(flashStatus._t);
    flashStatus._t = window.setTimeout(() => {
      if (state.refs.status) state.refs.status.textContent = '';
    }, 1600);
  }

  function renderUi() {
    if (!state.uiReady) return;
    const best = state.bestCopyable || state.bestOverall;
    state.refs.report.textContent = state.lastReport || 'Brak danych';
    state.refs.bestKind.textContent = best ? `${best.type} • ${best.confidence} • ${best.score}` : 'Brak';
    state.refs.bestUrl.textContent = best ? best.url : 'Nie znaleziono jeszcze linku.';

    const items = getSortedCandidates().slice(0, 25);
    state.refs.list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'Brak kandydatów.';
      state.refs.list.appendChild(empty);
      return;
    }

    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'item';
      const tags = [item.type, item.confidence, `score ${item.score}`]
        .concat(item.copyable ? ['copy'] : [])
        .concat(item.sourceKinds.slice(0, 3));
      row.innerHTML = `
        <div class="meta">${tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
        <div class="url">${escapeHtml(item.url)}</div>
        <div class="row" style="margin-top:6px;">
          <div class="muted">${escapeHtml(item.notes.join(', ') || 'brak notatek')}</div>
          <button type="button">Kopiuj</button>
        </div>
      `;
      row.querySelector('button').addEventListener('click', () => copyToClipboard(item.url));
      state.refs.list.appendChild(row);
    });
  }

  function escapeHtml(value) {
    return text(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function startObservers() {
    if (state.observer) return;
    const root = document.documentElement || document;
    if (!root || !root.addEventListener) return;

    state.observer = new MutationObserver(() => {
      scheduleScan('mutation', 200);
    });
    state.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data-src', 'data-url', 'data-file', 'data-video', 'data-stream', 'data-hls', 'data-m3u8', 'data-mpd', 'data-manifest', 'data-media', 'data-player', 'data-source', 'data-asset', 'data-content'],
    });

    document.addEventListener('play', () => scheduleScan('play-event', 150), true);
    window.addEventListener('load', () => scheduleScan('window-load', 200), { once: true, passive: true });
    window.addEventListener('DOMContentLoaded', () => scheduleScan('dom-ready', 100), { once: true, passive: true });
  }

  function bootstrap() {
    setupNetworkHooks();
    const mount = () => {
      ensureUi();
      startObservers();
      runScan('startup');
      window.setInterval(() => runScan('interval'), SCAN_INTERVAL);
      window.setTimeout(() => runScan('late-startup'), 1200);
    };

    if (document.documentElement) {
      mount();
    } else {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    }
  }

  bootstrap();
})();
