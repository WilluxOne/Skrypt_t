// ==UserScript==
// @name         UVLF_beta
// @namespace    https://github.com/WilluxOne/Skrypt_t
// @version      beta 9
// @description  Wykrywa adresy wideo, preferuje M3U8/HLS, obsluguje blob:, kopiuje najlepszy wynik i pokazuje menu przy odtwarzaczu.
// @author       Willux
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/WilluxOne/Skrypt_t/main/UVLF_beta.user.js
// @updateURL    https://raw.githubusercontent.com/WilluxOne/Skrypt_t/main/UVLF_beta.user.js
// @allFrames    true
// ==/UserScript==

(() => {
  'use strict';

  const DIRECT_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv', 'mpg', 'mpeg']);
  const MANIFEST_EXTS = new Set(['m3u8', 'mpd']);
  const EMBED_HOST_PATTERNS = [
    /(^|\.)voe\.(sx|com|network)$/i,
    /(^|\.)vidmoly\./i,
    /(^|\.)streamtape\./i,
    /(^|\.)dood\./i,
    /(^|\.)filemoon\./i,
    /(^|\.)uqload\./i,
    /(^|\.)mixdrop\./i,
    /(^|\.)ok\.ru$/i,
    /(^|\.)vtube\./i,
    /(^|\.)luluvdo\./i
  ];
  const WRAPPER_JUNK_PATH_RE = /\/(?:profile|profil|user|users|tag|tags|category|categories|kategoria|search|szukaj|help|faq|premium|logout|wylogowanie|account|login|register|signup|kontakt|contact|policy|privacy|terms|regulamin|cookies|ads?|reklama|about|home|index|browse|listing|list|forum|comments?|community)(?:\/|$)/i;
  const WRAPPER_JUNK_QUERY_RE = /(?:^|[?&])(page|sort|filter|cat|category|tag|profile|user|uid|q|query|search|s|ref|utm_[^=]+|fbclid|gclid)=/i;
  const MEDIA_HINT_RE = /(?:\.m3u8|\.mpd|\.(?:mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg))(?:$|[?#&])/i;
  const MEDIA_QUERY_HINT_RE = /(?:^|[?&])(file|src|source|url|video|stream|hls|m3u8|mpd|playlist|manifest|play)=/i;
  const IGNORE_EXTS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'css', 'js', 'map', 'json', 'xml', 'txt',
    'vtt', 'srt', 'ass', 'ssa', 'ttml', 'otf', 'ttf', 'woff', 'woff2', 'eot', 'm4s', 'ts', 'aac',
    'mp3', 'wav', 'm4a', 'oga', 'flac', 'swf', 'pdf', 'zip', 'rar', '7z'
  ]);
  const MEDIA_DATA_ATTRS = [
    'src', 'data-src', 'data-url', 'data-file', 'data-video', 'data-stream', 'data-hls',
    'data-m3u8', 'data-mpd', 'data-playlist', 'data-config', 'data-setup', 'poster'
  ];
  const TARGET_SELECTORS = [
    'video', 'iframe', 'embed', 'object', '.video-js', '.jwplayer', '.plyr',
    '[class*="player"]', '[id*="player"]', '[class*="video"]', '[id*="video"]'
  ].join(',');
  const SCRIPT_SCAN_LIMIT = 220000;
  const SHORT_WAIT_MS = 1800;
  const LONG_WAIT_MS = 12000;
  const BLOB_WAIT_MS = 20000;
  const POLL_MS = 350;

  const state = {
    root: null,
    toolbar: null,
    mainBtn: null,
    menuBtn: null,
    panel: null,
    resultsWrap: null,
    statusWrap: null,
    activeTarget: null,
    menuOpen: false,
    running: false,
    repaintScheduled: false,
    statusText: 'Gotowy',
    lastBestKey: '',
    candidates: new Map(),
    seenFingerprints: new Set(),
    settings: {
      autoScanOnPlay: true,
      showLowConfidence: false,
      preferM3U8: true,
      autoCopyOnPlay: false
    }
  };

  /*
   * Skrypt wyszukuje linki do strumieni i plikow wideo na stronie.
   * Najpierw preferuje M3U8/HLS, zwlaszcza gdy odtwarzacz korzysta z blob:,
   * ale potrafi tez znalezc MPD, bezposrednie pliki wideo i inne manifesty.
   * Wyniki mozna skopiowac jednym kliknieciem z panelu przy odtwarzaczu.
   */

  const isHttpLike = (u) => /^https?:/i.test(u);
  const isBlobLike = (u) => /^blob:/i.test(u);
  const isMaybeRelative = (u) => /^(\/|\.\/|\.\.\/)/.test(u);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function gmAddStyleSafe(css) {
    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle(css);
        return;
      }
    } catch (_) {}

    const apply = () => {
      const host = document.head || document.documentElement || document.body;
      if (!host) return false;
      const style = document.createElement('style');
      style.textContent = css;
      host.appendChild(style);
      return true;
    };

    if (!apply()) {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    }
  }

  gmAddStyleSafe(`
    .tm-vlf-root {
      position: fixed;
      z-index: 2147483647;
      display: none;
      pointer-events: auto;
      color: #fff;
      text-shadow: 0 0 2px rgba(100,170,255,0.9), 0 0 8px rgba(60,130,255,0.75);
      font: 700 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    .tm-vlf-root.tm-vlf-visible { display: block; }

    .tm-vlf-root,
    .tm-vlf-root *,
    .tm-vlf-root .tm-vlf-btn,
    .tm-vlf-root .tm-vlf-menu-btn,
    .tm-vlf-root .tm-vlf-mini-btn,
    .tm-vlf-root .tm-vlf-badge,
    .tm-vlf-root .tm-vlf-pill,
    .tm-vlf-root .tm-vlf-status-text,
    .tm-vlf-root .tm-vlf-url,
    .tm-vlf-root .tm-vlf-via,
    .tm-vlf-root label,
    .tm-vlf-root span,
    .tm-vlf-root div,
    .tm-vlf-root button {
      color: #fff !important;
      text-shadow: 0 0 2px rgba(100,170,255,0.95), 0 0 8px rgba(60,130,255,0.8), 0 0 14px rgba(60,130,255,0.45);
      font-weight: 700 !important;
    }
    .tm-vlf-toolbar {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .tm-vlf-btn, .tm-vlf-menu-btn, .tm-vlf-mini-btn {
      border: 1px solid rgba(255,255,255,0.22);
      background: rgba(20,20,20,0.78);
      color: #fff;
      text-shadow: 0 0 2px rgba(100,170,255,0.9), 0 0 8px rgba(60,130,255,0.75);
      cursor: pointer;
      user-select: none;
      backdrop-filter: blur(8px);
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
    }
    .tm-vlf-btn, .tm-vlf-menu-btn {
      height: 34px;
      border-radius: 11px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .tm-vlf-btn {
      padding: 0 12px;
      gap: 8px;
    }
    .tm-vlf-menu-btn {
      width: 38px;
      padding: 0;
      position: relative;
    }
    .tm-vlf-btn:hover, .tm-vlf-menu-btn:hover, .tm-vlf-mini-btn:hover {
      background: rgba(32,32,32,0.9);
    }
    .tm-vlf-btn:active, .tm-vlf-menu-btn:active, .tm-vlf-mini-btn:active {
      transform: translateY(1px);
    }
    .tm-vlf-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 54px;
      padding: 2px 6px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      opacity: 0.97;
    }
    .tm-vlf-bars,
    .tm-vlf-bars::before,
    .tm-vlf-bars::after {
      display: block;
      width: 16px;
      height: 2px;
      border-radius: 999px;
      background: rgba(255,255,255,0.95);
      content: "";
      transition: transform 0.18s ease, opacity 0.18s ease;
      position: relative;
    }
    .tm-vlf-bars::before { top: -5px; position: absolute; left: 0; }
    .tm-vlf-bars::after { top: 5px; position: absolute; left: 0; }
    .tm-vlf-menu-open .tm-vlf-bars { background: transparent; }
    .tm-vlf-menu-open .tm-vlf-bars::before { top: 0; transform: rotate(45deg); }
    .tm-vlf-menu-open .tm-vlf-bars::after { top: 0; transform: rotate(-45deg); }
    .tm-vlf-btn.tm-vlf-ok, .tm-vlf-menu-btn.tm-vlf-ok { border-color: rgba(46, 204, 113, 0.65); }
    .tm-vlf-btn.tm-vlf-bad, .tm-vlf-menu-btn.tm-vlf-bad { border-color: rgba(231, 76, 60, 0.65); }
    .tm-vlf-btn.tm-vlf-run, .tm-vlf-menu-btn.tm-vlf-run { border-color: rgba(241, 196, 15, 0.75); }
    .tm-vlf-panel {
      margin-top: 8px;
      min-width: 360px;
      max-width: min(76vw, 780px);
      max-height: min(58vh, 480px);
      overflow: auto;
      padding: 10px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(0,0,0,0.76);
      backdrop-filter: blur(10px);
      box-shadow: 0 14px 34px rgba(0,0,0,0.42);
      display: none;
    }
    .tm-vlf-root.tm-vlf-menu-open .tm-vlf-panel { display: block; }
    .tm-vlf-status-line {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .tm-vlf-status-text {
      opacity: 0.94;
      font-size: 12px;
      word-break: break-word;
    }
    .tm-vlf-badges {
      display: inline-flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tm-vlf-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 20px;
      padding: 0 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      font-size: 11px;
      white-space: nowrap;
    }
    .tm-vlf-section {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .tm-vlf-actions, .tm-vlf-toggles {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .tm-vlf-mini-btn {
      border-radius: 10px;
      padding: 6px 10px;
      font-size: 12px;
      line-height: 1.1;
    }
    .tm-vlf-toggle {
      display: inline-flex;
      gap: 7px;
      align-items: center;
      padding: 5px 8px;
      border-radius: 10px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      cursor: pointer;
      user-select: none;
    }
    .tm-vlf-toggle input { margin: 0; }
    .tm-vlf-list {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .tm-vlf-item {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 8px 9px;
      border-radius: 12px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      min-width: 0;
    }
    .tm-vlf-kind {
      min-width: 58px;
      text-align: center;
      font-size: 11px;
      padding: 4px 6px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
    }
    .tm-vlf-meta {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .tm-vlf-url {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.98;
    }
    .tm-vlf-via {
      font-size: 11px;
      opacity: 0.7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tm-vlf-empty {
      padding: 8px 0 2px;
      opacity: 0.8;
    }
  `);

  function setStatus(text) {
    state.statusText = text;
    renderPanel();
  }

  function cleanExtractedUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let url = raw.trim();
    url = url.replace(/["'`]+$/g, '').replace(/^["'`]+/g, '');
    url = url.replace(/[)\],;]+$/g, '');
    if (!url || /^(javascript:|data:|mailto:|about:blank|chrome:|moz-extension:|edge:)/i.test(url)) return '';
    if (isBlobLike(url)) return '';
    try {
      if (isHttpLike(url)) return new URL(url).href;
      if (isMaybeRelative(url)) return new URL(url, location.href).href;
      if (/^[\w.-]+\.[a-z]{2,}(?:\/|$)/i.test(url)) return `https://${url}`;
      return '';
    } catch (_) {
      return '';
    }
  }

  function safeDecode(value) {
    if (!value || typeof value !== 'string') return '';
    let out = value;
    for (let i = 0; i < 2; i += 1) {
      try {
        const next = decodeURIComponent(out);
        if (next === out) break;
        out = next;
      } catch (_) {
        break;
      }
    }
    return out;
  }

  function getUrlExt(url) {
    try {
      const u = new URL(url);
      const file = (u.pathname.split('/').pop() || '').toLowerCase();
      const match = file.match(/\.([a-z0-9]{1,6})$/i);
      return match ? match[1] : '';
    } catch (_) {
      return '';
    }
  }

  function isLikelySegment(url, ext) {
    const lower = url.toLowerCase();
    if (ext === 'm4s' || ext === 'ts') return true;
    if (/[?&](range|bytestart|byteend|part|segment|seg|frag)=/i.test(lower)) return true;
    if (/(^|\/)init[._-]/i.test(lower)) return true;
    if (/(^|\/)(seg|segment|chunk|frag|fragment|part)[-_/]?\d+/i.test(lower)) return true;
    if (/(^|\/)(audio|video|subtitle|subtitles|caption|captions)[-_./]?\d+/i.test(lower)) return true;
    return false;
  }

  function looksLikeEmbedHostUrl(url) {
    try {
      const u = new URL(url, location.href);
      const host = u.hostname || '';
      const path = u.pathname || '';
      if (EMBED_HOST_PATTERNS.some((re) => re.test(host))) return true;
      if (/\/(?:e|embed|v|d)\//i.test(path) && /(?:voe|vidmoly|streamtape|dood|filemoon|mixdrop|uqload|luluvdo|streamwish)/i.test(host)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function isNavigationLikeUrl(url) {
    try {
      const u = new URL(url, location.href);
      const samePage = u.origin === location.origin && u.pathname === location.pathname;
      if (samePage && (u.hash || !u.search)) return true;
      if (samePage && /^!(?:$|\/)/.test((u.hash || '').replace(/^#/, ''))) return true;
      if (/\/(profil|premium|wylogowanie|ulubione|poczekalnia|centrum-pomocy|ai\/search)\/?$/i.test(u.pathname)) return true;
      if (/\/(filmy|seriale|dla-dzieci-pl|materialy|tag)\b/i.test(u.pathname) && !looksLikeEmbedHostUrl(url)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function isLikelyWrapperJunkUrl(url, meta = {}) {
    if (!url) return true;
    if (looksLikeEmbedHostUrl(url) || meta.embedHost) return false;
    if (MEDIA_HINT_RE.test(url)) return false;

    try {
      const u = new URL(url, location.href);
      const path = u.pathname || '/';
      const hash = u.hash || '';
      const sameOrigin = u.origin === location.origin;

      if ((u.href === location.href || `${u.origin}${path}` === `${location.origin}${location.pathname}`) && (hash || !u.search)) return true;
      if (hash && (hash === '#' || hash === '#!' || /^#!(?:$|\/)/.test(hash))) return true;
      if (isNavigationLikeUrl(u.href)) return true;
      if (/^(?:javascript:|about:blank)$/i.test(u.href)) return true;

      if (!sameOrigin) return false;
      if (WRAPPER_JUNK_PATH_RE.test(path)) return true;
      if (WRAPPER_JUNK_QUERY_RE.test(u.search || '')) return true;

      if ((!path || path === '/' || /^\/(?:index(?:\.[a-z0-9]+)?|home)?$/i.test(path)) && !MEDIA_QUERY_HINT_RE.test(u.search || '')) return true;
      return false;
    } catch (_) {
      return true;
    }
  }

  function looksLikeManifestUrl(url) {
    const lower = url.toLowerCase();
    return /(manifest|playlist|master|stream|index)/.test(lower) && !isLikelySegment(lower, getUrlExt(lower));
  }

  function inferKind(url, meta = {}) {
    const cleanUrl = cleanExtractedUrl(url);
    if (!cleanUrl) return null;

    const contentType = String(meta.contentType || '').toLowerCase();
    const ext = getUrlExt(cleanUrl);
    const fromMedia = Boolean(meta.fromMedia);
    const lower = cleanUrl.toLowerCase();
    const segment = isLikelySegment(cleanUrl, ext);

    if (IGNORE_EXTS.has(ext) && !MANIFEST_EXTS.has(ext) && !DIRECT_EXTS.has(ext)) return null;
    if ((isNavigationLikeUrl(cleanUrl) || isLikelyWrapperJunkUrl(cleanUrl, meta)) && !meta.embedHost && !looksLikeEmbedHostUrl(cleanUrl)) return null;

    let kind = '';
    let confidence = 'low';
    let score = 0;

    if (DIRECT_EXTS.has(ext) && !segment) {
      kind = 'direct';
      confidence = 'high';
      score = 1000;
    } else if (ext === 'm3u8' || /mpegurl|application\/x-mpegurl|vnd\.apple\.mpegurl/.test(contentType)) {
      kind = 'm3u8';
      confidence = 'high';
      score = 820;
    } else if (ext === 'mpd' || /dash\+xml/.test(contentType)) {
      kind = 'mpd';
      confidence = 'high';
      score = 720;
    } else if (/^video\//.test(contentType) && !/mpegurl|dash\+xml/.test(contentType) && !segment) {
      kind = 'direct';
      confidence = fromMedia ? 'high' : 'medium';
      score = fromMedia ? 960 : 900;
    } else if (fromMedia && !segment) {
      kind = 'video-probable';
      confidence = 'medium';
      score = 690;
    } else if (looksLikeEmbedHostUrl(cleanUrl) || meta.embedHost) {
      kind = 'embed';
      confidence = 'medium';
      score = 780;
    } else if (looksLikeManifestUrl(cleanUrl) || /mpegurl|dash|manifest|playlist/.test(contentType)) {
      kind = 'manifest';
      confidence = 'medium';
      score = 600;
    } else {
      return null;
    }

    if (meta.via === 'video' || meta.via === 'source') score += 70;
    if (meta.via === 'fetch' || meta.via === 'xhr') score += 55;
    if (meta.via === 'performance') score += 35;
    if (meta.via === 'iframe') score += 120;
    if (meta.currentSrc) score += 60;
    if (meta.initiatorType === 'video') score += 35;
    try {
      const u = new URL(cleanUrl, location.href);
      const sameOrigin = u.origin === location.origin;
      if (sameOrigin && !DIRECT_EXTS.has(ext) && !MANIFEST_EXTS.has(ext) && kind !== 'embed') score -= 220;
      if (sameOrigin && (u.hash || /^!(?:$|\/)/.test((u.hash || '').replace(/^#/, '')))) score -= 320;
      if (isLikelyWrapperJunkUrl(cleanUrl, meta) && kind !== 'embed') score -= 500;
      if (kind === 'embed' && !sameOrigin) score += 80;
      if (kind === 'embed' && /\/(?:e|embed|v|d)\//i.test(u.pathname || '')) score += 50;
    } catch (_) {}

    return {
      url: cleanUrl,
      ext,
      kind,
      score,
      confidence,
      via: meta.via ? [meta.via] : [],
      initiatorTypes: meta.initiatorType ? [meta.initiatorType] : [],
      contentTypes: contentType ? [contentType] : [],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      hitCount: 1
    };
  }

  function mergeCandidate(next) {
    const key = next.url;
    const existing = state.candidates.get(key);
    if (!existing) {
      state.candidates.set(key, next);
      renderPanel();
      return next;
    }

    existing.lastSeen = Date.now();
    existing.hitCount += 1;
    existing.score = Math.max(existing.score, next.score);
    existing.confidence = existing.confidence === 'high' || next.confidence === 'high'
      ? 'high'
      : (existing.confidence === 'medium' || next.confidence === 'medium' ? 'medium' : 'low');
    if (!existing.via.includes(next.via[0])) existing.via.push(next.via[0]);
    for (const item of next.initiatorTypes) if (!existing.initiatorTypes.includes(item)) existing.initiatorTypes.push(item);
    for (const item of next.contentTypes) if (!existing.contentTypes.includes(item)) existing.contentTypes.push(item);
    if (priorityIndex(next.kind) < priorityIndex(existing.kind)) existing.kind = next.kind;
    renderPanel();
    return existing;
  }

  function ingestCandidate(rawUrl, meta = {}) {
    const seen = new Set();
    const queue = [rawUrl];

    while (queue.length) {
      const current = queue.shift();
      const clean = cleanExtractedUrl(current);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);

      const fingerprint = [
        meta.via || '',
        meta.contentType || '',
        meta.initiatorType || '',
        meta.fromMedia ? '1' : '0',
        meta.currentSrc ? '1' : '0',
        clean
      ].join('|');

      if (!state.seenFingerprints.has(fingerprint)) {
        state.seenFingerprints.add(fingerprint);
        const candidate = inferKind(clean, meta);
        if (candidate) mergeCandidate(candidate);
      }

      for (const nested of extractNestedUrls(clean)) {
        if (!seen.has(nested)) queue.push(nested);
      }
    }
  }

  function extractNestedUrls(rawUrl) {
    const found = [];
    try {
      const u = new URL(rawUrl, location.href);
      const keys = ['file', 'src', 'source', 'url', 'video', 'stream', 'hls', 'm3u8', 'mpd', 'playlist', 'manifest'];
      for (const [key, value] of u.searchParams.entries()) {
        if (!value) continue;
        const loweredKey = key.toLowerCase();
        const decoded = safeDecode(value);
        if (keys.some((item) => loweredKey.includes(item)) || /https?:|\.m3u8|\.mpd|\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg)/i.test(decoded)) {
          const nested = cleanExtractedUrl(decoded);
          if (nested) found.push(nested);
        }
      }
    } catch (_) {}
    return found;
  }

  function priorityIndex(kind) {
    const preferM3U8 = state.settings.preferM3U8;
    switch (kind) {
      case 'm3u8': return preferM3U8 ? 0 : 1;
      case 'direct': return preferM3U8 ? 1 : 0;
      case 'mpd': return 2;
      case 'video-probable': return 3;
      case 'manifest': return 4;
      case 'embed': return 5;
      default: return 6;
    }
  }

  function getSortedCandidates() {
    const values = Array.from(state.candidates.values());
    const filtered = values.filter((item) => state.settings.showLowConfidence || item.confidence !== 'low');
    filtered.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (priorityIndex(a.kind) !== priorityIndex(b.kind)) return priorityIndex(a.kind) - priorityIndex(b.kind);
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return b.lastSeen - a.lastSeen;
    });
    return filtered;
  }

  function getBestCandidate() {
    return getSortedCandidates()[0] || null;
  }

  function getBestEmbedCandidate() {
    const embeds = getSortedCandidates().filter((item) => item.kind === 'embed');
    return embeds[0] || null;
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      const base = `${u.origin}${u.pathname}`;
      const query = u.search ? `${u.search.slice(0, 90)}${u.search.length > 90 ? '...' : ''}` : '';
      return `${base}${query}`;
    } catch (_) {
      return url.length > 120 ? `${url.slice(0, 117)}...` : url;
    }
  }

  function kindLabel(kind) {
    switch (kind) {
      case 'direct': return 'VIDEO';
      case 'video-probable': return 'VIDEO?';
      case 'm3u8': return 'M3U8';
      case 'mpd': return 'MPD';
      case 'manifest': return 'Manifest';
      case 'embed': return 'Embed';
      default: return kind.toUpperCase();
    }
  }

  function renderPanel() {
    if (!state.panel || !state.statusWrap || !state.resultsWrap) return;

    const best = getBestCandidate();
    const total = state.candidates.size;
    const bestLabel = best ? `${kindLabel(best.kind)} przez ${best.via.join('+') || 'skan'}` : 'Brak wyniku';

    state.statusWrap.innerHTML = '';

    const topRow = document.createElement('div');
    topRow.className = 'tm-vlf-status-line';

    const statusText = document.createElement('div');
    statusText.className = 'tm-vlf-status-text';
    statusText.textContent = state.statusText;

    const badges = document.createElement('div');
    badges.className = 'tm-vlf-badges';
    badges.innerHTML = [
      `<span class="tm-vlf-badge">Najlepszy: ${escapeHtml(bestLabel)}</span>`,
      `<span class="tm-vlf-badge">Trafienia: ${total}</span>`,
      `<span class="tm-vlf-badge">Tryb: ${state.settings.preferM3U8 ? 'm3u8 > direct > reszta' : 'direct > m3u8 > reszta'}</span>`
    ].join('');

    topRow.appendChild(statusText);
    topRow.appendChild(badges);
    state.statusWrap.appendChild(topRow);

    state.resultsWrap.innerHTML = '';
    const sorted = getSortedCandidates().slice(0, 10);
    if (!sorted.length) {
      const empty = document.createElement('div');
      empty.className = 'tm-vlf-empty';
      empty.textContent = 'Brak wykrytych kandydatow. Kliknij glowny przycisk albo wlacz odtwarzanie.';
      state.resultsWrap.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'tm-vlf-list';
      for (const item of sorted) {
        const row = document.createElement('div');
        row.className = 'tm-vlf-item';

        const kind = document.createElement('div');
        kind.className = 'tm-vlf-kind';
        kind.textContent = kindLabel(item.kind);

        const conf = document.createElement('div');
        conf.className = 'tm-vlf-badge';
        conf.textContent = item.confidence;

        const meta = document.createElement('div');
        meta.className = 'tm-vlf-meta';
        const url = document.createElement('div');
        url.className = 'tm-vlf-url';
        url.textContent = shortUrl(item.url);
        url.title = item.url;
        const via = document.createElement('div');
        via.className = 'tm-vlf-via';
        via.textContent = `przez ${item.via.join(', ')}${item.contentTypes[0] ? ` | ${item.contentTypes[0]}` : ''}`;
        meta.appendChild(url);
        meta.appendChild(via);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'tm-vlf-mini-btn';
        copyBtn.textContent = 'Kopiuj';
        copyBtn.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await copyCandidate(item, `Skopiowano ${kindLabel(item.kind)}`);
        });

        row.appendChild(kind);
        row.appendChild(conf);
        row.appendChild(meta);
        row.appendChild(copyBtn);
        list.appendChild(row);
      }
      state.resultsWrap.appendChild(list);
    }

    if (state.mainBtn) {
      const pill = state.mainBtn.querySelector('.tm-vlf-pill');
      if (pill) {
        if (state.running) pill.textContent = 'Szukam';
        else if (best) pill.textContent = kindLabel(best.kind);
        else pill.textContent = 'Szukaj';
      }
    }
    if (state.menuBtn) state.menuBtn.title = state.menuOpen ? 'Zamknij menu' : 'Otworz menu';
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        return true;
      }
    } catch (_) {}
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function copyCandidate(candidate, successLabel) {
    const ok = await copyText(candidate.url);
    if (ok) {
      state.lastBestKey = candidate.url;
      setButtonState('tm-vlf-ok', successLabel || 'Skopiowano');
      setStatus(`Skopiowano ${candidate.url}`);
    } else {
      setButtonState('tm-vlf-bad', 'Blad schowka');
      setStatus('Nie udalo sie skopiowac do schowka.');
    }
    return ok;
  }

  function setButtonState(kindClass, label) {
    if (!state.mainBtn || !state.menuBtn) return;
    state.mainBtn.classList.remove('tm-vlf-ok', 'tm-vlf-bad', 'tm-vlf-run');
    state.menuBtn.classList.remove('tm-vlf-ok', 'tm-vlf-bad', 'tm-vlf-run');
    if (kindClass) {
      state.mainBtn.classList.add(kindClass);
      state.menuBtn.classList.add(kindClass);
    }
    const pill = state.mainBtn.querySelector('.tm-vlf-pill');
    if (pill && label) pill.textContent = label;
  }

  function fullPerformanceScan() {
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        if (!entry || !entry.name) continue;
        ingestCandidate(entry.name, { via: 'performance', initiatorType: entry.initiatorType || '' });
      }
    } catch (_) {}
  }

  function scanMediaElements() {
    const mediaNodes = document.querySelectorAll('video, audio, source');
    mediaNodes.forEach((node) => {
      const tag = (node.tagName || '').toLowerCase();
      const via = tag === 'source' ? 'source' : 'video';
      const src = node.currentSrc || node.src || node.getAttribute('src') || '';
      if (src) ingestCandidate(src, { via, fromMedia: tag !== 'source', currentSrc: !!node.currentSrc });
      const type = node.getAttribute('type') || '';
      if (src && type) ingestCandidate(src, { via, fromMedia: tag !== 'source', contentType: type, currentSrc: !!node.currentSrc });
    });
  }

  function scanAttributes() {
    const selector = MEDIA_DATA_ATTRS.map((attr) => `[${attr}]`).join(',');
    document.querySelectorAll(selector).forEach((el) => {
      for (const attr of MEDIA_DATA_ATTRS) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        const lowered = attr.toLowerCase();
        if (lowered === 'poster') continue;
        ingestCandidate(value, { via: 'dom', fromMedia: el.tagName === 'VIDEO' || el.tagName === 'SOURCE' });
      }
    });
  }


  function scanAnchorsAndLinks() {
    const selector = [
      'a[href*=".m3u8"]',
      'a[href*=".mpd"]',
      'a[href*=".mp4"]',
      'a[href*=".webm"]',
      'a[href*=".mov"]',
      'a[href*=".m4v"]',
      'a[href*=".mkv"]',
      'a[href*=".avi"]',
      'link[href][type*="mpegurl"]',
      'link[href][type*="dash"]',
      'link[href][as="video"]',
      'link[href][rel*="preload"]',
      'link[href][rel*="prefetch"]'
    ].join(',');
    document.querySelectorAll(selector).forEach((el) => {
      const value = el.getAttribute('href');
      if (!value) return;
      ingestCandidate(value, { via: 'dom' });
    });
  }

  function scanIframes() {
    document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => {
      const value = el.getAttribute('src') || el.getAttribute('data') || '';
      if (!value) return;
      ingestCandidate(value, { via: 'iframe', embedHost: looksLikeEmbedHostUrl(value) });
    });
  }

  function scanInlineScripts() {
    const scripts = Array.from(document.scripts || []).slice(0, 80);
    const pattern = /(?:https?:\/\/|\/|\.\/|\.\.\/)[^\s"'`<>]+?(?:\.m3u8|\.mpd|\.(?:mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg))(?:[^\s"'`<>]*)/gi;
    for (const script of scripts) {
      const text = (script.textContent || '').slice(0, SCRIPT_SCAN_LIMIT);
      if (!text) continue;
      const matches = text.match(pattern);
      if (!matches) continue;
      matches.forEach((match) => ingestCandidate(match, { via: 'script' }));
    }
  }

  function fullDomScan() {
    scanMediaElements();
    scanAttributes();
    scanAnchorsAndLinks();
    scanIframes();
    scanInlineScripts();
  }

  function getPreferredTarget() {
    const videos = Array.from(document.querySelectorAll('video')).filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 180 && rect.height > 100 && rect.bottom > 0 && rect.right > 0;
    });

    const playing = videos.filter((video) => !video.paused && !video.ended && video.readyState >= 2);
    if (playing.length) {
      playing.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      return playing[0];
    }

    if (videos.length) {
      videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      return videos[0];
    }

    const generic = Array.from(document.querySelectorAll(TARGET_SELECTORS)).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 220 && rect.height > 140 && rect.bottom > 0 && rect.right > 0;
    });
    if (!generic.length) return null;
    generic.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    return generic[0];
  }

  function ensureUI() {
    if (state.root) return;

    state.root = document.createElement('div');
    state.root.className = 'tm-vlf-root';

    state.toolbar = document.createElement('div');
    state.toolbar.className = 'tm-vlf-toolbar';

    state.mainBtn = document.createElement('button');
    state.mainBtn.type = 'button';
    state.mainBtn.className = 'tm-vlf-btn';
    state.mainBtn.innerHTML = '<span>\ud83d\udcfc Video</span><span class="tm-vlf-pill">Szukaj</span>';
    state.mainBtn.addEventListener('click', onMainButtonClick, true);

    state.menuBtn = document.createElement('button');
    state.menuBtn.type = 'button';
    state.menuBtn.className = 'tm-vlf-menu-btn';
    state.menuBtn.innerHTML = '<span class="tm-vlf-bars"></span>';
    state.menuBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMenu();
    }, true);

    state.panel = document.createElement('div');
    state.panel.className = 'tm-vlf-panel';
    state.panel.addEventListener('click', (event) => event.stopPropagation(), true);

    state.statusWrap = document.createElement('div');
    state.resultsWrap = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'tm-vlf-section tm-vlf-actions';

    const rescanBtn = document.createElement('button');
    rescanBtn.type = 'button';
    rescanBtn.className = 'tm-vlf-mini-btn';
    rescanBtn.textContent = 'Skanuj ponownie';
    rescanBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await runScan({ copyBest: false, userTriggered: true });
    });

    const copyBestBtn = document.createElement('button');
    copyBestBtn.type = 'button';
    copyBestBtn.className = 'tm-vlf-mini-btn';
    copyBestBtn.textContent = 'Kopiuj najlepszy';
    copyBestBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const best = getBestCandidate() || await runScan({ copyBest: false, userTriggered: true });
      if (best) await copyCandidate(best, `Skopiowano ${kindLabel(best.kind)}`);
    });

    const copyEmbedBtn = document.createElement('button');
    copyEmbedBtn.type = 'button';
    copyEmbedBtn.className = 'tm-vlf-mini-btn';
    copyEmbedBtn.textContent = 'Copy embed host';
    copyEmbedBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      let embed = getBestEmbedCandidate();
      if (!embed) {
        await runScan({ copyBest: false, userTriggered: true });
        embed = getBestEmbedCandidate();
      }
      if (embed) {
        await copyCandidate(embed, 'Skopiowano Embed');
      } else {
        setButtonState('tm-vlf-bad', 'Brak Embed');
        setStatus('Nie znaleziono sensownego URL osadzonego playera.');
      }
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'tm-vlf-mini-btn';
    clearBtn.textContent = 'Wyczysc';
    clearBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.candidates.clear();
      state.seenFingerprints.clear();
      setStatus('Wyczyszczono liste wynikow.');
      renderPanel();
    });

    actions.appendChild(rescanBtn);
    actions.appendChild(copyBestBtn);
    actions.appendChild(copyEmbedBtn);
    actions.appendChild(clearBtn);

    const toggles = document.createElement('div');
    toggles.className = 'tm-vlf-section tm-vlf-toggles';
    toggles.appendChild(makeToggle('Automatyczny skan po PLAY', 'autoScanOnPlay'));
    toggles.appendChild(makeToggle('Pokazuj wyniki o niskiej pewnosci', 'showLowConfidence'));
    toggles.appendChild(makeToggle('Preferuj M3U8 / HLS', 'preferM3U8'));
    toggles.appendChild(makeToggle('Automatyczne kopiowanie po PLAY', 'autoCopyOnPlay'));

    const resultsSection = document.createElement('div');
    resultsSection.className = 'tm-vlf-section';
    resultsSection.appendChild(state.resultsWrap);

    state.panel.appendChild(state.statusWrap);
    state.panel.appendChild(actions);
    state.panel.appendChild(toggles);
    state.panel.appendChild(resultsSection);

    state.toolbar.appendChild(state.mainBtn);
    state.toolbar.appendChild(state.menuBtn);
    state.root.appendChild(state.toolbar);
    state.root.appendChild(state.panel);

    document.documentElement.appendChild(state.root);

    document.addEventListener('click', (event) => {
      if (!state.menuOpen) return;
      if (state.root && !state.root.contains(event.target)) {
        toggleMenu(false);
      }
    }, true);

    renderPanel();
    schedulePosition();
  }

  function makeToggle(label, key) {
    const wrap = document.createElement('label');
    wrap.className = 'tm-vlf-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(state.settings[key]);
    input.addEventListener('change', () => {
      state.settings[key] = input.checked;
      if (key === 'showLowConfidence') renderPanel();
      else setStatus(`Ustawiono ${label}: ${input.checked ? 'ON' : 'OFF'}`);
    });
    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(input);
    wrap.appendChild(span);
    return wrap;
  }

  function toggleMenu(force) {
    ensureUI();
    state.menuOpen = typeof force === 'boolean' ? force : !state.menuOpen;
    state.root.classList.toggle('tm-vlf-menu-open', state.menuOpen);
    schedulePosition();
    renderPanel();
  }

  function schedulePosition() {
    if (state.repaintScheduled) return;
    state.repaintScheduled = true;
    requestAnimationFrame(() => {
      state.repaintScheduled = false;
      positionUI();
    });
  }

  function positionUI() {
    ensureUI();
    state.activeTarget = getPreferredTarget();
    if (!state.activeTarget) {
      const rootWidth = state.root.offsetWidth || 240;
      const x = clamp((window.innerWidth / 2) - (rootWidth / 2), 8, Math.max(8, window.innerWidth - rootWidth - 8));
      state.root.style.left = `${Math.round(x)}px`;
      state.root.style.top = `8px`;
      state.root.classList.add('tm-vlf-visible');
      return;
    }

    const rect = state.activeTarget.getBoundingClientRect();
    const rootWidth = state.root.offsetWidth || 240;
    const x = clamp(rect.left + (rect.width / 2) - (rootWidth / 2), 8, Math.max(8, window.innerWidth - rootWidth - 8));
    const y = clamp(rect.top + 8, 8, Math.max(8, window.innerHeight - 46));
    state.root.style.left = `${Math.round(x)}px`;
    state.root.style.top = `${Math.round(y)}px`;
    state.root.classList.add('tm-vlf-visible');
  }

  async function runScan(options = {}) {
    const copyBest = Boolean(options.copyBest);
    const userTriggered = Boolean(options.userTriggered);
    if (state.running) return getBestCandidate();
    state.running = true;
    setButtonState('tm-vlf-run', 'Szukam');
    setStatus('Skanuje DOM, media, performance, fetch i XHR...');

    try {
      fullDomScan();
      fullPerformanceScan();
      const target = getPreferredTarget();
      if (target && target.tagName === 'VIDEO') {
        const currentSrc = target.currentSrc || target.src || '';
        if (currentSrc) ingestCandidate(currentSrc, { via: 'video', fromMedia: true, currentSrc: true });
        if (isBlobLike(currentSrc)) {
          setStatus('Wykryto blob:. Czekam na rzeczywisty URL z sieci...');
        }
      }

      let best = getBestCandidate();
      const start = Date.now();
      const blobMode = Boolean(target && target.tagName === 'VIDEO' && isBlobLike(target.currentSrc || target.src || ''));
      const deadline = start + (blobMode ? BLOB_WAIT_MS : (userTriggered ? LONG_WAIT_MS : SHORT_WAIT_MS));
      let stableSince = Date.now();
      let bestScore = best ? best.score : -1;

      while (Date.now() < deadline) {
        fullPerformanceScan();
        if ((Date.now() - start) % 1400 < POLL_MS) fullDomScan();
        const current = getBestCandidate();
        if (current && current.score > bestScore) {
          best = current;
          bestScore = current.score;
          stableSince = Date.now();
          if (current.kind === 'm3u8' && Date.now() - stableSince > 2200) break;
          if (!state.settings.preferM3U8 && current.kind === 'direct' && Date.now() - stableSince > 2600) break;
        }
        if (current && current.score === bestScore && current.url === (best && best.url)) {
          if (current.kind === 'm3u8' && Date.now() - stableSince > 2000) break;
          if (current.kind === 'mpd' && Date.now() - stableSince > 2600) break;
          if (current.kind === 'direct' && !state.settings.preferM3U8 && Date.now() - stableSince > 2600) break;
          if (current.kind === 'video-probable' && Date.now() - stableSince > 2200) break;
        }
        await sleep(POLL_MS);
      }

      best = getBestCandidate();
      if (!best) {
        setButtonState('tm-vlf-bad', 'Brak');
        setStatus('Brak kandydatow. Sprobuj wlaczyc PLAY albo otworzyc menu i wybrac Skanuj ponownie.');
        return null;
      }

      if (best.kind === 'embed') {
        setStatus(`Wykryto host osadzonego playera: ${best.url}`);
      } else {
        setStatus(`Najlepszy kandydat: ${best.url}`);
      }
      setButtonState('tm-vlf-ok', kindLabel(best.kind));
      if (copyBest) await copyCandidate(best, `Skopiowano ${kindLabel(best.kind)}`);
      return best;
    } finally {
      state.running = false;
      renderPanel();
    }
  }

  async function onMainButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    await runScan({ copyBest: true, userTriggered: true });
  }

  function installFetchHook() {
    if (typeof window.fetch !== 'function' || window.fetch.__tmVlfPatched) return;
    const originalFetch = window.fetch;
    const patchedFetch = function patchedFetch(...args) {
      try {
        const requestLike = args[0];
        const requestUrl = requestLike instanceof Request ? requestLike.url : String(requestLike || '');
        if (requestUrl) ingestCandidate(requestUrl, { via: 'fetch', embedHost: looksLikeEmbedHostUrl(requestUrl) });
      } catch (_) {}
      return originalFetch.apply(this, args).then((response) => {
        try {
          const contentType = response && response.headers ? (response.headers.get('content-type') || '') : '';
          ingestCandidate(response.url || '', {
            via: 'fetch',
            contentType,
            initiatorType: 'fetch',
            embedHost: looksLikeEmbedHostUrl(response.url || '')
          });
        } catch (_) {}
        return response;
      });
    };
    patchedFetch.__tmVlfPatched = true;
    window.fetch = patchedFetch;
  }

  function installXhrHook() {
    const proto = XMLHttpRequest && XMLHttpRequest.prototype;
    if (!proto || proto.__tmVlfPatched) return;
    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function patchedOpen(method, url, ...rest) {
      try {
        this.__tmVlfUrl = cleanExtractedUrl(String(url || '')) || String(url || '');
      } catch (_) {
        this.__tmVlfUrl = String(url || '');
      }
      return originalOpen.call(this, method, url, ...rest);
    };

    proto.send = function patchedSend(...args) {
      if (!this.__tmVlfListenerAttached) {
        this.__tmVlfListenerAttached = true;
        this.addEventListener('loadend', function onLoadEnd() {
          try {
            const responseUrl = this.responseURL || this.__tmVlfUrl || '';
            const contentType = this.getResponseHeader('Content-Type') || '';
            ingestCandidate(responseUrl, { via: 'xhr', contentType, initiatorType: 'xmlhttprequest', embedHost: looksLikeEmbedHostUrl(responseUrl) });
          } catch (_) {}
        });
      }
      return originalSend.apply(this, args);
    };

    proto.__tmVlfPatched = true;
  }

  function installPerformanceObserver() {
    if (typeof PerformanceObserver !== 'function') return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry || !entry.name) continue;
          ingestCandidate(entry.name, { via: 'performance', initiatorType: entry.initiatorType || '', embedHost: looksLikeEmbedHostUrl(entry.name) });
        }
      });
      try {
        observer.observe({ type: 'resource', buffered: true });
      } catch (_) {
        observer.observe({ entryTypes: ['resource'] });
      }
    } catch (_) {}
  }

  function installMediaListeners() {
    document.addEventListener('loadedmetadata', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLMediaElement)) return;
      const url = target.currentSrc || target.src || '';
      if (url) ingestCandidate(url, { via: 'video', fromMedia: true, currentSrc: true });
      schedulePosition();
    }, true);

    document.addEventListener('play', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLMediaElement)) return;
      const url = target.currentSrc || target.src || '';
      if (url) ingestCandidate(url, { via: 'video', fromMedia: true, currentSrc: true });
      schedulePosition();
      if (!state.settings.autoScanOnPlay || state.running) return;
      setStatus('Automatyczny skan po PLAY...');
      const best = await runScan({ copyBest: false, userTriggered: false });
      if (best && state.settings.autoCopyOnPlay) {
        await copyCandidate(best, `Skopiowano ${kindLabel(best.kind)}`);
      }
    }, true);
  }

  function installMutationWatcher() {
    const observer = new MutationObserver(() => schedulePosition());
    const start = () => {
      try {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src', 'style', 'class']
        });
      } catch (_) {}
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  function bootstrap() {
    ensureUI();
    fullDomScan();
    fullPerformanceScan();
    renderPanel();
    schedulePosition();
    window.addEventListener('resize', schedulePosition, { passive: true });
    window.addEventListener('scroll', schedulePosition, { passive: true });
    document.addEventListener('visibilitychange', schedulePosition, true);
  }

  function installHookWatchdog() {
    const repair = () => {
      try {
        installFetchHook();
        installXhrHook();
      } catch (_) {}
    };
    setInterval(repair, 2500);
    window.addEventListener('focus', repair, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') repair();
    }, true);
  }

  installFetchHook();
  installXhrHook();
  installPerformanceObserver();
  installMediaListeners();
  installMutationWatcher();
  installHookWatchdog();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
