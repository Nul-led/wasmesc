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

test('invalid numeric array indexes return undefined without trapping', async () => {
  for (const expression of ['1.5', '-1', '0 / 0', '1 / 0', '2147483648']) {
    const { value } = await run(`
      function read(array, index) {
        return array[index];
      }

      export function answer() {
        const array = [10, 20, 30];
        return read(array, ${expression});
      }
    `);
    assert.equal(value, undefined, expression);
  }
});

test('invalid numeric writes do not change array length or elements', async () => {
  const length = await run(`
    function answer() {
      const array = [10, 20];
      array[1.5] = 99;
      array[-1] = 88;
      array[0 / 0] = 77;
      return array.length;
    }
  `);
  assert.equal(length.value, 2);

  const first = await run(`
    function answer() {
      const array = [10, 20];
      array[1.5] = 99;
      return array[1];
    }
  `);
  assert.equal(first.value, 20);
});

test('negative zero is canonicalized to array index zero', async () => {
  const { value } = await run(`
    function answer() {
      const array = [42];
      return array[-0];
    }
  `);
  assert.equal(value, 42);
});

test('numeric string literal indexes access array elements', async () => {
  const read = await run(`
    function answer() {
      const array = [10, 20, 30];
      return array["1"];
    }
  `);
  assert.equal(read.value, 20);

  const write = await run(`
    function answer() {
      const array = [10];
      array["2"] = 42;
      return array[2];
    }
  `);
  assert.equal(write.value, 42);
});

test('non-canonical numeric strings are named properties, not element indexes', async () => {
  const value = await run(`
    function answer() {
      const array = [10];
      array["01"] = 42;
      return array["01"];
    }
  `);
  assert.equal(value.value, 42);

  const length = await run(`
    function answer() {
      const array = [10];
      array["01"] = 42;
      return array.length;
    }
  `);
  assert.equal(length.value, 1);
});

test('large numeric-looking string keys remain named properties', async () => {
  const { value } = await run(`
    function answer() {
      const array = [1];
      array["2147483648"] = 42;
      return array["2147483648"];
    }
  `);
  assert.equal(value, 42);
});

test('named string bracket properties work on arrays and objects', async () => {
  const array = await run(`
    function answer() {
      const value = [];
      value["note"] = 42;
      return value.note;
    }
  `);
  assert.equal(array.value, 42);

  const object = await run(`
    function answer() {
      const value = { note: 42 };
      return value["note"];
    }
  `);
  assert.equal(object.value, 42);
});

test('bracketed length uses array length semantics', async () => {
  const { value } = await run(`
    function answer() {
      const array = [10, 20, 30];
      array["length"] = 1;
      return array[1];
    }
  `);
  assert.equal(value, undefined);
});

test('safe index coercion preserves zero imports', async () => {
  const { module, value } = await run(`
    function answer() {
      const array = [10, 20];
      return array["1"];
    }
  `);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 20);
});
