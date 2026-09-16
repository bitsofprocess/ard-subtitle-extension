/*
 * Background service worker — handles gloss requests from content.js.
 *
 * API calls run here, not in the content script, because content-script
 * fetches are subject to the ARD page's CORS rules.
 *
 * Uses importScripts() to load the shared modules.  All modules are UMD
 * and attach to globalThis / self.
 */

// Load shared modules (UMD — they attach to self).
importScripts(
  '../storage/storage.js',
  '../services/api.js',
  '../services/prompt.js',
  '../services/tokenize.js',
  '../services/gloss.js'
);

// --- Config -------------------------------------------------------------

SubtitleServices.config = SubtitleServices.config || {};
// Lower-consequence call — only affects one word, not the whole import.
SubtitleServices.config.GLOSS_MODEL = SubtitleServices.config.GLOSS_MODEL || 'openai/gpt-4o-mini';

// --- In-flight deduplication -------------------------------------------

// Map of "cueIndex:tokenIndex" → Promise
var inFlight = {};

// --- Message handler ----------------------------------------------------

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'GET_GLOSS') {
    handleGetGloss(message).then(sendResponse).catch(function (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true; // async sendResponse
  }

  // Unknown message type — not handled.
  return false;
});

/**
 * Handle a GET_GLOSS request.
 */
async function handleGetGloss(msg) {
  var videoUrl = msg.videoUrl;
  var cueIndex = msg.cueIndex;
  var tokenIndex = msg.tokenIndex;

  if (videoUrl == null || cueIndex == null || tokenIndex == null) {
    return { ok: false, error: 'Missing required fields: videoUrl, cueIndex, tokenIndex' };
  }

  // 1. Check cache.
  var cached = await SubtitleStorage.getGloss(videoUrl, cueIndex, tokenIndex);
  if (cached) {
    return { ok: true, gloss: cached, cached: true };
  }

  // 2. Dedupe in-flight requests.
  var dedupeKey = cueIndex + ':' + tokenIndex;
  if (inFlight[dedupeKey]) {
    try {
      var result = await inFlight[dedupeKey];
      return result;
    } catch (e) {
      // If the shared promise rejected, fall through to try again.
    }
  }

  // 3. Fetch from LLM.
  var promise = fetchGloss(videoUrl, cueIndex, tokenIndex);
  inFlight[dedupeKey] = promise;

  try {
    var result = await promise;
    return result;
  } finally {
    delete inFlight[dedupeKey];
  }
}

/**
 * Call the LLM for a single gloss, parse it, cache it.
 */
async function fetchGloss(videoUrl, cueIndex, tokenIndex) {
  // Load cues.
  var cues = await SubtitleStorage.getCues(videoUrl);
  if (!cues || cues.length === 0) {
    return { ok: false, error: 'No cues found for this video URL' };
  }

  var cue = cues[cueIndex];
  if (!cue) {
    return { ok: false, error: 'Invalid cueIndex: ' + cueIndex };
  }

  // Check API key.
  var apiKey = await SubtitleStorage.getApiKey();
  if (!apiKey) {
    return { ok: false, error: 'NO_API_KEY' };
  }

  var tokenCount = SubtitleServices.tokenize(cue.text).length;

  // Build messages.
  var messages = SubtitleServices.buildGlossMessages({
    cues: cues,
    cueIndex: cueIndex,
    tokenIndex: tokenIndex
  });

  // Call LLM with retry.
  var S = SubtitleServices;
  var lastErr;

  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      var raw = await callLLM(messages, apiKey, {
        model: S.config.GLOSS_MODEL,
        temperature: 0,
        max_tokens: 120
      });

      var parsed = S.parseGlossResponse(raw, tokenCount, tokenIndex);

      // Cache it.
      var entries = {};
      var key = cueIndex + ':' + tokenIndex;
      entries[key] = {
        lemma: parsed.lemma,
        gloss: parsed.gloss,
        related: parsed.related,
        note: parsed.note,
        model: S.config.GLOSS_MODEL,
        v: 1
      };
      await SubtitleStorage.saveGlosses(videoUrl, entries);

      return { ok: true, gloss: entries[key], cached: false };
    } catch (err) {
      lastErr = err;
      console.warn('[background] gloss fetch attempt ' + attempt + '/3 failed: ' + err.message);
      if (attempt < 3) {
        // Small delay before retry.
        await new Promise(function (r) { setTimeout(r, 500 * attempt); });
      }
    }
  }

  return { ok: false, error: lastErr ? lastErr.message : 'Unknown error' };
}

/**
 * Call the LLM with custom config overrides.
 *
 * Reuses the existing callDeepSeek's fetch logic but allows overriding
 * model, temperature, and max_tokens per-call (the gloss config differs
 * from the sentence-translation config).
 */
async function callLLM(messages, apiKey, opts) {
  // Temporarily override config for this call.
  var S = SubtitleServices;
  var origModel = S.config.MODEL;
  var origTemp = S.config.TEMPERATURE;
  var origMaxTokens = S.config.MAX_TOKENS;

  S.config.MODEL = opts.model || S.config.GLOSS_MODEL || 'openai/gpt-4o-mini';
  // We inject temperature and max_tokens into the fetch call directly below.

  var response;
  try {
    response = await S.withRetry(function () {
      var body = {
        model: opts.model || S.config.GLOSS_MODEL,
        messages: messages,
        temperature: opts.temperature !== undefined ? opts.temperature : 0,
        max_tokens: opts.max_tokens || 120
      };

      return fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    });
  } finally {
    // Restore original config.
    if (origModel !== undefined) S.config.MODEL = origModel;
  }

  if (!response.ok) {
    var errorBody = '';
    try { errorBody = await response.text(); } catch (e) { /* ignore */ }
    var err = new Error('OpenRouter API error ' + response.status + ': ' + errorBody);
    err.status = response.status;
    throw err;
  }

  var data = await response.json();

  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('Unexpected OpenRouter response structure');
  }

  return data.choices[0].message.content;
}