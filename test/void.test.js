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

test('void returns undefined for represented values', async () => {
  for (const expression of ['42', '"hello"', '{ value: 1 }', '[1, 2]', 'null', 'true']) {
    const { value } = await run(`function answer(){ return void (${expression}); }`);
    assert.equal(value, undefined, expression);
  }
});

test('void evaluates its operand exactly once', async () => {
  const { value } = await run(`
    function mark(state) {
      state.count = state.count + 1;
      return 42;
    }

    function answer() {
      const state = { count: 0 };
      const ignored = void mark(state);
      if (ignored !== undefined) {
        return 10;
      }
      return state.count;
    }
  `);
  assert.equal(value, 1);
});

test('void composes with equality and typeof using unary precedence', async () => {
  const equality = await run('function answer(){ return void 0 === undefined; }');
  assert.equal(equality.value, true);

  const type = await run('function answer(){ return typeof void 0; }');
  assert.equal(type.value, 'undefined');
});

test('void can discard object-producing expressions without changing later code', async () => {
  const { value } = await run(`
    function answer() {
      void { value: 1 };
      return 42;
    }
  `);
  assert.equal(value, 42);
});

test('void preserves zero imports', async () => {
  const { module, value } = await run('function answer(){ return void 42; }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, undefined);
});
