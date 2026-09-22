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

test('Array.indexOf finds ordinary values and returns -1 when absent', async () => {
  const found = await run('function answer(){ return [1,2,3].indexOf(2); }');
  assert.equal(found.value, 1);

  const missing = await run('function answer(){ return [1,2,3].indexOf(4); }');
  assert.equal(missing.value, -1);
});

test('Array.indexOf uses strict equality, so NaN does not match NaN', async () => {
  const { value } = await run(`
    function answer() {
      const nan = 0 / 0;
      return [nan].indexOf(nan);
    }
  `);
  assert.equal(value, -1);
});

test('Array.indexOf skips holes but finds explicit undefined', async () => {
  const hole = await run(`
    function answer() {
      const array = [];
      array.length = 2;
      return array.indexOf(undefined);
    }
  `);
  assert.equal(hole.value, -1);

  const explicit = await run('function answer(){ return [undefined].indexOf(undefined); }');
  assert.equal(explicit.value, 0);
});

test('Array.indexOf compares strings by value and objects by identity', async () => {
  const string = await run(`
    function answer() {
      const dynamic = "ab" + "cd";
      return ["abcd"].indexOf(dynamic);
    }
  `);
  assert.equal(string.value, 0);

  const alias = await run(`
    function answer() {
      const object = { value: 1 };
      return [object].indexOf(object);
    }
  `);
  assert.equal(alias.value, 0);

  const distinct = await run(`
    function answer() {
      return [{ value: 1 }].indexOf({ value: 1 });
    }
  `);
  assert.equal(distinct.value, -1);
});

test('Array.indexOf supports positive and negative fromIndex', async () => {
  const positive = await run('function answer(){ return [1,2,1].indexOf(1, 1); }');
  assert.equal(positive.value, 2);

  const pastEnd = await run('function answer(){ return [1,2,1].indexOf(1, 3); }');
  assert.equal(pastEnd.value, -1);

  const negative = await run('function answer(){ return [1,2,3,2].indexOf(2, -2); }');
  assert.equal(negative.value, 3);

  const clipped = await run('function answer(){ return [1,2,3].indexOf(1, -100); }');
  assert.equal(clipped.value, 0);
});

test('Array.indexOf truncates fractional fromIndex and treats NaN as zero', async () => {
  const fractional = await run('function answer(){ return [1,2,3].indexOf(2, 1.9); }');
  assert.equal(fractional.value, 1);

  const nan = await run('function answer(){ return [1,2,3].indexOf(1, 0 / 0); }');
  assert.equal(nan.value, 0);
});

test('Array.indexOf handles infinite fromIndex', async () => {
  const positive = await run('function answer(){ return [1,2,3].indexOf(1, 1 / 0); }');
  assert.equal(positive.value, -1);

  const negative = await run('function answer(){ return [1,2,3].indexOf(1, -(1 / 0)); }');
  assert.equal(negative.value, 0);
});

test('Array.indexOf validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].indexOf(); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ return [1].indexOf(1, 0, 2); }'),
    TypeError,
  );
});

test('Array.indexOf preserves zero imports', async () => {
  const { module, value } = await run('function answer(){ return [1,2,3].indexOf(2); }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 1);
});
