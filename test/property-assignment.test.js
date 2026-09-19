import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue } from '../src/jsvalue.js';

async function run(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  const name = WebAssembly.Module.exports(module).find((x) => x.kind === 'function').name;
  return {
    module,
    instance,
    value: decodeJSValue(instance.exports[name]()),
  };
}

test('overwrites an existing property', async () => {
  const { value } = await run(`
    function f() {
      const o = { answer: 1 };
      o.answer = 42;
      return o.answer;
    }
  `);
  assert.equal(value, 42);
});

test('adds a new property after object creation', async () => {
  const { value } = await run(`
    function f() {
      const o = {};
      o.answer = 42;
      return o.answer;
    }
  `);
  assert.equal(value, 42);
});

test('nested property assignment follows member chains', async () => {
  const { value } = await run(`
    function f() {
      const outer = { inner: { value: 1 } };
      outer.inner.value = 42;
      return outer.inner.value;
    }
  `);
  assert.equal(value, 42);
});

test('object aliases observe property writes', async () => {
  const { value } = await run(`
    function f() {
      const a = { x: 1 };
      const b = a;
      a.x = 42;
      return b.x;
    }
  `);
  assert.equal(value, 42);
});

test('const bindings still allow object mutation', async () => {
  const { value } = await run(`
    function f() {
      const o = { x: 1 };
      o.x = 41;
      o.x = o.x + 1;
      return o.x;
    }
  `);
  assert.equal(value, 42);
});

test('repeated property writes are not limited by literal capacity', async () => {
  const { module, value } = await run(`
    function f() {
      const o = {};
      let i = 0;
      while (i < 100) {
        o.value = i;
        i = i + 1;
      }
      return o.value;
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 99);
});
