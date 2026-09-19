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

test('shift removes the first element and renumbers remaining indexes', async () => {
  const shifted = await run(`
    function answer() {
      const a = [10, 20, 30];
      return a.shift();
    }
  `);
  assert.equal(shifted.value, 10);

  const first = await run(`
    function answer() {
      const a = [10, 20, 30];
      a.shift();
      return a[0];
    }
  `);
  assert.equal(first.value, 20);

  const length = await run(`
    function answer() {
      const a = [10, 20, 30];
      a.shift();
      return a.length;
    }
  `);
  assert.equal(length.value, 2);
});

test('shift on an empty array returns undefined', async () => {
  const { value } = await run('function answer(){ const a=[]; return a.shift(); }');
  assert.equal(value, undefined);
});

test('unshift prepends and returns the new length', async () => {
  const length = await run(`
    function answer() {
      const a = [20, 30];
      return a.unshift(10);
    }
  `);
  assert.equal(length.value, 3);

  const values = await run(`
    function answer() {
      const a = [20, 30];
      a.unshift(10);
      return a[0] + a[1] + a[2];
    }
  `);
  assert.equal(values.value, 60);
});

test('shift and unshift preserve holes', async () => {
  const shiftHole = await run(`
    function answer() {
      const a = [1];
      a.length = 3;
      a.shift();
      return a[0];
    }
  `);
  assert.equal(shiftHole.value, undefined);

  const unshiftHole = await run(`
    function answer() {
      const a = [1];
      a.length = 3;
      a.unshift(9);
      return a[2];
    }
  `);
  assert.equal(unshiftHole.value, undefined);
});

test('shift/unshift preserve named array properties', async () => {
  const shifted = await run(`
    function answer() {
      const a = [1, 2];
      a.note = 42;
      a.shift();
      return a.note;
    }
  `);
  assert.equal(shifted.value, 42);

  const unshifted = await run(`
    function answer() {
      const a = [1, 2];
      a.note = 42;
      a.unshift(0);
      return a.note;
    }
  `);
  assert.equal(unshifted.value, 42);
});

test('aliases observe shift and unshift mutations', async () => {
  const { value } = await run(`
    function answer() {
      const a = [2, 3];
      const b = a;
      b.unshift(1);
      a.shift();
      return b[0];
    }
  `);
  assert.equal(value, 2);
});

test('shift renumbers repeated writes with last-write-wins behavior', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3];
      a[1] = 20;
      a[1] = 42;
      a.shift();
      return a[0];
    }
  `);
  assert.equal(value, 42);
});

test('shift/unshift carry arbitrary tagged values', async () => {
  const stringValue = await run(`
    function answer() {
      const a = ["b"];
      a.unshift("a");
      return a.shift();
    }
  `);
  assert.equal(stringValue.value, 'a');

  const objectValue = await run(`
    function answer() {
      const a = [{ value: 42 }];
      return a.shift().value;
    }
  `);
  assert.equal(objectValue.value, 42);
});

test('shift/unshift compose with push and pop', async () => {
  const { value } = await run(`
    function answer() {
      const a = [2, 3];
      a.unshift(1);
      a.push(4);
      a.shift();
      return a.pop();
    }
  `);
  assert.equal(value, 4);
});

test('shift/unshift validate arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ const a=[]; return a.shift(1); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ const a=[]; return a.unshift(); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ const a=[]; return a.unshift(1,2); }'),
    TypeError,
  );
});

test('shift/unshift preserve zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const a = [2];
      a.unshift(1);
      return a.shift();
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 1);
});
