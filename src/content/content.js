/*
 * Content script: subtitle overlay for video pages.
 *
 *  1. Finds the <video> element and a suitable container inside the player.
 *  2. Loads stored (parsed + translated) cues from chrome.storage.local.
 *  3. Syncs the active cue to video.currentTime (+ user offset).
 *  4. Renders the cue as clickable word spans.
 *  5. Clicking a word shows the lemma + contextual gloss in a popup.
 *  6. Full-sentence translation revealed on hover.
 *  7. Fullscreen support — overlay moves into the fullscreen element.
 */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────
  var video = null;
  var cues = null;
  var activeCueIdx = -1;
  var syncRaf = null;
  var showGerman = true;   // display original German text
  var showEnglish = true;  // display English translation
  var hoverEnglish = false; // reveal English on hover instead of always

  // ── Display preferences ──────────────────────────────────────────────

  /**
   * Load display preferences from storage. Called on boot and
   * whenever chrome.storage changes.
   */
  async function loadDisplayPreferences() {
    try {
      showGerman = await SubtitleStorage.getDisplayGerman();
      showEnglish = await SubtitleStorage.getDisplayEnglish();
      hoverEnglish = await SubtitleStorage.getHoverEnglish();
      applyDisplayAttrs();
    } catch (e) { /* ignore */ }
  }

  /**
   * Set data attributes on the overlay so CSS rules respond.
   */
  function applyDisplayAttrs() {
    var overlay = document.getElementById('__subtitle_translator_overlay__');
    if (overlay) {
      overlay.dataset.showGerman = showGerman ? 'true' : 'false';
      overlay.dataset.showEnglish = showEnglish ? 'true' : 'false';
      overlay.dataset.hoverEnglish = hoverEnglish ? 'true' : 'false';
    }
  }

  // ── Overlay positioning ─────────────────────────────────────────────

  function repositionOverlay() {
    var overlay = document.getElementById('__subtitle_translator_overlay__');
    if (!overlay || !video) return;
    if (!document.body.contains(overlay)) return;

    // Position against the <video> element's rect so the overlay
    // exactly covers the video viewport, not a larger player wrapper.
    var r = video.getBoundingClientRect();
    overlay.style.position = 'fixed';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    overlay.style.zIndex = '2147483647';

    // Dynamically scale font with video width: 2.5% of video width,
    // clamped between 12px and 60px.
    var cueEl = document.getElementById('__st_cue__');
    if (cueEl) {
      cueEl.style.fontSize = Math.min(Math.max(r.width * 0.025, 12), 60) + 'px';
    }
  }

  // ── Selectors (tried in order for video & container) ────────────────

  var VIDEO_SELECTORS = [
    'video',                                     // plain <video>
    '[data-ctrl-enter] video',                   // ARD player
    '.vjs-tech',                                 // Video.js players
    '.hls-player video',                         // common HLS wrappers
    '.plyr video',                               // Plyr player
    '.media-player video',                       // generic
  ];



  function createOverlay() {
    var ol = document.createElement('div');
    ol.id = '__subtitle_translator_overlay__';
    // Default display attributes so CSS rules match even before
    // loadDisplayPreferences() runs.
    ol.setAttribute('data-show-german', 'true');
    ol.setAttribute('data-show-english', 'true');
    ol.setAttribute('data-hover-english', 'false');
    ol.innerHTML =
      '<style>' +
      '  #__subtitle_translator_overlay__ {' +
      '    display: flex;' +
      '    flex-direction: column;' +
      '    align-items: center;' +
      '    justify-content: flex-end;' +
      '    padding-bottom: 8%;' +
      '    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;' +
      '    pointer-events: none;' +
      '    user-select: none;' +
      '  }' +
      '  #__st_cue__ {' +
      '    display: none;' +
      '    flex-direction: column;' +
      '    background: rgba(0,0,0,0.7);' +
      '    border-radius: 6px;' +
      '    padding: 8px 16px;' +
      '    max-width: none;' +
      '    line-height: 1.7;' +
      '    text-shadow: 1px 1px 3px rgba(0,0,0,0.8);' +
      '    pointer-events: auto;' +
      '  }' +
      '  /* Both on: always show English (default) */ ' +
      '  #__subtitle_translator_overlay__[data-show-german="true"][data-show-english="true"] .__st_translation__ { display: block; }' +
      '  /* Hover mode (English enabled): hide German, reveal on hover */ ' +
      '  #__subtitle_translator_overlay__[data-hover-english="true"][data-show-english="true"] .__st_german__ { display: none; }' +
      '  #__subtitle_translator_overlay__.hover-show-german .__st_german__ { display: block !important; }' +
      '  /* German only: hide English completely */ ' +
      '  #__subtitle_translator_overlay__[data-show-english="false"] .__st_translation__ { display: none !important; }' +
      '  /* English only: always show English, hide German (unless hovering) */ ' +
      '  #__subtitle_translator_overlay__[data-show-german="false"]:not([data-show-english="false"]) .__st_translation__ { display: block !important; }' +
      '  #__subtitle_translator_overlay__[data-show-german="false"]:not([data-show-english="false"]):not([data-hover-english="true"]) .__st_german__ { display: none !important; }' +
      '  /* Both off: hide everything */ ' +
      '  #__subtitle_translator_overlay__[data-show-german="false"][data-show-english="false"] .__st_german__,' +
      '  #__subtitle_translator_overlay__[data-show-german="false"][data-show-english="false"] .__st_translation__ { display: none !important; }' +
      '  .__st_word__ {' +
      '    color: #fff;' +
      '    cursor: pointer;' +
      '    transition: color 0.15s, background 0.15s;' +
      '    border-radius: 3px;' +
      '    pointer-events: auto;' +
      '  }' +
      '  .__st_word__:hover { color: #e94560; background: rgba(255,255,255,0.25); }' +
      '  .__st_translation__ {' +
      '    order: 1;' +
      '    display: none;' +
      '    color: #ffd166;' +
      '    font-style: italic;' +
      '    margin-bottom: 4px;' +
      '    padding-bottom: 4px;' +
      '    border-bottom: 1px solid rgba(255,255,255,0.15);' +
      '  }' +
      '  .__st_german__ { order: 2; }' +
      '  /* Hover reveal: swap order so revealed text (German) sits on top */ ' +
      '  .hover-show-german .__st_translation__ { order: 2; }' +
      '  .hover-show-german .__st_german__ { order: 1; }' +
      '  #__st_gloss__ {' +
      '    display: none;' +
      '    position: absolute;' +
      '    background: #1a1a2e;' +
      '    border: 1px solid #e94560;' +
      '    border-radius: 6px;' +
      '    padding: 10px 14px;' +
      '    max-width: 90vw;' +
      '    text-align: left;' +
      '    font-size: 36px;' +
      '    line-height: 1.5;' +
      '    z-index: 9999;' +
      '    box-shadow: 0 4px 16px rgba(0,0,0,0.6);' +
      '    pointer-events: auto;' +
      '  }' +
      '  #__st_gloss__ .__st_gloss_w { color: #e94560; font-weight: 700; margin-bottom: 4px; }' +
      '  #__st_gloss__ .__st_gloss_lemma { color: #ffffff; font-weight: 700; font-size: 1.05em; }' +
      '  #__st_gloss__ .__st_gloss_gloss { color: #e0e0e0; margin-top: 4px; }' +
      '  #__st_gloss__ .__st_gloss_note { color: #888; font-size: 0.8em; margin-top: 4px; font-style: italic; }' +
      '  #__st_gloss__ .__st_gloss_loading { color: #888; }' +
      '  #__st_gloss__ .__st_gloss_error { color: #e94560; }' +
      '  #__st_gloss__ .__st_gloss_retry { color: #e94560; cursor: pointer; text-decoration: underline; }' +
      '  .__st_word_related__ { background: rgba(233,69,96,0.35); border-radius: 3px; }' +
      '</style>' +
      '<div id="__st_cue__"></div>' +
      '<div id="__st_gloss__"></div>';

    return ol;
  }

  // ── Cue lookup ───────────────────────────────────────────────────────

  // Binary-search for the cue whose [start, end) contains `timeSeconds`.
  function findActiveCue(timeSec) {
    if (!cues || cues.length === 0) return -1;
    var lo = 0;
    var hi = cues.length - 1;

    // binary search for the last cue with start <= timeSec
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (cues[mid].start <= timeSec) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    // Check if timeSec falls within [start, end) of the found cue.
    if (lo >= 0 && lo < cues.length &&
        timeSec >= cues[lo].start && timeSec < cues[lo].end) {
      return lo;
    }
    return -1;
  }

  // ── Rendering ────────────────────────────────────────────────────────

  function renderCue(cueIdx) {
    var cueEl = document.getElementById('__st_cue__');

    // Always hide the gloss when the cue changes (or disappears).
    hideGloss();

    if (cueIdx < 0 || !cues || cueIdx >= cues.length) {
      cueEl.innerHTML = '';
      cueEl.style.display = 'none';
      return;
    }

    cueEl.style.display = 'inline-flex';
    cueEl.innerHTML = '';

    var cue = cues[cueIdx];

    // Full-sentence translation (revealed on hover via CSS).
    // Split on newlines or the " / " line-break marker (artifact of
    // \n → " / " sanitisation before sending to the LLM).
    if (cue.translation) {
      var tDiv = document.createElement('div');
      tDiv.className = '__st_translation__';
      var parts = cue.translation.split(/\n| \/ /);
      for (var p = 0; p < parts.length; p++) {
        if (p > 0) tDiv.appendChild(document.createElement('br'));
        tDiv.appendChild(document.createTextNode(parts[p]));
      }
      cueEl.appendChild(tDiv);
    }

    // Use the shared tokenizer so word indices match the gloss cache.
    var tokens = SubtitleServices.tokenize(cue.text);
    var currentLine = 0;

    // Wrap all German content (spans, spaces, <br>s) in a container so
    // hiding German hides EVERYTHING — not just the spans.
    var germanDiv = document.createElement('div');
    germanDiv.className = '__st_german__';

    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];

      // Insert <br> between lines.
      while (tok.line > currentLine) {
        germanDiv.appendChild(document.createElement('br'));
        currentLine++;
      }

      // Insert whitespace between consecutive tokens on the same line.
      if (ti > 0 && tokens[ti - 1].line === tok.line) {
        germanDiv.appendChild(document.createTextNode(' '));
      }

      var span = document.createElement('span');
      span.className = '__st_word__';
      span.textContent = tok.raw;
      span.dataset.cueIndex = cueIdx;
      span.dataset.tokenIndex = tok.i;

      if (tok.clickable) {
        span.addEventListener('click', (function (cIdx, tIdx, event) {
          onWordClick(event, cIdx, tIdx);
        }).bind(null, cueIdx, tok.i));
      } else {
        // Non-clickable tokens get a muted style but no click handler.
        span.style.cursor = 'default';
        span.style.color = '#999';
      }

      germanDiv.appendChild(span);
    }

    cueEl.appendChild(germanDiv);
  }

  // ── Gloss popup ──────────────────────────────────────────────────────

  var glossRequestId = 0;      // incremented per click — ignore stale responses
  var currentGlossToken = null; // { cueIdx, tokenIdx } of visible gloss

  function onWordClick(event, cueIdx, tokenIdx) {
    event.stopPropagation();

    var cue = cues[cueIdx];
    if (!cue) return;

    var glossEl = document.getElementById('__st_gloss__');

    // If the gloss is already visible for this same word, toggle it off.
    if (glossEl.style.display === 'block' &&
        currentGlossToken &&
        currentGlossToken.cueIdx === cueIdx &&
        currentGlossToken.tokenIdx === tokenIdx) {
      hideGloss();
      return;
    }

    // Pause so the viewer can read the gloss.
    if (video && !video.paused) {
      video.pause();
    }

    // Clear any previous related highlights & stale request.
    hideRelatedHighlights();
    glossRequestId++;
    var reqId = glossRequestId;
    currentGlossToken = { cueIdx: cueIdx, tokenIdx: tokenIdx };

    // Get the word text from the tokenizer.
    var tokens = SubtitleServices.tokenize(cue.text);
    var wordRaw = (tokens[tokenIdx] ? tokens[tokenIdx].raw : event.target.textContent);

    // Show popup immediately with loading state.
    showGlossPopup(event, wordRaw, cue, null);

    // Try cache first (instant), then background worker.
    requestGloss(cueIdx, tokenIdx, reqId, event);
  }

  /**
   * Check chrome.storage.local for a cached gloss, then fall back
   * to the background service worker for a live LLM call.
   */
  async function requestGloss(cueIdx, tokenIdx, reqId, event) {
    var normalized = normalizeUrl(location.href);

    // 1. Check local cache (instant, no message round-trip).
    try {
      var cached = await SubtitleStorage.getGloss(normalized, cueIdx, tokenIdx);
      if (cached && reqId === glossRequestId) {
        applyGlossResult(cached, true, event);
        return;
      }
    } catch (e) { /* ignore cache errors, fall through */ }

    // 2. Request from background service worker.
    try {
      var response = await chrome.runtime.sendMessage({
        type: 'GET_GLOSS',
        videoUrl: normalized,
        cueIndex: cueIdx,
        tokenIndex: tokenIdx
      });
      // Ignore stale responses.
      if (reqId !== glossRequestId) return;

      if (response && response.ok) {
        applyGlossResult(response.gloss, response.cached, event);
      } else {
        showGlossError(event, cueIdx, tokenIdx, response ? response.error : 'Unknown error');
      }
    } catch (err) {
      if (reqId !== glossRequestId) return;
      showGlossError(event, cueIdx, tokenIdx, err.message || String(err));
    }
  }

  /**
   * Apply a successful gloss result to the popup.
   */
  function applyGlossResult(gloss, wasCached, event) {
    var cue = currentGlossToken ? cues[currentGlossToken.cueIdx] : null;
    if (!cue) return;

    var tokens = SubtitleServices.tokenize(cue.text);
    var tokenIdx = currentGlossToken.tokenIdx;
    var wordRaw = (tokens[tokenIdx] ? tokens[tokenIdx].raw : '');

    showGlossPopup(event, wordRaw, cue, gloss);

    // Highlight related words.
    if (gloss.related && gloss.related.length > 0) {
      highlightRelated(currentGlossToken.cueIdx, gloss.related);
    }
  }

  /**
   * Show the gloss popup with content.
   * If glossData is null, shows a loading state.
   */
  function showGlossPopup(event, wordRaw, cue, glossData) {
    var glossEl = document.getElementById('__st_gloss__');

    var html = '<div class="__st_gloss_w">' + escapeHTML(wordRaw) + '</div>';

    if (glossData) {
      // Filled-in gloss from cache or LLM.
      html += '<div class="__st_gloss_lemma">' + escapeHTML(glossData.lemma) + '</div>';
      html += '<div class="__st_gloss_gloss">' + escapeHTML(glossData.gloss) + '</div>';
      if (glossData.note) {
        html += '<div class="__st_gloss_note">' + escapeHTML(glossData.note) + '</div>';
      }
    } else {
      // Loading state.
      html += '<div class="__st_gloss_lemma"><span class="__st_gloss_loading">…</span></div>';
    }

    glossEl.innerHTML = html;
    positionGloss(event, glossEl);
  }

  /**
   * Show an error state in the popup with a Retry link.
   */
  function showGlossError(event, cueIdx, tokenIdx, errorMsg) {
    var glossEl = document.getElementById('__st_gloss__');
    var cue = cues[cueIdx];

    var html = '<div class="__st_gloss_error">';

    if (errorMsg === 'NO_API_KEY') {
      html += 'No API key set. <a class="__st_gloss_retry" href="' +
        chrome.runtime.getURL('src/options/options.html') + '" target="_blank">Open Settings</a>';
    } else {
      html += escapeHTML(errorMsg.substring(0, 120));
      html += ' <span class="__st_gloss_retry" id="__st_gloss_retry_btn__">Retry</span>';
    }

    html += '</div>';

    glossEl.innerHTML = html;
    positionGloss(event, glossEl);

    // Wire retry button.
    var retryBtn = document.getElementById('__st_gloss_retry_btn__');
    if (retryBtn) {
      retryBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        glossRequestId++;
        var reqId = glossRequestId;
        // Show loading again.
        var tokens = SubtitleServices.tokenize(cue.text);
        var wordRaw = (tokens[tokenIdx] ? tokens[tokenIdx].raw : '');
        showGlossPopup(event, wordRaw, cue, null);
        requestGloss(cueIdx, tokenIdx, reqId, event);
      });
    }
  }

  /**
   * Add highlight class to related word spans.
   */
  function highlightRelated(cueIdx, tokenIndices) {
    var cueEl = document.getElementById('__st_cue__');
    if (!cueEl) return;
    var spans = cueEl.querySelectorAll('.__st_word__');
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      if (parseInt(span.dataset.cueIndex) === cueIdx &&
          tokenIndices.indexOf(parseInt(span.dataset.tokenIndex)) !== -1) {
        span.classList.add('__st_word_related__');
      }
    }
  }

  /**
   * Remove related highlights from all word spans.
   */
  function hideRelatedHighlights() {
    var spans = document.querySelectorAll('.__st_word_related__');
    for (var i = 0; i < spans.length; i++) {
      spans[i].classList.remove('__st_word_related__');
    }
  }

  function positionGloss(event, glossEl) {
    var overlay = document.getElementById('__subtitle_translator_overlay__');
    var overlayRect = overlay.getBoundingClientRect();
    var spanRect = event.target.getBoundingClientRect();

    var left = spanRect.left - overlayRect.left + spanRect.width / 2;
    var top = spanRect.top - overlayRect.top - 8;

    glossEl.style.display = 'block';
    glossEl.style.left = '0px';
    glossEl.style.top = '-9999px';

    var glossRect = glossEl.getBoundingClientRect();
    var pw = overlayRect.width;

    var desiredLeft = left - glossRect.width / 2;
    if (desiredLeft < 4) desiredLeft = 4;
    if (desiredLeft + glossRect.width > pw - 4) desiredLeft = pw - glossRect.width - 4;

    var desiredTop = top - glossRect.height;
    if (desiredTop < 4) {
      desiredTop = spanRect.bottom - overlayRect.top + 8;
    }

    glossEl.style.left = desiredLeft + 'px';
    glossEl.style.top = desiredTop + 'px';
  }

  function hideGloss() {
    var glossEl = document.getElementById('__st_gloss__');
    if (glossEl) glossEl.style.display = 'none';
    hideRelatedHighlights();
    currentGlossToken = null;
  }

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Sync loop ────────────────────────────────────────────────────────

  var lastRenderedIdx = -1;

  function sync() {
    if (!video || !cues) {
      syncRaf = requestAnimationFrame(sync);
      return;
    }

    // Reposition every frame — the video may have shifted due to layout
    // changes, ads loading, or may not have been laid out yet at boot.
    repositionOverlay();

    var t = video.currentTime;
    var idx = findActiveCue(t);

    if (idx !== lastRenderedIdx) {
      lastRenderedIdx = idx;
      renderCue(idx);
    }

    syncRaf = requestAnimationFrame(sync);
  }

  // ── Fullscreen ──────────────────────────────────────────────────────

  function onFullscreenChange() {
    var fsEl = document.fullscreenElement;
    var overlay = document.getElementById('__subtitle_translator_overlay__');
    if (!overlay) return;

    if (fsEl) {
      // Move overlay INTO the fullscreen element so it renders on top.
      try {
        fsEl.appendChild(overlay);
        overlay.style.position = 'absolute';
        overlay.style.left = '0px';
        overlay.style.top = '0px';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
      } catch (e) { /* ignore */ }
    } else {
      // Back to body + fixed positioning over the video.
      try { document.body.appendChild(overlay); } catch (e) { /* ignore */ }
      repositionOverlay();
    }
  }

  // ── Boot / teardown ──────────────────────────────────────────────────

  /**
   * Handle CUES_READY message from the background service worker
   * (sent after the streamlined import translation pipeline finishes).
   */
  async function handleCuesReady() {
    // Already showing overlay — nothing to do.
    if (document.getElementById('__subtitle_translator_overlay__')) return true;

    var hasCues = await loadCues();
    if (!hasCues) return false;

    // Clear any stale state and boot fresh.
    cues = null;
    await tryBoot();
    return true;
  }

  // Listen for messages from the background service worker.
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'CUES_READY') {
      handleCuesReady().then(function (ok) {
        sendResponse({ ok: ok });
      }).catch(function (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      });
      return true; // async sendResponse
    }
    return false;
  });

  /**
   * Look up stored cues for `url`.  Normalises the URL to ignore query
   * params (ARD passes ?startTime=0 etc.).
   */
  /**
   * Return just the pathname of a URL (for comparing same-video across
   * different tracking params).
   */
  function urlKey(url) {
    try {
      var u = new URL(url);
      // Compare by origin + pathname — episode IDs live in the path,
      // so different episodes never match. Only query-param variants
      // of the same video will share the same origin + pathname.
      return u.origin + u.pathname;
    } catch (e) {
      return url;
    }
  }

  function normalizeUrl(url) {
    try {
      var u = new URL(url);
      // Strip common noisy params.
      u.searchParams.delete('startTime');
      u.searchParams.delete('t');
      u.searchParams.delete('autoplay');
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  async function loadCues() {
    var normalized = normalizeUrl(location.href);
    cues = await SubtitleStorage.getCues(normalized);

    // If no exact match, try stored keys for the same video that differ
    // only in query params (ARD adds tracking params dynamically).
    if (!cues || cues.length === 0) {
      var pageKey = urlKey(location.href);
      var allUrls = await SubtitleStorage.listVideoUrls();
      for (var i = 0; i < allUrls.length; i++) {
        if (urlKey(allUrls[i]) === pageKey) {
          cues = await SubtitleStorage.getCues(allUrls[i]);
          if (cues && cues.length > 0) break;
        }
      }
    }

    if (cues && cues.length > 0) {
      console.log('[subtitle-translator] loaded ' + cues.length + ' cues');
      return true;
    }
    return false;
  }

  function togglePause() {
    if (!video) return;
    if (video.paused) {
      video.play().catch(function () { /* ignore */ });
    } else {
      video.pause();
    }
  }

  function wireGlossDismiss() {
    // Click the cue text area (not a word) → dismiss gloss + toggle pause.
    // Word clicks call stopPropagation(), so they never reach this handler.
    document.getElementById('__st_cue__').addEventListener('click', function () {
      hideGloss();
      togglePause();
    });

    // Click anywhere in the overlay (but not on a word) → dismiss gloss.
    document.getElementById('__subtitle_translator_overlay__').addEventListener('click', function (e) {
      if (e.target.id === '__subtitle_translator_overlay__' ||
          e.target.id === '__st_cue__') {
        hideGloss();
      }
    });

    // Global click (outside overlay) → dismiss gloss.
    document.addEventListener('click', function (e) {
      var overlay = document.getElementById('__subtitle_translator_overlay__');
      if (overlay && !overlay.contains(e.target)) {
        hideGloss();
      }
    });
  }

  function wireHoverReveal() {
    var cueEl = document.getElementById('__st_cue__');
    var overlay = document.getElementById('__subtitle_translator_overlay__');
    if (!cueEl || !overlay) return;

    cueEl.addEventListener('mouseenter', function () {
      if (hoverEnglish) {
        overlay.classList.add('hover-show-german');
      }
    });

    cueEl.addEventListener('mouseleave', function () {
      overlay.classList.remove('hover-show-german');
    });
  }

  async function tryBoot() {
    // Already set up.
    if (document.getElementById('__subtitle_translator_overlay__')) return;

    // 1. Find video.
    for (var i = 0; i < VIDEO_SELECTORS.length; i++) {
      video = document.querySelector(VIDEO_SELECTORS[i]);
      if (video) break;
    }
    if (!video) return; // no video on page yet

    // 2. Check for stored cues.
    var hasCues = await loadCues();
    if (!hasCues) return;

    // 3. Inject overlay onto document.body (fixed over the video) to
    //    avoid overflow:hidden clipping inside the player.
    var overlay = createOverlay();
    document.body.appendChild(overlay);

    // Load display preferences and apply data attributes.
    await loadDisplayPreferences();

    repositionOverlay();

    // Keep position in sync on resize & scroll.
    window.addEventListener('resize', repositionOverlay);
    window.addEventListener('scroll', repositionOverlay);
    // Fullscreen: move overlay into the fullscreen element.
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // 4. Wire gloss dismissal.
    wireGlossDismiss();

    // 4b. Wire hover reveal for English.
    wireHoverReveal();

    // 5. Listen for display preference changes.
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.display_german || changes.display_english || changes.hover_english) {
        loadDisplayPreferences();
      }
    });

    // 6. Start sync loop.
    sync();
  }

  // ── Entry point ──────────────────────────────────────────────────────

  // Wait for the page to settle, then try to boot.
  function scheduleBoot(delay) {
    if (delay === undefined) delay = 600;
    // Debounce — video players sometimes replace <video> elements during init.
    if (scheduleBoot._timer) clearTimeout(scheduleBoot._timer);

    // Enforce a maximum delay so continuous DOM mutations don't prevent
    // boot forever (e.g. pages with ads, analytics, animation).
    if (!scheduleBoot._firstCall) scheduleBoot._firstCall = Date.now();
    var elapsed = Date.now() - scheduleBoot._firstCall;
    var maxDelay = 2000;
    if (elapsed + delay > maxDelay) delay = Math.max(0, maxDelay - elapsed);

    scheduleBoot._timer = setTimeout(function () {
      scheduleBoot._firstCall = null;
      tryBoot();
    }, delay);
  }

  // Try on load.
  if (document.readyState === 'complete') {
    scheduleBoot();
  } else {
    window.addEventListener('load', scheduleBoot);
  }

  // Watch for DOM mutations that might indicate a video player was injected
  // after page load (common on SPAs and some players).
  // Use a short delay here — we already know something changed.
  var domObserver = new MutationObserver(function () {
    if (!video || !document.body.contains(video)) {
      // Video disappeared (navigation) — reset.
      video = null;
      activeCueIdx = -1;
      cues = null;
      var old = document.getElementById('__subtitle_translator_overlay__');
      if (old) old.remove();
      scheduleBoot(200);
    }
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  // Watch for URL changes (SPA navigation).
  var lastUrl = location.href;
  var urlCheckInterval = setInterval(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      video = null;
      activeCueIdx = -1;
      cues = null;
      var old = document.getElementById('__subtitle_translator_overlay__');
      if (old) old.remove();
      scheduleBoot();
    }
  }, 1500);

})();