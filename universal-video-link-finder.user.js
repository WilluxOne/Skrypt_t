// ==UserScript==
// @name         Universal Video Link Finder
// @namespace    tm-video-link-finder
// @version      1.1.0
// @description  Button near player; finds real .m3u8 even when video src is blob: and copies to clipboard. All sites/frames.
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-idle
// @allFrames    true
// ==/UserScript==

(() => {
  "use strict";

  const isM3U8 = (u) => typeof u === "string" && /\.m3u8(\?|#|$)/i.test(u);
  const isBlob = (u) => typeof u === "string" && u.startsWith("blob:");
  const absUrl = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];

  const copyToClipboard = async (text) => {
    try { if (typeof GM_setClipboard === "function") { GM_setClipboard(text, "text"); return true; } } catch {}
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    return false;
  };

  GM_addStyle?.(`
    .tm-m3u8-btn{position:fixed;z-index:2147483647;padding:8px 10px;font:12px system-ui;border-radius:10px;
      border:1px solid rgba(255,255,255,.25);background:rgba(20,20,20,.78);color:#fff;cursor:pointer;user-select:none;
      backdrop-filter:blur(6px);box-shadow:0 6px 18px rgba(0,0,0,.35);display:inline-flex;gap:8px;align-items:center;}
    .tm-m3u8-btn:hover{background:rgba(30,30,30,.88)}
    .tm-m3u8-pill{padding:2px 6px;border-radius:999px;background:rgba(255,255,255,.12);font-size:11px}
    .tm-m3u8-ok{border-color:rgba(46,204,113,.65)}
    .tm-m3u8-bad{border-color:rgba(231,76,60,.65)}
    .tm-m3u8-run{border-color:rgba(241,196,15,.75)}
  `);

  // --- pick player target ---
  const getBestVideo = () => {
    const vids = [...document.querySelectorAll("video")]
      .filter(v => v.clientWidth > 180 && v.clientHeight > 100);
    if (!vids.length) return null;
    vids.sort((a,b) => (b.clientWidth*b.clientHeight) - (a.clientWidth*a.clientHeight));
    return vids[0];
  };

  let btn, running = false;

  const ensureButton = () => {
    if (btn) return;
    btn = document.createElement("div");
    btn.className = "tm-m3u8-btn";
    btn.innerHTML = `<span>📼 M3U8</span><span class="tm-m3u8-pill">Szukaj</span>`;
    btn.addEventListener("click", onClick, true);
    document.documentElement.appendChild(btn);
  };

  const setBtn = (cls, label) => {
    if (!btn) return;
    btn.classList.remove("tm-m3u8-ok","tm-m3u8-bad","tm-m3u8-run");
    if (cls) btn.classList.add(cls);
    btn.querySelector(".tm-m3u8-pill").textContent = label;
  };

  const place = () => {
    const v = getBestVideo();
    if (!v) return;
    ensureButton();
    const r = v.getBoundingClientRect();
    const margin = 8;
    const x = Math.max(0, Math.min(window.innerWidth - 10, r.right - btn.offsetWidth));
    const y = Math.max(0, r.top - btn.offsetHeight - margin);
    btn.style.left = `${Math.round(x)}px`;
    btn.style.top  = `${Math.round(y)}px`;
  };

  const scanPerf = () => {
    try {
      return uniq(performance.getEntriesByType("resource").map(e => e.name)).filter(isM3U8);
    } catch { return []; }
  };

  const scanDom = () => {
    const urls = [];
    document.querySelectorAll("a[href]").forEach(a => urls.push(a.href));
    document.querySelectorAll("[src]").forEach(el => urls.push(absUrl(el.getAttribute("src"))));
    document.querySelectorAll("[href]").forEach(el => urls.push(absUrl(el.getAttribute("href"))));
    return uniq(urls).filter(isM3U8);
  };

  const installHooks = () => {
    const hits = new Set();
    let installed = false;
    const origFetch = window.fetch;
    const origOpen = XMLHttpRequest.prototype.open;

    const restore = () => {
      if (!installed) return;
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origOpen;
      installed = false;
    };

    try {
      window.fetch = async (...args) => {
        try {
          const u = args?.[0] instanceof Request ? args[0].url : String(args?.[0]);
          if (isM3U8(u)) hits.add(u);
        } catch {}
        return origFetch.apply(window, args);
      };

      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          const u = absUrl(String(url));
          if (isM3U8(u)) hits.add(u);
        } catch {}
        return origOpen.call(this, method, url, ...rest);
      };

      installed = true;
    } catch {}
    return { hits, restore };
  };

  const findRealM3U8 = async () => {
    // quick pass
    const d = scanDom(); if (d.length) return d[0];
    const p = scanPerf(); if (p.length) return p[0];

    // If video src is blob:, we *must* wait for network activity
    const v = getBestVideo();
    const src = v?.currentSrc || v?.src || "";
    const blobMode = isBlob(src);

    const { hits, restore } = installHooks();

    // wait longer in blob mode
    const totalMs = blobMode ? 20000 : 8000;
    const step = 500;
    const loops = Math.ceil(totalMs / step);

    for (let i = 0; i < loops; i++) {
      scanPerf().forEach(u => hits.add(u));
      if (hits.size) break;
      await sleep(step);
    }

    restore();
    return hits.size ? [...hits][0] : null;
  };

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (running) return;
    running = true;

    setBtn("tm-m3u8-run","Szukam…");

    try {
      const v = getBestVideo();
      const src = v?.currentSrc || v?.src || "";
      if (isBlob(src)) {
        // blob: indicates you likely need to press play
        setBtn("tm-m3u8-run","Włącz PLAY…");
      }

      const url = await findRealM3U8();
      if (!url) {
        setBtn("tm-m3u8-bad","Brak");
        await sleep(1200);
        setBtn(null,"Szukaj");
        running = false;
        return;
      }

      const ok = await copyToClipboard(url);
      console.log("[TM M3U8] Found:", url);

      setBtn(ok ? "tm-m3u8-ok" : "tm-m3u8-bad", ok ? "Skopiowano" : "Nie skopiowano");
      await sleep(1600);
      setBtn(null,"Szukaj");
    } catch (err) {
      console.warn("[TM M3U8] Error:", err);
      setBtn("tm-m3u8-bad","Błąd");
      await sleep(1400);
      setBtn(null,"Szukaj");
    } finally {
      running = false;
    }
  }

  // keep positioned
  place();
  window.addEventListener("resize", place, { passive: true });
  window.addEventListener("scroll", place, { passive: true });
  new MutationObserver(place).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();