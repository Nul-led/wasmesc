import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic, parseDynamic } from '../src/dynamic.js';
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

test('parser gives && higher precedence than ||', () => {
  const program = parseDynamic('function f(){ return false || true && false; }');
  const expression = program.functions[0].statements[0].value;
  assert.equal(expression.op, '||');
  assert.equal(expression.right.op, '&&');
});

test('logical AND returns operand values', async () => {
  const falsey = await run('function answer(){ return 0 && 42; }');
  assert.equal(falsey.value, 0);

  const truthy = await run('function answer(){ return 1 && 42; }');
  assert.equal(truthy.value, 42);

  const string = await run('function answer(){ return "x" && "y"; }');
  assert.equal(string.value, 'y');
});

test('logical OR returns operand values', async () => {
  const truthy = await run('function answer(){ return 5 || 42; }');
  assert.equal(truthy.value, 5);

  const falsey = await run('function answer(){ return 0 || 42; }');
  assert.equal(falsey.value, 42);

  const string = await run('function answer(){ return "" || "fallback"; }');
  assert.equal(string.value, 'fallback');
});

test('logical operators preserve object identity', async () => {
  const orValue = await run(`
    function answer() {
      const object = { value: 42 };
      return (object || { value: 0 }) === object;
    }
  `);
  assert.equal(orValue.value, true);

  const andValue = await run(`
    function answer() {
      const object = { value: 42 };
      return (object && object) === object;
    }
  `);
  assert.equal(andValue.value, true);
});

test('false && skips the right-hand side', async () => {
  const { value } = await run(`
    function mutate(object) {
      object.value = 99;
      return true;
    }

    export function answer() {
      const object = { value: 1 };
      false && mutate(object);
      return object.value;
    }
  `);
  assert.equal(value, 1);
});

test('true || skips the right-hand side', async () => {
  const { value } = await run(`
    function mutate(object) {
      object.value = 99;
      return false;
    }

    export function answer() {
      const object = { value: 1 };
      true || mutate(object);
      return object.value;
    }
  `);
  assert.equal(value, 1);
});

test('required right-hand sides still execute', async () => {
  const andValue = await run(`
    function mutate(object) {
      object.value = 99;
      return 7;
    }

    export function answer() {
      const object = { value: 1 };
      true && mutate(object);
      return object.value;
    }
  `);
  assert.equal(andValue.value, 99);

  const orValue = await run(`
    function mutate(object) {
      object.value = 88;
      return 7;
    }

    export function answer() {
      const object = { value: 1 };
      false || mutate(object);
      return object.value;
    }
  `);
  assert.equal(orValue.value, 88);
});

test('nested logical expressions safely reuse the scratch local', async () => {
  const { value } = await run(`
    function answer() {
      return (0 || 5) && ("" || "nested");
    }
  `);
  assert.equal(value, 'nested');
});

test('logical expressions work directly as conditions', async () => {
  const { value } = await run(`
    function answer() {
      if (0 || 1) {
        return 42;
      }
      return 0;
    }
  `);
  assert.equal(value, 42);
});

test('logical precedence composes with equality and arithmetic', async () => {
  const { value } = await run(`
    function answer() {
      return false || 2 + 3 * 4 === 14 && 42;
    }
  `);
  assert.equal(value, 42);
});

test('logical operators preserve zero imports', async () => {
  const { module, value } = await run('function answer(){ return 0 || 42; }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 42);
});
