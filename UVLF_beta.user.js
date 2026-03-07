// ==UserScript==
// @name         UVLF_beta
// @namespace    https://github.com/WilluxOne/Skrypt_t
// @version      beta 16
// @description  Agresywny detektor strumieni wideo (m3u8, mpd, hls/dash) z kopiowaniem bezpośrednich linków. Szuka w network, dom, data-attrs. Wzorowane na tm-hls-dash-downloader i m3u8-pro-player.
// @author       WilluxOne (zmodyfikowane)
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

      const originalOnload = xhr.onload;
      xhr.onload = function(...args) {
        if (this.responseType === '' || this.responseType === 'text') {
          const contentType = this.getResponseHeader('content-type') || '';
          if (contentType.includes('m3u8') || contentType.includes('xml') || M3U8_RE.test(this.responseText) || MPD_RE.test(this.responseText)) {
            const bodyUrls = extractUrlsFromText(this.responseText);
            bodyUrls.forEach(u => addCandidate(u, { sourceKind: 'xhr-response', exposed: true, note: 'z response manifest' }));
          }
        }
        return originalOnload ? originalOnload.apply(this, args) : undefined;
      };

      return xhr;
    };

    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url && (M3U8_RE.test(url) || MPD_RE.test(url) || MANIFEST_RE.test(url) || DIRECT_EXT_RE.test(url))) {
        console.log('[uvlf] wykryto fetch wideo:', url);
        addCandidate(url, { sourceKind: 'fetch-request', exposed: true, note: 'z fetch hook' });
      }
      return originalFetch.apply(this, arguments).then(response => {
        if (response.clone) {
          const cloned = response.clone();
          cloned.text().then(text => {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('m3u8') || contentType.includes('xml') || M3U8_RE.test(text) || MPD_RE.test(text)) {
              const bodyUrls = extractUrlsFromText(text);
              bodyUrls.forEach(u => addCandidate(u, { sourceKind: 'fetch-response', exposed: true, note: 'z fetch response' }));
            }
          }).catch(() => {});
        }
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
    const copyable = meta.copyable !== false && (meta.exposed === true || same || meta.sourceKind.includes('request') || meta.sourceKind.includes('response') || meta.sourceKind === 'video.currentSrc' || meta.sourceKind === 'video.src' || meta.sourceKind === 'source[src]');
    const score = scoreCandidate(type, meta.sourceKind, {
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
      if (!existing.sourceKinds.includes(meta.sourceKind)) {
        existing.sourceKinds.push(meta.sourceKind);
      }
      if (meta.note && !existing.notes.includes(meta.note)) {
        existing.notes.push(meta.note);
      }
      existing
