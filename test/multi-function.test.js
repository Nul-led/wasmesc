import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue, encodeJSValue } from '../src/jsvalue.js';

async function instantiate(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  return { module, instance: result.instance ?? result };
}

test('supports forward direct calls between source functions', async () => {
  const { module, instance } = await instantiate(`
    export function answer() {
      return add(20, 22);
    }

    function add(a, b) {
      return a + b;
    }
  `);

  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.deepEqual(
    WebAssembly.Module.exports(module).map((x) => [x.name, x.kind]),
    [
      ['answer', 'function'],
      ['memory', 'memory'],
      ['__wasmesc_alloc', 'function'],
    ],
  );
  assert.equal(decodeJSValue(instance.exports.answer()), 42);
});

test('supports recursive source calls', async () => {
  const { instance } = await instantiate(`
    function factorial(n) {
      if (n <= 1) {
        return 1;
      }
      return n * factorial(n - 1);
    }

    export function answer() {
      return factorial(5);
    }
  `);

  assert.equal(decodeJSValue(instance.exports.answer()), 120);
});

test('supports multiple exported functions with independent signatures', async () => {
  const { instance } = await instantiate(`
    export function add(a, b) {
      return a + b;
    }

    export function double(x) {
      return x * 2;
    }
  `);

  assert.equal(
    decodeJSValue(instance.exports.add(encodeJSValue(20), encodeJSValue(22))),
    42,
  );
  assert.equal(
    decodeJSValue(instance.exports.double(encodeJSValue(21))),
    42,
  );
});

test('shares object property ids across compiled functions', async () => {
  const { instance } = await instantiate(`
    function readValue(object) {
      return object.value;
    }

    export function answer() {
      const object = { value: 42 };
      return readValue(object);
    }
  `);

  assert.equal(decodeJSValue(instance.exports.answer()), 42);
});

test('single-function source remains exported without explicit export keyword', async () => {
  const { instance } = await instantiate('function answer(){ return 42; }');
  assert.equal(decodeJSValue(instance.exports.answer()), 42);
});

test('rejects unknown calls, arity mismatches, and duplicate functions', () => {
  assert.throws(
    () => compileDynamic('function answer(){ return missing(); }'),
    ReferenceError,
  );

  assert.throws(
    () => compileDynamic('function add(a,b){ return a+b; } export function answer(){ return add(1); }'),
    TypeError,
  );

  assert.throws(
    () => compileDynamic('function f(){ return 1; } function f(){ return 2; }'),
    SyntaxError,
  );
});

test('does not miscompile calls through local bindings as direct calls', () => {
  assert.throws(
    () => compileDynamic(`
      function helper(x){ return x; }
      export function answer(){
        const helper = 42;
        return helper();
      }
    `),
    SyntaxError,
  );
});
