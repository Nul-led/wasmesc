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

test('Array.includes finds ordinary values', async () => {
  const found = await run('function answer(){ return [1,2,3].includes(2); }');
  assert.equal(found.value, true);

  const missing = await run('function answer(){ return [1,2,3].includes(4); }');
  assert.equal(missing.value, false);
});

test('Array.includes uses SameValueZero for NaN', async () => {
  const { value } = await run(`
    function answer() {
      const nan = 0 / 0;
      return [1, nan, 3].includes(nan);
    }
  `);
  assert.equal(value, true);
});

test('Array.includes treats holes as undefined', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1];
      array.length = 3;
      return array.includes(undefined);
    }
  `);
  assert.equal(value, true);
});

test('Array.includes compares strings by content', async () => {
  const { value } = await run(`
    function answer() {
      const dynamic = "ab" + "cd";
      return ["abcd"].includes(dynamic);
    }
  `);
  assert.equal(value, true);
});

test('Array.includes preserves object identity semantics', async () => {
  const alias = await run(`
    function answer() {
      const object = { value: 1 };
      return [object].includes(object);
    }
  `);
  assert.equal(alias.value, true);

  const distinct = await run(`
    function answer() {
      return [{ value: 1 }].includes({ value: 1 });
    }
  `);
  assert.equal(distinct.value, false);
});

test('Array.includes supports positive fromIndex', async () => {
  const found = await run(`
    function answer() {
      return [1, 2, 1].includes(1, 1);
    }
  `);
  assert.equal(found.value, true);

  const missing = await run(`
    function answer() {
      return [1, 2, 1].includes(1, 3);
    }
  `);
  assert.equal(missing.value, false);
});

test('Array.includes supports negative fromIndex', async () => {
  const last = await run(`
    function answer() {
      return [1, 2, 3].includes(3, -1);
    }
  `);
  assert.equal(last.value, true);

  const clipped = await run(`
    function answer() {
      return [1, 2, 3].includes(1, -100);
    }
  `);
  assert.equal(clipped.value, true);
});

test('Array.includes truncates fractional fromIndex and treats NaN as zero', async () => {
  const fractional = await run(`
    function answer() {
      return [1, 2, 3].includes(2, 1.9);
    }
  `);
  assert.equal(fractional.value, true);

  const nan = await run(`
    function answer() {
      return [1, 2, 3].includes(1, 0 / 0);
    }
  `);
  assert.equal(nan.value, true);
});

test('Array.includes handles infinite fromIndex', async () => {
  const positive = await run(`
    function answer() {
      return [1, 2, 3].includes(1, 1 / 0);
    }
  `);
  assert.equal(positive.value, false);

  const negative = await run(`
    function answer() {
      return [1, 2, 3].includes(1, -(1 / 0));
    }
  `);
  assert.equal(negative.value, true);
});

test('Array.includes validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].includes(); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ return [1].includes(1, 0, 2); }'),
    TypeError,
  );
});

test('Array.includes preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      return [1, 2, 3].includes(2);
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, true);
});
