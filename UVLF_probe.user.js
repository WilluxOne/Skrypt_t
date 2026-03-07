// ==UserScript==
// @name         UVLF_probe
// @namespace    https://github.com/WilluxOne/Skrypt_t
// @version      1.4.1
// @description  Bezpieczny skrypt diagnostyczny dla UVLF_beta. Generuje raport tekstowy o jawnie dostępnych źródłach media bez ekstrakcji ukrytych strumieni zewnętrznych.
// @author       WilluxOne
// @match        *://*/*
// @allFrames    true
// @run-at       document-start
// @grant        GM_setClipboard
// @updateURL    https://raw.githubusercontent.com/WilluxOne/Skrypt_t/main/UVLF_probe.user.js
// @downloadURL  https://raw.githubusercontent.com/WilluxOne/Skrypt_t/main/UVLF_probe.user.js
// ==/UserScript==

(function () {
  'use strict';

  const DIRECT_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg)(?:$|[?#])/i;
  const M3U8_RE = /(?:\.m3u8(?:$|[?#]))|(?:[?&](?:hls|m3u8|playlist)=)/i;
  const MPD_RE = /(?:\.mpd(?:$|[?#]))|(?:[?&](?:mpd|dash)=)/i;
  const MANIFEST_RE = /(?:manifest|playlist|master)(?:[/?#&=_-]|$)/i;
  const SEGMENT_RE = /\.(?:m4s|ts|cmfv?|cmfa|aac|vtt|key)(?:$|[?#])/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)(?:$|[?#])/i;
  const STATIC_EXT_RE = /\.(css|js|map|woff2?|ttf|otf|eot)(?:$|[?#])/i;

  const state = {
    host: null,
    shadow: null,
    refs: {},
    objectUrls: [],
    mounted: false,
  };

  patchCreateObjectURL();
  boot();

  function patchCreateObjectURL() {
    try {
      const original = URL.createObjectURL;
      if (typeof original !== 'function' || original.__uvlfProbeWrapped) return;
      const wrapped = function () {
        const value = original.apply(this, arguments);
        const obj = arguments[0];
        state.objectUrls.push({
          at: new Date().toISOString(),
          url: value,
          kind: obj && obj.constructor ? obj.constructor.name : typeof obj,
          type: obj && typeof obj.type === 'string' ? obj.type : '',
          size: obj && typeof obj.size === 'number' ? obj.size : null,
        });
        return value;
      };
      wrapped.__uvlfProbeWrapped = true;
      URL.createObjectURL = wrapped;
    } catch (_) {}
  }

  function boot() {
    buildUi();
    window.addEventListener('load', updateReport, { once: true });
    window.addEventListener('resize', positionUi, { passive: true });
    window.addEventListener('scroll', positionUi, { passive: true, capture: true });
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive' || document.readyState === 'complete') {
        buildUi();
        updateReport();
      }
    });
    window.setTimeout(updateReport, 1000);
  }

  function buildUi() {
    if (state.mounted) return;
    const mount = document.documentElement || document.body;
    if (!mount) {
      window.setTimeout(buildUi, 50);
      return;
    }

    const host = document.createElement('div');
    host.setAttribute('data-uvlf-probe-root', '1');
    host.style.position = 'fixed';
    host.style.top = '12px';
    host.style.right = '12px';
    host.style.zIndex = '2147483645';
    host.style.font = 'normal 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .probe {
          width: min(88vw, 420px);
          display: grid;
          gap: 8px;
          padding: 10px;
          border-radius: 16px;
          background: rgba(0, 0, 0, 0.84);
          color: #eef7f4;
          border: 1px solid rgba(88, 192, 168, 0.55);
          box-shadow: 0 12px 24px rgba(0, 0, 0, 0.35);
        }
        .row { display: flex; align-items: center; gap: 8px; }
        .title { font-size: 13px; font-weight: 700; flex: 1 1 auto; }
        button {
          appearance: none;
          border: 1px solid rgba(88, 192, 168, 0.65);
          background: rgba(17, 24, 26, 0.96);
          color: #eef7f4;
          border-radius: 12px;
          padding: 7px 10px;
          cursor: pointer;
          font: inherit;
        }
        .note { font-size: 11px; color: #d1e7df; opacity: 0.9; }
        textarea {
          width: 100%;
          min-height: 220px;
          resize: vertical;
          border-radius: 12px;
          border: 1px solid rgba(88, 192, 168, 0.28);
          background: rgba(8, 12, 14, 0.95);
          color: #eef7f4;
          padding: 10px;
          box-sizing: border-box;
          font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px;
          border-radius: 999px;
          background: rgba(16, 22, 24, 0.96);
          border: 1px solid rgba(88, 192, 168, 0.35);
          font-size: 11px;
          font-weight: 700;
        }
      </style>
      <div class="probe">
        <div class="row">
          <span class="title">UVLF Probe (diagnostyka)</span>
          <span class="pill" id="summary">start</span>
        </div>
        <div class="row">
          <button id="refreshBtn">Odśwież</button>
          <button id="copyBtn">Kopiuj raport</button>
          <button id="toggleBtn">Zwiń</button>
        </div>
        <div class="note">Bezpieczny raport diagnostyczny: tylko źródła jawne i same-origin performance. Brak ekstrakcji ukrytych URL-i.</div>
        <textarea id="report" spellcheck="false"></textarea>
      </div>
    `;

    mount.appendChild(host);
    state.host = host;
    state.shadow = shadow;
    state.refs = {
      report: shadow.getElementById('report'),
      summary: shadow.getElementById('summary'),
    };
    shadow.getElementById('refreshBtn').addEventListener('click', updateReport);
    shadow.getElementById('copyBtn').addEventListener('click', copyReport);
    shadow.getElementById('toggleBtn').addEventListener('click', () => {
      const hidden = state.refs.report.style.display === 'none';
      state.refs.report.style.display = hidden ? 'block' : 'none';
    });

    state.mounted = true;
    positionUi();
  }

  function positionUi() {
    if (!state.host) return;
    state.host.style.top = '12px';
    state.host.style.right = '12px';
  }

  function normalizeUrl(value, baseHref) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    if (/^(?:javascript:|data:|mailto:|tel:)/i.test(raw)) return null;
    if (/^blob:/i.test(raw)) return raw;
    try {
      return new URL(raw, baseHref || location.href).href;
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

  function classify(url, sourceKind) {
    if (!url) return 'none';
    if (/^blob:/i.test(url)) return 'blob';
    if (SEGMENT_RE.test(url)) return 'segment';
    if (DIRECT_EXT_RE.test(url)) return 'direct';
    if (M3U8_RE.test(url)) return 'hls';
    if (MPD_RE.test(url)) return 'dash';
    if (MANIFEST_RE.test(url)) return 'manifest';
    if (sourceKind === 'iframe' || sourceKind === 'embed' || sourceKind === 'object') return 'container';
    if (IMAGE_EXT_RE.test(url) || STATIC_EXT_RE.test(url)) return 'static';
    return 'other';
  }

  function collectVisibleSources() {
    const items = [];
    const videos = Array.from(document.querySelectorAll('video'));
    videos.forEach((video, index) => {
      const currentSrc = normalizeUrl(video.currentSrc, location.href);
      const src = normalizeUrl(video.getAttribute('src') || video.src, location.href);
      if (currentSrc) items.push({ where: `video#${index + 1}.currentSrc`, url: currentSrc, kind: classify(currentSrc, 'video') });
      if (src) items.push({ where: `video#${index + 1}.src`, url: src, kind: classify(src, 'video') });
      Array.from(video.querySelectorAll('source[src]')).forEach((source, sourceIndex) => {
        const value = normalizeUrl(source.getAttribute('src'), location.href);
        if (value) items.push({ where: `video#${index + 1} source#${sourceIndex + 1}`, url: value, kind: classify(value, 'source') });
      });
    });

    Array.from(document.querySelectorAll('iframe[src], embed[src], object[data]')).forEach((node, index) => {
      const tag = node.tagName.toLowerCase();
      const attr = tag === 'object' ? 'data' : 'src';
      const value = normalizeUrl(node.getAttribute(attr), location.href);
      if (value) items.push({ where: `${tag}#${index + 1}`, url: value, kind: classify(value, tag) });
    });

    const dataAttrs = ['data-src', 'data-url', 'data-file', 'data-video', 'data-stream', 'data-hls', 'data-m3u8', 'data-manifest', 'data-media'];
    const selector = dataAttrs.map((attr) => `[${attr}]`).join(',');
    Array.from(document.querySelectorAll(selector)).slice(0, 200).forEach((node, index) => {
      dataAttrs.forEach((attr) => {
        const value = normalizeUrl(node.getAttribute(attr), location.href);
        if (value) items.push({ where: `data#${index + 1}:${attr}`, url: value, kind: classify(value, 'data') });
      });
    });

    return dedupeItems(items);
  }

  function collectSameOriginPerformance() {
    try {
      return dedupeItems(performance.getEntriesByType('resource')
        .map((entry) => normalizeUrl(entry.name, location.href))
        .filter(Boolean)
        .filter(sameOrigin)
        .filter((url) => !STATIC_EXT_RE.test(url) && !IMAGE_EXT_RE.test(url))
        .map((url) => ({ where: 'performance', url, kind: classify(url, 'performance') }))
        .filter((item) => ['direct', 'hls', 'dash', 'manifest', 'other'].includes(item.kind))
      );
    } catch (_) {
      return [];
    }
  }

  function dedupeItems(items) {
    const map = new Map();
    items.forEach((item) => {
      if (!item || !item.url) return;
      if (map.has(item.url)) {
        const existing = map.get(item.url);
        if (!existing.where.includes(item.where)) existing.where += `, ${item.where}`;
        return;
      }
      map.set(item.url, { ...item });
    });
    return Array.from(map.values());
  }

  function classifyTransport(visible, perf) {
    const kinds = [...visible, ...perf].map((item) => item.kind);
    if (kinds.includes('direct')) return 'direct';
    if (kinds.includes('hls')) return 'hls';
    if (kinds.includes('dash')) return 'dash';
    if (kinds.includes('manifest')) return 'manifest-like';
    if (kinds.includes('blob')) return 'blob-or-mse';
    if (kinds.includes('container')) return 'container-only';
    return 'unknown';
  }

  function usefulness(visible, perf) {
    const all = [...visible, ...perf];
    const hasPlayable = all.some((item) => ['direct', 'hls', 'dash', 'manifest'].includes(item.kind));
    const hasBlob = all.some((item) => item.kind === 'blob');
    const hasContainer = all.some((item) => item.kind === 'container');
    if (hasPlayable) return 'wysoka';
    if (hasBlob && perf.length) return 'średnia';
    if (hasContainer) return 'niska';
    return 'nieznana';
  }

  function buildReport() {
    const visible = collectVisibleSources();
    const perf = collectSameOriginPerformance();
    const videos = Array.from(document.querySelectorAll('video'));
    const containers = Array.from(document.querySelectorAll('iframe[src], embed[src], object[data]'));
    const transport = classifyTransport(visible, perf);
    const utility = usefulness(visible, perf);
    const uiFound = document.querySelector('[data-uvlf-root]');

    const lines = [];
    lines.push('UVLF_beta RAPORT PROBE (BEZPIECZNY)');
    lines.push(`czas: ${new Date().toISOString()}`);
    lines.push(`adres: ${location.href}`);
    lines.push(`tytuł: ${document.title || '(brak tytułu)'}`);
    lines.push(`ramka: ${window.top === window.self ? 'główna' : 'podramka'}`);
    lines.push(`wykrytoUIuvlf: ${uiFound ? 'tak' : 'nie'}`);
    lines.push(`stanDokumentu: ${document.readyState}`);
    lines.push(`klasyfikacjaTransportu: ${transport}`);
    lines.push(`przydatnośćDlaZewnętrznegoOdtwarzacza: ${utility}`);
    lines.push('');

    lines.push('cele:');
    lines.push(`- videos=${videos.length}`);
    lines.push(`- containers=${containers.length}`);
    lines.push('');

    lines.push('wideo:');
    if (!videos.length) {
      lines.push('- brak');
    } else {
      videos.forEach((video, index) => {
        const rect = video.getBoundingClientRect();
        lines.push(`- #${index + 1} rozmiar=${Math.round(rect.width)}x${Math.round(rect.height)} currentSrc=${video.currentSrc || '(pusty)'}`);
        lines.push(`  src=${video.getAttribute('src') || video.src || '(pusty)'}`);
        const sources = Array.from(video.querySelectorAll('source[src]')).map((n) => n.getAttribute('src'));
        lines.push(`  źródła=${sources.length ? sources.join(' | ') : '(brak)'}`);
      });
    }
    lines.push('');

    lines.push('iframe/embed/object:');
    if (!containers.length) {
      lines.push('- brak');
    } else {
      containers.forEach((node, index) => {
        const tag = node.tagName.toLowerCase();
        const attr = tag === 'object' ? 'data' : 'src';
        lines.push(`- #${index + 1} <${tag}> ${node.getAttribute(attr) || '(pusty)'}`);
      });
    }
    lines.push('');

    lines.push('widoczneŹródła:');
    if (!visible.length) {
      lines.push('- brak');
    } else {
      visible.forEach((item, index) => {
        lines.push(`- #${index + 1} ${item.kind} | ${item.where}`);
        lines.push(`  ${item.url}`);
      });
    }
    lines.push('');

    lines.push('performanceSameOrigin:');
    if (!perf.length) {
      lines.push('- brak');
    } else {
      perf.forEach((item, index) => {
        lines.push(`- #${index + 1} ${item.kind}`);
        lines.push(`  ${item.url}`);
      });
    }
    lines.push('');

    const blobVideos = videos.filter((video) => /^blob:/i.test(video.currentSrc || '') || /^blob:/i.test(video.getAttribute('src') || video.src || ''));
    lines.push('blobMSE:');
    lines.push(`- mediaSourceDostępne=${typeof MediaSource !== 'undefined' ? 'tak' : 'nie'}`);
    lines.push(`- wideoUżywająceBlob=${blobVideos.length}`);
    lines.push(`- wywołaniaCreateObjectURL=${state.objectUrls.length}`);
    if (state.objectUrls.length) {
      state.objectUrls.slice(-10).forEach((entry, index) => {
        lines.push(`  - #${index + 1} ${entry.at} ${entry.kind} typ=${entry.type || '(brak)'} rozmiar=${entry.size == null ? '(n/d)' : entry.size} url=${entry.url}`);
      });
    }
    lines.push('');

    lines.push('wyłączoneWBezpiecznejWersji:');
    lines.push('- przechwytywanie fetch');
    lines.push('- przechwytywanie XMLHttpRequest');
    lines.push('- skanowanie skryptów inline pod ukryte URL-e');
    lines.push('- heurystyki ekstrakcji specyficzne dla hosterów');
    return lines.join('\n');
  }

  function updateReport() {
    if (!state.mounted) return;
    const report = buildReport();
    state.refs.report.value = report;
    const visible = collectVisibleSources();
    const perf = collectSameOriginPerformance();
    state.refs.summary.textContent = `${classifyTransport(visible, perf)} • ${usefulness(visible, perf)}`;
  }

  async function copyReport() {
    const report = state.refs.report.value || buildReport();
    const ok = await copyText(report);
    state.refs.summary.textContent = ok ? 'skopiowano' : 'błąd kopiowania';
  }

  async function copyText(value) {
    const textValue = String(value == null ? '' : value);
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
})();
