# wasmesc

A small, dependency-free proof of concept that packages a JavaScript **function body** into a standalone `.wasm` file and executes it with a literal empty import object:

```js
const { instance } = await WebAssembly.instantiate(bytes, {});
console.log(instance.exports.run());
```

No custom host imports, injected source strings, compiler closures, prototype pollution, Wasm GC instructions, or special compilation options are needed. **There are still Wasm imports**: ordinary JavaScript property lookup resolves them through the prototype chain of `{}`.

This is an interop/bootstrap PoC and source packager, **not yet an AST-to-Wasm compiler**. The generated module reconstructs its embedded source and invokes the host's `Function` constructor. Arithmetic in the input still executes as JavaScript.

## Run it

Node 22+ is the intended CLI environment; verified locally with **Node v22.16.0**. There are no npm dependencies to install.

```sh
npm test
npm run demo
npm run probe
```

The demo prints:

```text
Hello from Wasm instantiated with {}
{ answer: 42, text: 'Hello 🌍', squares: [ 1, 4, 9, 16 ] }
```

Compile your own body and inspect the generated WAT:

```sh
node bin/wasmesc.mjs compile examples/hello.body.js -o dist/hello.wasm --wat dist/hello.wat
node bin/wasmesc.mjs run dist/hello.wasm
```

To execute during instantiation instead of requiring an initial `run()` call:

```sh
node bin/wasmesc.mjs compile examples/hello.body.js -o dist/start.wasm --start
node bin/wasmesc.mjs run dist/start.wasm --instantiate-only
```

A `--start` module still exports `run()`. Calling it executes the body again. A start function discards the result and does not await a returned promise.

## API

```js
import { compile, build, emitWat } from './src/compiler.mjs';

const bytes = compile('return { answer: 6 * 7, text: "Hello 🌍" };');
const { instance } = await WebAssembly.instantiate(bytes, {});
console.log(instance.exports.run()); // { answer: 42, text: 'Hello 🌍' }

const artifacts = build('return 42;'); // { bytes: Uint8Array, wat: string }
const wat = emitWat('return 42;');
const startsImmediately = compile('console.log("started");', { autoRun: true });
```

`compile`, `build`, and `emitWat` are synchronous and do not execute the input. JavaScript syntax is checked by the host `Function` constructor on the first `run()`, or during instantiation with `autoRun`. Input is capped at 1,000,000 UTF-16 code units.

Input follows function-body syntax: `return` is accepted; static `import`/`export` and top-level `await` are not. Return an async IIFE or a promise when needed. Execution uses the imported intrinsics' global realm, not the compiler's lexical scope. The wrapper preserves a strict directive prologue and supplies zero arguments; it does change stack traces and function/caller introspection.

The first run caches the constructed function. Later runs invoke it again. Actual return values survive the `externref` boundary, including objects, functions, symbols, BigInt, promises, `undefined`, and negative zero. Exceptions propagate normally.

## Why `{}` works

An ordinary Wasm import has two literal names. In a normal JavaScript realm, lookup behaves like:

```js
imports[moduleName][fieldName]

({}).constructor.keys        === Object.keys;
({}).constructor.constructor === Function;
({}).constructor.prototype   === Object.prototype;
```

Corresponding WAT imports include:

```wat
(import "constructor" "keys" (func $keys (param externref) (result externref)))
(import "constructor" "constructor" (func $Function (param externref) (result externref)))
(import "constructor" "prototype" (global $objectPrototype externref))
```

`constructor.prototype` is an object, so importing it as a **function** fails. Dots are not path syntax: a module name of `"constructor.constructor"` does not walk two properties. Also, imported functions are called with `this = undefined`; merely importing `constructor.call` or `constructor.apply` does not provide a bound invocation primitive.

## Bootstrap, entirely inside Wasm

