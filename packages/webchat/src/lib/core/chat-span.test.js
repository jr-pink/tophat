import test from 'node:test';
import assert from 'node:assert/strict';
import { chatSpan } from './chat-span.js';

const now = Date.parse('2026-11-15T20:00:00Z');
const at = (h) => new Date(now - h * 3_600_000).toISOString();

test('within 24 h: a clock range', () => assert.match(chatSpan(at(2), at(1), now), /^\d\d:\d\d-\d\d:\d\d$/));
test('a single instant within 24 h: one time', () => assert.match(chatSpan(at(1), at(1), now), /^\d\d:\d\d$/));
test('one older day: 2d ago', () => assert.equal(chatSpan(at(49), at(48), now), '2d ago'));
test('several days: d-d ago', () => assert.equal(chatSpan(at(120), at(48), now), '5d-2d ago'));
test('older start, recent end', () => assert.equal(chatSpan(at(72), at(2), now), '3d-2h ago'));
test('bad input', () => assert.equal(chatSpan('x', null, now), ''));
