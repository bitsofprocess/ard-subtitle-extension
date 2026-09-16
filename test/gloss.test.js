'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Ensure tokenize is available for the cross-reference.
globalThis.SubtitleServices = globalThis.SubtitleServices || {};
Object.assign(globalThis.SubtitleServices, require('../src/services/tokenize.js'));

const G = require('../src/services/gloss.js');
const { buildGlossMessages, parseGlossResponse, buildIndexedTokens } = G;

// --- Test cues ----------------------------------------------------------

const cues = [
  { start: 0, end: 2, text: 'Hallo!',                     translation: 'Hello!' },
  { start: 2, end: 5, text: 'Ich fange morgen an.',       translation: "I'm starting tomorrow." },
  { start: 5, end: 8, text: 'Komm bitte mal her.',        translation: 'Come here, please.' },
  { start: 8, end: 11, text: 'Die Tür öffnet sich langsam.', translation: 'The door opens slowly.' },
  { start: 11, end: 14, text: 'Was hast du gesagt?',      translation: 'What did you say?' },
];

// --- buildIndexedTokens -------------------------------------------------

test('buildIndexedTokens marks the correct token with [[ ]]', () => {
  const result = buildIndexedTokens('Ich fange morgen an.', 1);
  assert.ok(result.includes('1:[[fange]]'));
  assert.ok(result.includes('0:Ich'));
  assert.ok(result.includes('2:morgen'));
  assert.ok(result.includes('3:an.'));
});

test('buildIndexedTokens with tokenIndex -1 marks nothing', () => {
  const result = buildIndexedTokens('Hallo Welt', -1);
  assert.ok(!result.includes('[['));
});

// --- buildGlossMessages -------------------------------------------------

test('buildGlossMessages marks correct token', () => {
  const msgs = buildGlossMessages({ cues, cueIndex: 1, tokenIndex: 1 });
  const user = msgs[1].content;
  assert.ok(user.indexOf('1:[[fange]]') !== -1, 'expected [[fange]] in:\n' + user);
});

test('buildGlossMessages includes previous context', () => {
  const msgs = buildGlossMessages({ cues, cueIndex: 2, tokenIndex: 0 });
  const user = msgs[1].content;
  // Cue 0 and cue 1 should appear as context.
  assert.ok(user.indexOf('Hallo!') !== -1);
  assert.ok(user.indexOf("I'm starting tomorrow.") !== -1);
});

test('buildGlossMessages includes next context', () => {
  const msgs = buildGlossMessages({ cues, cueIndex: 2, tokenIndex: 0 });
  const user = msgs[1].content;
  // Cue 3 and cue 4 should be next context.
  assert.ok(user.indexOf('Die Tür öffnet sich langsam.') !== -1);
  assert.ok(user.indexOf('Was hast du gesagt?') !== -1);
});

test('buildGlossMessages truncates context at boundaries', () => {
  // First cue — no previous context section.
  const msgs = buildGlossMessages({ cues, cueIndex: 0, tokenIndex: 0 });
  const user = msgs[1].content;
  assert.ok(user.indexOf('=== CONTEXT (previous cues) ===') === -1);

  // Last cue — no next context section.
  const msgs2 = buildGlossMessages({ cues, cueIndex: 4, tokenIndex: 0 });
  const user2 = msgs2[1].content;
  assert.ok(user2.indexOf('=== CONTEXT (next cues) ===') === -1);
});

test('buildGlossMessages sanitizes newlines in context cues', () => {
  const localCues = [
    { start: 0, end: 2, text: 'Before\nline two', translation: 'Before / line two' },
    { start: 2, end: 4, text: 'Target', translation: 'Target EN' },
    { start: 4, end: 6, text: 'After\nfinal', translation: 'After / final' }
  ];
  const msgs = buildGlossMessages({ cues: localCues, cueIndex: 1, tokenIndex: 0 });
  const user = msgs[1].content;
  // Context cues should have \n → ' / '.
  assert.ok(user.indexOf('Before / line two') !== -1);
  assert.ok(user.indexOf('After / final') !== -1);
  // Raw newlines should not appear inside any cue text.
  assert.ok(user.indexOf('Before\nline') === -1);
  assert.ok(user.indexOf('After\nfinal') === -1);
});

test('buildGlossMessages includes sentence translation', () => {
  const msgs = buildGlossMessages({ cues, cueIndex: 1, tokenIndex: 0 });
  const user = msgs[1].content;
  assert.ok(user.indexOf("I'm starting tomorrow.") !== -1);
});

// --- parseGlossResponse -------------------------------------------------

test('parseGlossResponse happy path', () => {
  const result = parseGlossResponse('anfangen|to start|3|separable verb', 4, 1);
  assert.deepEqual(result, {
    lemma: 'anfangen',
    gloss: 'to start',
    related: [3],
    note: 'separable verb'
  });
});

test('parseGlossResponse strips code fences', () => {
  const result = parseGlossResponse('```\nanfangen|to start||\n```', 3, 1);
  assert.equal(result.lemma, 'anfangen');
  assert.equal(result.gloss, 'to start');
});

test('parseGlossResponse ignores leading chatter', () => {
  const result = parseGlossResponse('Here is the gloss:\nanfangen|to start||', 3, 1);
  assert.equal(result.lemma, 'anfangen');
});

test('parseGlossResponse handles 3 fields (note empty)', () => {
  const result = parseGlossResponse('die Tür|the door|', 3, 1);
  assert.equal(result.lemma, 'die Tür');
  assert.equal(result.gloss, 'the door');
  assert.equal(result.note, '');
});

test('parseGlossResponse throws on empty lemma', () => {
  assert.throws(() => {
    parseGlossResponse('|gloss||', 3, 1);
  }, /empty lemma/);
});

test('parseGlossResponse throws on empty gloss', () => {
  assert.throws(() => {
    parseGlossResponse('lemma|||', 3, 1);
  }, /empty gloss/);
});

test('parseGlossResponse throws on no pipe line', () => {
  assert.throws(() => {
    parseGlossResponse('just some text\nno pipes here', 3, 1);
  }, /no pipe/);
});

test('parseGlossResponse drops out-of-range related indices', () => {
  const result = parseGlossResponse('lemma|gloss|99,0,-5', 4, 1);
  assert.deepEqual(result.related, [0]); // 99 and -5 dropped
});

test('parseGlossResponse removes clicked index from related', () => {
  const result = parseGlossResponse('lemma|gloss|1,2', 4, 1);
  assert.deepEqual(result.related, [2]); // 1 (clicked) removed
});

test('parseGlossResponse empty related stays empty', () => {
  const result = parseGlossResponse('lemma|gloss||', 3, 1);
  assert.deepEqual(result.related, []);
});

test('parseGlossResponse drops non-numeric related entries', () => {
  const result = parseGlossResponse('lemma|gloss|abc,1,xyz', 4, 0);
  assert.deepEqual(result.related, [1]); // abc and xyz silently dropped
});