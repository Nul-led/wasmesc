import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue } from '../src/jsvalue.js';

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function expression(random, depth = 0) {
  if (depth >= 4 || random() < 0.3) {
    const n = Math.trunc(random() * 41) - 20;
    return random() < 0.2 ? `(${n}.5)` : String(n);
  }
  if (random() < 0.18) return `-(${expression(random, depth + 1)})`;
  const op = ['+', '-', '*', '/'][Math.floor(random() * 4)];
  return `(${expression(random, depth + 1)} ${op} ${expression(random, depth + 1)})`;
}

function sameNumber(a, b) {
  return (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b);
}

test('differential: arithmetic matches Node', async () => {
  const random = rng(0x5ec0c0de);

  for (let i = 0; i < 200; i += 1) {
    const expr = expression(random);
    const expected = Function(`"use strict"; return (${expr});`)();
    const bytes = compileDynamic(`function fuzz(){ return ${expr}; }`);
    const instance = await WebAssembly.instantiate(bytes, {});
    const actual = decodeJSValue(instance.instance.exports.fuzz());
    assert.ok(sameNumber(actual, expected), `${expr}: expected ${expected}, got ${actual}`);
  }
});
