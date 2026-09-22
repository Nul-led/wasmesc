import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue } from '../src/jsvalue.js';

async function instantiate(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  return { module, instance: result.instance ?? result };
}

async function run(source) {
  const { module, instance } = await instantiate(source);
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

test('Array.with returns a changed copy without mutating the source', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1, 2, 3];
      const copy = source.with(1, 9);

      if (source[1] !== 2) {
        return 10;
      }
      if (copy === source) {
        return 20;
      }
      return copy[0] * 100 + copy[1] * 10 + copy[2];
    }
  `);
  assert.equal(value, 193);
});

test('Array.with supports negative indexes', async () => {
  const { value } = await run(`
    function answer() {
      const copy = [1, 2, 3].with(-1, 8);
      return copy[0] * 100 + copy[1] * 10 + copy[2];
    }
  `);
  assert.equal(value, 128);
});

test('Array.with truncates fractional indexes toward zero and treats NaN as zero', async () => {
  const fractional = await run(`
    function answer() {
      return [1, 2, 3].with(1.9, 7)[1];
    }
  `);
  assert.equal(fractional.value, 7);

  const nan = await run(`
    function answer() {
      return [1, 2, 3].with(0 / 0, 9)[0];
    }
  `);
  assert.equal(nan.value, 9);
});

test('Array.with creates a dense result from sparse input', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1];
      source.length = 3;
      const copy = source.with(2, 9);

      if (copy.length !== 3) {
        return 10;
      }
      if (copy.indexOf(undefined) !== 1) {
        return 20;
      }
      return copy[0] * 10 + copy[2];
    }
  `);
  assert.equal(value, 19);
});

test('Array.with is shallow for object values', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const source = [object, 1];
      const copy = source.with(1, 2);
      return copy[0] === object && source[0] === object;
    }
  `);
  assert.equal(value, true);
});

test('Array.with does not copy named array properties', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1, 2];
      source.note = 42;
      const copy = source.with(0, 9);
      return copy.note === undefined && source.note === 42;
    }
  `);
  assert.equal(value, true);
});

test('Array.with traps for out-of-range indexes', async () => {
  for (const index of ['3', '-4', '1 / 0', '-(1 / 0)']) {
    const { module, instance } = await instantiate(`
      function answer() {
        return [1, 2, 3].with(${index}, 9)[0];
      }
    `);
    const name = WebAssembly.Module.exports(module).find((x) => (
      x.kind === 'function' && x.name !== '__wasmesc_alloc'
    )).name;
    assert.throws(() => instance.exports[name](), WebAssembly.RuntimeError, index);
  }
});

test('Array.with validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].with(0); }'),
    TypeError,
  );
  assert.throws(
    () => compileDynamic('function f(){ return [1].with(0, 1, 2); }'),
    TypeError,
  );
});

test('Array.with preserves zero imports', async () => {
  const { module, value } = await run('function answer(){ return [1,2].with(0,9)[0]; }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 9);
});
