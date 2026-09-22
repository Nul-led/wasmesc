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

test('Array.toReversed returns a reversed copy without mutating the source', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1, 2, 3];
      const copy = source.toReversed();

      if (source[0] !== 1 || source[2] !== 3) {
        return 10;
      }
      if (copy === source) {
        return 20;
      }
      return copy[0] * 100 + copy[1] * 10 + copy[2];
    }
  `);
  assert.equal(value, 321);
});

test('Array.toReversed preserves sparse holes', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1];
      source.length = 4;
      source[3] = 9;
      const copy = source.toReversed();

      if (copy.length !== 4) {
        return 10;
      }
      if (copy[0] !== 9 || copy[3] !== 1) {
        return 20;
      }
      if (copy.indexOf(undefined) !== -1) {
        return 30;
      }
      return 42;
    }
  `);
  assert.equal(value, 42);
});

test('Array.toReversed is shallow for object values', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const copy = [object, 1].toReversed();
      return copy[1] === object;
    }
  `);
  assert.equal(value, true);
});

test('Array.toReversed does not copy named array properties', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1, 2];
      source.note = 42;
      const copy = source.toReversed();
      return copy.note === undefined && source.note === 42;
    }
  `);
  assert.equal(value, true);
});

test('mutating a toReversed result does not mutate the source array', async () => {
  const { value } = await run(`
    function answer() {
      const source = [1, 2, 3];
      const copy = source.toReversed();
      copy[0] = 9;
      return source[2] * 10 + copy[0];
    }
  `);
  assert.equal(value, 39);
});

test('Array.toReversed works for empty and singleton arrays', async () => {
  const empty = await run('function answer(){ return [].toReversed().length; }');
  assert.equal(empty.value, 0);

  const single = await run('function answer(){ return [42].toReversed()[0]; }');
  assert.equal(single.value, 42);
});

test('Array.toReversed validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].toReversed(1); }'),
    TypeError,
  );
});

test('Array.toReversed preserves zero imports', async () => {
  const { module, value } = await run('function answer(){ return [1,2].toReversed()[0]; }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 2);
});
