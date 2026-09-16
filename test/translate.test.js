'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/services/prompt.js');
const { SYSTEM_PROMPT, buildUserPrompt, buildMessages, parseTranslationResponse } = P;

// --- parseTranslationResponse -----------------------------------------

test('parses a numbered-list response in order', () => {
  const raw = '1. Hello.\n2. Goodbye.\n3. Really?';
  const result = parseTranslationResponse(raw, ['Hallo.', 'Tschüss.', 'Wirklich?']);
  assert.deepEqual(result, ['Hello.', 'Goodbye.', 'Really?']);
});

test('handles "1)" style numbering and leading whitespace', () => {
  const raw = '  1) One\n   2) Two';
  const result = parseTranslationResponse(raw, ['a', 'b']);
  assert.deepEqual(result, ['One', 'Two']);
});

test('ignores preamble/commentary lines', () => {
  const raw = 'Here are the translations:\n1. One\n2. Two';
  const result = parseTranslationResponse(raw, ['a', 'b']);
  assert.deepEqual(result, ['One', 'Two']);
});

test('throws on missing numbers', () => {
  assert.throws(
    () => parseTranslationResponse('1. Only one', ['a', 'b']),
    /Missing/.test.bind(/Missing/)
  );
  // Simpler:
  assert.throws(
    () => parseTranslationResponse('1. Only one', ['a', 'b']),
    /Missing translations/
  );
});

test('throws on duplicate numbers', () => {
  assert.throws(
    () => parseTranslationResponse('1. One\n1. Duplicate', ['a']),
    /Duplicate/
  );
});

// --- prompt building ----------------------------------------------------

test('SYSTEM_PROMPT asks for numbered German→English', () => {
  assert.ok(SYSTEM_PROMPT.includes('numbered'));
  assert.ok(SYSTEM_PROMPT.includes('English'));
});

test('buildUserPrompt numbers cues and marks context', () => {
  const prompt = buildUserPrompt(['Hallo', 'Tschüss'], ['Vorher']);
  assert.ok(prompt.includes('CONTEXT'));
  assert.ok(prompt.includes('Vorher'));
  assert.ok(prompt.includes('1. Hallo'));
  assert.ok(prompt.includes('2. Tschüss'));
});

test('buildMessages returns system + user', () => {
  const msgs = buildMessages(['Test.'], null);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
});

test('buildUserPrompt handles newline sanitization (multi-line cues)', () => {
  // In translation pipeline, \n is replaced with ' / ' before calling
  // buildUserPrompt so each numbered item stays on a single line.
  const prompt = buildUserPrompt(
    ['aber ein Mensch / mit herausragender Willenskraft', 'zweite Zeile'],
    null
  );
  // Both items must appear as complete numbered lines.
  assert.ok(prompt.includes('1. aber ein Mensch / mit herausragender Willenskraft'));
  assert.ok(prompt.includes('2. zweite Zeile'));
  // parseTranslationResponse must handle the ' / ' safely.
  const raw = '1. but a person / with outstanding willpower\n2. second line';
  const parsed = parseTranslationResponse(raw, [
    'aber ein Mensch / mit herausragender Willenskraft',
    'zweite Zeile'
  ]);
  assert.deepEqual(parsed, [
    'but a person / with outstanding willpower',
    'second line'
  ]);
});