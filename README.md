# wasmesc

A small playground for two related ideas:

1. Inspect how `WebAssembly.instantiate(module, {})` resolves JavaScript imports.
2. Build a JavaScript-to-WebAssembly compiler that emits ordinary core Wasm with **no imports** and **no Wasm GC dependency**.

## Import-object detail

The WebAssembly JavaScript API resolves an import by performing ordinary JavaScript property access for the module name and then the field name. Inherited properties therefore participate in lookup.

`poc/inherited-imports.js` demonstrates this with an inherited `Object.keys` lookup and also shows that a null-prototype import object does not expose `Object.prototype`.

Run it with:

```sh
npm run demo:imports
```

The compiler itself does not depend on inherited imports.

## Static backend

The first backend accepts one function with numeric parameters, `let`/`const` locals, a `return`, numeric literals, identifiers, parentheses, unary `+`/`-`, and `+ - * /`.

Values are lowered directly to `f64`, making simple numerical programs very small.

```js
export function add(a, b) {
  const doubled = b * 2;
  return a + doubled;
}
```

```sh
mkdir -p dist
node src/cli.js examples/add.js dist/add.wasm
```

## Experimental dynamic backend

The dynamic backend introduces a single internal `JSValue` ABI carried in a core-Wasm `i64`.

Numbers retain their IEEE-754 bits. Reserved quiet-NaN patterns represent:

```text
undefined
null
false
true
object pointer
string pointer
```

Arithmetic NaNs are canonicalized before returning to the tagged representation, keeping them out of the reserved tag space.

Objects live entirely in ordinary Wasm linear memory. There are no GC structs or host object imports.

Current object layout:

```text
object:
+0   head entry pointer : i32
+4   property-write count : i32

entry:
+0   next entry pointer : i32
+4   property id        : i32
+8   JSValue            : i64
```

Each property write prepends a 16-byte entry. Reads walk newest-to-oldest, which naturally gives last-write-wins behavior and lets object literals grow later through assignment without a fixed-capacity object buffer.

Static property names are interned by the compiler to unique integer IDs.

String literals are also interned by value and emitted into active Wasm data segments as UTF-16:

```text
string:
+0   UTF-16 code-unit length : i32
+4   code units              : u16[]
```

The heap begins after the aligned static-string region, so literal data and runtime objects share the same ordinary linear memory without overlapping. Equal source literals share one pointer, which gives the current strict-equality implementation JavaScript string-value semantics for compiled literals.

Example:

```js
export function answer() {
  const config = {
    inner: { value: 21 },
    enabled: true,
  };
  return config.inner.value * 2;
}
```

Compile it with:

```sh
node src/cli.js --dynamic examples/object.js dist/object.wasm
# or:
npm run compile:dynamic -- examples/object.js dist/object.wasm
```

The generated module has no imports:

```js
const module = await WebAssembly.compile(bytes);
console.log(WebAssembly.Module.imports(module)); // []
```

Dynamic function parameters/results use the tagged `i64` ABI. JavaScript therefore sees them as `bigint`; `src/jsvalue.js` contains `encodeJSValue()` and `decodeJSValue()` helpers for tests and embedding. Passing the exported memory to `decodeJSValue(bits, memory)` decodes tagged strings back to JavaScript strings.

The dynamic subset currently supports multiple top-level functions, direct calls (including forward calls and recursion), explicit exports, expression statements, numeric arithmetic and comparisons, strict equality/inequality (`===`, `!==`), unary `!`, JavaScript-style truthiness for the represented value kinds, `if`/`else`, `else if`, mutable `let`/parameter bindings, `while` loops with `break`/`continue`, primitive literals (`true`, `false`, `null`, `undefined`), interned string literals, object literals, nested objects, static member reads and writes, locals, parameters, and return values. Property assignment supports new keys, overwrites, aliases, and nested member chains. Function fallthrough produces `undefined`. It is intentionally not pretending to implement all JavaScript coercion rules yet.

## Pipeline

```text
                          ┌-> static f64 backend -> tiny core Wasm
source -> parser / AST ---|
                          └-> tagged i64 backend -> linear-memory runtime -> core Wasm
```

The binary encoder is dependency-free and writes sections/opcodes directly.

A useful next sequence is:

- string concatenation and host-side string argument encoding;
- arrays;
- proper `ToNumber` coercions and broader JavaScript comparison semantics;
- shapes/hidden classes and inline property caches once semantics are stable.

## Differential testing

`test/differential.test.js` generates a deterministic corpus of arithmetic expressions, executes each expression using Node's JavaScript engine, compiles the same expression with the dynamic backend, and checks the decoded result.

That includes edge cases produced naturally by floating-point arithmetic such as infinities, NaNs, and signed zero.

## Tests

```sh
npm test
```

Tests verify that generated modules have zero imports, tagged primitive values round-trip, interned UTF-16 strings decode from linear memory with JavaScript truthiness/equality behavior, nested objects live in linear memory, property reads/writes preserve aliasing and last-write-wins behavior, missing properties produce `undefined`, arithmetic matches Node on the differential corpus, structured control flow preserves `if`, loops, `break`, and `continue` semantics across nested Wasm labels, direct source-function calls work across forward references and recursion, and unused expression values are explicitly dropped without disturbing stack balance.

## Reference

WebAssembly JavaScript Interface, "read the imports":
https://webassembly.github.io/spec/js-api/#read-the-imports
