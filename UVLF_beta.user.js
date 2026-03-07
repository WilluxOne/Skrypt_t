// ==UserScript==
//          UVLF_beta
//     https://github.com/WilluxOne/Skrypt_t
//       beta 13
// @description  Safe media inspector overlay for pages you control or are authorized to debug. Detects exposed media URLs, reports blob state, and provides a small floating UI.
//        WilluxOne
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

  const SCRIPT_ID = 'uvlf-beta-safe';
  const STORE_KEY = 'uvlf-beta-settings';
  const MAX_DATA_ATTR_ELEMENTS = 200;
  const DEFAULT_SETTINGS = {
    autoScanOnPlay: true,
    showLowConfidence: false,
    preferM3U8: true,
    autoCopyOnPlay: false,
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
    blobTimers: new Set(),
    lastBlobSeenAt: 0,
    blobActiveSince: 0,
    blobSeenThisScan: false,
    lastReport: '',
    lastScanReason: 'startup',
    mountedOnce: false,
  };

  const SELECTORS = {
    target: 'video, iframe[src], embed[src], object[data]',
    video: 'video',
    source: 'video source[src], source[src]',
    containers: 'iframe[src], embed[src], object[data]',
    dataAttrs: [
      'data-src',
      'data-url',
      'data-file',
      'data-video',
      'data-stream',
      'data-hls',
      'data-m3u8',
      'data-manifest',
      'data-media',
    ],
  };

  const DIRECT_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg)(?:$|[?#])/i;
  const M3U8_RE = /(?:\.m3u8(?:$|[?#]))|(?:[?&](?:hls|m3u8|playlist)=)/i;
  const MPD_RE = /(?:\.mpd(?:$|[?#]))|(?:[?&](?:mpd|dash)=)/i;
  const MANIFEST_RE = /(?:manifest|playlist|master)(?:[/?#&=_-]|$)/i;
  const SEGMENT_RE = /\.(?:m4s|ts|cmfv?|cmfa|aac|vtt|key)(?:$|[?#])/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)(?:$|[?#])/i;
  const STATIC_EXT_RE = /\.(css|js|map|woff2?|ttf|otf|eot)(?:$|[?#])/i;
  const GARBAGE_RE = /(analytics|doubleclick|googletagmanager|google-analytics|recaptcha|facebook\.com\/plugins|fonts\.(?:googleapis|gstatic)|fontawesome|gravatar)/i;
  const PAGE_NOISE_RE = /(?:^|\/)(?:profile|profiles|tag|tags|category|categories|premium|logout|search|account|help|support)(?:[/?#]|$)/i;
  const QUERY_KEYS = ['src', 'data-src', 'data-url', 'data-file', 'data-video', 'data-stream', 'data-hls', 'data-m3u8', 'data-manifest'];

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
      m3u8: 92,
      mpd: 86,
      manifest: 72,
      other: 34,
      container: 26,
      page: 10,
    };
    const sourceBase = {
      'video.currentSrc': 38,
      'video.src': 34,
      'source[src]': 28,
      'data-*': 20,
      performance: 14,
      'iframe[src]': 10,
      'embed[src]': 10,
      'object[data]': 10,
    };
    let score = (typeBase[type] || 0) + (sourceBase[sourceKind] || 0);
    if (options.visible) score += 6;
    if (options.sameOrigin) score += 10;
    if (options.fromBlobFallback) score += 4;
    if (!options.sameOrigin && sourceKind === 'performance') score -= 80;
    if (state.settings.preferM3U8 && type === 'm3u8') score += 8;
    if (type === 'page') score -= 20;
    if (type === 'container') score -= 8;
    if (!options.copyable) score -= 12;
    return score;
  }

  function confidenceLabel(score) {
    if (score >= 120) return 'wysoka';
    if (score >= 90) return 'średnia';
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
    if (type === 'static' || type === 'segment' || type === 'blob') return;

    const same = sameOrigin(url);
    const copyable = meta.copyable !== false && (meta.exposed === true || same || meta.sourceKind === 'video.currentSrc' || meta.sourceKind === 'video.src' || meta.sourceKind === 'source[src]');
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
      existing.confidence = confidenceLabel(existing.score);
      existing.type = chooseBetterType(existing.type, type);
      return;
    }

    state.candidates.set(url, {
      url,
      type,
      sourceKinds: [meta.sourceKind],
      score,
      confidence,
      sameOrigin: same,
      visible: meta.visible !== false,
      copyable,
      notes: meta.note ? [meta.note] : [],
    });
  }

  function chooseBetterType(a, b) {
    const rank = { direct: 5, m3u8: 4, mpd: 3, manifest: 2, container: 1, other: 0, page: -1 };
    return (rank[b] || 0) > (rank[a] || 0) ? b : a;
  }

  function collectFromVideos() {
    const videos = Array.from(document.querySelectorAll(SELECTORS.video));
    videos.forEach((video) => {
      try {
        const currentSrc = text(video.currentSrc).trim();
        const src = text(video.getAttribute('src') || video.src).trim();

        if (/^blob:/i.test(currentSrc) || /^blob:/i.test(src)) {
          state.lastBlobSeenAt = Date.now();
      state.blobSeenThisScan = true;
      if (!state.blobActiveSince) state.blobActiveSince = Date.now();
        }

        if (currentSrc && !/^blob:/i.test(currentSrc)) {
          addCandidate(currentSrc, {
            sourceKind: 'video.currentSrc',
            visible: isElementVisible(video),
            exposed: true,
            note: 'widoczny <video>.currentSrc',
          });
        }
        if (src && !/^blob:/i.test(src)) {
          addCandidate(src, {
            sourceKind: 'video.src',
            visible: isElementVisible(video),
            exposed: true,
            note: 'widoczny atrybut src w <video>',
          });
        }

        const sources = Array.from(video.querySelectorAll('source[src]'));
        sources.forEach((source) => {
          addCandidate(source.getAttribute('src'), {
            sourceKind: 'source[src]',
            visible: isElementVisible(video),
            exposed: true,
            note: 'widoczny <source src>',
          });
        });
      } catch (_) {}
    });
  }

  function collectFromContainers() {
    const nodes = Array.from(document.querySelectorAll(SELECTORS.containers));
    nodes.forEach((node) => {
      const kind = node.tagName.toLowerCase() === 'iframe' ? 'iframe[src]' : node.tagName.toLowerCase() === 'embed' ? 'embed[src]' : 'object[data]';
      const value = node.getAttribute(node.tagName.toLowerCase() === 'object' ? 'data' : 'src');
      addCandidate(value, {
        sourceKind: kind,
        visible: isElementVisible(node),
        exposed: true,
        copyable: false,
        note: 'widoczny kontener osadzony',
      });
    });
  }

  function collectFromDataAttrs() {
    const selectors = SELECTORS.dataAttrs.map((attr) => `[${attr}]`).join(',');
    const nodes = Array.from(document.querySelectorAll(selectors)).slice(0, MAX_DATA_ATTR_ELEMENTS);
    nodes.forEach((node) => {
      QUERY_KEYS.forEach((attr) => {
        const value = node.getAttribute(attr);
        if (!value) return;
        addCandidate(value, {
          sourceKind: 'data-*',
          visible: isElementVisible(node),
          exposed: true,
          note: `widoczny ${attr}`,
        });
      });
    });
  }

  function collectFromPerformance() {
    let entries = [];
    try {
      entries = performance.getEntriesByType('resource');
    } catch (_) {
      return;
    }
    entries.forEach((entry) => {
      const name = text(entry.name).trim();
      if (!name || isGarbageUrl(name)) return;
      if (!sameOrigin(name)) return;
      const kind = classifyUrl(name, 'performance');
      if (!['direct', 'm3u8', 'mpd', 'manifest', 'other'].includes(kind)) return;
      addCandidate(name, {
        sourceKind: 'performance',
        visible: false,
        exposed: false,
        note: `performance (${entry.initiatorType || 'resource'}) same-origin`,
        fromBlobFallback: Date.now() - state.lastBlobSeenAt < 12000,
      });
    });
  }

  function chooseBest() {
    const values = Array.from(state.candidates.values()).sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    const copyable = values.filter((item) => item.copyable && (state.settings.showLowConfidence || item.confidence !== 'niska'));
    state.bestCopyable = copyable[0] || null;
    state.bestOverall = values[0] || null;
  }

  function isElementVisible(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 24 && rect.height > 24 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function getPrimaryTarget() {
    const nodes = Array.from(document.querySelectorAll(SELECTORS.target)).filter(isElementVisible);
    if (!nodes.length) return null;
    nodes.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return nodes[0] || null;
  }

  function positionUi() {
    if (!state.uiReady || !state.host) return;
    const target = getPrimaryTarget();
    let top = 14;
    let left = Math.round(window.innerWidth / 2);

    if (target) {
      const rect = target.getBoundingClientRect();
      top = Math.max(10, Math.round(rect.top + 10));
      left = Math.round(rect.left + rect.width / 2);
    }

    state.host.style.top = `${top}px`;
    state.host.style.left = `${left}px`;
  }

  function renderSummary() {
    if (!state.uiReady) return;
    const best = state.bestCopyable;
    const fallback = state.bestOverall;
    const badge = state.refs.badge;
    const label = state.refs.label;

    if (!badge || !label) return;

    if (best) {
      badge.textContent = `${best.type.toUpperCase()} • ${best.confidence}`;
      label.textContent = shortUrl(best.url);
      badge.dataset.mode = best.type;
    } else if (fallback) {
      badge.textContent = `${fallback.type.toUpperCase()} • tylko raport`;
      label.textContent = shortUrl(fallback.url);
      badge.dataset.mode = 'fallback';
    } else {
      badge.textContent = 'brak';
      label.textContent = 'Brak wykrytego URL-a media';
      badge.dataset.mode = 'none';
    }

    const count = state.candidates.size;
    state.refs.counter.textContent = String(count);
    positionUi();
  }

  function shortUrl(url) {
    const raw = text(url);
    if (raw.length <= 64) return raw;
    return `${raw.slice(0, 30)}…${raw.slice(-26)}`;
  }

  async function copyBest() {
    if (!state.bestCopyable) {
      toast('Brak kopiowalnego URL-a media w tej bezpiecznej wersji.');
      return false;
    }
    const ok = await copyText(state.bestCopyable.url);
    toast(ok ? 'Skopiowano najlepszy URL media.' : 'Nie udało się skopiować.');
    return ok;
  }

  async function copyReport() {
    state.lastReport = buildReport();
    const ok = await copyText(state.lastReport);
    toast(ok ? 'Skopiowano raport diagnostyczny.' : 'Nie udało się skopiować raportu.');
    return ok;
  }

  async function copyText(value) {
    const textValue = text(value);
    if (!textValue) return false;

    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(textValue, 'text');
        return true;
      }
    } catch (_) {}

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(textValue);
        return true;
      }
    } catch (_) {}

    try {
      const ta = document.createElement('textarea');
      ta.value = textValue;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function clearCandidates() {
    state.candidates.clear();
    state.bestCopyable = null;
    state.bestOverall = null;
    renderSummary();
    toast('Wyczyszczono listę wyników.');
  }

  function buildReport() {
    const lines = [];
    lines.push('UVLF_beta SAFE REPORT');
    lines.push(`time: ${safeNow()}`);
    lines.push(`location: ${location.href}`);
    lines.push(`title: ${document.title || '(brak tytułu)'}`);
    lines.push(`frame: ${isTopWindow() ? 'top' : 'subframe'}`);
    lines.push(`lastScanReason: ${state.lastScanReason}`);
    lines.push(`blobSeenRecently: ${Date.now() - state.lastBlobSeenAt < 12000 ? 'yes' : 'no'}`);
    lines.push(`settings: ${JSON.stringify(state.settings)}`);
    lines.push('');
    lines.push('bestCopyable:');
    if (state.bestCopyable) {
      lines.push(`- ${state.bestCopyable.type} | ${state.bestCopyable.confidence} | ${state.bestCopyable.url}`);
      lines.push(`  sources: ${state.bestCopyable.sourceKinds.join(', ')}`);
    } else {
      lines.push('- none');
    }
    lines.push('');
    lines.push('bestOverall:');
    if (state.bestOverall) {
      lines.push(`- ${state.bestOverall.type} | ${state.bestOverall.confidence} | ${state.bestOverall.url}`);
      lines.push(`  sources: ${state.bestOverall.sourceKinds.join(', ')}`);
    } else {
      lines.push('- none');
    }
    lines.push('');
    lines.push('videos:');
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) {
      lines.push('- none');
    } else {
      videos.forEach((video, index) => {
        const rect = video.getBoundingClientRect();
        lines.push(`- #${index + 1} visible=${isElementVisible(video)} size=${Math.round(rect.width)}x${Math.round(rect.height)}`);
        lines.push(`  currentSrc=${video.currentSrc || '(empty)'}`);
        lines.push(`  src=${video.getAttribute('src') || video.src || '(empty)'}`);
        const sources = Array.from(video.querySelectorAll('source[src]')).map((node) => node.getAttribute('src'));
        lines.push(`  sources=${sources.length ? sources.join(' | ') : '(none)'}`);
      });
    }
    lines.push('');
    lines.push('containers:');
    const containers = Array.from(document.querySelectorAll('iframe[src], embed[src], object[data]'));
    if (!containers.length) {
      lines.push('- none');
    } else {
      containers.forEach((node, index) => {
        const attr = node.tagName.toLowerCase() === 'object' ? 'data' : 'src';
        lines.push(`- #${index + 1} <${node.tagName.toLowerCase()}> ${node.getAttribute(attr) || '(empty)'}`);
      });
    }
    lines.push('');
    lines.push('candidates:');
    const candidates = Array.from(state.candidates.values()).sort((a, b) => b.score - a.score);
    if (!candidates.length) {
      lines.push('- none');
    } else {
      candidates.forEach((item, index) => {
        lines.push(`- #${index + 1} ${item.type} | score=${item.score} | conf=${item.confidence} | copyable=${item.copyable} | sameOrigin=${item.sameOrigin}`);
        lines.push(`  url=${item.url}`);
        lines.push(`  sources=${item.sourceKinds.join(', ')}`);
        if (item.notes.length) lines.push(`  notes=${item.notes.join(' ; ')}`);
      });
    }
    lines.push('');
    lines.push('notes:');
    lines.push('- this safe build only uses exposed DOM sources and same-origin performance entries');
    lines.push('- no fetch/xhr interception');
    lines.push('- no inline-script URL scraping');
    lines.push('- no hoster-specific extraction logic');
    return lines.join('\n');
  }

  function attachPlayListeners() {
    const videos = Array.from(document.querySelectorAll('video'));
    videos.forEach((video) => {
      if (state.playBound.has(video)) return;
      state.playBound.add(video);
      video.addEventListener('play', () => {
        if (!state.settings.autoScanOnPlay) return;
        scheduleScan('play', 150);
        if (state.settings.autoCopyOnPlay) {
          window.setTimeout(() => {
            if (state.bestCopyable) copyBest();
          }, 450);
        }
      }, { passive: true });
    });
  }

  function scheduleBlobFollowUps() {
    if (!state.blobActiveSince || Date.now() - state.blobActiveSince > 12000) return;
    [1200, 3200, 7000].forEach((delay) => {
      const timer = window.setTimeout(() => {
        state.blobTimers.delete(timer);
        runScan(`blob-followup-${delay}`);
      }, delay);
      state.blobTimers.add(timer);
    });
  }

  function clearBlobTimers() {
    state.blobTimers.forEach((timer) => clearTimeout(timer));
    state.blobTimers.clear();
  }

  function runScan(reason) {
    state.lastScanReason = reason || 'manual';
    state.candidates.clear();
    state.blobSeenThisScan = false;
    attachPlayListeners();
    collectFromVideos();
    collectFromContainers();
    collectFromDataAttrs();
    collectFromPerformance();
    chooseBest();
    if (!state.blobSeenThisScan) {
      state.blobActiveSince = 0;
      clearBlobTimers();
    }
    state.lastReport = buildReport();
    renderSummary();
    if (state.blobActiveSince && Date.now() - state.blobActiveSince < 12000) {
      clearBlobTimers();
      scheduleBlobFollowUps();
    }
  }

  function toast(message) {
    if (!state.uiReady || !state.refs.toast) return;
    state.refs.toast.textContent = message;
    state.refs.toast.dataset.open = '1';
    clearTimeout(state.refs.toast._timer);
    state.refs.toast._timer = window.setTimeout(() => {
      state.refs.toast.dataset.open = '0';
    }, 1800);
  }

  function setToggle(name, value) {
    state.settings[name] = !!value;
    saveSettings();
    renderSummary();
  }

  function buildUi() {
    if (state.uiReady) return;
    const mount = document.documentElement || document.body;
    if (!mount) {
      window.setTimeout(buildUi, 50);
      return;
    }

    const host = document.createElement('div');
    host.id = SCRIPT_ID;
    host.setAttribute('data-uvlf-root', '1');
    host.style.position = 'fixed';
    host.style.top = '14px';
    host.style.left = '50%';
    host.style.transform = 'translateX(-50%)';
    host.style.zIndex = '2147483646';
    host.style.pointerEvents = 'auto';
    host.style.font = 'normal 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .uvlf-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .uvlf-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 10px;
          border-radius: 18px;
          color: #f0f7f5;
          background: rgba(5, 10, 12, 0.88);
          border: 1px solid rgba(54, 203, 155, 0.65);
          box-shadow: 0 0 0 1px rgba(0,0,0,0.35) inset, 0 6px 18px rgba(0,0,0,0.45);
          backdrop-filter: blur(4px);
          min-width: 260px;
          max-width: min(86vw, 620px);
        }
        .uvlf-btn,
        .uvlf-menu-btn,
        .uvlf-mini {
          appearance: none;
          border: 1px solid rgba(73, 207, 162, 0.7);
          background: rgba(22, 28, 31, 0.96);
          color: #f0f7f5;
          border-radius: 14px;
          cursor: pointer;
          font: inherit;
          transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
        }
        .uvlf-btn:hover,
        .uvlf-menu-btn:hover,
        .uvlf-mini:hover { transform: translateY(-1px); }
        .uvlf-btn { padding: 8px 12px; font-weight: 700; }
        .uvlf-menu-btn { width: 38px; height: 38px; display: grid; place-items: center; font-size: 20px; line-height: 1; }
        .uvlf-status { min-width: 0; flex: 1 1 auto; display: grid; gap: 4px; }
        .uvlf-badge {
          justify-self: start;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 3px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.02em;
          background: rgba(20, 26, 28, 0.95);
          border: 1px solid rgba(104, 204, 176, 0.55);
          color: #cafff0;
        }
        .uvlf-badge[data-mode="direct"],
        .uvlf-badge[data-mode="m3u8"],
        .uvlf-badge[data-mode="mpd"],
        .uvlf-badge[data-mode="manifest"] { color: #d5ffde; }
        .uvlf-badge[data-mode="fallback"] { color: #ffeab4; }
        .uvlf-badge[data-mode="none"] { color: #f7d4d4; }
        .uvlf-label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          color: #d7ece5;
        }
        .uvlf-counter {
          width: 24px;
          height: 24px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          background: rgba(18, 26, 29, 0.96);
          border: 1px solid rgba(104, 204, 176, 0.55);
          font-size: 11px;
          font-weight: 700;
          color: #f2fffb;
        }
        .uvlf-menu {
          width: min(86vw, 420px);
          display: none;
          gap: 10px;
          padding: 12px;
          border-radius: 16px;
          background: rgba(0, 0, 0, 0.82);
          border: 1px solid rgba(91, 197, 167, 0.55);
          box-shadow: 0 12px 24px rgba(0,0,0,0.35);
          color: #eff8f5;
        }
        .uvlf-menu[data-open="1"] { display: grid; }
        .uvlf-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .uvlf-mini { padding: 8px 10px; text-align: center; }
        .uvlf-note {
          font-size: 11px;
          color: #cfe4dd;
          opacity: 0.88;
        }
        .uvlf-toggles { display: grid; gap: 8px; }
        .uvlf-toggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 7px 10px;
          background: rgba(13, 18, 20, 0.92);
          border: 1px solid rgba(73, 207, 162, 0.22);
          border-radius: 12px;
          font-size: 12px;
        }
        .uvlf-toggle input { accent-color: #4fd7aa; }
        .uvlf-toast {
          max-width: min(82vw, 480px);
          padding: 8px 10px;
          border-radius: 12px;
          background: rgba(0,0,0,0.78);
          color: #eff8f5;
          border: 1px solid rgba(94, 194, 165, 0.4);
          font-size: 12px;
          opacity: 0;
          transform: translateY(-4px);
          transition: opacity 0.18s ease, transform 0.18s ease;
          pointer-events: none;
        }
        .uvlf-toast[data-open="1"] { opacity: 1; transform: translateY(0); }
      </style>
      <div class="uvlf-wrap">
        <div class="uvlf-bar">
          <button class="uvlf-btn" id="scanCopyBtn" title="Skanuj i kopiuj, jeśli dostępny jest kopiowalny URL">Video</button>
          <div class="uvlf-status">
            <span class="uvlf-badge" id="badge" data-mode="none">brak</span>
            <span class="uvlf-label" id="label">Brak wykrytego URL-a media</span>
          </div>
          <span class="uvlf-counter" id="counter">0</span>
          <button class="uvlf-menu-btn" id="menuBtn" title="Menu">☰</button>
        </div>
        <div class="uvlf-menu" id="menu" data-open="0">
          <div class="uvlf-actions">
            <button class="uvlf-mini" id="rescanBtn">Skanuj ponownie</button>
            <button class="uvlf-mini" id="copyBestBtn">Kopiuj najlepszy</button>
            <button class="uvlf-mini" id="copyReportBtn">Kopiuj raport</button>
            <button class="uvlf-mini" id="clearBtn">Wyczyść</button>
          </div>
          <div class="uvlf-toggles">
            <label class="uvlf-toggle"><span>Automatyczny skan po PLAY</span><input id="toggleAutoScan" type="checkbox"></label>
            <label class="uvlf-toggle"><span>Pokaż wyniki o niskiej pewności</span><input id="toggleLowConf" type="checkbox"></label>
            <label class="uvlf-toggle"><span>Preferuj M3U8 / HLS</span><input id="togglePreferM3u8" type="checkbox"></label>
            <label class="uvlf-toggle"><span>Automatyczne kopiowanie po PLAY</span><input id="toggleAutoCopy" type="checkbox"></label>
          </div>
          <div class="uvlf-note">Ta bezpieczna wersja używa tylko źródeł jawnie widocznych w DOM oraz same-origin wpisów z performance.</div>
        </div>
        <div class="uvlf-toast" id="toast" data-open="0"></div>
      </div>
    `;

    mount.appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.refs = {
      menu: shadow.getElementById('menu'),
      badge: shadow.getElementById('badge'),
      label: shadow.getElementById('label'),
      counter: shadow.getElementById('counter'),
      toast: shadow.getElementById('toast'),
    };

    shadow.getElementById('scanCopyBtn').addEventListener('click', async () => {
      runScan('button-scan-copy');
      if (state.bestCopyable) {
        await copyBest();
      } else {
        toast('Skan zakończony. Brak kopiowalnego URL-a media.');
      }
    });
    shadow.getElementById('menuBtn').addEventListener('click', () => {
      const open = state.refs.menu.dataset.open === '1';
      state.refs.menu.dataset.open = open ? '0' : '1';
      positionUi();
    });
    shadow.getElementById('rescanBtn').addEventListener('click', () => runScan('menu-rescan'));
    shadow.getElementById('copyBestBtn').addEventListener('click', copyBest);
    shadow.getElementById('copyReportBtn').addEventListener('click', copyReport);
    shadow.getElementById('clearBtn').addEventListener('click', clearCandidates);

    const toggleAutoScan = shadow.getElementById('toggleAutoScan');
    const toggleLowConf = shadow.getElementById('toggleLowConf');
    const togglePreferM3u8 = shadow.getElementById('togglePreferM3u8');
    const toggleAutoCopy = shadow.getElementById('toggleAutoCopy');

    toggleAutoScan.checked = !!state.settings.autoScanOnPlay;
    toggleLowConf.checked = !!state.settings.showLowConfidence;
    togglePreferM3u8.checked = !!state.settings.preferM3U8;
    toggleAutoCopy.checked = !!state.settings.autoCopyOnPlay;

    toggleAutoScan.addEventListener('change', (event) => setToggle('autoScanOnPlay', event.target.checked));
    toggleLowConf.addEventListener('change', (event) => { setToggle('showLowConfidence', event.target.checked); runScan('toggle-low-confidence'); });
    togglePreferM3u8.addEventListener('change', (event) => { setToggle('preferM3U8', event.target.checked); runScan('toggle-prefer-hls'); });
    toggleAutoCopy.addEventListener('change', (event) => setToggle('autoCopyOnPlay', event.target.checked));

    state.uiReady = true;
    state.mountedOnce = true;
    renderSummary();
    positionUi();
  }

  function observeDom() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(() => {
      attachPlayListeners();
      positionUi();
      scheduleScan('mutation', 500);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data', 'style', 'class', 'data-src', 'data-url', 'data-file', 'data-video', 'data-stream', 'data-hls', 'data-m3u8', 'data-manifest', 'data-media'],
    });
  }

  function wireGlobalEvents() {
    window.addEventListener('resize', positionUi, { passive: true });
    window.addEventListener('scroll', positionUi, { passive: true, capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleScan('visible', 120);
    });
    window.addEventListener('load', () => scheduleScan('load', 120), { once: true });
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive' || document.readyState === 'complete') {
        buildUi();
        observeDom();
        attachPlayListeners();
        scheduleScan(`readyState-${document.readyState}`, 80);
      }
    });
  }

  function boot() {
    buildUi();
    observeDom();
    attachPlayListeners();
    scheduleScan('startup', document.readyState === 'loading' ? 220 : 80);
    window.setTimeout(() => runScan('startup-late'), 1200);
    wireGlobalEvents();
  }

  boot();
})();
