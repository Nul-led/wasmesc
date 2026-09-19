import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue } from '../src/jsvalue.js';

async function run(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  const instance = result.instance ?? result;
  const name = WebAssembly.Module.exports(module).find((x) => x.kind === 'function').name;
  return { module, value: decodeJSValue(instance.exports[name]()) };
}

test('supports side-effect-only function call statements', async () => {
  const { module, value } = await run(`
    function setAnswer(object, value) {
      object.answer = value;
    }

    export function answer() {
      const object = {};
      setAnswer(object, 42);
      return object.answer;
    }
  `);

  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 42);
});

test('drops unused arithmetic expression results', async () => {
  const { value } = await run(`
    function answer() {
      1 + 2;
      3 * 4;
      return 42;
    }
  `);
  assert.equal(value, 42);
});

test('expression statements work inside loops and conditionals', async () => {
  const { value } = await run(`
    function bump(object) {
      object.value = object.value + 1;
    }

    export function answer() {
      const object = { value: 0 };
      let i = 0;
      while (i < 4) {
        if (i !== 2) {
          bump(object);
        }
        i = i + 1;
      }
      return object.value;
    }
  `);
  assert.equal(value, 3);
});

test('object and member expression statements keep stack balance', async () => {
  const { value } = await run(`
    function answer() {
      const object = { value: 42 };
      object.value;
      { ignored: 1 };
      return object.value;
    }
  `);
  assert.equal(value, 42);
});
