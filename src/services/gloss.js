/*
 * Gloss prompt builder & response parser.
 *
 * Takes a cue array + the clicked word position and builds a compact
 * LLM prompt that asks for lemma + contextual gloss.  The one-line
 * pipe-delimited response format is easy to parse and hard to
 * malform.
 *
 * UMD so Node tests can require() it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SubtitleServices = root.SubtitleServices || {};
    Object.assign(root.SubtitleServices, factory());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // --- Config ------------------------------------------------------------

  var S = typeof globalThis !== 'undefined' ? (globalThis.SubtitleServices || {}) : {};
  S.config = S.config || {};
  S.config.GLOSS_MODEL = S.config.GLOSS_MODEL || 'openai/gpt-4o-mini';
  S.config.GLOSS_TEMPERATURE = 0;
  S.config.GLOSS_MAX_TOKENS = S.config.GLOSS_MAX_TOKENS || 120;

  // --- Constants ---------------------------------------------------------

  var CONTEXT_CUES_BEFORE = 2;
  var CONTEXT_CUES_AFTER = 2;

  var SYSTEM_PROMPT =
    'You are a German→English glossing assistant for an intermediate (B1–B2) learner.\n' +
    'For the word marked with [[ ]], reply with EXACTLY one line in the format:\n' +
    'lemma|gloss|related|note\n\n' +
    '  lemma:   dictionary form. Separable verbs → full infinitive (anfangen).\n' +
    '           Nouns → singular nominative with article (die Tür, der Mann).\n' +
    '           Never include inflection unless it IS the lemma.\n' +
    '  gloss:   short English meaning AS USED IN THIS SENTENCE, max ~8 words.\n' +
    '  related: comma-separated token indices (0,1,2…) of words in the SAME\n' +
    '           target-cue line that belong to this lexical unit:\n' +
    '           separable prefix, reflexive pronoun, fixed expression.\n' +
    '           Leave empty if none.\n' +
    '  note:     optional hint, max ~15 words, e.g. "separable verb",\n' +
    '           "modal particle softening a request", "dative".\n' +
    '           Leave empty if nothing useful.\n\n' +
    'Never use | inside any field. No commentary, no markdown.';

  // --- Helpers -----------------------------------------------------------

  /**
   * Sanitise cue text the same way the sentence pipeline does.
   */
  function sanitizeCueText(text) {
    return (text || '').replace(/\n/g, ' / ');
  }

  /**
   * Build the indexed token display for a cue, wrapping the target
   * in [[ ]] markers.
   *
   * Example: "0:Ich 1:[[fange]] 2:morgen 3:an."
   *
   * @param {string} text  — raw cue text
   * @param {number} tokenIndex — which token to mark (-1 = none)
   * @returns {string}
   */
  function buildIndexedTokens(text, tokenIndex) {
    // Use the shared tokenizer for consistent indices.
    // In the browser, tokenize is available on the global namespace.
    // In Node tests, require it directly.
    var tokenize;
    if (typeof globalThis !== 'undefined' && globalThis.SubtitleServices && globalThis.SubtitleServices.tokenize) {
      tokenize = globalThis.SubtitleServices.tokenize;
    } else {
      tokenize = require('./tokenize.js').tokenize;
    }

    var tokens = tokenize(text);
    var parts = [];

    for (var i = 0; i < tokens.length; i++) {
      var w = tokens[i].raw;
      if (i === tokenIndex) {
        parts.push(i + ':[[' + w + ']]');
      } else {
        parts.push(i + ':' + w);
      }
    }

    return parts.join(' ');
  }

  // --- Public API -------------------------------------------------------

  /**
   * Build the messages array for a single-word gloss request.
   *
   * @param {Object} opts
   * @param {Object[]} opts.cues         — full cue array for the video
   * @param {number}   opts.cueIndex     — which cue contains the word
   * @param {number}   opts.tokenIndex   — which token was clicked
   * @returns {Object[]} — [{role, content}] for the chat API
   */
  function buildGlossMessages(opts) {
    var cues = opts.cues;
    var cueIndex = opts.cueIndex;
    var tokenIndex = opts.tokenIndex;

    var targetCue = cues[cueIndex];
    if (!targetCue) throw new Error('Invalid cueIndex: ' + cueIndex);

    var lines = [];

    // --- Previous cues (context) ---
    var startCtx = Math.max(0, cueIndex - CONTEXT_CUES_BEFORE);
    if (startCtx < cueIndex) {
      lines.push('=== CONTEXT (previous cues) ===');
      for (var ci = startCtx; ci < cueIndex; ci++) {
        var c = cues[ci];
        lines.push(sanitizeCueText(c.text));
        if (c.translation) lines.push('  EN: ' + sanitizeCueText(c.translation));
      }
      lines.push('');
    }

    // --- Target cue ---
    lines.push('=== TARGET CUE ===');
    lines.push(buildIndexedTokens(targetCue.text, tokenIndex));
    if (targetCue.translation) {
      lines.push('  Sentence translation: ' + sanitizeCueText(targetCue.translation));
    }
    lines.push('');

    // --- Next cues (context) ---
    var endCtx = Math.min(cues.length, cueIndex + CONTEXT_CUES_AFTER + 1);
    if (cueIndex + 1 < endCtx) {
      lines.push('=== CONTEXT (next cues) ===');
      for (var cj = cueIndex + 1; cj < endCtx; cj++) {
        lines.push(sanitizeCueText(cues[cj].text));
      }
    }

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: lines.join('\n') }
    ];
  }

  /**
   * Parse the LLM response into a gloss entry.
   *
   * @param {string} raw           — raw model output
   * @param {number} tokenCount    — number of tokens in the cue (for related validation)
   * @param {number} tokenIndex    — the clicked token index (removed from related)
   * @returns {{ lemma: string, gloss: string, related: number[], note: string }}
   * @throws {Error} on unparseable response
   */
  function parseGlossResponse(raw, tokenCount, tokenIndex) {
    // Strip code fences and trim.
    var cleaned = raw
      .replace(/^```[a-zA-Z]*\n?/gm, '')
      .replace(/```$/gm, '')
      .trim();

    // Find the first non-empty line containing |.
    var lines = cleaned.split('\n');
    var answerLine = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (ln && ln.indexOf('|') !== -1) {
        answerLine = ln;
        break;
      }
    }

    if (!answerLine) {
      throw new Error('Gloss parse error: no pipe-delimited line found');
    }

    // Split into fields.  Use a limit so a stray | inside a field
    // doesn't create extra fields — it all ends up in `rest`.
    var fields = answerLine.split('|');
    var lemma = (fields[0] || '').trim();
    var gloss = (fields[1] || '').trim();
    var relatedRaw = (fields[2] || '').trim();
    var note = fields.length >= 4 ? fields.slice(3).join('|').trim() : '';

    // Validate required fields.
    if (!lemma) {
      throw new Error('Gloss parse error: empty lemma');
    }
    if (!gloss) {
      throw new Error('Gloss parse error: empty gloss');
    }

    // Parse related indices.
    var related = [];
    if (relatedRaw) {
      var parts = relatedRaw.split(',');
      for (var j = 0; j < parts.length; j++) {
        var parsed = parseInt(parts[j].trim(), 10);
        if (!isNaN(parsed)) {
          // Drop out-of-range and self.
          if (parsed >= 0 && parsed < tokenCount && parsed !== tokenIndex) {
            related.push(parsed);
          }
        }
      }
    }

    return { lemma: lemma, gloss: gloss, related: related, note: note };
  }

  return {
    buildGlossMessages: buildGlossMessages,
    parseGlossResponse: parseGlossResponse,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    buildIndexedTokens: buildIndexedTokens
  };
});