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

test('Array.reverse reverses numeric elements in place', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      array.reverse();
      return array[0] * 100 + array[1] * 10 + array[2];
    }
  `);
  assert.equal(value, 321);
});

test('Array.reverse returns the same array object', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      return array.reverse() === array;
    }
  `);
  assert.equal(value, true);
});

test('Array.reverse preserves sparse holes', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1];
      array.length = 3;
      array.reverse();

      if (array.length !== 3) {
        return 10;
      }
      if (array[2] !== 1) {
        return 20;
      }
      if (array.indexOf(undefined) !== -1) {
        return 30;
      }
      return 42;
    }
  `);
  assert.equal(value, 42);
});

test('Array.reverse preserves named properties', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      array.note = 42;
      array.reverse();
      return array.note + array[0];
    }
  `);
  assert.equal(value, 45);
});

test('Array.reverse mutations are visible through aliases', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1, 2, 3];
      const alias = array;
      alias.reverse();
      return array[0] * 100 + array[2];
    }
  `);
  assert.equal(value, 301);
});

test('Array.reverse preserves object and string JSValues', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      const array = [object, "middle", "last"];
      array.reverse();
      return array[2] === object && array[0] === "last";
    }
  `);
  assert.equal(value, true);
});

test('reversing twice restores numeric layout including holes', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1];
      array.length = 4;
      array[3] = 9;
      array.reverse();
      array.reverse();

      if (array[0] !== 1 || array[3] !== 9) {
        return 10;
      }
      if (array.indexOf(undefined) !== -1) {
        return 20;
      }
      return array.length;
    }
  `);
  assert.equal(value, 4);
});

test('Array.reverse works for empty and singleton arrays', async () => {
  const empty = await run('function answer(){ const a=[]; a.reverse(); return a.length; }');
  assert.equal(empty.value, 0);

  const single = await run('function answer(){ const a=[42]; a.reverse(); return a[0]; }');
  assert.equal(single.value, 42);
});

test('Array.reverse validates arity at compile time', () => {
  assert.throws(
    () => compileDynamic('function f(){ return [1].reverse(1); }'),
    TypeError,
  );
});

test('Array.reverse preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const array = [1, 2];
      array.reverse();
      return array[0];
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 2);
});
