/*
 * Translation prompt, parser & validation.
 *
 * Numbered German lines → numbered English lines, parsed with regex.
 * No JSON — matches the battle-tested transcript-player approach.
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

  var SYSTEM_PROMPT =
    'You are a German-to-English subtitle translator. ' +
    'Translate each numbered German line into natural, idiomatic English. ' +
    'Preserve the tone (formal/informal) and translate sound descriptions ' +
    'wrapped in *asterisks* as well. ' +
    'Return ONLY a numbered list matching the input numbering exactly, ' +
    'one translation per line, no commentary, no extra formatting.\n\n' +
    'Example:\n' +
    '1. I am starting tomorrow.\n' +
    '2. Come closer.';

  function buildUserPrompt(cueTexts, contextTexts) {
    var parts = [];

    if (contextTexts && contextTexts.length > 0) {
      parts.push('=== CONTEXT (for reference only — do NOT translate) ===');
      for (var i = 0; i < contextTexts.length; i++) {
        parts.push(contextTexts[i]);
      }
      parts.push('');
    }

    parts.push('=== TO TRANSLATE ===');
    for (var j = 0; j < cueTexts.length; j++) {
      parts.push((j + 1) + '. ' + cueTexts[j]);
    }

    return parts.join('\n');
  }

  function buildMessages(cueTexts, contextTexts) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(cueTexts, contextTexts) }
    ];
  }

  function parseTranslationResponse(rawText, cueTexts) {
    var lines = rawText.split('\n');
    var map = new Map();

    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (!trimmed) continue;

      var match = trimmed.match(/^(\d+)[\.\)]\s?(.*)$/);
      if (!match) continue;

      var num = parseInt(match[1], 10);
      var translation = match[2].trim();

      if (num < 1 || num > cueTexts.length) {
        console.warn('[validate] line number out of range: ' + num);
        continue;
      }

      if (map.has(num)) {
        throw new Error('Duplicate number in translation: ' + num);
      }

      map.set(num, translation);
    }

    var missing = [];
    for (var j = 1; j <= cueTexts.length; j++) {
      if (!map.has(j)) missing.push(j);
    }

    if (missing.length > 0) {
      throw new Error(
        'Missing translations: ' + missing.join(', ') +
        ' (got ' + map.size + '/' + cueTexts.length + ')'
      );
    }

    var results = [];
    for (var k = 1; k <= cueTexts.length; k++) {
      results.push(map.get(k));
    }

    return results;
  }

  return {
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    buildUserPrompt: buildUserPrompt,
    buildMessages: buildMessages,
    parseTranslationResponse: parseTranslationResponse
  };
});
