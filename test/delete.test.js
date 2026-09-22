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

test('delete removes an object property and returns true', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const deleted = delete object.value;
      return deleted && object.value === undefined;
    }
  `);
  assert.equal(value, true);
});

test('delete removes all historical writes for a property', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 1 };
      object.value = 2;
      object.value = 3;
      delete object.value;
      return object.value === undefined;
    }
  `);
  assert.equal(value, true);
});

test('delete of a missing property still returns true', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 1 };
      return delete object.missing;
    }
  `);
  assert.equal(value, true);
});

test('delete array[index] creates a hole without changing length', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      const deleted = delete array[1];

      if (!deleted) return 10;
      if (array.length !== 3) return 20;
      if (array[1] !== undefined) return 30;
      if (array.indexOf(undefined) !== -1) return 40;
      return 42;
    }
  `);
  assert.equal(value, 42);
});

test('delete supports dynamic numeric array indexes', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      let index = 1;
      delete array[index];
      return array.length === 3 && array[1] === undefined && array.indexOf(undefined) === -1;
    }
  `);
  assert.equal(value, true);
});

test('delete supports string-literal bracket properties', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      delete object["value"];
      return object.value === undefined;
    }
  `);
  assert.equal(value, true);
});

test('delete supports named array properties without touching elements', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2];
      array.note = 40;
      delete array.note;
      return array.note === undefined && array.length === 2 && array[0] + array[1] === 3;
    }
  `);
  assert.equal(value, true);
});

test('delete supports nested member targets', async () => {
  const { value } = await run(`
    function answer() {
      const outer = { inner: { value: 42 } };
      delete outer.inner.value;
      return outer.inner.value === undefined;
    }
  `);
  assert.equal(value, true);
});

test('delete array numeric properties removes repeated writes', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2];
      array[1] = 7;
      array[1] = 9;
      delete array[1];
      return array[1] === undefined && array.indexOf(undefined) === -1 && array.length === 2;
    }
  `);
  assert.equal(value, true);
});

test('delete rejects identifier targets in the current subset', () => {
  assert.throws(
    () => compileDynamic('function f(){ let x=1; return delete x; }'),
    SyntaxError,
  );
});

test('delete length is conservatively rejected', () => {
  assert.throws(
    () => compileDynamic('function f(){ const a=[1]; return delete a.length; }'),
    SyntaxError,
  );
  assert.throws(
    () => compileDynamic('function f(){ const a=[1]; return delete a["length"]; }'),
    SyntaxError,
  );
});

test('delete preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const object = { value: 42 };
      delete object.value;
      return object.value === undefined;
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, true);
});
