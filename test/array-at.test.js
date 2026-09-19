import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue } from '../src/jsvalue.js';

async function run(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  const instance = result.instance ?? result;
  const name = WebAssembly.Module.exports(module).find((x) => (
    x.kind === 'function' && x.name !== '__wasmesc_alloc'
  )).name;
  const raw = instance.exports[name]();
  return {
    module,
    instance,
    value: decodeJSValue(raw, instance.exports.memory),
  };
}

test('Array.at supports positive and negative indexes', async () => {
  for (const [index, expected] of [
    ['0', 10],
    ['1', 20],
    ['-1', 30],
    ['-2', 20],
    ['-3', 10],
  ]) {
    const { value } = await run(`
      function answer() {
        const a = [10, 20, 30];
        return a.at(${index});
      }
    `);
    assert.equal(value, expected, index);
  }
});

test('Array.at returns undefined outside the relative range', async () => {
  for (const index of ['3', '-4', '1 / 0', '-(1 / 0)']) {
    const { value } = await run(`
      function answer() {
        const a = [10, 20, 30];
        return a.at(${index});
      }
    `);
    assert.equal(value, undefined, index);
  }
});

test('Array.at truncates fractional numeric indexes toward zero', async () => {
  const positive = await run(`
    function answer() {
      const a = [10, 20, 30];
      return a.at(1.9);
    }
  `);
  assert.equal(positive.value, 20);

  const negative = await run(`
    function answer() {
      const a = [10, 20, 30];
      return a.at(-1.9);
    }
  `);
  assert.equal(negative.value, 30);
});

test('Array.at treats NaN as zero for the current numeric subset', async () => {
  const { value } = await run(`
    function answer() {
      const a = [42, 99];
      return a.at(0 / 0);
    }
  `);
  assert.equal(value, 42);
});

test('Array.at returns undefined for holes', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1];
      a.length = 3;
      return a.at(-1);
    }
  `);
  assert.equal(value, undefined);
});

test('Array.at observes aliases and later writes', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2];
      const b = a;
      b[1] = 42;
      return a.at(-1);
    }
  `);
  assert.equal(value, 42);
});

test('Array.at validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ const a=[1]; return a.at(); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ const a=[1]; return a.at(0, 1); }'),
    TypeError,
  );
});

test('Array.at preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const a = [10, 20];
      return a.at(-1);
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 20);
});
