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

test('Array.concat with no arguments returns a distinct shallow copy', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const source = [object, 2];
      const copy = source.concat();
      return copy !== source && copy[0] === object && copy[1] === 2;
    }
  `);
  assert.equal(value, true);
});

test('Array.concat appends a scalar value', async () => {
  const { value } = await run(`
    function answer() {
      const result = [1, 2].concat(3);
      return result.length * 1000 + result[0] * 100 + result[1] * 10 + result[2];
    }
  `);
  assert.equal(value, 3123);
});

test('Array.concat flattens one array argument by one level', async () => {
  const { value } = await run(`
    function answer() {
      const result = [1, 2].concat([3, 4]);
      return result.length * 10000 + result[0] * 1000 + result[1] * 100 + result[2] * 10 + result[3];
    }
  `);
  assert.equal(value, 41234);
});

test('Array.concat preserves sparse holes from both arrays', async () => {
  const { value } = await run(`
    function answer() {
      const left = [1];
      left.length = 3;
      const right = [4];
      right.length = 3;
      right[2] = 9;
      const result = left.concat(right);

      if (result.length !== 6) return 10;
      if (result[0] !== 1 || result[3] !== 4 || result[5] !== 9) return 20;
      if (result.indexOf(undefined) !== -1) return 30;
      return 42;
    }
  `);
  assert.equal(value, 42);
});

test('Array.concat is shallow for object values', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const result = [object].concat([]);
      return result[0] === object;
    }
  `);
  assert.equal(value, true);
});

test('Array.concat does not mutate either source array', async () => {
  const { value } = await run(`
    function answer() {
      const left = [1, 2];
      const right = [3, 4];
      const result = left.concat(right);
      result[0] = 9;
      result[2] = 8;
      return left[0] * 1000 + left[1] * 100 + right[0] * 10 + right[1];
    }
  `);
  assert.equal(value, 1234);
});

test('Array.concat does not copy named properties from array arguments', async () => {
  const { value } = await run(`
    function answer() {
      const right = [2];
      right.note = 40;
      const result = [1].concat(right);
      return result.note === undefined && right.note === 40;
    }
  `);
  assert.equal(value, true);
});

test('Array.concat appends strings and ordinary objects as scalar values', async () => {
  const string = await run(`
    function answer() {
      const result = [1].concat("x");
      return result.length === 2 && result[1] === "x";
    }
  `);
  assert.equal(string.value, true);

  const object = await run(`
    function answer() {
      const value = { answer: 42 };
      const result = [1].concat(value);
      return result[1] === value;
    }
  `);
  assert.equal(object.value, true);
});

test('Array.concat handles empty array arguments', async () => {
  const { value } = await run(`
    function answer() {
      const result = [1, 2].concat([]);
      return result.length * 100 + result[0] * 10 + result[1];
    }
  `);
  assert.equal(value, 212);
});

test('Array.concat currently validates the single-argument subset', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].concat(2, 3); }'),
    TypeError,
  );
});

test('Array.concat preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const result = [1].concat([2]);
      return result[0] + result[1];
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 3);
});
