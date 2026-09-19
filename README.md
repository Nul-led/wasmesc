# wasmesc

A small playground for two related ideas:

1. Inspect how `WebAssembly.instantiate(module, {})` resolves JavaScript imports.
2. Build a tiny JavaScript-to-WebAssembly compiler that emits ordinary core Wasm with **no imports** and **no Wasm GC dependency**.

## Import-object detail

The WebAssembly JavaScript API resolves an import by performing ordinary JavaScript property access for the module name and then the field name. Inherited properties therefore participate in lookup.

`poc/inherited-imports.js` demonstrates this with an inherited `Object.keys` lookup and also shows that a null-prototype import object does not expose `Object.prototype`.

Run it with:

```sh
npm run demo:imports
```

The compiler itself does not depend on inherited imports.

## Tiny zero-import compiler

The current compiler accepts one function with numeric parameters, `let`/`const` locals, a `return`, numeric literals, identifiers, parentheses, unary `+`/`-`, and `+ - * /`.

All values are currently lowered to `f64`.

Example:

```js
export function add(a, b) {
  const doubled = b * 2;
  return a + doubled;
}
```

Compile it:

```sh
mkdir -p dist
node src/cli.js examples/add.js dist/add.wasm
```

Use it:

```js
import { readFile } from 'node:fs/promises';

const bytes = await readFile('dist/add.wasm');
const module = await WebAssembly.compile(bytes);
console.log(WebAssembly.Module.imports(module)); // []

const instance = await WebAssembly.instantiate(module, {});
console.log(instance.exports.add(2, 20)); // 42
```

## Pipeline

```text
source -> tokens -> AST -> typed locals/expressions -> Wasm binary
```

The binary encoder is dependency-free and writes Wasm sections/opcodes directly. A natural next sequence is comparisons/control flow, multiple functions and calls, integer types, then a linear-memory runtime for strings, arrays, and object-like values.

## Tests

```sh
npm test
```

The compiler tests verify that generated modules have no imports and execute correctly with `{}`.

## Reference

WebAssembly JavaScript Interface, "read the imports":
https://webassembly.github.io/spec/js-api/#read-the-imports