1. **Read descriptor values.** Import `Object.values` with four return values. The JS/Wasm multi-value conversion unpacks the iterable `[value, writable, enumerable, configurable]` returned for a data descriptor. Drop the final three values to read an own property. This is also how the module reads array elements without a host `get` helper.
2. **Create properties holding object references.** Obtain the native `Object.prototype.__proto__` accessor descriptor. On a new descriptor object `d = Object.create(v)`, install that accessor as `d.value`. Reading `d.value` returns `v`. `Object.defineProperty` can consequently install the reference on another fresh object. Numeric character codes are boxed with `Object(code)`.
3. **Build strings from linear memory.** Discover `String` through the prototype of the imported native name `"Object"`. Resolve `String.fromCharCode` and `String.raw`. `Object.groupBy([boxedCode], String.fromCharCode)` calls the callback with `(boxedCode, 0)`, producing a group key containing the desired UTF-16 unit plus NUL. Copy just the first character's descriptor into a fresh raw-parts array. Cache descriptors per code unit.
4. **Join and execute.** Call `String.raw` through `groupBy` on a one-element template array, then recover the source from the resulting object's key. The extra callback index inserts `0`; the generated body accommodates it as `0;return (function(){ ...user body... })();`. Construct the function with the inherited `Function` import. Invoke it as an enumerable getter on a fresh object, and recover its actual return value via `Object.values`.

Native property names are discovered by matching characters from inherited function-name strings, not by assuming an engine's property enumeration order. The initial `from?har?ode` match is required to be unique; both missing uppercase Cs are subsequently checked against `fromCharCode(67)`. Missing or ambiguous bootstrap properties fail rather than being silently substituted. Descriptor-field ordering and the sole `length` property of an empty array are the only positional bootstrap seeds.

Only newly allocated objects are written. Built-in prototypes and the supplied import object are left unchanged; the suite also runs the module in a separate realm with frozen intrinsics.

## Requirements and boundaries

| Requirement | Used? |
| --- | --- |
| Basic Wasm numeric instructions, linear memory and globals | Yes |
| Reference types (`externref`, `ref.null`, `ref.is_null`) | Yes |
| Multi-value function returns | Yes |
| Wasm GC structs, arrays, casts, or conversion instructions | No |
| Wasm string builtins / imported string constants | No |
| Custom JavaScript import functions | No |
| JavaScript `Object.groupBy` and legacy prototype accessors | Yes |
| Host JavaScript allocation and garbage collection | Yes |

This is **not MVP-only Wasm**, and it is not independent of the JavaScript host. Browser execution is expected only where these features are present, but browser engines have not been tested here. It is not a standalone WASI module.

The bootstrap assumes ordinary, compatible intrinsics. `Object.create(null)` as the import object blocks this prototype route; freezing `{}` does not. Dynamic-code restrictions still apply: this is not a CSP or disabled-`Function` bypass. The tests verify rejection when JavaScript string compilation is disabled in a Node VM context.

The source remains recoverable from the Wasm data section. This is not an obfuscation guarantee, and there are no performance claims. Avoid treating `{}` as a capability-free import object when loading untrusted modules.

## Tests and layout

`npm test` runs 29 tests covering actual Wasm execution, literal-name linking, receiver binding, null-prototype rejection, frozen objects, value preservation, Unicode (including raw lone surrogates and NUL), repeated execution, start functions, exceptions, syntax errors, code-generation restrictions, reordered intrinsic properties, large data sections, integer encodings, and CLI execution in a separate process.

`return 42;` produces a 2,479-byte module in this revision; the included hello example produces 2,894 bytes. These are file sizes, not benchmark results.

```text
src/wasm.mjs          Small shared-IR binary/WAT emitter
src/compiler.mjs      Bootstrap generator and public API
src/probe.mjs         Minimal import/linking fixtures and capability probe
bin/wasmesc.mjs       CLI
examples/hello.body.js
test/wasmesc.test.mjs
```

## Toward an actual compiler

Keep this bootstrap as a host-interoperation backend. Next, define a small cached ABI for property access, calls, construction, and dynamic JS operators; add an AST frontend; lower numeric operations, locals, control flow, and suitable functions to real Wasm instructions. Keep unsupported semantics explicit rather than silently falling back to whole-program evaluation. Choose between opaque JS references and a tagged linear-memory value representation before adding a language runtime. Neither direction inherently requires Wasm GC structs or arrays.

## Specification references

- [Wasm JavaScript interface: import resolution and host-function calls](https://webassembly.github.io/spec/js-api/index.html)
- [ECMAScript: property descriptor conversion](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-frompropertydescriptor)
- [ECMAScript: Object.groupBy](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.groupby)
- [ECMAScript: Object.prototype.__proto__](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.prototype.__proto__)
- [ECMAScript: String.fromCharCode and String.raw](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.raw)
