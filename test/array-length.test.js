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

test('array length assignment can shrink arrays', async () => {
  const length = await run(`
    function answer() {
      const a = [10, 20, 30];
      a.length = 1;
      return a.length;
    }
  `);
  assert.equal(length.value, 1);

  const removed = await run(`
    function answer() {
      const a = [10, 20, 30];
      a.length = 1;
      return a[2];
    }
  `);
  assert.equal(removed.value, undefined);
});

test('shrunk elements do not reappear after re-expansion', async () => {
  const { value } = await run(`
    function answer() {
      const a = [10, 20, 30];
      a.length = 1;
      a.length = 3;
      return a[2];
    }
  `);
  assert.equal(value, undefined);
});

test('expanding length creates holes without allocating element values', async () => {
  const length = await run(`
    function answer() {
      const a = [1];
      a.length = 5;
      return a.length;
    }
  `);
  assert.equal(length.value, 5);

  const hole = await run(`
    function answer() {
      const a = [1];
      a.length = 5;
      return a[4];
    }
  `);
  assert.equal(hole.value, undefined);
});

test('named array properties survive length truncation', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.note = 42;
      a.length = 1;
      return a.note;
    }
  `);
  assert.equal(value, 42);
});

test('ordinary object length assignment still behaves as a normal property', async () => {
  const { value } = await run(`
    function answer() {
      const object = { length: 1 };
      object.length = 42;
      return object.length;
    }
  `);
  assert.equal(value, 42);
});

test('array length assignment preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const a = [1, 2];
      a.length = 0;
      return a.length;
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 0);
});
