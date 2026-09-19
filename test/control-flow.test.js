import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue, encodeJSValue } from '../src/jsvalue.js';

async function run(source, args = []) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  const name = WebAssembly.Module.exports(module).find((x) => x.kind === 'function').name;
  return {
    module,
    raw: instance.exports[name](...args.map(encodeJSValue)),
  };
}

test('comparisons produce tagged booleans', async () => {
  for (const [expr, expected] of [
    ['2 < 3', true],
    ['2 >= 3', false],
    ['2 === 2', true],
    ['2 !== 2', false],
    ['0 === -0', true],
    ['true === true', true],
    ['true === false', false],
    ['null === null', true],
    ['undefined !== null', true],
  ]) {
    const { raw } = await run('function f(){ return ' + expr + '; }');
    assert.equal(decodeJSValue(raw), expected, expr);
  }

  const nan = await run('function f(a){ return a === a; }', [NaN]);
  assert.equal(decodeJSValue(nan.raw), false);
});

test('if/else and ! use JS-style truthiness for represented values', async () => {
  for (const [value, expected] of [
    [0, 0],
    [-0, 0],
    [NaN, 0],
    [false, 0],
    [null, 0],
    [undefined, 0],
    [1, 1],
    [-2, 1],
    [true, 1],
  ]) {
    const { raw } = await run(
      'function f(x){ if (!x) { return 0; } else { return 1; } }',
      [value],
    );
    assert.equal(decodeJSValue(raw), expected, String(value));
  }

  const object = await run('function f(){ if ({a:1}) { return 1; } return 0; }');
  assert.equal(decodeJSValue(object.raw), 1);
});

test('while loops and mutable locals lower to structured Wasm', async () => {
  const { module, raw } = await run(`
    function sum(n) {
      let i = 0;
      let total = 0;
      while (i < n) {
        total = total + i;
        i = i + 1;
      }
      return total;
    }
  `, [10]);

  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(decodeJSValue(raw), 45);
});

test('else-if chains compile', async () => {
  const source = `
    function sign(x) {
      if (x < 0) { return -1; }
      else if (x > 0) { return 1; }
      else { return 0; }
    }
  `;

  assert.equal(decodeJSValue((await run(source, [-4])).raw), -1);
  assert.equal(decodeJSValue((await run(source, [0])).raw), 0);
  assert.equal(decodeJSValue((await run(source, [4])).raw), 1);
});

test('fallthrough returns undefined', async () => {
  const { raw } = await run('function f(){ let x = 1; x = x + 1; }');
  assert.equal(decodeJSValue(raw), undefined);
});

test('const and unresolved assignments are rejected', () => {
  assert.throws(
    () => compileDynamic('function f(){ const x=1; x=2; return x; }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ x=2; return x; }'),
    ReferenceError,
  );
});
