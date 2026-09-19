import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue, JSValue, stringPointer } from '../src/jsvalue.js';

async function run(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  const instance = result.instance ?? result;
  const name = WebAssembly.Module.exports(module).find((x) => x.kind === 'function').name;
  const raw = instance.exports[name]();
  return {
    bytes,
    module,
    instance,
    raw,
    value: decodeJSValue(raw, instance.exports.memory),
  };
}

test('returns UTF-16 string literals from linear memory', async () => {
  const { module, instance, raw, value } = await run(`
    export function answer() {
      return "Hello 🌍";
    }
  `);

  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 'Hello 🌍');
  assert.equal(raw & JSValue.TAG_MASK, JSValue.STRING);

  const pointer = stringPointer(raw);
  const view = new DataView(instance.exports.memory.buffer);
  assert.equal(view.getUint32(pointer, true), 'Hello 🌍'.length);
});

test('supports common escapes and Unicode code-point escapes', async () => {
  const { value } = await run(String.raw`
    function answer() {
      return "line\n\t\x41\u0042\u{1F600}";
    }
  `);

  assert.equal(value, 'line\n\tAB😀');
});

test('preserves lone UTF-16 surrogates', async () => {
  const { value } = await run('function answer(){ return "\\uD800"; }');
  assert.equal(value, '\uD800');
  assert.equal(value.length, 1);
});

test('interns equal literals so strict equality has string value semantics', async () => {
  const equal = await run(`
    function same() { return "value"; }
    export function answer() {
      return "value" === same();
    }
  `);
  assert.equal(equal.value, true);

  const unequal = await run('function answer(){ return "a" === "b"; }');
  assert.equal(unequal.value, false);
});

test('empty strings are falsey and non-empty strings are truthy', async () => {
  const empty = await run('function answer(){ if ("") { return 1; } return 0; }');
  assert.equal(empty.value, 0);

  const nonEmpty = await run('function answer(){ if ("x") { return 1; } return 0; }');
  assert.equal(nonEmpty.value, 1);
});

test('strings survive locals, function calls, and object storage', async () => {
  const { value } = await run(`
    function identity(value) {
      return value;
    }

    export function answer() {
      const object = { text: identity("stored") };
      return object.text;
    }
  `);

  assert.equal(value, 'stored');
});

test('decodeJSValue can expose an undecoded string pointer without memory', async () => {
  const { raw } = await run('function answer(){ return "pointer"; }');
  const descriptor = decodeJSValue(raw);
  assert.equal(descriptor.type, 'string');
  assert.equal(descriptor.pointer, stringPointer(raw));
});
