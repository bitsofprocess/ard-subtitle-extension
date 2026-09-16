/*
 * Subtitle parsers.
 *
 * Written as a UMD module so it can be loaded in the browser with a plain
 * <script> tag (attaches `window.SubtitleParser`) and in Node via require()
 * (for the test suite). No build step, matching the project's "plain JS"
 * constraint.
 *
 * Every adapter emits the same common cue format:
 *   { start: number, end: number, text: string }
 * where start/end are in seconds as floats and text keeps source line breaks
 * as "\n" (e.g. a speaker change on a second <br/> line).
 *
 * Supported formats (see parse/detectFormat):
 *   - "ttml"            EBU-TT-D TTML (ARD/ZDF Mediathek)
 *   - "youtube-timedtext" YouTube timedtext XML (not implemented yet)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SubtitleParser = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // --- DOM helpers -------------------------------------------------------

  // Namespace-aware-looking tag-name helper: "tt:span" -> "span".
  function localTagName(el) {
    return el.localName || String(el.tagName || '').split(':').pop();
  }

  // --- Time parsing ------------------------------------------------------

  // Convert a TTML time expression to seconds (float).
  // Supports "HH:MM:SS.mmm", "MM:SS.mmm", "SS.mmm" and plain seconds.
  // Frame-count syntax ("HH:MM:SS:FF") is not produced by the current
  // fixtures, so it's intentionally left out for now.
  function parseTimeToSeconds(time) {
    if (typeof time !== 'string') {
      throw new TypeError('parseTimeToSeconds expects a string, got ' + typeof time);
    }
    var trimmed = time.trim();
    if (trimmed === '') {
      throw new Error('Cannot parse an empty time value');
    }
    var parts = trimmed.split(':');
    var seconds;
    if (parts.length === 3) {
      seconds = parseInt(parts[0], 10) * 3600 +
                parseInt(parts[1], 10) * 60 +
                parseFloat(parts[2]);
    } else if (parts.length === 2) {
      seconds = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    } else if (parts.length === 1) {
      seconds = parseFloat(parts[0]);
    } else {
      throw new Error('Unrecognized time format: "' + time + '"');
    }
    if (!Number.isFinite(seconds)) {
      throw new Error('Could not parse time: "' + time + '"');
    }
    // Round to milliseconds to avoid IEEE-754 artefacts (e.g. 129.479 vs 129.47900000000001).
    return Math.round(seconds * 1000) / 1000;
  }

  // --- TTML adapter ------------------------------------------------------

  // Extract the display text of a <tt:p> cue. <tt:br/> becomes "\n"; the
  // whitespace used purely for pretty-printing the XML is ignored.
  function cueText(p) {
    var parts = [];
    var children = p.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node.nodeType === 3) { // text node
        var t = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      } else if (node.nodeType === 1) { // element node
        if (localTagName(node) === 'br') {
          parts.push('\n');
        } else {
          var inner = String(node.textContent || '').replace(/\s+/g, ' ').trim();
          if (inner) parts.push(inner);
        }
      }
    }
    return parts
      .join('')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  // Parse TTML (EBU-TT-D) into the common cue format.
  function parseTTML(xmlString) {
    if (typeof DOMParser === 'undefined') {
      throw new Error('DOMParser is not available in this environment');
    }
    var doc = new DOMParser().parseFromString(xmlString, 'text/xml');

    // Browser DOMParser reports malformed XML as a <parsererror> element.
    var parserErrors = doc.getElementsByTagName('parsererror');
    if (parserErrors && parserErrors.length > 0) {
      throw new Error('Malformed XML: ' + String(parserErrors[0].textContent || '').trim());
    }

    var all = doc.getElementsByTagName('*');
    var cues = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (localTagName(el) !== 'p') continue;
      var begin = el.getAttribute('begin');
      var end = el.getAttribute('end');
      // Skip cues with no timing or no text (e.g. self-closing empty cues).
      if (!begin || !end) continue;
      var text = cueText(el);
      if (!text) continue;
      cues.push({
        start: parseTimeToSeconds(begin),
        end: parseTimeToSeconds(end),
        text: text
      });
    }

    // Guarantee chronological order and drop any malformed (non-positive
    // duration) cues, just in case a source file isn't already sorted.
    cues.sort(function (a, b) { return a.start - b.start; });
    return cues.filter(function (c) { return c.end > c.start; });
  }

  // --- Format detection & dispatch --------------------------------------

  function detectFormat(xmlString) {
    if (typeof xmlString !== 'string') return null;
    var trimmed = xmlString.trim();
    if (/<tt(?:[:> ])/.test(trimmed) && /ttml/i.test(trimmed)) return 'ttml';
    if (/<transcript[\s>]/.test(trimmed)) return 'youtube-timedtext';
    return null;
  }

  function parse(xmlString) {
    var format = detectFormat(xmlString);
    if (format === 'ttml') return parseTTML(xmlString);
    if (format === 'youtube-timedtext') {
      throw new Error('YouTube timedtext parser is not implemented yet');
    }
    throw new Error('Unrecognized subtitle format (expected TTML or YouTube timedtext XML)');
  }

  return {
    parse: parse,
    parseTTML: parseTTML,
    parseTimeToSeconds: parseTimeToSeconds,
    detectFormat: detectFormat
  };
});