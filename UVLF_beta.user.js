// ==UserScript==
// @name         UVLF_beta
// @namespace    https://github.com/WilluxOne/Skrypt_t
// @version      beta 15
// @description  Safe universal video URL finder overlay. Exposed DOM/performance only. No fetch/XHR hooks, no inline-script scraping, no DRM bypass.
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

    // ============================================================
    // core/constants
    // ============================================================

    const SCRIPT_ID = 'uvlf-beta-safe';
    const STORE_KEY = 'uvlf-beta-settings-v14';
    const CHANNEL = '__UVLF_BETA_CHANNEL__';
    const MAX_DATA_ATTR_ELEMENTS = 250;
    const MAX_HREF_ELEMENTS = 120;
    const MAX_PERF_ENTRIES = 250;
    const BLOB_FOLLOW_UPS = [1200, 3200, 7000, 12000];
    const BLOB_ACTIVE_MS = 15000;

    const DEFAULT_SETTINGS = {
        autoScanOnPlay: true,
        showLowConfidence: false,
        preferM3U8: true,
        autoCopyOnPlay: false,
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
            'data-mpd',
            'data-dash',
            'data-manifest',
            'data-media',
            'data-play',
            'data-source',
            'data-embed'
        ],
        hrefs: 'a[href], link[href]',
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
    const PAGE_NOISE_RE = /(?:^|\/)(?:profile|profiles|tag|tags|category|categories|premium|logout|search|account|help|support|login|register|signup|terms|privacy)(?:[/?#]|$)/i;
    const HASH_NOISE_RE = /^#!?$/;

    const KIND_PRIORITY = {
        'direct': 700,
        'm3u8': 640,
        'mpd': 600,
        'manifest': 520,
        'container': 420,
        'player-page': 280,
        'blob-state': 220,
        'page': 150,
        'other': 80
    };

    const SOURCE_PRIORITY = {
        'video.currentSrc': 180,
        'video.src': 165,
        'source[src]': 150,
        'data-*': 110,
        'query-param': 105,
        'performance': 80,
        'iframe[src]': 90,
        'embed[src]': 90,
        'object[data]': 90,
        'a[href]': 40,
        'synthetic.playerPage': 55,
        'synthetic.blobState': 45
    };

    // ============================================================
    // core/state
    // ============================================================

    const state = {
        frameId: createFrameId(),
        settings: loadSettings(),
        scanTimer: null,
        blobTimers: new Set(),
        mutationObserver: null,
        uiWatchdogTimer: null,
        createObjectUrlHits: [],
        candidateMapLocal: new Map(),
        frameDigests: new Map(),
        bestLocal: null,
        bestGlobal: null,
        bestCopyable: null,
        bestContainer: null,
        bestPlayerPage: null,
        bestOverall: null,
        lastReport: '',
        lastScanReason: 'startup',
        lastScanAt: 0,
        uiReady: false,
        shadow: null,
        host: null,
        refs: {},
        playBound: new WeakSet(),
        blobSeenThisScan: false,
        blobActiveSince: 0,
        lastBlobSeenAt: 0,
        lastKnownMse: false,
        diagnostics: getEmptyDiagnostics(),
    };

    // ============================================================
    // core/settings
    // ============================================================

    function loadSettings() {
        const fallback = { ...DEFAULT_SETTINGS };
        try {
            if (typeof GM_getValue === 'function') {
                const raw = GM_getValue(STORE_KEY, null);
                if (raw && typeof raw === 'object') return { ...fallback, ...raw };
                if (typeof raw === 'string') return { ...fallback, ...JSON.parse(raw) };
            }
        } catch (_) {}
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw) return { ...fallback, ...JSON.parse(raw) };
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

    // ============================================================
    // utils/basic
    // ============================================================

    function createFrameId() {
        return `f_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    }

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

    function shortUrl(url) {
        const raw = text(url);
        if (raw.length <= 90) return raw;
        return `${raw.slice(0, 42)}…${raw.slice(-36)}`;
    }

    function confidenceLabel(score) {
        if (score >= 760) return 'wysoka';
        if (score >= 520) return 'średnia';
        return 'niska';
    }

    function createNoteList(...values) {
        return values.filter(Boolean).map(String);
    }

    function clampString(value, maxLen) {
        const raw = text(value);
        return raw.length > maxLen ? `${raw.slice(0, maxLen - 1)}…` : raw;
    }

    // ============================================================
    // utils/url
    // ============================================================

    function normalizeUrl(value, baseHref) {
        const raw = text(value).trim();
        if (!raw) return null;
        if (/^(?:javascript:|data:|mailto:|tel:|about:blank)/i.test(raw)) return null;
        if (/^blob:/i.test(raw)) {
            return {
                raw,
                normalizedUrl: raw,
                isBlob: true
            };
        }
        try {
            const normalizedUrl = new URL(raw, baseHref || location.href).href;
            return {
                raw,
                normalizedUrl,
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

    function looksLikeMediaFilename(url) {
        return DIRECT_EXT_RE.test(url) || M3U8_RE.test(url) || MPD_RE.test(url) || MANIFEST_RE.test(url);
    }

    function looksLikePage(url) {
        try {
            const u = new URL(url, location.href);
            const path = u.pathname || '/';
            if (M3U8_RE.test(url) || MPD_RE.test(url) || DIRECT_EXT_RE.test(url)) return false;
            if (!/\.[a-z0-9]{2,6}$/i.test(path)) return true;
            return false;
        } catch (_) {
            return false;
        }
    }

    function isGarbageUrl(url) {
        if (!url) return true;
        if (/^blob:/i.test(url)) return false;
        if (GARBAGE_HOST_RE.test(url)) return true;
        if (IMAGE_EXT_RE.test(url) || STATIC_EXT_RE.test(url) || SEGMENT_RE.test(url)) return true;

        try {
            const u = new URL(url, location.href);
            if ((u.href === location.href) && (u.hash === '#' || u.hash === '#!')) return true;
            if (PAGE_NOISE_RE.test(u.pathname || '/')) return true;
        } catch (_) {}

        return false;
    }

    function classifyUrl(url, sourceKind) {
        if (/^blob:/i.test(url)) return 'blob-state';
        if (DIRECT_EXT_RE.test(url)) return 'direct';
        if (M3U8_RE.test(url)) return 'm3u8';
        if (MPD_RE.test(url)) return 'mpd';
        if (MANIFEST_RE.test(url)) return 'manifest';
        if (sourceKind === 'iframe[src]' || sourceKind === 'embed[src]' || sourceKind === 'object[data]') return 'container';
        if (looksLikePage(url)) return 'page';
        return 'other';
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

    // ============================================================
    // detector/blobMse
    // ============================================================

    function getEmptyDiagnostics() {
        return {
            videoCount: 0,
            visibleVideoCount: 0,
            visibleContainerCount: 0,
            iframeCount: 0,
            embedCount: 0,
            objectCount: 0,
            localBlobVideos: 0,
            mediaSourceDetected: typeof window.MediaSource !== 'undefined',
            createObjectURLMediaSourceSeen: false,
            likelyPlayerPage: false,
            likelyWrapperPage: false
        };
    }

    function installCreateObjectUrlProbe() {
        const URLCtor = window.URL || window.webkitURL;
        if (!URLCtor || typeof URLCtor.createObjectURL !== 'function') return;
        if (URLCtor.createObjectURL.__uvlfWrapped) return;

        const original = URLCtor.createObjectURL.bind(URLCtor);

        function wrappedCreateObjectURL(obj) {
            try {
                const isMediaSourceObj = typeof window.MediaSource !== 'undefined' && obj instanceof window.MediaSource;
                if (isMediaSourceObj) {
                    state.createObjectUrlHits.push({
                        time: Date.now(),
                        kind: 'MediaSource'
                    });
                    state.lastKnownMse = true;
                }
            } catch (_) {}
            return original(obj);
        }

        wrappedCreateObjectURL.__uvlfWrapped = true;
        URLCtor.createObjectURL = wrappedCreateObjectURL;
    }

    function detectBlobAndMse(videos) {
        let blobVideoCount = 0;
        let blobSeenThisScan = false;
        let mediaSourceDetected = typeof window.MediaSource !== 'undefined';
        let createObjectURLMediaSourceSeen = state.createObjectUrlHits.length > 0;

        videos.forEach((video) => {
            const currentSrc = text(video.currentSrc).trim();
            const srcAttr = text(video.getAttribute('src') || video.src).trim();
            if (/^blob:/i.test(currentSrc) || /^blob:/i.test(srcAttr)) {
                blobVideoCount += 1;
                blobSeenThisScan = true;
            }
        });

        if (blobSeenThisScan) {
            state.lastBlobSeenAt = Date.now();
            state.blobActiveSince = state.blobActiveSince || Date.now();
        }

        state.blobSeenThisScan = blobSeenThisScan;
        state.lastKnownMse = state.lastKnownMse || (blobSeenThisScan && (mediaSourceDetected || createObjectURLMediaSourceSeen));

        return {
            blobVideoCount,
            blobSeenThisScan,
            mediaSourceDetected,
            createObjectURLMediaSourceSeen,
            mseLikely: blobSeenThisScan && (mediaSourceDetected || createObjectURLMediaSourceSeen || state.lastKnownMse)
        };
    }

    // ============================================================
    // collector / scoring model
    // ============================================================

    function makeCandidate(input) {
        return {
            url: input.url,
            normalizedUrl: input.normalizedUrl || input.url,
            kind: input.kind || 'other',
            source: input.source || 'unknown',
            score: input.score || 0,
            copyable: Boolean(input.copyable),
            confidence: input.confidence || 'niska',
            notes: Array.isArray(input.notes) ? input.notes.slice() : [],
            isSameOrigin: Boolean(input.isSameOrigin),
            isBlob: Boolean(input.isBlob),
            isLikelyWrapper: Boolean(input.isLikelyWrapper),
            isLikelyPlayerPage: Boolean(input.isLikelyPlayerPage),
            visible: Boolean(input.visible),
            fromFrameId: input.fromFrameId || state.frameId,
            frameHref: input.frameHref || location.href,
            frameTitle: input.frameTitle || document.title || '',
            sourcePriority: SOURCE_PRIORITY[input.source] || 0,
            kindPriority: KIND_PRIORITY[input.kind] || 0
        };
    }

    function computeCandidateScore(meta) {
        let score = 0;

        score += KIND_PRIORITY[meta.kind] || 0;
        score += SOURCE_PRIORITY[meta.source] || 0;

        if (meta.visible) score += 30;
        if (meta.isSameOrigin) score += 24;

        if (meta.kind === 'container' && meta.visible) score += 36;
        if (meta.kind === 'player-page' && meta.isLikelyPlayerPage) score += 60;
        if (meta.kind === 'player-page' && meta.isLikelyWrapper) score -= 130;
        if (meta.kind === 'page') score -= 120;
        if (meta.kind === 'other') score -= 20;
        if (meta.source === 'performance' && !meta.isSameOrigin) score -= 180;
        if (meta.source === 'a[href]') score -= 40;
        if (meta.kind === 'container' && meta.isLikelyWrapper) score += 18;
        if (meta.kind === 'blob-state') score -= 35;
        if (!meta.copyable) score -= 24;

        if (state.settings.preferM3U8 && meta.kind === 'm3u8') score += 20;

        return score;
    }

    function addCandidateToMap(map, rawValue, meta) {
        const normalized = normalizeUrl(rawValue, meta.baseHref || location.href);
        if (!normalized) return;

        if (normalized.isBlob) {
            return;
        }

        const url = normalized.normalizedUrl;
        if (isGarbageUrl(url)) return;

        const kind = meta.kind || classifyUrl(url, meta.source);
        if (kind === 'page' && meta.forcePage !== true && meta.source !== 'synthetic.playerPage') {
            // ordinary page links are weak and noisy; keep only if explicitly useful
            if (meta.source !== 'iframe[src]' && meta.source !== 'embed[src]' && meta.source !== 'object[data]' && meta.source !== 'a[href]') {
                return;
            }
        }

        const candidate = makeCandidate({
            url,
            normalizedUrl: url,
            kind,
            source: meta.source,
            visible: meta.visible !== false,
            copyable: meta.copyable !== false,
            notes: meta.notes || [],
            isSameOrigin: sameOrigin(url),
            isBlob: false,
            isLikelyWrapper: Boolean(meta.isLikelyWrapper),
            isLikelyPlayerPage: Boolean(meta.isLikelyPlayerPage),
            fromFrameId: meta.fromFrameId,
            frameHref: meta.frameHref,
            frameTitle: meta.frameTitle
        });

        candidate.score = computeCandidateScore(candidate);
        candidate.confidence = confidenceLabel(candidate.score);

        const existing = map.get(candidate.normalizedUrl);
        if (!existing) {
            map.set(candidate.normalizedUrl, candidate);
            return;
        }

        existing.score = Math.max(existing.score, candidate.score);
        existing.copyable = existing.copyable || candidate.copyable;
        existing.visible = existing.visible || candidate.visible;
        existing.isSameOrigin = existing.isSameOrigin || candidate.isSameOrigin;
        existing.isLikelyWrapper = existing.isLikelyWrapper || candidate.isLikelyWrapper;
        existing.isLikelyPlayerPage = existing.isLikelyPlayerPage || candidate.isLikelyPlayerPage;
        existing.kind = chooseBetterKind(existing.kind, candidate.kind);
        existing.source = chooseBetterSource(existing.source, candidate.source);
        existing.sourcePriority = Math.max(existing.sourcePriority, candidate.sourcePriority);
        existing.kindPriority = Math.max(existing.kindPriority, candidate.kindPriority);
        existing.confidence = confidenceLabel(existing.score);
        existing.notes = Array.from(new Set(existing.notes.concat(candidate.notes)));
    }

    function chooseBetterKind(a, b) {
        return (KIND_PRIORITY[b] || 0) > (KIND_PRIORITY[a] || 0) ? b : a;
    }

    function chooseBetterSource(a, b) {
        return (SOURCE_PRIORITY[b] || 0) > (SOURCE_PRIORITY[a] || 0) ? b : a;
    }

    function sortCandidates(list) {
        return list.slice().sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if ((b.kindPriority || 0) !== (a.kindPriority || 0)) return (b.kindPriority || 0) - (a.kindPriority || 0);
            if ((b.sourcePriority || 0) !== (a.sourcePriority || 0)) return (b.sourcePriority || 0) - (a.sourcePriority || 0);
            return a.normalizedUrl.localeCompare(b.normalizedUrl);
        });
    }

    // ============================================================
    // collector/dom
    // ============================================================

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

    function getPrimaryTarget() {
        const nodes = Array.from(document.querySelectorAll(SELECTORS.target)).filter(isElementVisible);
        if (!nodes.length) return null;
        nodes.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return (rb.width * rb.height) - (ra.width * ra.height);
        });
        return nodes[0] || null;
    }

    function analyzePageRole(videos, containers, blobInfo) {
        const visibleVideos = videos.filter(isElementVisible);
        const visibleContainers = containers.filter(isElementVisible);

        const likelyPlayerPage =
            visibleVideos.length > 0 &&
            (visibleContainers.length === 0 || visibleVideos.length >= visibleContainers.length);

        const likelyWrapperPage =
            visibleVideos.length === 0 &&
            visibleContainers.length > 0;

        state.diagnostics.videoCount = videos.length;
        state.diagnostics.visibleVideoCount = visibleVideos.length;
        state.diagnostics.visibleContainerCount = visibleContainers.length;
        state.diagnostics.iframeCount = containers.filter((n) => n.tagName.toLowerCase() === 'iframe').length;
        state.diagnostics.embedCount = containers.filter((n) => n.tagName.toLowerCase() === 'embed').length;
        state.diagnostics.objectCount = containers.filter((n) => n.tagName.toLowerCase() === 'object').length;
        state.diagnostics.localBlobVideos = blobInfo.blobVideoCount;
        state.diagnostics.mediaSourceDetected = blobInfo.mediaSourceDetected;
        state.diagnostics.createObjectURLMediaSourceSeen = blobInfo.createObjectURLMediaSourceSeen;
        state.diagnostics.likelyPlayerPage = likelyPlayerPage;
        state.diagnostics.likelyWrapperPage = likelyWrapperPage;

        return { likelyPlayerPage, likelyWrapperPage };
    }

    function collectFromVideos(map, videos, pageRole) {
        videos.forEach((video) => {
            const visible = isElementVisible(video);
            const currentSrc = text(video.currentSrc).trim();
            const srcAttr = text(video.getAttribute('src') || video.src).trim();

            if (currentSrc && !/^blob:/i.test(currentSrc)) {
                addCandidateToMap(map, currentSrc, {
                    source: 'video.currentSrc',
                    visible,
                    copyable: true,
                    notes: createNoteList('visible video.currentSrc'),
                    isLikelyPlayerPage: pageRole.likelyPlayerPage,
                    isLikelyWrapper: pageRole.likelyWrapperPage
                });
            }

            if (srcAttr && !/^blob:/i.test(srcAttr)) {
                addCandidateToMap(map, srcAttr, {
                    source: 'video.src',
                    visible,
                    copyable: true,
                    notes: createNoteList('visible video src attribute'),
                    isLikelyPlayerPage: pageRole.likelyPlayerPage,
                    isLikelyWrapper: pageRole.likelyWrapperPage
                });
            }

            Array.from(video.querySelectorAll('source[src]')).forEach((source) => {
                addCandidateToMap(map, source.getAttribute('src'), {
                    source: 'source[src]',
                    visible,
                    copyable: true,
                    notes: createNoteList('video source child'),
                    isLikelyPlayerPage: pageRole.likelyPlayerPage,
                    isLikelyWrapper: pageRole.likelyWrapperPage
                });
            });
        });
    }

    function collectFromContainers(map, containers, pageRole) {
        containers.forEach((node) => {
            const tag = node.tagName.toLowerCase();
            const attr = tag === 'object' ? 'data' : 'src';
            const value = node.getAttribute(attr);
            const source = tag === 'iframe' ? 'iframe[src]' : tag === 'embed' ? 'embed[src]' : 'object[data]';
            const visible = isElementVisible(node);

            addCandidateToMap(map, value, {
                source,
                visible,
                copyable: true,
                notes: createNoteList('embedded container'),
                isLikelyPlayerPage: pageRole.likelyPlayerPage,
                isLikelyWrapper: pageRole.likelyWrapperPage
            });

            extractNestedUrlsFromValue(value, location.href).forEach((nestedUrl) => {
                if (nestedUrl === value) return;
                addCandidateToMap(map, nestedUrl, {
                    source: 'query-param',
                    visible,
                    copyable: true,
                    notes: createNoteList(`nested in ${source}`),
                    isLikelyPlayerPage: pageRole.likelyPlayerPage,
                    isLikelyWrapper: pageRole.likelyWrapperPage
                });
            });
        });
    }

    function collectFromDataAttrs(map, pageRole) {
        const selector = SELECTORS.dataAttrs.map((attr) => `[${attr}]`).join(',');
        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, MAX_DATA_ATTR_ELEMENTS);

        nodes.forEach((node) => {
            const visible = isElementVisible(node);
            SELECTORS.dataAttrs.forEach((attr) => {
                const value = node.getAttribute(attr);
                if (!value) return;

                addCandidateToMap(map, value, {
                    source: 'data-*',
                    visible,
                    copyable: true,
                    notes: createNoteList(`exposed ${attr}`),
                    isLikelyPlayerPage: pageRole.likelyPlayerPage,
                    isLikelyWrapper: pageRole.likelyWrapperPage
                });

                extractNestedUrlsFromValue(value, location.href).forEach((nestedUrl) => {
                    if (nestedUrl === value) return;
                    addCandidateToMap(map, nestedUrl, {
                        source: 'query-param',
                        visible,
                        copyable: true,
                        notes: createNoteList(`nested in ${attr}`),
                        isLikelyPlayerPage: pageRole.likelyPlayerPage,
                        isLikelyWrapper: pageRole.likelyWrapperPage
                    });
                });
            });
        });
    }

    function collectFromHrefs(map, pageRole) {
        const nodes = Array.from(document.querySelectorAll(SELECTORS.hrefs)).slice(0, MAX_HREF_ELEMENTS);

        nodes.forEach((node) => {
            const href = node.getAttribute('href');
            if (!href) return;
            const normalized = normalizeUrl(href, location.href);
            if (!normalized || normalized.isBlob) return;

            const url = normalized.normalizedUrl;
            const directish = looksLikeMediaFilename(url);
            const nested = extractNestedUrlsFromValue(href, location.href);
            const visible = isElementVisible(node);

            if (directish) {
                addCandidateToMap(map, url, {
                    source: 'a[href]',
                    visible,
                    copyable: true,
                    notes: createNoteList('conservative href media candidate'),
                    isLikelyPlayerPage: pageRole.likelyPlayerPage,
                    isLikelyWrapper: pageRole.likelyWrapperPage
                });
            }

            nested.forEach((nestedUrl) => {
                addCandidateToMap(map, nestedUrl, {
                    source: 'query-param',
                    visible,
                    copyable: true,
                    notes: createNoteList('nested in href'),
                    isLikelyPlayerPage: pageRole.likelyPlayerPage,
                    isLikelyWrapper: pageRole.likelyWrapperPage
                });
            });
        });
    }

    // ============================================================
    // collector/performance
    // ============================================================

    function collectFromPerformance(map, pageRole) {
        let entries = [];
        try {
            entries = performance.getEntriesByType('resource') || [];
        } catch (_) {
            return;
        }

        entries.slice(-MAX_PERF_ENTRIES).forEach((entry) => {
            const name = text(entry && entry.name).trim();
            if (!name) return;
            if (isGarbageUrl(name)) return;
            if (!sameOrigin(name)) return;

            const kind = classifyUrl(name, 'performance');
            if (!['direct', 'm3u8', 'mpd', 'manifest', 'other'].includes(kind)) return;

            addCandidateToMap(map, name, {
                source: 'performance',
                visible: false,
                copyable: true,
                notes: createNoteList(`performance ${entry.initiatorType || 'resource'} same-origin`),
                isLikelyPlayerPage: pageRole.likelyPlayerPage,
                isLikelyWrapper: pageRole.likelyWrapperPage
            });
        });
    }

    // ============================================================
    // synthetic candidates
    // ============================================================

    function addSyntheticFallbacks(map, pageRole, blobInfo) {
        const currentList = sortCandidates(Array.from(map.values()));
        const hasStrongCopyable = currentList.some((item) =>
            item.copyable && ['direct', 'm3u8', 'mpd', 'manifest', 'container'].includes(item.kind)
        );

        const hasContainer = currentList.some((item) => item.kind === 'container');
        const shouldAddPlayerPage =
            pageRole.likelyPlayerPage &&
            !pageRole.likelyWrapperPage &&
            (!hasStrongCopyable || (blobInfo.mseLikely && !hasContainer));

        if (shouldAddPlayerPage) {
            addCandidateToMap(map, location.href, {
                source: 'synthetic.playerPage',
                kind: 'player-page',
                visible: true,
                copyable: true,
                forcePage: true,
                notes: createNoteList(
                    'fallback player-page-url',
                    blobInfo.mseLikely ? 'blob/MSE player page fallback' : 'player page fallback'
                ),
                isLikelyPlayerPage: true,
                isLikelyWrapper: false
            });
        }

        if (blobInfo.mseLikely) {
            const syntheticBlobKey = `blob-state://${location.origin}${location.pathname}`;
            const candidate = makeCandidate({
                url: syntheticBlobKey,
                normalizedUrl: syntheticBlobKey,
                kind: 'blob-state',
                source: 'synthetic.blobState',
                visible: true,
                copyable: false,
                notes: createNoteList(
                    'blob currentSrc/src detected',
                    blobInfo.mediaSourceDetected ? 'MediaSource available' : '',
                    blobInfo.createObjectURLMediaSourceSeen ? 'createObjectURL(MediaSource) seen' : ''
                ),
                isSameOrigin: true,
                isBlob: true,
                isLikelyWrapper: pageRole.likelyWrapperPage,
                isLikelyPlayerPage: pageRole.likelyPlayerPage
            });
            candidate.score = computeCandidateScore(candidate);
            candidate.confidence = confidenceLabel(candidate.score);
            map.set(candidate.normalizedUrl, candidate);
        }
    }

    // ============================================================
    // ranking / selection
    // ============================================================

    function pickBestFromList(list) {
        const sorted = sortCandidates(list);
        const visibleThreshold = state.settings.showLowConfidence ? -Infinity : 520;

        const bestOverall = sorted[0] || null;
        const bestCopyable = sorted.find((item) => item.copyable && item.score >= visibleThreshold) || null;
        const bestContainer = sorted.find((item) => item.copyable && item.kind === 'container') || null;
        const bestPlayerPage = sorted.find((item) => item.copyable && item.kind === 'player-page') || null;

        return { sorted, bestOverall, bestCopyable, bestContainer, bestPlayerPage };
    }

    // ============================================================
    // bridge/frames
    // ============================================================

    function buildLocalDigest(selection) {
        return {
            kind: 'uvlf-frame-digest',
            channel: CHANNEL,
            frameId: state.frameId,
            href: location.href,
            title: document.title || '',
            ts: Date.now(),
            diagnostics: { ...state.diagnostics },
            candidates: selection.sorted.slice(0, 20).map(serializeCandidate),
            bestOverall: selection.bestOverall ? serializeCandidate(selection.bestOverall) : null,
            bestCopyable: selection.bestCopyable ? serializeCandidate(selection.bestCopyable) : null,
            bestContainer: selection.bestContainer ? serializeCandidate(selection.bestContainer) : null,
            bestPlayerPage: selection.bestPlayerPage ? serializeCandidate(selection.bestPlayerPage) : null
        };
    }

    function serializeCandidate(candidate) {
        return {
            url: candidate.url,
            normalizedUrl: candidate.normalizedUrl,
            kind: candidate.kind,
            source: candidate.source,
            score: candidate.score,
            copyable: candidate.copyable,
            confidence: candidate.confidence,
            notes: candidate.notes.slice(),
            isSameOrigin: candidate.isSameOrigin,
            isBlob: candidate.isBlob,
            isLikelyWrapper: candidate.isLikelyWrapper,
            isLikelyPlayerPage: candidate.isLikelyPlayerPage,
            visible: candidate.visible,
            fromFrameId: candidate.fromFrameId || state.frameId,
            frameHref: candidate.frameHref || location.href,
            frameTitle: candidate.frameTitle || document.title || ''
        };
    }

    function reviveCandidate(raw) {
        return makeCandidate(raw);
    }

    function broadcastDigestToTop(digest) {
        if (isTopWindow()) {
            state.frameDigests.set(state.frameId, digest);
            return;
        }
        const topWin = tryGetTopWindow();
        if (!topWin || typeof topWin.postMessage !== 'function') return;
        try {
            topWin.postMessage(digest, '*');
        } catch (_) {}
    }

    function installFrameBridge() {
        window.addEventListener('message', (event) => {
            const data = event && event.data;
            if (!data || data.channel !== CHANNEL || data.kind !== 'uvlf-frame-digest') return;

            if (!isTopWindow()) return;
            if (!data.frameId) return;

            state.frameDigests.set(data.frameId, data);
            recomputeGlobalFromDigests();
            renderSummary();
        }, false);
    }

    function recomputeGlobalFromDigests() {
        const merged = new Map();

        for (const digest of state.frameDigests.values()) {
            const candidates = Array.isArray(digest.candidates) ? digest.candidates : [];
            candidates.forEach((raw) => {
                const candidate = reviveCandidate(raw);
                addCandidateToMap(merged, candidate.normalizedUrl, {
                    source: candidate.source,
                    kind: candidate.kind,
                    visible: candidate.visible,
                    copyable: candidate.copyable,
                    notes: candidate.notes.concat([
                        `frame: ${clampString(candidate.frameHref || '', 120)}`
                    ]),
                    isLikelyWrapper: candidate.isLikelyWrapper,
                    isLikelyPlayerPage: candidate.isLikelyPlayerPage,
                    fromFrameId: candidate.fromFrameId,
                    frameHref: candidate.frameHref,
                    frameTitle: candidate.frameTitle
                });
            });
        }

        const selection = pickBestFromList(Array.from(merged.values()));
        state.bestGlobal = selection;
        state.bestOverall = selection.bestOverall;
        state.bestCopyable = selection.bestCopyable;
        state.bestContainer = selection.bestContainer;
        state.bestPlayerPage = selection.bestPlayerPage;
        state.lastReport = buildReport(selection.sorted);
    }

    // ============================================================
    // export/clipboard
    // ============================================================

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

    async function copyBest() {
        if (!state.bestCopyable) {
            toast('Brak kopiowalnego wyniku.');
            return false;
        }
        const ok = await copyText(state.bestCopyable.url);
        toast(ok ? 'Skopiowano najlepszy wynik.' : 'Nie udało się skopiować.');
        return ok;
    }

    async function copyContainer() {
        if (!state.bestContainer) {
            toast('Brak embed/container do skopiowania.');
            return false;
        }
        const ok = await copyText(state.bestContainer.url);
        toast(ok ? 'Skopiowano embed/container.' : 'Nie udało się skopiować.');
        return ok;
    }

    async function copyPlayerPage() {
        if (!state.bestPlayerPage) {
            toast('Brak player-page-url.');
            return false;
        }
        const ok = await copyText(state.bestPlayerPage.url);
        toast(ok ? 'Skopiowano adres strony playera.' : 'Nie udało się skopiować.');
        return ok;
    }

    async function copyReport() {
        state.lastReport = buildReport((state.bestGlobal && state.bestGlobal.sorted) || []);
        const ok = await copyText(state.lastReport);
        toast(ok ? 'Skopiowano raport.' : 'Nie udało się skopiować raportu.');
        return ok;
    }

    // ============================================================
    // report
    // ============================================================

    function buildReport(candidates) {
        const list = Array.isArray(candidates) ? candidates : [];
        const lines = [];

        lines.push('UVLF_beta SAFE REPORT');
        lines.push(`time: ${safeNow()}`);
        lines.push(`location: ${location.href}`);
        lines.push(`title: ${document.title || '(brak tytułu)'}`);
        lines.push(`frame: ${isTopWindow() ? 'top' : 'subframe'}`);
        lines.push(`frameId: ${state.frameId}`);
        lines.push(`lastScanReason: ${state.lastScanReason}`);
        lines.push(`lastScanAt: ${state.lastScanAt ? new Date(state.lastScanAt).toISOString() : '(none)'}`);
        lines.push(`settings: ${JSON.stringify(state.settings)}`);
        lines.push('');

        lines.push('diagnostics:');
        Object.entries(state.diagnostics).forEach(([key, value]) => {
            lines.push(`- ${key}: ${value}`);
        });
        lines.push('');

        lines.push('bestCopyable:');
        if (state.bestCopyable) {
            lines.push(`- kind=${state.bestCopyable.kind} conf=${state.bestCopyable.confidence} score=${state.bestCopyable.score}`);
            lines.push(`  url=${state.bestCopyable.url}`);
            lines.push(`  source=${state.bestCopyable.source}`);
            if (state.bestCopyable.notes.length) lines.push(`  notes=${state.bestCopyable.notes.join(' ; ')}`);
        } else {
            lines.push('- none');
        }
        lines.push('');

        lines.push('bestOverall:');
        if (state.bestOverall) {
            lines.push(`- kind=${state.bestOverall.kind} conf=${state.bestOverall.confidence} score=${state.bestOverall.score}`);
            lines.push(`  url=${state.bestOverall.url}`);
            lines.push(`  source=${state.bestOverall.source}`);
            if (state.bestOverall.notes.length) lines.push(`  notes=${state.bestOverall.notes.join(' ; ')}`);
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
        const containers = Array.from(document.querySelectorAll(SELECTORS.containers));
        if (!containers.length) {
            lines.push('- none');
        } else {
            containers.forEach((node, index) => {
                const tag = node.tagName.toLowerCase();
                const attr = tag === 'object' ? 'data' : 'src';
                lines.push(`- #${index + 1} <${tag}> ${node.getAttribute(attr) || '(empty)'}`);
            });
        }
        lines.push('');

        lines.push('candidates:');
        if (!list.length) {
            lines.push('- none');
        } else {
            list.forEach((item, index) => {
                lines.push(`- #${index + 1} ${item.kind} | score=${item.score} | conf=${item.confidence} | copyable=${item.copyable}`);
                lines.push(`  url=${item.url}`);
                lines.push(`  source=${item.source}`);
                lines.push(`  sameOrigin=${item.isSameOrigin} visible=${item.visible} playerPage=${item.isLikelyPlayerPage} wrapper=${item.isLikelyWrapper}`);
                if (item.notes.length) lines.push(`  notes=${item.notes.join(' ; ')}`);
            });
        }
        lines.push('');
        lines.push('safety:');
        lines.push('- exposed DOM only');
        lines.push('- same-origin performance only');
        lines.push('- no fetch/xhr hooks');
        lines.push('- no inline script scraping');
        lines.push('- no hidden-stream extraction');
        return lines.join('\n');
    }

    // ============================================================
    // ui/bar + ui/menu
    // ============================================================

    function shouldShowFullUiInThisFrame() {
        return isTopWindow();
    }

    function buildUi() {
        if (!shouldShowFullUiInThisFrame()) return;
        if (state.uiReady && state.host && state.host.isConnected) return;

        const mount = document.documentElement || document.body;
        if (!mount) {
            window.setTimeout(buildUi, 60);
            return;
        }

        const old = document.getElementById(SCRIPT_ID);
        if (old) old.remove();

        const host = document.createElement('div');
        host.id = SCRIPT_ID;
        host.setAttribute('data-uvlf-root', '1');
        host.style.position = 'fixed';
        host.style.left = '50%';
        host.style.top = '14px';
        host.style.transform = 'translateX(-50%)';
        host.style.zIndex = '2147483646';
        host.style.pointerEvents = 'auto';

        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
<style>
:host, * { box-sizing: border-box; }
.wrap {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    font: normal 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #f3f6fb;
}
.bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 320px;
    max-width: min(92vw, 920px);
    padding: 8px 10px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,.14);
    background: rgba(13, 17, 24, .84);
    box-shadow: 0 8px 28px rgba(0,0,0,.38);
    backdrop-filter: blur(10px);
}
.badge {
    flex: 0 0 auto;
    padding: 4px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    background: rgba(120, 180, 255, .18);
    border: 1px solid rgba(120, 180, 255, .35);
    white-space: nowrap;
}
.badge[data-mode="none"] { background: rgba(255,255,255,.10); border-color: rgba(255,255,255,.18); }
.badge[data-mode="blob-state"] { background: rgba(246, 184, 68, .18); border-color: rgba(246, 184, 68, .35); }
.badge[data-mode="player-page"] { background: rgba(144, 238, 144, .14); border-color: rgba(144, 238, 144, .30); }
.label {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.btn, .iconbtn {
    appearance: none;
    border: 1px solid rgba(255,255,255,.14);
    background: rgba(255,255,255,.08);
    color: #fff;
    border-radius: 10px;
    cursor: pointer;
}
.btn {
    padding: 7px 10px;
    font-weight: 600;
}
.iconbtn {
    width: 34px;
    height: 34px;
    font-size: 17px;
}
.btn:hover, .iconbtn:hover { background: rgba(255,255,255,.16); }
.counter {
    opacity: .8;
    font-size: 11px;
    padding: 0 4px;
}
.menu {
    display: none;
    width: min(92vw, 520px);
    padding: 10px;
    border-radius: 14px;
    border: 1px solid rgba(255,255,255,.14);
    background: rgba(7, 10, 15, .86);
    box-shadow: 0 10px 28px rgba(0,0,0,.44);
    backdrop-filter: blur(12px);
}
.menu[data-open="1"] { display: block; }
.grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}
.row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 6px;
}
.row label { cursor: pointer; }
.meta {
    margin-top: 8px;
    font-size: 11px;
    opacity: .82;
}
.toast {
    display: none;
    min-width: 220px;
    max-width: min(92vw, 520px);
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(0,0,0,.78);
    border: 1px solid rgba(255,255,255,.14);
    box-shadow: 0 8px 22px rgba(0,0,0,.35);
}
.toast[data-open="1"] { display: block; }
@media (max-width: 640px) {
    .bar { min-width: 0; width: min(94vw, 94vw); }
    .grid { grid-template-columns: 1fr; }
}
</style>
<div class="wrap">
    <div class="bar">
        <div id="badge" class="badge" data-mode="none">brak</div>
        <div id="label" class="label">Brak wykrytego URL-a media</div>
        <button id="scanCopyBtn" class="btn" type="button">Skanuj / kopiuj</button>
        <div id="counter" class="counter">0</div>
        <button id="menuBtn" class="iconbtn" type="button" aria-label="Menu">☰</button>
    </div>

    <div id="menu" class="menu" data-open="0">
        <div class="grid">
            <button id="rescanBtn" class="btn" type="button">Skan ponowny</button>
            <button id="copyBestBtn" class="btn" type="button">Kopiuj najlepszy wynik</button>
            <button id="copyContainerBtn" class="btn" type="button">Kopiuj embed/container</button>
            <button id="copyPlayerBtn" class="btn" type="button">Kopiuj adres strony playera</button>
            <button id="copyReportBtn" class="btn" type="button">Kopiuj raport</button>
            <button id="clearBtn" class="btn" type="button">Wyczyść wyniki</button>
        </div>

        <div class="row">
            <input id="autoScanOnPlay" type="checkbox">
            <label for="autoScanOnPlay">Automatyczny skan po PLAY</label>
        </div>
        <div class="row">
            <input id="showLowConfidence" type="checkbox">
            <label for="showLowConfidence">Pokazuj wyniki o niskiej pewności</label>
        </div>
        <div class="row">
            <input id="preferM3U8" type="checkbox">
            <label for="preferM3U8">Preferuj M3U8 / HLS</label>
        </div>
        <div class="row">
            <input id="autoCopyOnPlay" type="checkbox">
            <label for="autoCopyOnPlay">Automatyczne kopiowanie po PLAY</label>
        </div>

        <div class="meta">
            Safe mode: tylko jawne źródła DOM, kontenery, wybrane data-*, ostrożne href oraz same-origin performance.
        </div>
    </div>

    <div id="toast" class="toast" data-open="0"></div>
