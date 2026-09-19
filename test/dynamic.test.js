import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue, encodeJSValue, JSValue } from '../src/jsvalue.js';

async function run(source, args = []) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  const name = WebAssembly.Module.exports(module).find((x) => x.kind === 'function').name;
  return {
    bytes,
    module,
    instance,
    raw: instance.exports[name](...args.map(encodeJSValue)),
  };
}

test('JSValue codec round-trips primitive values', () => {
  for (const value of [0, -0, 1.5, -42, Infinity, -Infinity, NaN, true, false, null, undefined]) {
    const decoded = decodeJSValue(encodeJSValue(value));
    if (Number.isNaN(value)) assert.ok(Number.isNaN(decoded));
    else assert.ok(Object.is(decoded, value), `${String(value)} did not round-trip`);
  }
  assert.equal(JSValue.OBJECT & JSValue.TAG_MASK, JSValue.OBJECT);
});

test('dynamic backend has no imports and uses core memory', async () => {
  const { module, instance, raw } = await run('export function answer(){ return 40 + 2; }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(decodeJSValue(raw), 42);
  assert.ok(instance.exports.memory instanceof WebAssembly.Memory);
});

test('stores JSValues in linear-memory objects', async () => {
  const { raw } = await run(`
    export function answer() {
      const outer = { inner: { value: 21 }, ignored: false };
      return outer.inner.value * 2;
    }
  `);
  assert.equal(decodeJSValue(raw), 42);
});

test('missing and duplicate properties follow the intended JS behavior', async () => {
  const duplicate = await run('function f(){ const o={a:1,a:7}; return o.a; }');
  assert.equal(decodeJSValue(duplicate.raw), 7);

  const missing = await run('function f(){ const o={a:1}; return o.missing; }');
  assert.equal(decodeJSValue(missing.raw), undefined);
});

test('dynamic numeric parameters use the tagged i64 ABI', async () => {
  const { raw } = await run('function f(a,b){ return a * 2 + b; }', [20, 2]);
  assert.equal(decodeJSValue(raw), 42);
});
