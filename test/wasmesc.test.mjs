import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compile, build, emitWat, MAX_SOURCE_UNITS } from '../src/compiler.mjs';
import { importFixture } from '../src/probe.mjs';
import { u32, i32, WasmModule } from '../src/wasm.mjs';

async function load(source, options) {
  const bytes = compile(source, options);
  assert.equal(WebAssembly.validate(bytes), true);
  return (await WebAssembly.instantiate(bytes, {})).instance;
}
async function run(source) { return (await load(source)).exports.run(); }

for (const [label, expression, expected] of [
  ['number', '6 * 7', 42], ['undefined', 'undefined', undefined],
  ['null', 'null', null], ['boolean', 'true', true], ['NaN', 'NaN', NaN],
  ['negative zero', '-0', -0], ['infinity', 'Infinity', Infinity],
  ['bigint', '123456789012345678901234567890n', 123456789012345678901234567890n],
  ['symbol', 'Symbol.for("wasmesc-test")', Symbol.for('wasmesc-test')],
]) {
  test(`preserves ${label} return values`, async () => assert.ok(Object.is(await run(`return ${expression};`), expected)));
}

test('objects, arrays, functions, and promises survive the externref boundary', async () => {
  assert.deepEqual(await run('return { answer: 42, values: [1, undefined, null] };'), { answer: 42, values: [1, undefined, null] });
  assert.equal((await run('return x => x + 1;'))(41), 42);
  const instance = await load('return Promise.resolve(42);');
  const value = instance.exports.run();
  assert.ok(value instanceof Promise);
  assert.equal(await value, 42);
});

test('UTF-16 round trips: Unicode, raw lone surrogates, NUL and escaping', async () => {
  for (const value of ['Hello 🌍 — Καλημέρα — 日本語', '"\'\\\n\r\t', '\0', '\ud800', '\udfff', 'a\u2028b\u2029c']) {
    assert.equal(await run(`return ${JSON.stringify(value)};`), value);
  }
  assert.equal(await run('return "' + String.fromCharCode(0xd800) + '";'), '\ud800');
  assert.equal(await run('return "' + String.fromCharCode(0) + '";'), '\0');
});

test('deterministic mixed Unicode stress sample', async () => {
  let state = 0x12345678;
  let text = '';
  for (let i = 0; i < 1024; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    text += String.fromCharCode(state & 0xffff);
  }
  assert.equal(await run(`return ${JSON.stringify(text)};`), text);
});

test('empty body, trailing comment, strict prologue, arguments and global this', async () => {
  assert.equal(await run(''), undefined);
  assert.equal(await run('return 42; // trailing comment'), 42);
  assert.equal(await run('"use strict"; return this;'), undefined);
  assert.equal(await run('return arguments.length;'), 0);
  assert.equal(await run('return this === globalThis;'), true);
});

test('ordinary instantiation does not run the payload; repeated run calls do', async () => {
  const key = '__wasmesc_counter_test__';
  assert.equal(Object.hasOwn(globalThis, key), false);
  try {
    const instance = await load(`globalThis.${key} = (globalThis.${key} ?? 0) + 1; return globalThis.${key};`);
    assert.equal(Object.hasOwn(globalThis, key), false);
    assert.equal(instance.exports.run(), 1);
    assert.equal(instance.exports.run(), 2);
  } finally { delete globalThis[key]; }
});

test('autoRun executes in the start function; exported run remains callable', async () => {
  const key = '__wasmesc_start_test__';
  try {
    const instance = await load(`globalThis.${key} = (globalThis.${key} ?? 0) + 1; return globalThis.${key};`, { autoRun: true });
    assert.equal(globalThis[key], 1);
    assert.equal(instance.exports.run(), 2);
  } finally { delete globalThis[key]; }
});

test('JS exceptions propagate; failing payload can be called again', async () => {
  const instance = await load('throw new RangeError("intentional test");');
  for (let i = 0; i < 2; i++) assert.throws(() => instance.exports.run(), { name: 'RangeError', message: 'intentional test' });
});

test('JS syntax errors occur on run, not binary generation, and are not cached', async () => {
  const instance = await load('return (;');
  for (let i = 0; i < 2; i++) assert.throws(() => instance.exports.run(), SyntaxError);
  await assert.rejects(load('return (;', { autoRun: true }), SyntaxError);
});

test('{} and frozen {} work; null prototype, shadowed constructor and omitted imports fail', async () => {
  const bytes = compile('return 42;');
  assert.equal((await WebAssembly.instantiate(bytes, Object.freeze({}))).instance.exports.run(), 42);
  for (const imports of [Object.create(null), { constructor: undefined }]) {
    await assert.rejects(WebAssembly.instantiate(bytes, imports), TypeError);
  }
  await assert.rejects(WebAssembly.instantiate(bytes), TypeError);
});

test('prototype is a global, not callable; dots are literal; call is unbound', async () => {
  await WebAssembly.instantiate(importFixture('constructor', 'prototype', { global: true }), {});
  await assert.rejects(WebAssembly.instantiate(importFixture('constructor', 'prototype'), {}), WebAssembly.LinkError);
  await assert.rejects(WebAssembly.instantiate(importFixture('constructor.constructor', 'call'), {}), TypeError);
  await assert.rejects(WebAssembly.instantiate(importFixture('constructor', 'constructor.call'), {}), WebAssembly.LinkError);
  const { instance } = await WebAssembly.instantiate(importFixture('constructor', 'call', { invoke: true }), {});
  assert.throws(() => instance.exports.run(), TypeError);
});

