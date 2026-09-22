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

test('typeof classifies represented primitive values', async () => {
  const cases = [
    ['undefined', 'undefined'],
    ['null', 'object'],
    ['true', 'boolean'],
    ['false', 'boolean'],
    ['42', 'number'],
    ['0 / 0', 'number'],
    ['"hello"', 'string'],
    ['"a" + "b"', 'string'],
  ];

  for (const [expression, expected] of cases) {
    const { value } = await run(`function answer(){ return typeof (${expression}); }`);
    assert.equal(value, expected, expression);
  }
});

test('typeof classifies objects and arrays as object', async () => {
  const object = await run('function answer(){ return typeof ({ value: 1 }); }');
  assert.equal(object.value, 'object');

  const array = await run('function answer(){ return typeof [1, 2, 3]; }');
  assert.equal(array.value, 'object');
});

test('typeof results participate in ordinary string equality', async () => {
  const number = await run('function answer(){ return typeof 42 === "number"; }');
  assert.equal(number.value, true);

  const mismatch = await run('function answer(){ return typeof "42" === "number"; }');
  assert.equal(mismatch.value, false);
});

test('typeof evaluates its operand exactly once', async () => {
  const { value } = await run(`
    function mark(state) {
      state.count = state.count + 1;
      return 42;
    }

    function answer() {
      const state = { count: 0 };
      const kind = typeof mark(state);
      if (kind !== "number") {
        return 10;
      }
      return state.count;
    }
  `);
  assert.equal(value, 1);
});

test('typeof binds as a unary operator', async () => {
  const negative = await run('function answer(){ return typeof -1; }');
  assert.equal(negative.value, 'number');

  const negated = await run('function answer(){ return typeof !0; }');
  assert.equal(negated.value, 'boolean');
});

test('typeof currently requires identifiers to resolve at compile time', () => {
  assert.throws(
    () => compileDynamic('function answer(){ return typeof missing; }'),
    ReferenceError,
  );
});

test('typeof preserves zero imports', async () => {
  const { module, value } = await run('function answer(){ return typeof { value: 1 }; }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 'object');
});
