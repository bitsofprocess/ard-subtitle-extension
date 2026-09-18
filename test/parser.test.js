'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The browser provides DOMParser natively; Node doesn't, so polyfill it just
// enough for the parser's W3C-DOM usage. This is a dev-only test dependency.
const { DOMParser } = require('@xmldom/xmldom');
globalThis.DOMParser = DOMParser;

const parser = require('../src/parser/parser.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const ardXml = fs.readFileSync(path.join(FIXTURES, 'ard-sample.ttml'), 'utf8');
const zdfXml = fs.readFileSync(path.join(FIXTURES, 'zdf-sample.ttml'), 'utf8');

// --- Time parsing ----------------------------------------------------------

test('parseTimeToSeconds handles HH:MM:SS.mmm', () => {
  assert.equal(parser.parseTimeToSeconds('00:00:20.280'), 20.28);
  assert.equal(parser.parseTimeToSeconds('00:02:09.479'), 129.479);
  assert.equal(parser.parseTimeToSeconds('00:00:00.000'), 0);
  assert.equal(parser.parseTimeToSeconds('01:00:00.000'), 3600);
});

test('parseTimeToSeconds handles shorter forms', () => {
  assert.equal(parser.parseTimeToSeconds('01:30.500'), 90.5);
  assert.equal(parser.parseTimeToSeconds('5.25'), 5.25);
});

test('parseTimeToSeconds rejects invalid input', () => {
  assert.throws(() => parser.parseTimeToSeconds(''), /empty/i);
  assert.throws(() => parser.parseTimeToSeconds('abc'), /could not parse/i);
  assert.throws(() => parser.parseTimeToSeconds(123), TypeError);
});

// --- Format detection ------------------------------------------------------

test('detectFormat recognizes TTML fixtures', () => {
  assert.equal(parser.detectFormat(ardXml), 'ttml');
  assert.equal(parser.detectFormat(zdfXml), 'ttml');
});

test('detectFormat recognizes YouTube timedtext and rejects unknown XML', () => {
  assert.equal(
    parser.detectFormat('<transcript><text start="0" dur="1">hi</text></transcript>'),
    'youtube-timedtext'
  );
  assert.equal(parser.detectFormat('<html><body/></html>'), null);
});

test('parse (dispatcher) routes TTML fixtures to the TTML adapter', () => {
  assert.ok(parser.parse(ardXml).length > 0);
  assert.ok(parser.parse(zdfXml).length > 0);
});

// --- ARD fixture smoke test ------------------------------------------------

test('parseTTML on ARD fixture: skips empty self-closing cue, parses the rest', () => {
  const cues = parser.parseTTML(ardXml);

  // sub0 is an empty self-closing <tt:p /> — should be skipped.
  // sub1–sub4 are real cues.
  assert.equal(cues.length, 4);

  for (const cue of cues) {
    assert.ok(Number.isFinite(cue.start) && Number.isFinite(cue.end), JSON.stringify(cue));
    assert.ok(cue.end > cue.start, 'non-positive duration: ' + JSON.stringify(cue));
    assert.ok(cue.text.length > 0, 'empty cue text: ' + JSON.stringify(cue));
  }
});

test('parseTTML on ARD fixture: preserves timing and line breaks', () => {
  const cues = parser.parseTTML(ardXml);

  // First cue: an audio description split over two lines.
  assert.equal(cues[0].start, 20.28);
  assert.equal(cues[0].end, 24.28);
  assert.equal(cues[0].text, '*dissonante Geigenklänge\nsynchron zum Metronom*');

  // Two-speaker cue uses one timing, two lines.
  const twoSpeaker = cues.find(c => c.text.includes('Haben Sie noch einen Wunsch'));
  assert.equal(twoSpeaker, undefined, 'two-speaker cue not in trimmed fixture');
});

// --- ZDF fixture smoke test ------------------------------------------------

test('parseTTML on ZDF fixture: parses all cues', () => {
  const cues = parser.parseTTML(zdfXml);

  // sub0–sub4 + sub47 + sub119 = 7 cues (no empty self-closing cues in this fixture).
  assert.equal(cues.length, 7);

  for (const cue of cues) {
    assert.ok(Number.isFinite(cue.start) && Number.isFinite(cue.end), JSON.stringify(cue));
    assert.ok(cue.end > cue.start, 'non-positive duration: ' + JSON.stringify(cue));
    assert.ok(cue.text.length > 0, 'empty cue text: ' + JSON.stringify(cue));
  }
});

// --- Multi-span joining ----------------------------------------------------

function parseSingleCue(xmlString) {
  var doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  // The parser's parseTTML expects a full <tt:tt> document, so wrap it.
  var wrapped = '<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xml:lang="de">' +
    '<tt:body><tt:div>' + xmlString + '</tt:div></tt:body></tt:tt>';
  return parser.parseTTML(wrapped);
}

test('cueText joins sibling spans separated by <br/> with newline', () => {
  var cues = parseSingleCue(
    '<tt:p begin="00:00:01.000" end="00:00:02.000">' +
    '<tt:span>Hello</tt:span>' +
    '<tt:br/>' +
    '<tt:span>world</tt:span>' +
    '</tt:p>'
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Hello\nworld');
});

test('cueText joins sibling spans without <br/> with a space', () => {
  var cues = parseSingleCue(
    '<tt:p begin="00:00:01.000" end="00:00:02.000">' +
    '<tt:span>Hello</tt:span>' +
    '<tt:span>world</tt:span>' +
    '</tt:p>'
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Hello world');
});

test('cueText preserves trailing-space separation between spans (the ZDF bug)', () => {
  // Real pattern from zdf-sample.ttml sub47: first span ends with a trailing
  // space that separates it from the next span. Without this fix the output
  // would be "ist auch ein schöner Name.Oh!"
  var cues = parseSingleCue(
    '<tt:p begin="00:00:01.000" end="00:00:02.000">' +
    '<tt:span>ist auch ein schöner Name. </tt:span>' +
    '<tt:span>Oh!</tt:span>' +
    '</tt:p>'
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'ist auch ein schöner Name. Oh!');
});

test('cueText with mixed br and no-br spans in the same cue', () => {
  // Pattern from ZDF sub47: br-separated line, then a color-change mid-line.
  var cues = parseSingleCue(
    '<tt:p begin="00:00:01.000" end="00:00:02.000">' +
    '<tt:span>Line one</tt:span>' +
    '<tt:br/>' +
    '<tt:span>Line two part A. </tt:span>' +
    '<tt:span>Line two part B.</tt:span>' +
    '</tt:p>'
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Line one\nLine two part A. Line two part B.');
});

test('cueText collapses excess whitespace from pretty-printed XML', () => {
  var cues = parseSingleCue(
    '<tt:p begin="00:00:01.000" end="00:00:02.000">\n' +
    '        <tt:span>  Hello   world  </tt:span>\n' +
    '        <tt:br/>\n' +
    '        <tt:span>  foo   bar  </tt:span>\n' +
    '      </tt:p>'
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Hello world\nfoo bar');
});

// --- Edge cases ------------------------------------------------------------

test('parseTTML handles empty or non-subtitle documents gracefully', () => {
  var cues = parser.parseTTML('<root></root>');
  assert.equal(cues.length, 0);
});

test('cueText with only whitespace children returns empty string', () => {
  var cues = parseSingleCue(
    '<tt:p begin="00:00:01.000" end="00:00:02.000">\n' +
    '  \n' +
    '  <tt:span> \n  </tt:span>\n' +
    '</tt:p>'
  );
  // All whitespace — should be filtered out, no cue emitted.
  assert.equal(cues.length, 0);
});