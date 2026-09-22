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

test('Array.lastIndexOf finds the last matching value', async () => {
  const found = await run('function answer(){ return [1,2,1,3].lastIndexOf(1); }');
  assert.equal(found.value, 2);

  const missing = await run('function answer(){ return [1,2,3].lastIndexOf(4); }');
  assert.equal(missing.value, -1);
});

test('Array.lastIndexOf uses strict equality, so NaN does not match NaN', async () => {
  const { value } = await run(`
    function answer() {
      const nan = 0 / 0;
      return [nan, nan].lastIndexOf(nan);
    }
  `);
  assert.equal(value, -1);
});

test('Array.lastIndexOf skips holes but finds explicit undefined', async () => {
  const hole = await run(`
    function answer() {
      const array = [];
      array.length = 3;
      return array.lastIndexOf(undefined);
    }
  `);
  assert.equal(hole.value, -1);

  const explicit = await run(`
    function answer() {
      const array = [undefined, 1, undefined];
      return array.lastIndexOf(undefined);
    }
  `);
  assert.equal(explicit.value, 2);
});

test('Array.lastIndexOf compares strings by value and objects by identity', async () => {
  const string = await run(`
    function answer() {
      const dynamic = "ab" + "cd";
      return ["abcd", "x", "abcd"].lastIndexOf(dynamic);
    }
  `);
  assert.equal(string.value, 2);

  const alias = await run(`
    function answer() {
      const object = { value: 1 };
      return [object, { value: 1 }, object].lastIndexOf(object);
    }
  `);
  assert.equal(alias.value, 2);

  const distinct = await run(`
    function answer() {
      return [{ value: 1 }].lastIndexOf({ value: 1 });
    }
  `);
  assert.equal(distinct.value, -1);
});

test('Array.lastIndexOf supports positive and negative fromIndex', async () => {
  const positive = await run('function answer(){ return [1,2,1,2].lastIndexOf(2, 2); }');
  assert.equal(positive.value, 1);

  const clipped = await run('function answer(){ return [1,2,1].lastIndexOf(1, 99); }');
  assert.equal(clipped.value, 2);

  const negative = await run('function answer(){ return [1,2,3,2].lastIndexOf(2, -2); }');
  assert.equal(negative.value, 1);

  const beforeStart = await run('function answer(){ return [1,2,3].lastIndexOf(1, -100); }');
  assert.equal(beforeStart.value, -1);
});

test('Array.lastIndexOf truncates fractional fromIndex and treats NaN as zero', async () => {
  const fractional = await run('function answer(){ return [1,2,1].lastIndexOf(1, 1.9); }');
  assert.equal(fractional.value, 0);

  const nan = await run('function answer(){ return [1,2,1].lastIndexOf(1, 0 / 0); }');
  assert.equal(nan.value, 0);
});

test('Array.lastIndexOf handles infinite fromIndex', async () => {
  const positive = await run('function answer(){ return [1,2,1].lastIndexOf(1, 1 / 0); }');
  assert.equal(positive.value, 2);

  const negative = await run('function answer(){ return [1,2,1].lastIndexOf(1, -(1 / 0)); }');
  assert.equal(negative.value, -1);
});

test('Array.lastIndexOf returns -1 for empty arrays', async () => {
  const { value } = await run('function answer(){ return [].lastIndexOf(1); }');
  assert.equal(value, -1);
});

test('Array.lastIndexOf validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].lastIndexOf(); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ return [1].lastIndexOf(1, 0, 2); }'),
    TypeError,
  );
});

test('Array.lastIndexOf preserves zero imports', async () => {
  const { module, value } = await run('function answer(){ return [1,2,1].lastIndexOf(1); }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 2);
});
