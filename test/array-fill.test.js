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

test('Array.fill fills the whole array and returns the same object', async () => {
  const values = await run(`
    function answer() {
      const array = [1, 2, 3];
      const result = array.fill(9);
      if (result !== array) {
        return 10;
      }
      return array[0] * 100 + array[1] * 10 + array[2];
    }
  `);
  assert.equal(values.value, 999);
});

test('Array.fill respects start and end bounds', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3, 4];
      array.fill(9, 1, 3);
      return array[0] * 1000 + array[1] * 100 + array[2] * 10 + array[3];
    }
  `);
  assert.equal(value, 1994);
});

test('Array.fill supports negative relative bounds', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3, 4];
      array.fill(8, -3, -1);
      return array[0] * 1000 + array[1] * 100 + array[2] * 10 + array[3];
    }
  `);
  assert.equal(value, 1884);
});

test('Array.fill materializes sparse holes in the selected range', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1];
      array.length = 4;
      array.fill(7, 1, 3);

      if (array.length !== 4) {
        return 10;
      }
      if (array.indexOf(7) !== 1 || array.lastIndexOf(7) !== 2) {
        return 20;
      }
      if (array.indexOf(undefined) !== -1) {
        return 30;
      }
      return array[3] === undefined ? 42 : 40;
    }
  `);
  assert.equal(value, 42);
});

test('Array.fill mutations are visible through aliases', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      const alias = array;
      alias.fill(5, 1);
      return array[0] * 100 + array[1] * 10 + array[2];
    }
  `);
  assert.equal(value, 155);
});

test('Array.fill can fill with object and string JSValues', async () => {
  const object = await run(`
    function answer() {
      const object = { value: 42 };
      const array = [1, 2];
      array.fill(object);
      return array[0] === object && array[1] === object;
    }
  `);
  assert.equal(object.value, true);

  const string = await run(`
    function answer() {
      const array = [1, 2, 3];
      array.fill("x", 1);
      return array[1] === "x" && array[2] === "x";
    }
  `);
  assert.equal(string.value, true);
});

test('Array.fill preserves named properties', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      array.note = 40;
      array.fill(2);
      return array.note + array[0];
    }
  `);
  assert.equal(value, 42);
});

test('Array.fill handles omitted, undefined, NaN, and infinite bounds', async () => {
  const undefinedStart = await run(`
    function answer() {
      const array = [1, 2, 3];
      array.fill(9, undefined, 1);
      return array[0] * 100 + array[1] * 10 + array[2];
    }
  `);
  assert.equal(undefinedStart.value, 923);

  const nanStart = await run(`
    function answer() {
      const array = [1, 2];
      array.fill(7, 0 / 0, 1);
      return array[0] * 10 + array[1];
    }
  `);
  assert.equal(nanStart.value, 72);

  const positiveInfinity = await run(`
    function answer() {
      const array = [1, 2, 3];
      array.fill(9, 1 / 0);
      return array[0] * 100 + array[1] * 10 + array[2];
    }
  `);
  assert.equal(positiveInfinity.value, 123);

  const negativeInfinity = await run(`
    function answer() {
      const array = [1, 2, 3];
      array.fill(9, -(1 / 0), 1);
      return array[0] * 100 + array[1] * 10 + array[2];
    }
  `);
  assert.equal(negativeInfinity.value, 923);
});

test('Array.fill is a no-op when end precedes start', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      array.fill(9, 2, 1);
      return array[0] * 100 + array[1] * 10 + array[2];
    }
  `);
  assert.equal(value, 123);
});

test('Array.fill validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].fill(); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ return [1].fill(1, 0, 1, 2); }'),
    TypeError,
  );
});

test('Array.fill preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const array = [1, 2];
      array.fill(4);
      return array[0] + array[1];
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 8);
});