</div>`;

        mount.appendChild(host);

        state.host = host;
        state.shadow = shadow;
        state.refs = {
            badge: shadow.getElementById('badge'),
            label: shadow.getElementById('label'),
            menu: shadow.getElementById('menu'),
            counter: shadow.getElementById('counter'),
            toast: shadow.getElementById('toast'),
            autoScanOnPlay: shadow.getElementById('autoScanOnPlay'),
            showLowConfidence: shadow.getElementById('showLowConfidence'),
            preferM3U8: shadow.getElementById('preferM3U8'),
            autoCopyOnPlay: shadow.getElementById('autoCopyOnPlay'),
        };

        bindUiEvents(shadow);
        syncSettingsToUi();
        state.uiReady = true;
        positionUi();
        renderSummary();
    }

    function bindUiEvents(shadow) {
        shadow.getElementById('menuBtn').addEventListener('click', () => {
            const open = state.refs.menu.getAttribute('data-open') === '1';
            state.refs.menu.setAttribute('data-open', open ? '0' : '1');
        });

        shadow.getElementById('scanCopyBtn').addEventListener('click', async () => {
            runScan('button-scan-copy');
            if (state.bestCopyable) {
                await copyBest();
            } else {
                toast('Skan zakończony. Brak kopiowalnego wyniku.');
            }
        });

        shadow.getElementById('rescanBtn').addEventListener('click', () => runScan('menu-rescan'));
        shadow.getElementById('copyBestBtn').addEventListener('click', copyBest);
        shadow.getElementById('copyContainerBtn').addEventListener('click', copyContainer);
        shadow.getElementById('copyPlayerBtn').addEventListener('click', copyPlayerPage);
        shadow.getElementById('copyReportBtn').addEventListener('click', copyReport);
        shadow.getElementById('clearBtn').addEventListener('click', clearResults);

        ['autoScanOnPlay', 'showLowConfidence', 'preferM3U8', 'autoCopyOnPlay'].forEach((name) => {
            const node = shadow.getElementById(name);
            node.addEventListener('change', () => {
                state.settings[name] = !!node.checked;
                saveSettings();
                runScan(`toggle-${name}`);
            });
        });
    }

    function syncSettingsToUi() {
        if (!state.uiReady) return;
        state.refs.autoScanOnPlay.checked = !!state.settings.autoScanOnPlay;
        state.refs.showLowConfidence.checked = !!state.settings.showLowConfidence;
        state.refs.preferM3U8.checked = !!state.settings.preferM3U8;
        state.refs.autoCopyOnPlay.checked = !!state.settings.autoCopyOnPlay;
    }

    function toast(message) {
        if (!state.uiReady || !state.refs.toast) return;
        state.refs.toast.textContent = message;
        state.refs.toast.setAttribute('data-open', '1');
        clearTimeout(state.refs.toast.__timer);
        state.refs.toast.__timer = setTimeout(() => {
            state.refs.toast.setAttribute('data-open', '0');
        }, 1800);
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
        if (!shouldShowFullUiInThisFrame()) return;
        if (!state.uiReady) return;

        const badge = state.refs.badge;
        const label = state.refs.label;
        const counter = state.refs.counter;

        const best = state.bestCopyable;
        const overall = state.bestOverall;
        const totalCount = (state.bestGlobal && state.bestGlobal.sorted && state.bestGlobal.sorted.length) || 0;

        if (best) {
            badge.textContent = `${best.kind} • ${best.confidence}`;
            badge.setAttribute('data-mode', best.kind);
            label.textContent = shortUrl(best.url);
        } else if (overall) {
            badge.textContent = `${overall.kind} • raport`;
            badge.setAttribute('data-mode', overall.kind);
            label.textContent = overall.kind === 'blob-state'
                ? 'Wykryto blob/MSE. Brak direct URL, użyj raportu lub player-page-url.'
                : shortUrl(overall.url);
        } else {
            badge.textContent = 'brak';
            badge.setAttribute('data-mode', 'none');
            label.textContent = 'Brak wykrytego URL-a media';
        }

        counter.textContent = String(totalCount);
        positionUi();
    }

    function keepUiAlive() {
        if (!shouldShowFullUiInThisFrame()) return;
        clearInterval(state.uiWatchdogTimer);
        state.uiWatchdogTimer = setInterval(() => {
            if (!state.host || !state.host.isConnected) {
                state.uiReady = false;
                buildUi();
            }
            positionUi();
        }, 1200);
    }

    // ============================================================
    // scan loop
    // ============================================================

    function clearBlobTimers() {
        state.blobTimers.forEach((timer) => clearTimeout(timer));
        state.blobTimers.clear();
    }

    function scheduleBlobFollowUps() {
        clearBlobTimers();
        if (!state.blobActiveSince) return;
        if (Date.now() - state.blobActiveSince > BLOB_ACTIVE_MS) return;

        BLOB_FOLLOW_UPS.forEach((delay) => {
            const timer = setTimeout(() => {
                state.blobTimers.delete(timer);
                runScan(`blob-followup-${delay}`);
            }, delay);
            state.blobTimers.add(timer);
        });
    }

    function attachPlayListeners() {
        const videos = Array.from(document.querySelectorAll('video'));
        videos.forEach((video) => {
            if (state.playBound.has(video)) return;
            state.playBound.add(video);
            video.addEventListener('play', () => {
                if (!state.settings.autoScanOnPlay) return;
                scheduleScan('play', 180);

                if (state.settings.autoCopyOnPlay) {
                    setTimeout(() => {
                        if (state.bestCopyable) copyBest();
                    }, 600);
                }
            }, { passive: true });
        });
    }

    function scheduleScan(reason, delay) {
        state.lastScanReason = reason || 'scheduled';
        clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(() => runScan(reason), typeof delay === 'number' ? delay : 0);
    }

    function runScan(reason) {
        state.lastScanReason = reason || 'manual';
        state.lastScanAt = Date.now();
        state.candidateMapLocal.clear();

        attachPlayListeners();

        const videos = Array.from(document.querySelectorAll(SELECTORS.video));
        const containers = Array.from(document.querySelectorAll(SELECTORS.containers));
        const blobInfo = detectBlobAndMse(videos);
        const pageRole = analyzePageRole(videos, containers, blobInfo);

        collectFromVideos(state.candidateMapLocal, videos, pageRole);
        collectFromContainers(state.candidateMapLocal, containers, pageRole);
        collectFromDataAttrs(state.candidateMapLocal, pageRole);
        collectFromHrefs(state.candidateMapLocal, pageRole);
        collectFromPerformance(state.candidateMapLocal, pageRole);
        addSyntheticFallbacks(state.candidateMapLocal, pageRole, blobInfo);

        const localSelection = pickBestFromList(Array.from(state.candidateMapLocal.values()));
        state.bestLocal = localSelection;

        const digest = buildLocalDigest(localSelection);
        broadcastDigestToTop(digest);

        if (isTopWindow()) {
            state.frameDigests.set(state.frameId, digest);
            recomputeGlobalFromDigests();
            renderSummary();
        }

        if (blobInfo.mseLikely) {
            scheduleBlobFollowUps();
        } else {
            state.blobActiveSince = 0;
            clearBlobTimers();
        }
    }

    function clearResults() {
        state.candidateMapLocal.clear();
        if (isTopWindow()) {
            state.frameDigests.clear();
            state.bestGlobal = { sorted: [], bestOverall: null, bestCopyable: null, bestContainer: null, bestPlayerPage: null };
            state.bestOverall = null;
            state.bestCopyable = null;
            state.bestContainer = null;
            state.bestPlayerPage = null;
            state.lastReport = buildReport([]);
            renderSummary();
        }
        toast('Wyczyszczono wyniki.');
    }

    // ============================================================
    // startup / observers
    // ============================================================

    function installObservers() {
        const observeRoot = document.documentElement || document;
        if (!observeRoot || typeof MutationObserver === 'undefined') return;

        if (state.mutationObserver) {
            try { state.mutationObserver.disconnect(); } catch (_) {}
        }

        state.mutationObserver = new MutationObserver(() => {
            if (shouldShowFullUiInThisFrame()) {
                buildUi();
                positionUi();
            }
            scheduleScan('mutation', 180);
        });

        try {
            state.mutationObserver.observe(observeRoot, {
                childList: true,
                subtree: true,
                attributes: true
            });
        } catch (_) {}
    }

    function installEventHooks() {
        window.addEventListener('load', () => scheduleScan('load', 60), { once: true });
        document.addEventListener('DOMContentLoaded', () => scheduleScan('domcontentloaded', 60), { once: true });
        window.addEventListener('resize', () => {
            if (shouldShowFullUiInThisFrame()) positionUi();
            scheduleScan('resize', 90);
        }, { passive: true });
        window.addEventListener('scroll', () => {
            if (shouldShowFullUiInThisFrame()) positionUi();
        }, { passive: true });

        document.addEventListener('fullscreenchange', () => {
            if (shouldShowFullUiInThisFrame()) {
                buildUi();
                positionUi();
            }
            scheduleScan('fullscreenchange', 90);
        }, false);

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) scheduleScan('visibility', 60);
        }, false);
    }

    function init() {
        installCreateObjectUrlProbe();
        installFrameBridge();
        installEventHooks();
        installObservers();

        if (shouldShowFullUiInThisFrame()) {
            buildUi();
            keepUiAlive();
        }

        scheduleScan('startup', 140);
    }

    init();
})();
