/*
 * OpenRouter API helpers (browser runtime).
 *
 * Loaded via a regular <script> tag in the extension page — attaches to
 * the `SubtitleServices` namespace created by prompt.js and validate.js.
 */
(function () {
  'use strict';

  var OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

  // Shared namespace (populated by prompt.js and translate.js).
  var g = typeof globalThis !== 'undefined' ? globalThis : this;
  var S = g.SubtitleServices || {};

  /**
   * Exponential-backoff retry wrapper around fetch.
   *
   * Retries on network errors, timeouts, HTTP 429, and 5xx.
   * Does NOT retry on other 4xx — fails immediately.
   */
  async function withRetry(fn, opts) {
    opts = opts || {};
    var maxAttempts = opts.maxAttempts || 4;
    var lastErr;

    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;

        // Non-network errors — throw immediately
        if (err.name !== 'TypeError' && !err.status && !err.response) {
          throw err;
        }

        var status = err.status || (err.response && err.response.status);

        // Don't retry client errors except 429
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw err;
        }

        if (attempt === maxAttempts) {
          throw lastErr;
        }

        var base = Math.pow(2, attempt - 1) * 1000;
        var delay = base + Math.random() * base;

        console.warn(
          '[withRetry] attempt ' + attempt + '/' + maxAttempts +
          ', waiting ' + (delay / 1000).toFixed(1) + 's: ' + (err.message || String(err))
        );

        await new Promise(function (r) { setTimeout(r, delay); });
      }
    }

    throw lastErr;
  }

  /**
   * Call the OpenRouter chat/completions endpoint with DeepSeek.
   *
   * @param {Object[]} messages — chat messages array
   * @param {string} apiKey    — OpenRouter API key
   * @returns {Promise<string>} — raw response text
   */
  async function callDeepSeek(messages, apiKey) {
    var response = await withRetry(function () {
      return fetch(OPENROUTER_BASE + '/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: S.config.MODEL || 'openai/gpt-4o-mini',
          messages: messages,
          temperature: 0.2
        })
      });
    });

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

  // Attach to shared namespace.
  S.withRetry = withRetry;
  S.callDeepSeek = callDeepSeek;
  g.SubtitleServices = S;
})();