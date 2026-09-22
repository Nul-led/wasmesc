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
array pointer
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

The heap begins after the aligned static-string region, so literal data and runtime values share the same ordinary linear memory without overlapping. Equal source literals are interned, and dynamically allocated strings are compared by UTF-16 content for strict equality. String concatenation allocates a fresh UTF-16 string in the same heap.

Arrays use an alias-safe linked-entry representation:

```text
array:
+0   head entry pointer : i32
+4   length             : i32

element entry:
+0   next entry pointer : i32
+4   encoded index      : i32
+8   JSValue            : i64
```

Indexed writes prepend entries and update `length` when an index extends the array. Reads walk newest-to-oldest, so repeated writes are last-write-wins and holes read as `undefined`.

Assigning `array.length` supports non-negative integer values. Growing creates holes. Shrinking unlinks truncated numeric entries while preserving named properties, so expanding again does not resurrect old elements.

The compiler also recognizes `array.push(value)`, `array.pop()`, `array.shift()`, `array.unshift(value)`, `array.at(index)`, `array.includes(value[, fromIndex])`, `array.indexOf(value[, fromIndex])`, `array.lastIndexOf(value[, fromIndex])`, `array.slice(start?, end?)`, `array.reverse()`, `array.fill(value, start?, end?)`, `array.copyWithin(target, start, end?)`, `array.concat(value?)`, and `array.with(index, value)`. `push`/`unshift` return the new length; `pop`/`shift` return the removed JSValue or `undefined` for an empty array. Shift/unshift renumber live numeric entries in place while leaving named properties untouched, so aliases continue to observe the same array object. Pop delegates to the truncation path, so removed values do not reappear after later length growth. `at` supports positive/negative relative numeric indexes, truncates fractions toward zero, treats NaN as zero in the current numeric subset, and returns `undefined` outside the array range. `includes` uses SameValueZero semantics (so NaN matches NaN), treats holes as `undefined`, and supports positive/negative/fractional numeric `fromIndex` values in the current subset. `indexOf` and `lastIndexOf` use strict equality instead, skip holes, and return the first/last matching index or `-1`. `slice` returns a distinct shallow copy, preserves sparse holes, and supports positive/negative numeric bounds. `reverse` renumbers live numeric entries in place, preserving holes, named properties, and array identity. `toReversed` returns a distinct reversed array while leaving the source untouched. Like JavaScript's copying array methods, it produces a dense result: source holes become explicit `undefined` entries. `fill` writes through the normal array-set path, materializing holes in the selected range and returning the same array. `copyWithin` performs overlap-safe in-place copies and preserves sparsity: a source hole deletes the corresponding destination element. The current `concat` subset accepts zero or one argument, returns a new shallow array, flattens one array argument by one level, and preserves sparse holes. `with` returns a distinct shallow array, supports positive/negative numeric indices, and intentionally densifies source holes to explicit `undefined` values. Out-of-range `with` indices currently trap at the Wasm boundary rather than producing a JavaScript `RangeError`.

Computed numeric indexes are validated at runtime before truncation: negative, fractional, NaN, infinite, and out-of-range values yield `undefined` on reads and are ignored on writes instead of trapping or silently truncating.

String-literal bracket keys are resolved at compile time. Canonical decimal indexes such as `array["1"]` address elements; other keys such as `array["note"]`, `array["01"]`, and `array["length"]` use named-property semantics. Dynamic string-key coercion and the full JavaScript array-index range are not implemented yet.

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

Dynamic modules also export `__wasmesc_alloc` for embedding support. Host strings can be encoded directly into the module heap:

```js
const embedding = {
  memory: instance.exports.memory,
  alloc: instance.exports.__wasmesc_alloc,
};

const input = encodeJSValue('hello', embedding);
const output = instance.exports.echo(input);
console.log(decodeJSValue(output, embedding.memory));
```

The current `+` implementation supports number+number and string+string. Mixed string/number coercion is intentionally not implemented yet. Logical `&&`/`||` short-circuit and return operand values rather than forced booleans. Conditional `?:` also evaluates only the selected branch and returns its full JSValue.

The dynamic subset currently supports multiple top-level functions, direct calls (including forward calls and recursion), explicit exports, expression statements, numeric arithmetic and comparisons, string concatenation, short-circuit `&&`/`||`, conditional `?:`, strict equality/inequality (`===`, `!==`), unary `!`, JavaScript-style truthiness for the represented value kinds, `if`/`else`, `else if`, mutable `let`/parameter bindings, `while` loops with `break`/`continue`, primitive literals (`true`, `false`, `null`, `undefined`), interned and host-allocated strings, growable array literals with safe computed reads/writes, string-literal bracket keys, mutable `.length`, and `push`/`pop`/`shift`/`unshift`/`at`/`includes`/`indexOf`/`lastIndexOf`/`slice`/`reverse`/`fill`/`copyWithin`/`concat`, object literals, nested objects, static member reads/writes/deletes, locals, parameters, and return values. Property assignment supports new keys, overwrites, aliases, and nested member chains. `delete` currently supports member properties and numeric array slots; identifier targets and `length` deletion are rejected. Function fallthrough produces `undefined`. It is intentionally not pretending to implement all JavaScript coercion rules yet.

## Pipeline

```text
                          ┌-> static f64 backend -> tiny core Wasm
source -> parser / AST ---|
                          └-> tagged i64 backend -> linear-memory runtime -> core Wasm
```

The binary encoder is dependency-free and writes sections/opcodes directly.

A useful next sequence is:

- mixed string/number `+` coercion;
- dynamic string-key coercion and additional array methods;
- proper `ToNumber` coercions and broader JavaScript comparison semantics;
- shapes/hidden classes and inline property caches once semantics are stable.

## Differential testing

`test/differential.test.js` generates a deterministic corpus of arithmetic expressions, executes each expression using Node's JavaScript engine, compiles the same expression with the dynamic backend, and checks the decoded result.

That includes edge cases produced naturally by floating-point arithmetic such as infinities, NaNs, and signed zero.

## Tests

```sh
npm test
```

Tests verify that generated modules have zero imports, tagged primitive values round-trip, UTF-16 strings decode/concatenate/compare in linear memory, host strings can be encoded through the exported allocator, growable arrays preserve safe index/string-key/length/alias/truncation/push/pop/shift/unshift/at/includes/indexOf/lastIndexOf/slice/reverse/toReversed/fill/copyWithin/concat/with semantics, nested objects live in linear memory, property reads/writes/deletes preserve aliasing, last-write-wins behavior, and sparse array-hole semantics, missing properties produce `undefined`, arithmetic matches Node on the differential corpus, structured control flow preserves `if`, loops, `break`, `continue`, short-circuit logical semantics, and conditional-expression branch selection across nested Wasm labels, direct source-function calls work across forward references and recursion, and unused expression values are explicitly dropped without disturbing stack balance.

## Reference

WebAssembly JavaScript Interface, "read the imports":
https://webassembly.github.io/spec/js-api/#read-the-imports
