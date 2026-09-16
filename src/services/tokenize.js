/*
 * Shared tokenizer — single source of truth for word indices.
 *
 * The overlay's clickable spans and the gloss cache both use this, so
 * indices always match between what the user clicks and what we cache.
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

  /**
   * Tokenize cue text into word-level tokens.
   *
   * @param {string} cueText  — the cue's original text (may contain \n)
   * @returns {Object[]}       — [{ i, raw, word, line, clickable }]
   *
   *   i:        0-based index across the whole cue, continuing across lines.
   *   raw:      the token as displayed, including punctuation and * markers.
   *   word:     the lookup form: leading/trailing punctuation, quotes, and *
   *             stripped.  Hyphenated words and internal apostrophes kept.
   *   line:     line number (0-based) within the cue.
   *   clickable: false if the word is empty after stripping or purely numeric.
   */
  function tokenize(cueText) {
    if (!cueText) return [];

    var lines = cueText.split('\n');
    var tokens = [];
    var idx = 0;

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      // Split on word boundaries: sequences of non-whitespace.
      var re = /(\S+)|(\s+)/g;
      var m;
      while ((m = re.exec(line)) !== null) {
        if (m[1] !== undefined) {
          var raw = m[1];
          var word = stripMarkers(raw);
          tokens.push({
            i: idx,
            raw: raw,
            word: word,
            line: li,
            clickable: isClickable(word)
          });
          idx++;
        }
        // Whitespace is skipped — only words get indices.
      }
    }

    return tokens;
  }

  /**
   * Strip leading and trailing punctuation, quotes, asterisks, and
   * other markers from a token to produce the lookup form.
   *
   * Keeps: hyphens, internal apostrophes, internal periods (abbreviations).
   * Strips: outer quotes, asterisks, dashes, commas, etc.
   */
  function stripMarkers(raw) {
    // Start with the raw token.
    var w = raw;

    // Strip leading punctuation/asterisks/quotes.
    // This includes: *, ", „, ', «, », (, [, {, and Unicode punctuation.
    w = w.replace(/^[\*"'""''«»\(\)\[\]\{\}`\u2018\u2019\u201C\u201D\u201E\u201F\u2039\u203A\u00AB\u00BB\u2013\u2014\u2015\u2026\.\,\;\:\!\?\-\–\—\‐]+/, '');

    // Strip trailing punctuation/asterisks/quotes.
    w = w.replace(/[\*"'""''«»\(\)\[\]\{\}`\u2018\u2019\u201C\u201D\u201E\u201F\u2039\u203A\u00AB\u00BB\u2013\u2014\u2015\u2026\.\,\;\:\!\?\-\–\—\‐]+$/, '');

    // Also strip standalone * markers (used for italics in subtitles).
    w = w.replace(/^\*+/, '').replace(/\*+$/, '');

    return w;
  }

  /**
   * A token is NOT clickable if its stripped word is empty or purely numeric.
   */
  function isClickable(word) {
    if (!word || word.length === 0) return false;
    // Allow hyphens and apostrophes but not a pure-number token.
    if (/^\d+$/.test(word)) return false;
    return true;
  }

  return {
    tokenize: tokenize,
    stripMarkers: stripMarkers,
    isClickable: isClickable
  };
});