test('the module has inherited imports, not zero imports or injected strings', async () => {
  const bytes = compile('return 42;');
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  assert.equal(imports.length, 24);
  assert.ok(imports.every(i => ['function', 'global'].includes(i.kind)));
  assert.ok(imports.some(i => i.module === 'constructor' && i.name === 'constructor' && i.kind === 'function'));
  assert.deepEqual(WebAssembly.Module.exports(module), [{ name: 'run', kind: 'function' }]);
  const instance = new WebAssembly.Instance(module, {});
  assert.equal(instance.exports.run(), 42);
});

test('does not mutate import object, constructors, or built-in prototypes', async () => {
  const imports = {};
  const objects = [imports, Object, Function, String, Number, Array, Object.prototype, Function.prototype, String.prototype, Number.prototype, Array.prototype];
  const before = objects.map(Object.getOwnPropertyDescriptors);
  const { instance } = await WebAssembly.instantiate(compile('return 42;'), imports);
  assert.equal(instance.exports.run(), 42);
  objects.forEach((object, i) => assert.deepEqual(Object.getOwnPropertyDescriptors(object), before[i]));
});

test('fresh JS realm, frozen intrinsics, and no compiler closures', () => {
  const context = vm.createContext({ bytes: compile('return 42;') });
  const result = vm.runInContext(`
    for (const value of [Object, Function, String, Number, Array, Object.prototype, Function.prototype, String.prototype, Number.prototype, Array.prototype]) Object.freeze(value);
    new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.run();
  `, context, { timeout: 5000 });
  assert.equal(result, 42);
});

test('does not depend on Object or String property enumeration order', () => {
  const context = vm.createContext({ bytes: compile('return 42;') });
  const result = vm.runInContext(`
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'constructor');
    delete Object.prototype.constructor;
    Object.defineProperty(Object.prototype, 'constructor', descriptor);
    const charDescriptor = Object.getOwnPropertyDescriptor(String, 'fromCharCode');
    delete String.fromCharCode;
    Object.defineProperty(String, 'fromCharCode', charDescriptor);
    new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.run();
  `, context, { timeout: 5000 });
  assert.equal(result, 42);
});

test('dynamic JS code-generation restrictions are respected', () => {
  const context = vm.createContext({ bytes: compile('return 42;') }, { codeGeneration: { strings: false, wasm: true } });
  assert.throws(() => vm.runInContext('new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.run()', context), { name: 'EvalError' });
});

test('missing groupBy fails linking rather than pretending it is supported', () => {
  const context = vm.createContext({ bytes: compile('return 42;') });
  assert.throws(() => vm.runInContext('delete Object.groupBy; new WebAssembly.Instance(new WebAssembly.Module(bytes), {})', context), { name: 'LinkError' });
});

test('data and section lengths work across a 64 KiB memory-page boundary', async () => {
  assert.equal(await run(' '.repeat(40_000) + 'return 42;'), 42);
});

test('binary is deterministic; WAT uses no GC or string proposal operations', () => {
  const { bytes, wat } = build('return 42;');
  assert.deepEqual(bytes, compile('return 42;'));
  assert.equal(wat, emitWat('return 42;'));
  assert.match(wat, /\(result externref externref externref externref\)/);
  assert.doesNotMatch(wat, /\((?:struct\.|array\.|ref\.cast|call_ref|extern\.convert_any|any\.convert_extern|string\.)/);
});

test('input validation and integer encodings', () => {
  for (const value of [null, 42, {}, []]) assert.throws(() => compile(value), TypeError);
  assert.throws(() => compile('x'.repeat(MAX_SOURCE_UNITS + 1)), RangeError);
  for (const options of [null, [], { autoRun: 1 }, { start: true }]) assert.throws(() => compile('', options), TypeError);
  assert.deepEqual(u32(624485), [0xe5, 0x8e, 0x26]);
  assert.deepEqual(u32(0xffffffff), [0xff, 0xff, 0xff, 0xff, 0x0f]);
  assert.deepEqual(i32(-123456), [0xc0, 0xbb, 0x78]);
  for (const value of [-1, 0x100000000, 1.5]) assert.throws(() => u32(value), RangeError);
  for (const value of [-0x80000001, 0x80000000, 1.5]) assert.throws(() => i32(value), RangeError);
  for (const value of [-0x80000000, -65, -64, 0, 63, 64, 0x7fffffff]) {
    const m = new WasmModule();
    m.func('$run', [], ['i32'], [], [['i32.const', value]]);
    m.exportFunction('run', '$run');
    assert.equal(new WebAssembly.Instance(new WebAssembly.Module(m.toBytes())).exports.run(), value);
  }
});

test('CLI compiles, runs in a separate process, emits WAT, and rejects overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wasmesc-'));
  const cli = resolve('bin/wasmesc.mjs');
  try {
    const input = join(dir, 'demo.body.js');
    const wasm = join(dir, 'nested', 'demo.wasm');
    const wat = join(dir, 'nested', 'demo.wat');
    writeFileSync(input, 'return 42;');
    execFileSync(process.execPath, [cli, 'compile', input, '-o', wasm, '--wat', wat]);
    assert.equal(execFileSync(process.execPath, [cli, 'run', wasm], { encoding: 'utf8' }).trim(), '42');
    assert.ok(readFileSync(wat, 'utf8').startsWith('(module'));
    const bad = spawnSync(process.execPath, [cli, 'compile', input, '-o', input]);
    assert.equal(bad.status, 1);
    assert.equal(readFileSync(input, 'utf8'), 'return 42;');
    execFileSync(process.execPath, [cli, 'compile', input, '-o', wasm, '--start']);
    assert.equal(execFileSync(process.execPath, [cli, 'run', wasm, '--instantiate-only'], { encoding: 'utf8' }), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
