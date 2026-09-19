import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { arrayPointer, decodeJSValue, JSValue } from '../src/jsvalue.js';

async function instantiate(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  return { bytes, module, instance: result.instance ?? result };
}

async function run(source) {
  const { module, instance } = await instantiate(source);
  const name = WebAssembly.Module.exports(module).find((x) => x.kind === 'function').name;
  const raw = instance.exports[name]();
  return {
    module,
    instance,
    raw,
    value: decodeJSValue(raw, instance.exports.memory),
  };
}

test('array literals support indexed reads and length', async () => {
  const element = await run('function answer(){ const a=[10,20,30]; return a[1]; }');
  assert.deepEqual(WebAssembly.Module.imports(element.module), []);
  assert.equal(element.value, 20);

  const length = await run('function answer(){ const a=[10,20,30]; return a.length; }');
  assert.equal(length.value, 3);
});

test('indexed writes grow arrays and preserve holes as undefined', async () => {
  const grown = await run(`
    function answer() {
      const a = [1, 2];
      a[4] = 42;
      return a.length;
    }
  `);
  assert.equal(grown.value, 5);

  const hole = await run(`
    function answer() {
      const a = [1];
      a[3] = 4;
      return a[2];
    }
  `);
  assert.equal(hole.value, undefined);
});

test('array aliases observe indexed writes', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1];
      const b = a;
      b[0] = 42;
      return a[0];
    }
  `);
  assert.equal(value, 42);
});

test('dynamic numeric indexes work in loops', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3, 4];
      let i = 0;
      let total = 0;
      while (i < a.length) {
        total = total + a[i];
        i = i + 1;
      }
      return total;
    }
  `);
  assert.equal(value, 10);
});

test('arrays carry arbitrary tagged values', async () => {
  const stringValue = await run(`
    function answer() {
      const a = [1, "stored", { value: 42 }];
      return a[1];
    }
  `);
  assert.equal(stringValue.value, 'stored');

  const objectValue = await run(`
    function answer() {
      const a = [{ value: 42 }];
      return a[0].value;
    }
  `);
  assert.equal(objectValue.value, 42);
});

test('arrays use reference identity for strict equality and are truthy', async () => {
  const alias = await run(`
    function answer() {
      const a = [];
      const b = a;
      return a === b;
    }
  `);
  assert.equal(alias.value, true);

  const distinct = await run('function answer(){ return [] === []; }');
  assert.equal(distinct.value, false);

  const truthy = await run('function answer(){ if ([]) { return 1; } return 0; }');
  assert.equal(truthy.value, 1);
});

test('array descriptors expose pointer and length to embedding code', async () => {
  const { raw, instance } = await run('function answer(){ return [1,2,3]; }');
  assert.equal(raw & JSValue.TAG_MASK, JSValue.ARRAY);
  assert.equal(arrayPointer(raw) > 0, true);

  const descriptor = decodeJSValue(raw, instance.exports.memory);
  assert.equal(descriptor.type, 'array');
  assert.equal(descriptor.pointer, arrayPointer(raw));
  assert.equal(descriptor.length, 3);
});

test('reserved length property id does not break ordinary object properties', async () => {
  const { value } = await run(`
    function answer() {
      const object = { length: 41 };
      object.length = object.length + 1;
      return object.length;
    }
  `);
  assert.equal(value, 42);
});
