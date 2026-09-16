/*
 * Translation orchestrator (browser runtime).
 *
 * Splits cues into batches, translates each via the LLM, validates every
 * response, and returns the fully annotated cue array.
 *
 * Requires prompt.js, validate.js, and api.js to be loaded first (they all
 * attach to window.SubtitleServices).
 *
 * Uses the shared config key `SubtitleServices.config` which defaults are:
 *   BATCH_SIZE: 30   — cues per LLM call
 *   CONTEXT_CUES: 3  — neighbouring previous cues sent as context
 *   CONCURRENCY: 2   — parallel batch calls
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : this;
  var S = g.SubtitleServices || {};

  // --- Config ------------------------------------------------------------

  S.config = S.config || {};
  S.config.BATCH_SIZE = S.config.BATCH_SIZE || 20;
  S.config.CONTEXT_CUES = S.config.CONTEXT_CUES || 3;
  S.config.CONCURRENCY = S.config.CONCURRENCY || 3;
  S.config.MODEL = S.config.MODEL || 'openai/gpt-4o-mini';

  // --- Public API --------------------------------------------------------

  /**
   * Translate all cues and return the annotated result.
   *
   * @param {Object[]} cues     — array of { start, end, text } from the parser
   * @param {string}   apiKey   — OpenRouter API key
   * @param {Function} onProgress — called with (done, total) on each batch completion
   * @returns {Promise<Object[]>} — cues with .translation and .tokens added
   */
  async function translateAll(cues, apiKey, onProgress) {
    if (!cues || cues.length === 0) {
      return [];
    }

    var batchSize = S.config.BATCH_SIZE;
    var contextCount = S.config.CONTEXT_CUES;
    var concurrency = S.config.CONCURRENCY;

    // Build batches.
    var batches = [];
    for (var i = 0; i < cues.length; i += batchSize) {
      var batchCues = cues.slice(i, i + batchSize);
      var contextCues = i > 0 ? cues.slice(Math.max(0, i - contextCount), i) : null;

      batches.push({
        idx: batches.length,
        cues: batchCues,
        contextCues: contextCues,
        texts: batchCues.map(function (c) { return c.text.replace(/\n/g, ' / '); }),
        contextTexts: contextCues
          ? contextCues.map(function (c) { return c.text.replace(/\n/g, ' / '); })
          : null
      });
    }

    console.log(
      '[translate] ' + cues.length + ' cues → ' + batches.length +
      ' batches (concurrency=' + concurrency + ')'
    );

    var t0 = Date.now();

    // Run batches with limited concurrency.
    var results = await runBatches(batches, concurrency, apiKey, onProgress);

    // Apply results back to cues.
    var batchOffset = 0;
    for (var b = 0; b < results.length; b++) {
      if (!results[b].ok) {
        throw new Error(
          'Batch ' + b + ' failed: ' + (results[b].error || 'unknown error')
        );
      }
      var entries = results[b].value;
      for (var j = 0; j < entries.length; j++) {
        cues[batchOffset + j].translation = entries[j];
      }
      batchOffset += entries.length;
    }

    var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('[translate] done in ' + elapsed + 's');

    return cues;
  }

  /**
   * Translate a single batch (one API call).
   */
  async function translateOneBatch(batch, apiKey) {
    var messages = S.buildMessages(batch.texts, batch.contextTexts);

    // Try up to 3 times, with recursive split on persistent failure.
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        var raw = await S.callDeepSeek(messages, apiKey);
        var parsed = S.parseTranslationResponse(raw, batch.texts);

        console.log(
          '[translate] batch ' + batch.idx +
          ' attempt=' + attempt + ' OK (' + batch.texts.length + ' cues)'
        );
        return parsed;
      } catch (err) {
        console.warn(
          '[translate] batch ' + batch.idx +
          ' attempt=' + attempt + '/3 failed: ' + err.message
        );
        if (attempt === 3) {
          break;
        }
      }
    }

    // Split and retry recursively.
    return splitAndTranslate(batch, apiKey);
  }

  /**
   * Split a failing batch in half and translate each half separately.
   */
  async function splitAndTranslate(batch, apiKey) {
    var mid = Math.ceil(batch.cues.length / 2);
    if (mid >= batch.cues.length) {
      // Single cue that failed after all retries — skip it instead of crashing.
      console.warn(
        '[translate] batch ' + batch.idx +
        ' skipping cue after all attempts: "' +
        batch.texts[0].substring(0, 80) + '…"'
      );
      // Return a placeholder so the cue array stays aligned.
      return [batch.texts[0]];
    }

    console.warn(
      '[translate] batch ' + batch.idx +
      ' splitting ' + batch.cues.length + ' → ' + mid + '+' +
      (batch.cues.length - mid)
    );

    var leftBatch = {
      idx: batch.idx,
      cues: batch.cues.slice(0, mid),
      contextCues: batch.contextCues,
      texts: batch.texts.slice(0, mid),
      contextTexts: batch.contextTexts
    };

    var rightContextCues = batch.contextCues
      ? batch.contextCues.concat(batch.cues.slice(0, mid)).slice(-S.config.CONTEXT_CUES)
      : batch.cues.slice(Math.max(0, mid - S.config.CONTEXT_CUES), mid);

    var rightBatch = {
      idx: batch.idx,
      cues: batch.cues.slice(mid),
      contextCues: rightContextCues,
      texts: batch.texts.slice(mid),
      contextTexts: rightContextCues.map(function (c) { return c.text.replace(/\n/g, ' / '); })
    };

    var left = await translateOneBatch(leftBatch, apiKey);
    var right = await translateOneBatch(rightBatch, apiKey);

    return left.concat(right);
  }

  // --- Concurrency helper ------------------------------------------------

  /**
   * Run batches with limited concurrency (simplified port of transcript-player's runPool).
   */
  async function runBatches(batches, limit, apiKey, onProgress) {
    var results = new Array(batches.length);
    var nextIndex = Math.min(limit, batches.length);
    var done = 0;

    async function run(idx) {
      try {
        var value = await translateOneBatch(batches[idx], apiKey);
        results[idx] = { ok: true, value: value };
      } catch (err) {
        results[idx] = { ok: false, error: err.message || String(err) };
      }
      done++;
      if (onProgress) {
        try { onProgress(done, batches.length); } catch (e) { /* ignore */ }
      }
      var i = nextIndex++;
      if (i < batches.length) {
        await run(i);
      }
    }

    var tasks = [];
    for (var j = 0; j < Math.min(limit, batches.length); j++) {
      tasks.push(run(j));
    }
    await Promise.all(tasks);

    return results;
  }

  // Attach.
  S.translateAll = translateAll;
  S.translateOneBatch = translateOneBatch;
  g.SubtitleServices = S;
})();