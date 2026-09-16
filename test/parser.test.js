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

const SAMPLE_PATH = path.join(__dirname, '..', 'sample.xml');
const sampleXml = fs.readFileSync(SAMPLE_PATH, 'utf8');

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

test('detectFormat recognizes the real fixture as TTML', () => {
  assert.equal(parser.detectFormat(sampleXml), 'ttml');
});

test('detectFormat recognizes YouTube timedtext and rejects unknown XML', () => {
  assert.equal(
    parser.detectFormat('<transcript><text start="0" dur="1">hi</text></transcript>'),
    'youtube-timedtext'
  );
  assert.equal(parser.detectFormat('<html><body/></html>'), null);
});

test('parse (dispatcher) routes the real fixture to the TTML adapter', () => {
  const cues = parser.parse(sampleXml);
  assert.ok(cues.length > 0);
});

test('parseTTML extracts every non-empty cue from the fixture', () => {
  const cues = parser.parseTTML(sampleXml);

  // The fixture has 497 <tt:p> cues; sub0 is an empty self-closing one.
  assert.equal(cues.length, 496);

  for (const cue of cues) {
    assert.ok(Number.isFinite(cue.start) && Number.isFinite(cue.end), JSON.stringify(cue));
    assert.ok(cue.end > cue.start, 'non-positive duration: ' + JSON.stringify(cue));
    assert.ok(cue.text.length > 0, 'empty cue text: ' + JSON.stringify(cue));
  }

  for (let i = 1; i < cues.length; i++) {
    assert.ok(cues[i].start >= cues[i - 1].start, 'cues not in chronological order');
  }
});

test('parseTTML preserves timing and line breaks', () => {
  const cues = parser.parseTTML(sampleXml);

  // First cue: an audio description split over two lines.
  const first = cues[0];
  assert.equal(first.start, 20.28);
  assert.equal(first.end, 24.28);
  assert.equal(first.text, '*dissonante Geigenklänge\nsynchron zum Metronom*');

  // Two-speaker cue uses different styles per line but shares one timing.
  const twoSpeaker = cues.find(c => c.text.includes('Haben Sie noch einen Wunsch'));
  assert.equal(twoSpeaker.text, 'Haben Sie noch einen Wunsch?\nDanke.');
});

test('parseTTML handles empty or non-subtitle documents gracefully', () => {
  // xmldom doesn't throw on non-XML; the safety net is the format detection
  // in parse(), not the raw parseTTML() call. parseTTML on an empty doc
  // simply returns no cues.
  const empty = '<root></root>';
  const cues = parser.parseTTML(empty);
  assert.equal(cues.length, 0);
});