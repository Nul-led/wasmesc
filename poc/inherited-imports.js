import {
  ValType,
  encodeFunctionBody,
  functionType,
  moduleBytes,
  section,
  u32,
  vec,
  wasmString,
} from '../src/wasm.js';

// This module intentionally declares constructor.keys as an import.
// WebAssembly's JS API uses ordinary property lookup, so instantiating with {}
// resolves {}.constructor -> Object and Object.keys -> Object.keys.
function buildInheritedKeysModule() {
  const typeSection = section(1, vec([
    functionType([ValType.externref], [ValType.externref]),
  ]));

  const importSection = section(2, vec([[
    ...wasmString('constructor'),
    ...wasmString('keys'),
    0x00, // func import
    ...u32(0),
  ]]));

  const functionSection = section(3, vec([[...u32(0)]]));

  const exportSection = section(7, vec([[
    ...wasmString('keys'),
    0x00,
    ...u32(1), // imported function is index 0; wrapper is index 1
  ]]));

  const codeSection = section(10, vec([
    encodeFunctionBody({
      instructions: [
        0x20, 0x00, // local.get 0
        0x10, 0x00, // call imported Object.keys
      ],
    }),
  ]));

  return moduleBytes([typeSection, importSection, functionSection, exportSection, codeSection]);
}

const bytes = buildInheritedKeysModule();
const module = await WebAssembly.compile(bytes);

console.log('declared imports:', WebAssembly.Module.imports(module));

const { exports } = await WebAssembly.instantiate(module, {});
console.log('keys({alpha: 1, beta: 2}):', exports.keys({ alpha: 1, beta: 2 }));

try {
  await WebAssembly.instantiate(module, Object.create(null));
  console.log('unexpected: null-prototype import object linked');
} catch (error) {
  console.log('null-prototype imports reject inherited lookup:', error.constructor.name);
}
