// ==UserScript==
// @name         UVLF_probe
// @namespace    https://github.com/WilluxOne/Skrypt_t
// @version      1.4.2
// @description  Independent diagnostic probe for UVLF_beta. Exposed DOM/performance only. No fetch/XHR hooks, no inline-script scraping.
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

    const SCRIPT_ID = 'uvlf-beta-probe';
    const REPORT_CHANNEL = '__UVLF_BETA_PROBE_CHANNEL__';
    const MAX_DATA_ATTR_ELEMENTS = 250;
    const MAX_HREF_ELEMENTS = 120;
    const MAX_PERF_ENTRIES = 250;

    const SELECTORS = {
        targets: 'video, iframe[src], embed[src], object[data]',
        videos: 'video',
        containers: 'iframe[src], embed[src], object[data]',
        sources: 'video source[src], source[src]',
        hrefs: 'a[href], link[href]',
        dataAttrs: [
            'data-src',
            'data-url',
            'data-file',
            'data-video',
            'data-stream',
            'data-hls',
            'data-m3u8',
            'data-mpd',
            'data-dash',
            'data-manifest',
            'data-media',
            'data-play',
            'data-source',
            'data-embed'
        ],
    };

    const QUERY_PARAM_KEYS = [
        'file', 'src', 'source', 'url', 'play', 'stream', 'hls', 'm3u8', 'mpd',
        'dash', 'manifest', 'playlist', 'video', 'media', 'embed'
    ];

    const DIRECT_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg)(?:$|[?#])/i;
    const M3U8_RE = /(?:\.m3u8(?:$|[?#]))|(?:[?&](?:hls|m3u8|playlist)=)/i;
    const MPD_RE = /(?:\.mpd(?:$|[?#]))|(?:[?&](?:mpd|dash)=)/i;
    const MANIFEST_RE = /(?:manifest|playlist|master)(?:[/?#&=_-]|$)/i;
    const SEGMENT_RE = /\.(?:m4s|ts|cmfv?|cmfa|aac|vtt|key)(?:$|[?#])/i;
    const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)(?:$|[?#])/i;
    const STATIC_EXT_RE = /\.(css|js|map|woff2?|woff|ttf|otf|eot|xml)(?:$|[?#])/i;
    const GARBAGE_HOST_RE = /(doubleclick|googletagmanager|google-analytics|recaptcha|facebook\.com\/plugins|fonts\.(?:googleapis|gstatic)|fontawesome|gravatar|hotjar|sentry|analytics)/i;

    const state = {
        frameId: `probe_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
        createObjectUrlHits: [],
        uiReady: false,
        shadow: null,
        host: null,
        refs: {},
        lastReport: '',
        scanTimer: null,
        frameReports: new Map(),
    };

    function text(value) {
        return String(value == null ? '' : value);
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

    function tryGetTopWindow() {
        try {
            return window.top;
        } catch (_) {
            return null;
        }
    }

    function normalizeUrl(value, baseHref) {
        const raw = text(value).trim();
        if (!raw) return null;
        if (/^(?:javascript:|data:|mailto:|tel:|about:blank)/i.test(raw)) return null;
        if (/^blob:/i.test(raw)) return { raw, normalizedUrl: raw, isBlob: true };
        try {
            return {
                raw,
                normalizedUrl: new URL(raw, baseHref || location.href).href,
                isBlob: false
            };
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

    function isElementVisible(element) {
        if (!element || typeof element.getBoundingClientRect !== 'function') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 24 &&
            rect.height > 24 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;
    }

    function classifyTransport(url) {
        if (!url) return 'unknown';
        if (/^blob:/i.test(url)) return 'blob';
        if (DIRECT_EXT_RE.test(url)) return 'direct-file';
        if (M3U8_RE.test(url)) return 'm3u8-hls';
        if (MPD_RE.test(url)) return 'mpd-dash';
        if (MANIFEST_RE.test(url)) return 'manifest-like';
        if (SEGMENT_RE.test(url)) return 'segment';
        if (IMAGE_EXT_RE.test(url)) return 'image';
        if (STATIC_EXT_RE.test(url)) return 'static-asset';
        return 'page-or-other';
    }

    function looksUsableForExternalPlayer(url) {
        const transport = classifyTransport(url);
        return ['direct-file', 'm3u8-hls', 'mpd-dash', 'manifest-like'].includes(transport);
    }

    function isGarbageUrl(url) {
        if (!url) return true;
        if (/^blob:/i.test(url)) return false;
        if (GARBAGE_HOST_RE.test(url)) return true;
        if (IMAGE_EXT_RE.test(url) || STATIC_EXT_RE.test(url) || SEGMENT_RE.test(url)) return true;
        return false;
    }

    function extractNestedUrlsFromValue(value, baseHref) {
        const results = [];
        const raw = text(value).trim();
        if (!raw) return results;

        const direct = normalizeUrl(raw, baseHref);
        if (direct && !direct.isBlob) results.push(direct.normalizedUrl);

        const decoded = [];
        try { decoded.push(decodeURIComponent(raw)); } catch (_) {}
        try { decoded.push(decodeURIComponent(decodeURIComponent(raw))); } catch (_) {}

        const bag = [raw, ...decoded];
        for (const candidateText of bag) {
            let urlObj = null;
            try {
                urlObj = new URL(candidateText, baseHref || location.href);
            } catch (_) {
                continue;
            }
            for (const key of QUERY_PARAM_KEYS) {
                const valueFromQuery = urlObj.searchParams.get(key);
                if (!valueFromQuery) continue;
                const nested = normalizeUrl(valueFromQuery, urlObj.href);
                if (nested && !nested.isBlob) results.push(nested.normalizedUrl);
            }
        }

        return Array.from(new Set(results));
    }

    function installCreateObjectUrlProbe() {
        const URLCtor = window.URL || window.webkitURL;
        if (!URLCtor || typeof URLCtor.createObjectURL !== 'function') return;
        if (URLCtor.createObjectURL.__uvlfProbeWrapped) return;

        const original = URLCtor.createObjectURL.bind(URLCtor);

        function wrappedCreateObjectURL(obj) {
            try {
                const isMediaSourceObj = typeof window.MediaSource !== 'undefined' && obj instanceof window.MediaSource;
                if (isMediaSourceObj) {
                    state.createObjectUrlHits.push({
                        time: Date.now(),
                        type: 'MediaSource'
                    });
                }
            } catch (_) {}
            return original(obj);
        }

        wrappedCreateObjectURL.__uvlfProbeWrapped = true;
        URLCtor.createObjectURL = wrappedCreateObjectURL;
    }

    function collectReport() {
        const lines = [];
        const videos = Array.from(document.querySelectorAll(SELECTORS.videos));
        const containers = Array.from(document.querySelectorAll(SELECTORS.containers));
        const sourceNodes = Array.from(document.querySelectorAll(SELECTORS.sources));
        const hrefNodes = Array.from(document.querySelectorAll(SELECTORS.hrefs)).slice(0, MAX_HREF_ELEMENTS);
        const dataSelector = SELECTORS.dataAttrs.map((attr) => `[${attr}]`).join(',');
        const dataNodes = Array.from(document.querySelectorAll(dataSelector)).slice(0, MAX_DATA_ATTR_ELEMENTS);

        let performanceEntries = [];
        try {
            performanceEntries = performance.getEntriesByType('resource').slice(-MAX_PERF_ENTRIES);
        } catch (_) {}

        const localBlobVideos = videos.filter((video) => {
            const currentSrc = text(video.currentSrc).trim();
            const srcAttr = text(video.getAttribute('src') || video.src).trim();
            return /^blob:/i.test(currentSrc) || /^blob:/i.test(srcAttr);
        });

        const likelyPlayerPage = videos.some(isElementVisible);
        const likelyWrapperPage = !videos.some(isElementVisible) && containers.some(isElementVisible);

        const uiDetected = !!(
            document.querySelector('#uvlf-beta-safe') ||
            document.querySelector('[data-uvlf-root="1"]')
        );

        lines.push('UVLF_beta_probe REPORT');
        lines.push(`time: ${safeNow()}`);
        lines.push(`location: ${location.href}`);
        lines.push(`title: ${document.title || '(brak tytułu)'}`);
        lines.push(`frame: ${isTopWindow() ? 'top' : 'subframe'}`);
        lines.push(`frameId: ${state.frameId}`);
        lines.push('');

        lines.push('ui-state:');
        lines.push(`- uvlfMainUiDetected: ${uiDetected}`);
        lines.push('');

        lines.push('page-role:');
        lines.push(`- likelyPlayerPage: ${likelyPlayerPage}`);
        lines.push(`- likelyWrapperPage: ${likelyWrapperPage}`);
        lines.push('');

        lines.push('blob-mse:');
        lines.push(`- MediaSourceAvailable: ${typeof window.MediaSource !== 'undefined'}`);
        lines.push(`- localBlobVideos: ${localBlobVideos.length}`);
        lines.push(`- createObjectURL(MediaSource) seen: ${state.createObjectUrlHits.length > 0}`);
        lines.push(`- createObjectURL hit count: ${state.createObjectUrlHits.length}`);
        lines.push('');

        lines.push('targets:');
        const targets = Array.from(document.querySelectorAll(SELECTORS.targets));
        if (!targets.length) {
            lines.push('- none');
        } else {
            targets.forEach((node, index) => {
                const tag = node.tagName.toLowerCase();
                const attr = tag === 'object' ? 'data' : 'src';
                const value = node.getAttribute(attr) || '';
                lines.push(`- #${index + 1} <${tag}> visible=${isElementVisible(node)} value=${value || '(empty)'}`);
            });
        }
        lines.push('');

        lines.push('videos:');
        if (!videos.length) {
            lines.push('- none');
        } else {
            videos.forEach((video, index) => {
                const rect = video.getBoundingClientRect();
                lines.push(`- #${index + 1} visible=${isElementVisible(video)} size=${Math.round(rect.width)}x${Math.round(rect.height)}`);
                lines.push(`  currentSrc=${video.currentSrc || '(empty)'}`);
                lines.push(`  currentSrcTransport=${classifyTransport(video.currentSrc || '')}`);
                lines.push(`  src=${video.getAttribute('src') || video.src || '(empty)'}`);
                lines.push(`  srcTransport=${classifyTransport(video.getAttribute('src') || video.src || '')}`);
                const nestedSources = Array.from(video.querySelectorAll('source[src]')).map((node) => node.getAttribute('src'));
                lines.push(`  sources=${nestedSources.length ? nestedSources.join(' | ') : '(none)'}`);
            });
        }
        lines.push('');

        lines.push('source[src]:');
        if (!sourceNodes.length) {
            lines.push('- none');
        } else {
            sourceNodes.forEach((node, index) => {
                const value = node.getAttribute('src') || '';
                const norm = normalizeUrl(value, location.href);
                lines.push(`- #${index + 1} raw=${value || '(empty)'} normalized=${norm ? norm.normalizedUrl : '(invalid)'} transport=${classifyTransport(norm ? norm.normalizedUrl : '')}`);
            });
        }
        lines.push('');

        lines.push('containers:');
        if (!containers.length) {
            lines.push('- none');
        } else {
            containers.forEach((node, index) => {
                const tag = node.tagName.toLowerCase();
                const attr = tag === 'object' ? 'data' : 'src';
                const raw = node.getAttribute(attr) || '';
                const norm = normalizeUrl(raw, location.href);
                lines.push(`- #${index + 1} <${tag}> raw=${raw || '(empty)'}`);
                lines.push(`  normalized=${norm ? norm.normalizedUrl : '(invalid)'}`);
                lines.push(`  transport=${classifyTransport(norm ? norm.normalizedUrl : '')}`);
                lines.push(`  externalPlayerUsable=${looksUsableForExternalPlayer(norm ? norm.normalizedUrl : '')}`);
                extractNestedUrlsFromValue(raw, location.href).forEach((nested) => {
                    lines.push(`  nested=${nested} transport=${classifyTransport(nested)} usable=${looksUsableForExternalPlayer(nested)}`);
                });
            });
        }
        lines.push('');

        lines.push('data-attrs:');
        if (!dataNodes.length) {
            lines.push('- none');
        } else {
            dataNodes.forEach((node, index) => {
                lines.push(`- #${index + 1} <${node.tagName.toLowerCase()}> visible=${isElementVisible(node)}`);
                SELECTORS.dataAttrs.forEach((attr) => {
                    const raw = node.getAttribute(attr);
                    if (!raw) return;
                    const norm = normalizeUrl(raw, location.href);
                    lines.push(`  ${attr}=${raw}`);
                    lines.push(`    normalized=${norm ? norm.normalizedUrl : '(invalid)'}`);
                    lines.push(`    transport=${classifyTransport(norm ? norm.normalizedUrl : '')}`);
                    extractNestedUrlsFromValue(raw, location.href).forEach((nested) => {
                        lines.push(`    nested=${nested} transport=${classifyTransport(nested)} usable=${looksUsableForExternalPlayer(nested)}`);
                    });
                });
            });
        }
        lines.push('');

        lines.push('href scan (conservative):');
        if (!hrefNodes.length) {
            lines.push('- none');
        } else {
            hrefNodes.forEach((node, index) => {
                const raw = node.getAttribute('href') || '';
                const norm = normalizeUrl(raw, location.href);
                const directish = norm && !norm.isBlob && !isGarbageUrl(norm.normalizedUrl) && (
                    DIRECT_EXT_RE.test(norm.normalizedUrl) ||
                    M3U8_RE.test(norm.normalizedUrl) ||
                    MPD_RE.test(norm.normalizedUrl) ||
                    MANIFEST_RE.test(norm.normalizedUrl)
                );

                const nested = extractNestedUrlsFromValue(raw, location.href);
                if (!directish && !nested.length) return;

                lines.push(`- #${index + 1} raw=${raw}`);
                if (norm) lines.push(`  normalized=${norm.normalizedUrl}`);
                if (norm) lines.push(`  transport=${classifyTransport(norm.normalizedUrl)} usable=${looksUsableForExternalPlayer(norm.normalizedUrl)}`);
                nested.forEach((item) => {
                    lines.push(`  nested=${item} transport=${classifyTransport(item)} usable=${looksUsableForExternalPlayer(item)}`);
                });
            });
        }
        lines.push('');

        lines.push('performance same-origin:');
        const perfUseful = performanceEntries.filter((entry) => {
            const name = text(entry && entry.name).trim();
            return name && !isGarbageUrl(name) && sameOrigin(name);
        });

        if (!perfUseful.length) {
            lines.push('- none');
        } else {
            perfUseful.forEach((entry, index) => {
                const name = entry.name;
                lines.push(`- #${index + 1} initiator=${entry.initiatorType || 'resource'} transport=${classifyTransport(name)} usable=${looksUsableForExternalPlayer(name)} url=${name}`);
            });
        }
        lines.push('');

        lines.push('summary:');
        if (localBlobVideos.length && likelyPlayerPage) {
            lines.push('- local video uses blob: and page looks like a real player page');
            lines.push('- if no direct/m3u8/mpd candidate exists, player-page-url should be treated as fallback copyable result');
            lines.push('- blob itself is diagnostic only and should not be copied as final stream URL');
        } else if (likelyWrapperPage) {
            lines.push('- page looks like a wrapper; iframe/embed/object should outrank ordinary page links');
        } else {
            lines.push('- no strong wrapper/player distinction from current DOM snapshot');
        }

        return lines.join('\n');
    }

    function buildUi() {
        if (state.uiReady || !isTopWindow()) return;

        const mount = document.documentElement || document.body;
        if (!mount) {
            setTimeout(buildUi, 60);
            return;
        }

        const host = document.createElement('div');
        host.id = SCRIPT_ID;
        host.style.position = 'fixed';
        host.style.right = '12px';
        host.style.bottom = '12px';
        host.style.zIndex = '2147483645';

        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
<style>
* { box-sizing: border-box; font: normal 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.box {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px;
    border-radius: 12px;
    background: rgba(10, 12, 18, .84);
    color: #eef3ff;
    border: 1px solid rgba(255,255,255,.14);
    box-shadow: 0 8px 22px rgba(0,0,0,.34);
    backdrop-filter: blur(10px);
}
button {
    appearance: none;
    border: 1px solid rgba(255,255,255,.14);
    background: rgba(255,255,255,.10);
    color: #fff;
    border-radius: 10px;
    padding: 7px 10px;
    cursor: pointer;
    font-weight: 600;
}
button:hover { background: rgba(255,255,255,.16); }
.status { opacity: .85; max-width: 320px; }
</style>
<div class="box">
    <button id="scanBtn" type="button">Probe: skanuj</button>
    <button id="copyBtn" type="button">Kopiuj raport</button>
    <div id="status" class="status">Gotowy</div>
</div>`;

        mount.appendChild(host);
        state.host = host;
        state.shadow = shadow;
        state.refs = {
            status: shadow.getElementById('status'),
            scanBtn: shadow.getElementById('scanBtn'),
            copyBtn: shadow.getElementById('copyBtn'),
        };

        shadow.getElementById('scanBtn').addEventListener('click', () => {
            state.lastReport = collectReport();
            state.refs.status.textContent = 'Skan zakończony';
            broadcastLocalReport();
        });

        shadow.getElementById('copyBtn').addEventListener('click', async () => {
            state.lastReport = collectReport();
            const ok = await copyText(state.lastReport);
            state.refs.status.textContent = ok ? 'Raport skopiowany' : 'Błąd kopiowania';
            broadcastLocalReport();
        });

        state.uiReady = true;
    }

    async function copyText(value) {
        const raw = text(value);
        if (!raw) return false;

        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(raw, 'text');
                return true;
            }
        } catch (_) {}

        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(raw);
                return true;
            }
        } catch (_) {}

        try {
            const ta = document.createElement('textarea');
            ta.value = raw;
            ta.readOnly = true;
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

    function broadcastLocalReport() {
        const payload = {
            kind: 'uvlf-probe-report',
            channel: REPORT_CHANNEL,
            frameId: state.frameId,
            href: location.href,
            title: document.title || '',
            report: state.lastReport || collectReport(),
            ts: Date.now()
        };

        if (isTopWindow()) {
            state.frameReports.set(state.frameId, payload);
            return;
        }

        const topWin = tryGetTopWindow();
        if (!topWin || typeof topWin.postMessage !== 'function') return;
        try {
            topWin.postMessage(payload, '*');
        } catch (_) {}
    }

    function installBridge() {
        window.addEventListener('message', (event) => {
            const data = event && event.data;
            if (!data || data.channel !== REPORT_CHANNEL || data.kind !== 'uvlf-probe-report') return;
            if (!isTopWindow()) return;
            state.frameReports.set(data.frameId, data);
            if (state.uiReady && state.refs.status) {
                state.refs.status.textContent = `Zebrano raporty ramek: ${state.frameReports.size}`;
            }
        }, false);
    }

    function init() {
        installCreateObjectUrlProbe();
        installBridge();
        if (isTopWindow()) buildUi();

        document.addEventListener('DOMContentLoaded', () => {
            state.lastReport = collectReport();
            broadcastLocalReport();
        }, { once: true });

        window.addEventListener('load', () => {
            state.lastReport = collectReport();
            broadcastLocalReport();
        }, { once: true });
    }

    init();
})();
