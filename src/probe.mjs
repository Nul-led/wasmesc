import { compile } from './compiler.mjs';
import { WasmModule } from './wasm.mjs';

/** Minimal import fixture, also used to test the exact two-name lookup rules. */
export function importFixture(moduleName, field, { global = false, invoke = false } = {}) {
  const m = new WasmModule();
  if (global) m.importGlobal('$value', moduleName, field);
  else {
    m.importFunction('$value', moduleName, field, [], []);
    if (invoke) {
      m.func('$run', [], [], [], [['call', '$value']]);
      m.exportFunction('run', '$run');
    }
  }
  return m.toBytes();
}

export async function probe() {
  const rows = [];
  async function check(label, action) {
    try { rows.push({ check: label, result: String(await action()) }); }
    catch (error) { rows.push({ check: label, result: `${error.name}: ${error.message}` }); }
  }
  for (const field of ['keys', 'values', 'getOwnPropertyNames', 'constructor', 'groupBy', 'prototype']) {
    await check(`constructor.${field}`, async () => {
      await WebAssembly.instantiate(importFixture('constructor', field, { global: field === 'prototype' }), {});
      return `linked as ${field === 'prototype' ? 'externref global' : 'function'}`;
    });
  }
  const bytes = compile('return 42;');
  for (const [label, imports] of [['{}', {}], ['Object.freeze({})', Object.freeze({})], ['Object.create(null)', Object.create(null)]]) {
    await check(`run with ${label}`, async () => (await WebAssembly.instantiate(bytes, imports)).instance.exports.run());
  }
  await check('literal dotted module name', () => WebAssembly.instantiate(importFixture('constructor.constructor', 'call'), {}));
  await check('unbound constructor.call()', async () => {
    const { instance } = await WebAssembly.instantiate(importFixture('constructor', 'call', { invoke: true }), {});
    return instance.exports.run();
  });
  return rows;
}
