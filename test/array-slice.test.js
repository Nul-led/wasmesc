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

test('Array.slice copies the whole array into a distinct array', async () => {
  const values = await run(`
    function answer() {
      const source = [1, 2, 3];
      const copy = source.slice();
      return copy.length * 1000 + copy[0] * 100 + copy[1] * 10 + copy[2];
    }
  `);
  assert.equal(values.value, 3123);

  const identity = await run(`
    function answer() {
      const source = [1, 2, 3];
      return source.slice() === source;
    }
  `);
  assert.equal(identity.value, false);
});

test('Array.slice respects start and end bounds', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 2, 3, 4].slice(1, 3);
      return copy.length * 100 + copy[0] * 10 + copy[1];
    }
  `);
  assert.equal(value, 223);
});

test('Array.slice supports negative relative bounds', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 2, 3, 4].slice(-3, -1);
      return copy.length * 100 + copy[0] * 10 + copy[1];
    }
  `);
  assert.equal(value, 223);
});

test('Array.slice preserves holes instead of materializing undefined', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1];
      source.length = 3;
      const copy = source.slice();

      if (copy.length !== 3) {
        return 10;
      }
      if (copy.indexOf(undefined) !== -1) {
        return 20;
      }
      return copy[0];
    }
  `);
  assert.equal(value, 1);
});

test('Array.slice is shallow for object values', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const copy = [object].slice();
      return copy[0] === object;
    }
  `);
  assert.equal(value, true);
});

test('Array.slice returns an independently mutable array', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1, 2];
      const copy = source.slice();
      copy[0] = 42;
      return source[0] * 100 + copy[0];
    }
  `);
  assert.equal(value, 142);
});

test('Array.slice handles omitted, undefined, NaN, and infinite bounds', async () => {
  const undefinedStart = await run(`
    function answer() {
      const copy = [1, 2, 3].slice(undefined, 2);
      return copy.length * 100 + copy[0] * 10 + copy[1];
    }
  `);
  assert.equal(undefinedStart.value, 212);

  const nanStart = await run(`
    function answer() {
      const copy = [1, 2, 3].slice(0 / 0, 1);
      return copy[0];
    }
  `);
  assert.equal(nanStart.value, 1);

  const positiveInfinity = await run(`
    function answer() {
      return [1, 2, 3].slice(1 / 0).length;
    }
  `);
  assert.equal(positiveInfinity.value, 0);

  const negativeInfinity = await run(`
    function answer() {
      return [1, 2, 3].slice(-(1 / 0)).length;
    }
  `);
  assert.equal(negativeInfinity.value, 3);
});

test('Array.slice returns an empty array when end precedes start', async () => {
  const { value } = await run('function answer(){ return [1,2,3].slice(2, 1).length; }');
  assert.equal(value, 0);
});

test('Array.slice validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].slice(0, 1, 2); }'),
    TypeError,
  );
});

test('Array.slice preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const copy = [1, 2, 3].slice(1);
      return copy.length;
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 2);
});
