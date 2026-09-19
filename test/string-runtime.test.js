import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue, encodeJSValue, JSValue } from '../src/jsvalue.js';

async function instantiate(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  return { module, instance: result.instance ?? result };
}

function embedding(instance) {
  return {
    memory: instance.exports.memory,
    alloc: instance.exports.__wasmesc_alloc,
  };
}

test('concatenates compiled strings in linear memory', async () => {
  const { module, instance } = await instantiate(`
    export function answer() {
      return "Hello, " + "world 🌍";
    }
  `);

  const raw = instance.exports.answer();
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(raw & JSValue.TAG_MASK, JSValue.STRING);
  assert.equal(decodeJSValue(raw, instance.exports.memory), 'Hello, world 🌍');
});

test('numeric addition still uses number semantics', async () => {
  const { instance } = await instantiate('function answer(){ return 20 + 22; }');
  assert.equal(decodeJSValue(instance.exports.answer()), 42);
});

test('host strings can be encoded into the module heap', async () => {
  const { instance } = await instantiate('export function echo(value){ return value; }');
  const host = embedding(instance);
  const input = encodeJSValue('from host 😀', host);
  const raw = instance.exports.echo(input);
  assert.equal(decodeJSValue(raw, instance.exports.memory), 'from host 😀');
});

test('host-provided strings concatenate with other strings', async () => {
  const { instance } = await instantiate(`
    export function join(left, right) {
      return left + right;
    }
  `);
  const host = embedding(instance);
  const left = encodeJSValue('left-', host);
  const right = encodeJSValue('right', host);
  const raw = instance.exports.join(left, right);
  assert.equal(decodeJSValue(raw, instance.exports.memory), 'left-right');
});

test('strict equality compares string contents, not pointers', async () => {
  const { instance } = await instantiate(`
    export function same(a, b) {
      return a === b;
    }
  `);
  const host = embedding(instance);

  const a = encodeJSValue('equal', host);
  const b = encodeJSValue('equal', host);
  assert.notEqual(a, b);
  assert.equal(decodeJSValue(instance.exports.same(a, b)), true);

  const c = encodeJSValue('different', host);
  assert.equal(decodeJSValue(instance.exports.same(a, c)), false);
});

test('concatenation preserves empty strings and lone surrogates', async () => {
  const { instance } = await instantiate(`
    export function join(a, b) {
      return a + b;
    }
  `);
  const host = embedding(instance);

  const empty = encodeJSValue('', host);
  const lone = encodeJSValue('\uD800', host);
  const raw = instance.exports.join(empty, lone);
  const value = decodeJSValue(raw, instance.exports.memory);
  assert.equal(value, '\uD800');
  assert.equal(value.length, 1);
});

test('encoding strings requires the embedding allocator', () => {
  assert.throws(() => encodeJSValue('missing runtime'), TypeError);
});
