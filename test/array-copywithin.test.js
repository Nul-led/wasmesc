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

test('Array.copyWithin copies forward ranges in place', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3, 4, 5];
      a.copyWithin(0, 3);
      return a[0] * 10000 + a[1] * 1000 + a[2] * 100 + a[3] * 10 + a[4];
    }
  `);
  assert.equal(value, 45345);
});

test('Array.copyWithin handles overlapping copies backwards', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3, 4, 5];
      a.copyWithin(2, 0, 3);
      return a[0] * 10000 + a[1] * 1000 + a[2] * 100 + a[3] * 10 + a[4];
    }
  `);
  assert.equal(value, 12123);
});

test('Array.copyWithin returns the same array object', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3];
      return a.copyWithin(1, 0, 1) === a;
    }
  `);
  assert.equal(value, true);
});

test('Array.copyWithin copies holes as holes', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1];
      a.length = 4;
      a[3] = 9;
      a.copyWithin(1, 0, 3);

      if (a.length !== 4) return 10;
      if (a[1] !== 1) return 20;
      if (a[2] !== undefined || a[3] !== undefined) return 30;
      if (a.indexOf(undefined) !== -1) return 40;
      return 42;
    }
  `);
  assert.equal(value, 42);
});

test('Array.copyWithin supports negative relative bounds', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3, 4, 5];
      a.copyWithin(-2, -4, -2);
      return a[0] * 10000 + a[1] * 1000 + a[2] * 100 + a[3] * 10 + a[4];
    }
  `);
  assert.equal(value, 12323);
});

test('Array.copyWithin clamps ranges and no-ops when there is no room', async () => {
  const clipped = await run(`
    function answer() {
      const a = [1, 2, 3, 4];
      a.copyWithin(3, 0, 4);
      return a[0] * 1000 + a[1] * 100 + a[2] * 10 + a[3];
    }
  `);
  assert.equal(clipped.value, 1231);

  const noop = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.copyWithin(3, 0, 2);
      return a[0] * 100 + a[1] * 10 + a[2];
    }
  `);
  assert.equal(noop.value, 123);
});

test('Array.copyWithin mutations are visible through aliases', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3];
      const b = a;
      b.copyWithin(1, 0, 2);
      return a[0] * 100 + a[1] * 10 + a[2];
    }
  `);
  assert.equal(value, 112);
});

test('Array.copyWithin preserves named properties', async () => {
  const { value } = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.note = 40;
      a.copyWithin(1, 0, 1);
      return a.note + a[1];
    }
  `);
  assert.equal(value, 41);
});

test('Array.copyWithin copies object and string JSValues', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const a = [object, "x", 3];
      a.copyWithin(1, 0, 2);
      return a[1] === object && a[2] === "x";
    }
  `);
  assert.equal(value, true);
});

test('Array.copyWithin handles undefined, NaN, and infinite bounds', async () => {
  const nan = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.copyWithin(0 / 0, 1, 2);
      return a[0] * 100 + a[1] * 10 + a[2];
    }
  `);
  assert.equal(nan.value, 223);

  const positiveInfinity = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.copyWithin(1 / 0, 0, 2);
      return a[0] * 100 + a[1] * 10 + a[2];
    }
  `);
  assert.equal(positiveInfinity.value, 123);

  const negativeInfinity = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.copyWithin(-(1 / 0), 1, 2);
      return a[0] * 100 + a[1] * 10 + a[2];
    }
  `);
  assert.equal(negativeInfinity.value, 223);

  const undefinedEnd = await run(`
    function answer() {
      const a = [1, 2, 3, 4];
      a.copyWithin(1, 2, undefined);
      return a[0] * 1000 + a[1] * 100 + a[2] * 10 + a[3];
    }
  `);
  assert.equal(undefinedEnd.value, 1344);
});

test('Array.copyWithin validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].copyWithin(0); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ return [1].copyWithin(0, 0, 1, 2); }'),
    TypeError,
  );
});

test('Array.copyWithin preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const a = [1, 2, 3];
      a.copyWithin(1, 0, 1);
      return a[1];
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 1);
});
