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

test('Array.toSpliced with no arguments returns a dense copy', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1];
      source.length = 3;
      const copy = source.toSpliced();

      if (copy === source || copy.length !== 3) {
        return 10;
      }
      if (copy.indexOf(undefined) !== 1) {
        return 20;
      }
      if (source.indexOf(undefined) !== -1) {
        return 30;
      }
      return copy[0];
    }
  `);
  assert.equal(value, 1);
});

test('Array.toSpliced with only start deletes through the end', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 2, 3, 4].toSpliced(2);
      return copy.length * 100 + copy[0] * 10 + copy[1];
    }
  `);
  assert.equal(value, 212);
});

test('Array.toSpliced deletes a bounded range', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 2, 3, 4].toSpliced(1, 2);
      return copy.length * 100 + copy[0] * 10 + copy[1];
    }
  `);
  assert.equal(value, 214);
});

test('Array.toSpliced supports arbitrary inserted items', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 4].toSpliced(1, 0, 2, 3);
      return copy.length * 10000
        + copy[0] * 1000
        + copy[1] * 100
        + copy[2] * 10
        + copy[3];
    }
  `);
  assert.equal(value, 41234);
});

test('Array.toSpliced can replace values', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 2, 3].toSpliced(1, 1, 9);
      return copy[0] * 100 + copy[1] * 10 + copy[2];
    }
  `);
  assert.equal(value, 193);
});

test('Array.toSpliced supports negative starts', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 2, 3, 4].toSpliced(-2, 1, 9);
      return copy[0] * 1000 + copy[1] * 100 + copy[2] * 10 + copy[3];
    }
  `);
  assert.equal(value, 1294);
});

test('explicit undefined deleteCount deletes zero elements', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 2].toSpliced(1, undefined, 9);
      return copy.length * 1000 + copy[0] * 100 + copy[1] * 10 + copy[2];
    }
  `);
  assert.equal(value, 3192);
});

test('Array.toSpliced normalizes deleteCount', async () => {
  const nan = await run(`
    function answer() {
      const copy = [1, 2, 3].toSpliced(1, 0 / 0, 9);
      return copy.length;
    }
  `);
  assert.equal(nan.value, 4);

  const negative = await run(`
    function answer() {
      const copy = [1, 2, 3].toSpliced(1, -10, 9);
      return copy.length;
    }
  `);
  assert.equal(negative.value, 4);

  const infinity = await run(`
    function answer() {
      const copy = [1, 2, 3, 4].toSpliced(1, 1 / 0, 9);
      return copy.length * 10 + copy[1];
    }
  `);
  assert.equal(infinity.value, 29);
});

test('Array.toSpliced is shallow and does not mutate the source', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const source = [1, object, 3];
      const copy = source.toSpliced(0, 1, 9);

      if (source[0] !== 1 || source[1] !== object || copy === source) {
        return 10;
      }
      return copy[1] === object;
    }
  `);
  assert.equal(value, true);
});

test('Array.toSpliced does not copy named array properties', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1, 2];
      source.note = 42;
      const copy = source.toSpliced(1, 0, 9);
      return copy.note === undefined && source.note === 42;
    }
  `);
  assert.equal(value, true);
});

test('Array.toSpliced evaluates arguments left to right', async () => {
  const { value } = await run(`
    function mark(state, value) {
      state.order = state.order * 10 + value;
      return value;
    }

    function answer() {
      const state = { order: 0 };
      const source = [0, 1, 2, 3, 4];
      source.toSpliced(
        mark(state, 1),
        mark(state, 2),
        mark(state, 3),
        mark(state, 4)
      );
      return state.order;
    }
  `);
  assert.equal(value, 1234);
});

test('Array.toSpliced preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const copy = [1, 3].toSpliced(1, 0, 2);
      return copy[1];
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 2);
});
