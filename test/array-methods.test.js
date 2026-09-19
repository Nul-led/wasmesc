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

test('push appends a value and returns the new length', async () => {
  const length = await run(`
    function answer() {
      const a = [1, 2];
      return a.push(3);
    }
  `);
  assert.equal(length.value, 3);

  const value = await run(`
    function answer() {
      const a = [1, 2];
      a.push(42);
      return a[2];
    }
  `);
  assert.equal(value.value, 42);
});

test('pop returns the last value and shrinks length', async () => {
  const popped = await run(`
    function answer() {
      const a = [1, 2, 42];
      return a.pop();
    }
  `);
  assert.equal(popped.value, 42);

  const length = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.pop();
      return a.length;
    }
  `);
  assert.equal(length.value, 2);
});

test('pop on an empty array returns undefined', async () => {
  const { value } = await run('function answer(){ const a=[]; return a.pop(); }');
  assert.equal(value, undefined);
});

test('push and pop preserve aliasing', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1];
      const b = a;
      b.push(42);
      a.pop();
      return b.length;
    }
  `);
  assert.equal(value, 1);
});

test('popped elements do not reappear after later length growth', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.pop();
      a.length = 3;
      return a[2];
    }
  `);
  assert.equal(value, undefined);
});

test('push and pop support arbitrary tagged values', async () => {
  const stringValue = await run(`
    function answer() {
      const a = [];
      a.push("stored");
      return a.pop();
    }
  `);
  assert.equal(stringValue.value, 'stored');

  const objectValue = await run(`
    function answer() {
      const a = [];
      a.push({ value: 42 });
      return a.pop().value;
    }
  `);
  assert.equal(objectValue.value, 42);
});

test('push/pop arity is validated at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ const a=[]; return a.push(); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ const a=[]; return a.pop(1); }'),
    TypeError,
  );
});

test('array methods preserve zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const a = [1];
      a.push(2);
      return a.pop();
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 2);
});
