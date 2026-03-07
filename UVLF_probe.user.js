// ==UserScript==
// @name         UVLF Universal Probe
// @namespace    https://github.com/WilluxOne/Skrypt_t
// @version      1.2.0
// @description  Uniwersalny probe diagnostyczny dla UVLF_beta. Zbiera UI, targety, video, źródła URL i klasyfikację transportu bez sprzężenia z konkretną wersją.
// @author       OpenAI
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-start
// @allFrames    true
// ==/UserScript==

(() => {
  'use strict';

  const MAX_ITEMS = 300;
  const WATCH_MS = 18000;
  const POLL_MS = 500;
  const DIRECT_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv', 'mpg', 'mpeg']);
  const MANIFEST_EXTS = new Set(['m3u8', 'mpd']);
  const SEGMENT_EXTS = new Set(['m4s', 'ts', 'cmf', 'cmfv', 'cmfa']);
  const IGNORE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'css', 'js', 'map', 'json', 'xml', 'txt', 'ico', 'woff', 'woff2', 'ttf', 'eot']);
  const EMBED_HOST_PATTERNS = [
    /(^|\.)voe\.(sx|com|network)$/i, /(^|\.)vidmoly\./i, /(^|\.)streamtape\./i, /(^|\.)dood\./i,
    /(^|\.)filemoon\./i, /(^|\.)uqload\./i, /(^|\.)mixdrop\./i, /(^|\.)ok\.ru$/i, /(^|\.)vtube\./i,
    /(^|\.)luluvdo\./i, /(^|\.)streamwish\./i
  ];

  const state = {
    startedAt: Date.now(),
    runCount: 0,
    watchersInstalled: false,
    watchActive: false,
    candidates: new Map(),
    performanceSeen: new Set(),
    iframeHosts: new Map(),
    videos: [],
    targets: [],
    ui: { visible: false, nodes: [] },
    events: [],
    reqs: [],
    errors: [],
    lastReport: ''
  };

  const pushCap = (arr, item, max = MAX_ITEMS) => {
    arr.push(item);
    if (arr.length > max) arr.splice(0, arr.length - max);
  };
  const trunc = (v, n = 240) => {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  };

  function cleanUrl(raw) {
    if (!raw) return '';
    const v = String(raw).trim().replace(/^['"`]+|['"`]+$/g, '');
    if (!v || /^(javascript:|data:|mailto:)/i.test(v)) return '';
    if (/^blob:/i.test(v)) return v;
    try { return new URL(v, location.href).href; } catch (_) { return ''; }
  }

  function urlExt(url) {
    try {
      const u = new URL(url, location.href);
      const file = (u.pathname.split('/').pop() || '').toLowerCase();
      const m = file.match(/\.([a-z0-9]{1,6})$/i);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function looksLikeEmbed(url) {
    try {
      const u = new URL(url, location.href);
      if (EMBED_HOST_PATTERNS.some((re) => re.test(u.hostname || ''))) return true;
      return /\/(?:e|embed|v|d)\//i.test(u.pathname || '');
    } catch (_) { return false; }
  }

  function classifyUrl(url) {
    const raw = cleanUrl(url);
    if (!raw) return { kind: 'invalid', usable: false, score: 0, externalPlayer: 'NO', url: '' };
    if (/^blob:/i.test(raw)) return { kind: 'blob', usable: false, score: 8, externalPlayer: 'NO', url: raw };

    const ext = urlExt(raw);
    const lower = raw.toLowerCase();
    let kind = 'unknown';
    let score = 20;
    let usable = /^https?:/i.test(raw);

    if (DIRECT_EXTS.has(ext)) { kind = 'direct'; score = 100; }
    else if (ext === 'm3u8') { kind = 'm3u8'; score = 90; }
    else if (ext === 'mpd') { kind = 'mpd'; score = 80; }
    else if (SEGMENT_EXTS.has(ext)) { kind = 'segment'; score = 20; usable = false; }
    else if (IGNORE_EXTS.has(ext)) { kind = 'ignore'; score = 0; usable = false; }
    else if (looksLikeEmbed(raw)) { kind = 'embed'; score = 58; }
    else if (/(manifest|playlist|master|stream|hls|dash)/i.test(lower)) { kind = 'manifest-like'; score = 65; }
    else if (/license|widevine|fairplay|playready/i.test(lower)) { kind = 'license'; score = 5; usable = false; }

    const externalPlayer = (kind === 'direct' || kind === 'm3u8') ? 'YES'
      : (kind === 'mpd' || kind === 'manifest-like' || kind === 'embed' ? 'MAYBE' : 'NO');

    return { kind, usable, score, ext, externalPlayer, url: raw };
  }

  function addCandidate(url, via, note) {
    const meta = classifyUrl(url);
    if (!meta.url || meta.kind === 'invalid') return;
    const prev = state.candidates.get(meta.url) || {
      url: meta.url, meta, via: new Set(), notes: new Set(), count: 0, firstSeen: Date.now()
    };
    if (meta.score > prev.meta.score) prev.meta = meta;
    prev.count += 1;
    prev.lastSeen = Date.now();
    if (via) prev.via.add(via);
    if (note) prev.notes.add(trunc(note, 140));
    state.candidates.set(meta.url, prev);

    if (meta.kind === 'embed') {
      try {
        const u = new URL(meta.url, location.href);
        const host = u.hostname || '(none)';
        state.iframeHosts.set(host, { host, url: meta.url, seen: (state.iframeHosts.get(host)?.seen || 0) + 1 });
      } catch (_) {}
    }
  }

  function sortedCandidates() {
    return [...state.candidates.values()]
      .filter((x) => !['ignore'].includes(x.meta.kind))
      .sort((a, b) => (b.meta.score - a.meta.score) || (b.count - a.count) || (b.lastSeen - a.lastSeen));
  }

  function bestCandidate() {
    return sortedCandidates()[0] || null;
  }

  function collectTargets() {
    const nodes = [...document.querySelectorAll('video,iframe,embed,object,[class*="player"],[id*="player"],[class*="video"],[id*="video"]')];
    state.targets = nodes.slice(0, 12).map((el) => `${el.tagName}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0,2).join('.')}` : ''}`);
  }

  function collectVideos() {
    state.videos = [...document.querySelectorAll('video')].slice(0, 10).map((v) => {
      const r = v.getBoundingClientRect();
      const currentSrc = v.currentSrc || '';
      if (currentSrc) addCandidate(currentSrc, 'video.currentSrc', 'video');
      if (v.src) addCandidate(v.src, 'video.src', 'video');
      [...v.querySelectorAll('source[src]')].slice(0, 8).forEach((s) => addCandidate(s.src || s.getAttribute('src'), 'source[src]', 'video source'));
      return {
        visible: r.width > 1 && r.height > 1,
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        paused: !!v.paused,
        readyState: v.readyState,
        currentSrc: trunc(currentSrc),
        src: trunc(v.src || '')
      };
    });
  }

  function scanDom() {
    const selectors = ['video[src]', 'source[src]', 'iframe[src]', 'embed[src]', 'object[data]', 'a[href]', 'link[href]', '[data-src]', '[data-url]', '[data-file]', '[data-video]', '[data-stream]', '[data-hls]', '[data-m3u8]', '[data-mpd]'];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        ['src', 'href', 'data', 'data-src', 'data-url', 'data-file', 'data-video', 'data-stream', 'data-hls', 'data-m3u8', 'data-mpd'].forEach((attr) => {
          const val = el.getAttribute && el.getAttribute(attr);
          if (!val) return;
          addCandidate(val, `dom:${attr}`, el.tagName);
        });
      }
    }
  }

  function scanScripts() {
    const re = /(?:https?:\/\/|\/|\.\/|\.\.\/)[^\s"'`<>]+/g;
    for (const s of Array.from(document.scripts || []).slice(0, 80)) {
      const t = (s.textContent || '').slice(0, 160000);
      if (!t || !/(m3u8|mpd|manifest|playlist|videoplayback|mp4|webm|source|stream)/i.test(t)) continue;
      const found = t.match(re) || [];
      found.slice(0, 120).forEach((u) => addCandidate(u, 'script-text', 'inline script'));
    }
  }

  function scanPerformance() {
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (!e || !e.name || state.performanceSeen.has(e.name)) continue;
        state.performanceSeen.add(e.name);
        addCandidate(e.name, `perf:${e.initiatorType || 'resource'}`, e.initiatorType || 'resource');
      }
    } catch (e) { pushCap(state.errors, `perf: ${e && e.message ? e.message : e}`); }
  }

  function detectUi() {
    const hits = [];
    const uiNodes = [...document.querySelectorAll('[class],[id],button,div,section,aside')];
    for (const el of uiNodes) {
      const sig = `${el.tagName}${el.id ? `#${el.id}` : ''}.${typeof el.className === 'string' ? el.className : ''}`;
      const text = trunc(el.textContent || '', 100);
      if (!/(tm-vlf|uvlf|vlf)/i.test(sig + ' ' + text)) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      hits.push(`${sig} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}] d=${cs.display} v=${cs.visibility} o=${cs.opacity}`);
    }
    state.ui.nodes = hits.slice(0, 20);
    state.ui.visible = hits.some((h) => !/ d=none\b/.test(h) && !/ v=hidden\b/.test(h) && !/ o=0\b/.test(h));
  }

  function transportGuess() {
    const vals = sortedCandidates();
    const has = (k) => vals.some((v) => v.meta.kind === k);
    const hasBlob = vals.some((v) => v.meta.kind === 'blob');
    if (has('direct')) return 'direct-file';
    if (has('m3u8') && hasBlob) return 'hls-via-blob';
    if (has('m3u8')) return 'hls';
    if (has('mpd') && hasBlob) return 'dash-via-blob';
    if (has('mpd')) return 'dash';
    if (has('embed')) return 'embed-fallback';
    if (hasBlob) return 'blob-mse';
    return 'unknown';
  }

  function externalPlayerGuess() {
    const best = bestCandidate();
    return best ? best.meta.externalPlayer : 'NO_URL_SEEN';
  }

  function collectSnapshot(reason) {
    state.runCount += 1;
    collectTargets();
    collectVideos();
    scanDom();
    scanScripts();
    scanPerformance();
    detectUi();
    pushCap(state.events, `${Date.now() - state.startedAt}ms snapshot:${reason}`);
  }

  function report() {
    const best = bestCandidate();
    const vals = sortedCandidates();
    const lines = [];
    lines.push('UVLF Universal Probe report');
    lines.push(`time=${new Date().toISOString()} frame=${window.top === window ? 'top' : 'child'} href=${location.href}`);
    lines.push(`ui.visible=${Number(state.ui.visible)} ui.nodes=${state.ui.nodes.length}`);
    state.ui.nodes.slice(0, 6).forEach((x) => lines.push(`ui.node=${x}`));
    lines.push(`targets=${state.targets.join(' | ') || 'none'}`);
    lines.push(`videos=${state.videos.length}`);
    state.videos.slice(0, 8).forEach((v, i) => lines.push(`video${i + 1}=visible:${Number(v.visible)} size:${v.size} paused:${Number(v.paused)} ready:${v.readyState} currentSrc:${v.currentSrc || '-'} src:${v.src || '-'}`));
    lines.push(`iframeHosts=${[...state.iframeHosts.values()].map((x) => `${x.host}(${x.seen})`).join(', ') || 'none'}`);
    lines.push(`transport=${transportGuess()} externalPlayer=${externalPlayerGuess()}`);
    lines.push(`best=${best ? `${best.meta.kind} score=${best.meta.score} via=${[...best.via].join(',')} url=${best.url}` : 'none'}`);
    vals.slice(0, 30).forEach((c, i) => lines.push(`cand${i + 1}=${c.meta.kind} score=${c.meta.score} ext=${c.meta.ext || '-'} usable=${Number(c.meta.usable)} mpc=${c.meta.externalPlayer} via=${[...c.via].join(',')} count=${c.count} url=${c.url}`));
    state.reqs.slice(-30).forEach((r, i) => lines.push(`req${i + 1}=${r}`));
    state.errors.slice(-20).forEach((e, i) => lines.push(`err${i + 1}=${e}`));
    state.events.slice(-20).forEach((e, i) => lines.push(`evt${i + 1}=${e}`));
    state.lastReport = lines.join('\n');
    return state.lastReport;
  }

  function copyText(text) {
    try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; } } catch (_) {}
    try { navigator.clipboard.writeText(text); return true; } catch (_) {}
    return false;
  }

  function installHooks() {
    if (state.watchersInstalled) return;
    state.watchersInstalled = true;

    try {
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function patchedFetch(...args) {
          try {
            const req = args[0] instanceof Request ? args[0].url : String(args[0] || '');
            addCandidate(req, 'fetch:req', 'fetch');
            pushCap(state.reqs, `fetch:req ${trunc(req, 300)}`);
          } catch (_) {}
          return origFetch.apply(this, args).then((res) => {
            try {
              addCandidate(res.url || '', 'fetch:res', String(res.status || ''));
              pushCap(state.reqs, `fetch:res ${res.status} ${trunc(res.url || '', 300)}`);
            } catch (_) {}
            return res;
          });
        };
      }
    } catch (e) { pushCap(state.errors, `hook fetch: ${e && e.message ? e.message : e}`); }

    try {
      const proto = XMLHttpRequest && XMLHttpRequest.prototype;
      if (proto) {
        const oOpen = proto.open;
        const oSend = proto.send;
        proto.open = function patchedOpen(method, url, ...rest) {
          this.__uvlfProbeUrl = cleanUrl(url) || String(url || '');
          addCandidate(this.__uvlfProbeUrl, 'xhr:open', method || 'GET');
          pushCap(state.reqs, `xhr:open ${method || 'GET'} ${trunc(this.__uvlfProbeUrl, 300)}`);
          return oOpen.call(this, method, url, ...rest);
        };
        proto.send = function patchedSend(...args) {
          this.addEventListener('loadend', () => {
            try {
              const ru = this.responseURL || this.__uvlfProbeUrl || '';
              addCandidate(ru, 'xhr:res', String(this.status || ''));
              pushCap(state.reqs, `xhr:res ${this.status} ${trunc(ru, 300)}`);
            } catch (_) {}
          }, { once: true });
          return oSend.apply(this, args);
        };
      }
    } catch (e) { pushCap(state.errors, `hook xhr: ${e && e.message ? e.message : e}`); }

    window.addEventListener('error', (ev) => pushCap(state.errors, `window.error: ${trunc(ev && ev.message ? ev.message : 'error')}`), true);
    window.addEventListener('unhandledrejection', (ev) => pushCap(state.errors, `unhandledrejection: ${trunc(ev && ev.reason ? String(ev.reason) : 'rejection')}`), true);
  }

  let root; let out;
  function ensureUi() {
    if (root) return;
    const css = `
      .uvlf-probe-root{position:fixed;right:14px;bottom:14px;z-index:2147483647;color:#fff;font:12px/1.35 system-ui,sans-serif}
      .uvlf-probe-bar{display:flex;gap:8px;align-items:center}
      .uvlf-probe-btn{height:34px;padding:0 12px;border-radius:11px;border:1px solid rgba(255,255,255,.22);background:rgba(20,20,20,.82);color:#fff;cursor:pointer}
      .uvlf-probe-panel{display:none;margin-top:8px;max-width:min(92vw,980px);max-height:min(74vh,680px);overflow:auto;padding:10px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.82);white-space:pre-wrap;word-break:break-word}
      .uvlf-probe-root.open .uvlf-probe-panel{display:block}
    `;
    try { if (typeof GM_addStyle === 'function') GM_addStyle(css); else { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); } } catch (_) {}

    root = document.createElement('div');
    root.className = 'uvlf-probe-root';
    root.innerHTML = '<div class="uvlf-probe-bar">'
      + '<button class="uvlf-probe-btn" data-act="toggle">Probe</button>'
      + '<button class="uvlf-probe-btn" data-act="scan">Scan</button>'
      + '<button class="uvlf-probe-btn" data-act="watch">Watch 18s</button>'
      + '<button class="uvlf-probe-btn" data-act="copy">Copy report</button>'
      + '<button class="uvlf-probe-btn" data-act="best">Copy best</button>'
      + '</div><div class="uvlf-probe-panel"><div class="uvlf-probe-out">UVLF Probe ready.</div></div>';
    out = root.querySelector('.uvlf-probe-out');
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.getAttribute('data-act');
      if (act === 'toggle') {
        root.classList.toggle('open');
        if (root.classList.contains('open')) { collectSnapshot('toggle'); out.textContent = report(); }
      } else if (act === 'scan') {
        collectSnapshot('scan');
        out.textContent = report();
      } else if (act === 'copy') {
        collectSnapshot('copy');
        const rep = report();
        copyText(rep);
        out.textContent = `${rep}\n\n[report copied]`;
      } else if (act === 'best') {
        collectSnapshot('copy-best');
        const best = bestCandidate();
        if (best) copyText(best.url);
        out.textContent = `${report()}\n\n[best ${best ? 'copied' : 'missing'}]${best ? `\n${best.url}` : ''}`;
      } else if (act === 'watch') {
        if (state.watchActive) return;
        state.watchActive = true;
        collectSnapshot('watch-start');
        out.textContent = `${report()}\n\n[watching 18s...]`;
        const end = Date.now() + WATCH_MS;
        while (Date.now() < end) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          scanPerformance();
          collectVideos();
          detectUi();
        }
        state.watchActive = false;
        collectSnapshot('watch-end');
        out.textContent = report();
      }
    }, true);

    (document.documentElement || document.body).appendChild(root);
  }

  installHooks();
  ensureUi();

  document.addEventListener('DOMContentLoaded', () => collectSnapshot('domcontentloaded'), { once: true });
  window.addEventListener('load', () => collectSnapshot('load'), { once: true });
  setTimeout(() => collectSnapshot('t+2s'), 2000);
  setTimeout(() => collectSnapshot('t+6s'), 6000);
})();
