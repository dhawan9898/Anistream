import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, toNumber } from './errors.ts';

test('errorMessage reads Error and message-bearing objects', () => {
  assert.equal(errorMessage(new Error('boom'), 'x'), 'boom');
  assert.equal(errorMessage({ message: 'plain' }, 'x'), 'plain');
});

test('errorMessage falls back for everything else', () => {
  assert.equal(errorMessage(undefined, 'fallback'), 'fallback');
  assert.equal(errorMessage('str', 'fallback'), 'fallback');
  assert.equal(errorMessage(new Error(''), 'fallback'), 'fallback');
  assert.equal(errorMessage({ message: 5 }, 'fallback'), 'fallback');
});

test('toNumber handles numbers, strings and big-integer-like objects', () => {
  assert.equal(toNumber(42), 42);
  assert.equal(toNumber('7'), 7);
  assert.equal(toNumber({ toJSNumber: () => 9007 }), 9007);
});
