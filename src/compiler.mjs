import { WasmModule } from './wasm.mjs';

export const MAX_SOURCE_UNITS = 1_000_000;
const E = 'externref';
const I = 'i32';
const c = value => ['i32.const', value];
const l = id => ['local.get', id];
const g = id => ['global.get', id];
const call = (id, ...args) => ['call', id, ...args];
const set = (id, value) => ['local.set', id, value];
const store = (id, value) => ['global.set', id, value];
const drop = value => ['drop', value];
const ret = value => ['return', value];
const nil = () => ['ref.null'];
const p = (id, t = E) => [id, t];

// These strings describe native function names. They are NOT inserted into the
// module as JS string constants: the module obtains them through inherited imports.
const SEEDS = [
  ['constructor', 'Object'],
  ['propertyIsEnumerable', 'propertyIsEnumerable'],
  ['__lookupGetter__', '__lookupGetter__'],
  ['hasOwnProperty', 'hasOwnProperty'],
  ['toString', 'toString'],
  ['valueOf', 'valueOf'],
  ['__defineGetter__', '__defineGetter__'],
];

function makeModule(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a JavaScript function-body string');
  if (source.length > MAX_SOURCE_UNITS) throw new RangeError(`source exceeds ${MAX_SOURCE_UNITS} UTF-16 code units`);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  const { autoRun = false } = options;
  if (typeof autoRun !== 'boolean') throw new TypeError('autoRun must be boolean');
  for (const key of Object.keys(options)) {
    if (key !== 'autoRun') throw new TypeError(`Unknown option: ${key}`);
  }

  // groupBy invokes String.raw(template, 0), inserting a literal "0" after raw[0].
  // The outer 0; is harmless. An inner function preserves the user's directive
  // prologue, zero arguments, and normal strict/sloppy function-body semantics.
  const body = ';return (function(){\n' + source + '\n})();';
  const m = new WasmModule();
  m.data = new Uint8Array(body.length * 2);
  const data = new DataView(m.data.buffer);
  for (let i = 0; i < body.length; i++) data.setUint16(i * 2, body.charCodeAt(i), true);
  m.memory = { pages: Math.max(1, Math.ceil(m.data.length / 65536)) };

  const imp = (id, field, params, results) => m.importFunction(id, 'constructor', field, params, results);
  imp('$keys', 'keys', [E], [E]);
  imp('$names', 'getOwnPropertyNames', [E], [E]);
  imp('$desc', 'getOwnPropertyDescriptor', [E, E], [E]);
  imp('$descIndex', 'getOwnPropertyDescriptor', [E, I], [E]);
  imp('$values', 'values', [E], [E]);
  // Multi-value import conversion unpacks Object.values(descriptor), in order.
  imp('$values4', 'values', [E], [E, E, E, E]);
  imp('$valuesI32', 'values', [E], [I, E, E, E]);
  imp('$create', 'create', [E], [E]);
  imp('$define', 'defineProperty', [E, E, E], [E]);
  imp('$defineIndex', 'defineProperty', [E, I, E], [E]);
  imp('$prototypeOf', 'getPrototypeOf', [E], [E]);
  imp('$groupBy', 'groupBy', [E, E], [E]);
  imp('$Function', 'constructor', [E], [E]);
  imp('$same', 'is', [E, E], [I]);
  imp('$hasIndex', 'hasOwn', [E, I], [I]);
  m.importFunction('$boxI32', '__proto__', 'constructor', [I], [E]);
  m.importGlobal('$objectPrototype', 'constructor', 'prototype');
  for (let i = 0; i < SEEDS.length; i++) m.importGlobal(`$seed${i}`, SEEDS[i][0], 'name');
  for (const id of ['$lengthKey', '$valueKey', '$enumerableKey', '$protoDescriptor', '$getterKey', '$rawKey', '$raw', '$fromCharCode', '$charCache', '$compiled']) m.global(id);

  const discard3 = [['drop'], ['drop'], ['drop']];
  m.func('$first', [p('$descriptor')], [E], [], [call('$values4', l('$descriptor')), ...discard3]);
  m.func('$getIndex', [p('$object'), p('$index', I)], [E], [], [call('$first', call('$descIndex', l('$object'), l('$index')))]);
  m.func('$get', [p('$object'), p('$key')], [E], [], [call('$first', call('$desc', l('$object'), l('$key')))]);
  m.func('$length', [p('$object')], [I], [], [call('$valuesI32', call('$desc', l('$object'), g('$lengthKey'))), ...discard3]);
  m.func('$array', [], [E], [], [call('$keys', call('$create', nil()))]);

  // Match bootstrap property names character-by-character using native name seeds.
  // There is no dependency on the enumeration order of built-in properties.
  const alphabet = new Map();
  SEEDS.forEach(([, text], seed) => [...text].forEach((char, index) => {
    if (!alphabet.has(char)) alphabet.set(char, [seed, index]);
  }));
  function finder(id, pattern) {
    const tests = [
      ['if', ['i32.ne', call('$length', l('$candidate')), c(pattern.length)], [ret(c(0))]],
    ];
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === '?') continue;
      if (!alphabet.has(char)) throw new Error(`No bootstrap seed for ${char}`);
      const [seed, offset] = alphabet.get(char);
      tests.push(['if', ['i32.eqz', call('$same', call('$getIndex', l('$candidate'), c(index)), call('$getIndex', g(`$seed${seed}`), c(offset)))], [ret(c(0))]]);
    }
    m.func(`${id}_matches`, [p('$candidate')], [I], [], [...tests, c(1)]);
    m.func(id, [p('$object')], [E], [p('$names'), p('$candidate'), p('$found'), p('$index', I), p('$count', I)], [
      set('$names', call('$names', l('$object'))),
      ['block', '$done', [
        ['loop', '$next', [
          ['br_if', '$done', ['i32.ge_u', l('$index'), call('$length', l('$names'))]],
          set('$candidate', call('$getIndex', l('$names'), l('$index'))),
          ['if', call(`${id}_matches`, l('$candidate')), [
            set('$found', l('$candidate')), set('$count', ['i32.add', l('$count'), c(1)]),
          ]],
          set('$index', ['i32.add', l('$index'), c(1)]), ['br', '$next'],
        ]],
      ]],
      ['if', ['i32.ne', l('$count'), c(1)], [['unreachable']]],
      l('$found'),
    ]);
  }
  finder('$findConstructor', 'constructor');
  finder('$findProto', '__proto__');
  finder('$findRaw', 'raw');
  // No uppercase C is available in the initial name seeds. Resolve the unique
  // shape, then verify BOTH Cs against fromCharCode(67) during initialization.
  finder('$findFromCharCode', 'from?har?ode');

  // Turn an object reference v into a data-property descriptor without host glue:
  // d = Object.create(v); define d.value with Object.prototype.__proto__'s accessor.
  // Reading d.value yields v. Only newly allocated objects are modified.
  for (const [id, keyType, def] of [['$putObject', E, '$define'], ['$putIndex', I, '$defineIndex']]) {
    m.func(id, [p('$object'), p('$key', keyType), p('$value')], [], [p('$descriptor')], [
      set('$descriptor', call('$create', l('$value'))),
      drop(call('$define', l('$descriptor'), g('$valueKey'), g('$protoDescriptor'))),
      drop(call(def, l('$object'), l('$key'), l('$descriptor'))),
    ]);
  }
  m.func('$one', [p('$value')], [E], [p('$items')], [
    set('$items', call('$array')), call('$putIndex', l('$items'), c(0), l('$value')), l('$items'),
  ]);
  m.func('$charDescriptor', [p('$code', I)], [E], [p('$characters'), p('$descriptor')], [
    ['if', call('$hasIndex', g('$charCache'), l('$code')), [ret(call('$getIndex', g('$charCache'), l('$code')))]],
    set('$characters', call('$getIndex', call('$keys', call('$groupBy', call('$one', call('$boxI32', l('$code'))), g('$fromCharCode'))), c(0))),
    // groupBy passes (boxedCode, 0), yielding the desired UTF-16 unit plus NUL.
    set('$descriptor', call('$descIndex', l('$characters'), c(0))),
    call('$putIndex', g('$charCache'), l('$code'), l('$descriptor')),
    l('$descriptor'),
  ]);

  m.func('$initialize', [], [], [p('$empty'), p('$descriptorKeys'), p('$constructorKey'), p('$string'), p('$charKey'), p('$capitalC'), p('$rawParts'), p('$template'), p('$source'), p('$index', I)], [
    set('$empty', call('$array')),
    // An empty Array has exactly one own name: length. Descriptor field order is
    // specified by ECMAScript FromPropertyDescriptor, not an engine fingerprint.
    store('$lengthKey', call('$getIndex', call('$names', l('$empty')), c(0))),
    set('$descriptorKeys', call('$keys', call('$desc', l('$empty'), g('$lengthKey')))),
    store('$valueKey', call('$getIndex', l('$descriptorKeys'), c(0))),
    store('$enumerableKey', call('$getIndex', l('$descriptorKeys'), c(2))),
    set('$constructorKey', call('$findConstructor', g('$objectPrototype'))),
    store('$protoDescriptor', call('$desc', g('$objectPrototype'), call('$findProto', g('$objectPrototype')))),
    store('$getterKey', call('$getIndex', call('$keys', g('$protoDescriptor')), c(0))),
    set('$string', call('$get', call('$prototypeOf', g('$seed0')), l('$constructorKey'))),
    store('$rawKey', call('$findRaw', l('$string'))),
    store('$raw', call('$get', l('$string'), g('$rawKey'))),
    set('$charKey', call('$findFromCharCode', l('$string'))),
    store('$fromCharCode', call('$get', l('$string'), l('$charKey'))),
    store('$charCache', call('$create', nil())),
    set('$capitalC', call('$first', call('$charDescriptor', c(67)))),
    ['if', ['i32.eqz', ['i32.and',
      call('$same', call('$getIndex', l('$charKey'), c(4)), l('$capitalC')),
      call('$same', call('$getIndex', l('$charKey'), c(8)), l('$capitalC')),
    ]], [['unreachable']]],
    set('$rawParts', call('$array')),
    call('$putIndex', l('$rawParts'), c(0), call('$array')),
    ['block', '$done', [
      ['loop', '$next', [
        ['br_if', '$done', ['i32.ge_u', l('$index'), c(body.length)]],
        drop(call('$defineIndex', l('$rawParts'), ['i32.add', l('$index'), c(1)], call('$charDescriptor', ['i32.load16_u', ['i32.mul', l('$index'), c(2)]]))),
        set('$index', ['i32.add', l('$index'), c(1)]), ['br', '$next'],
      ]],
    ]],
    set('$template', call('$create', nil())),
    call('$putObject', l('$template'), g('$rawKey'), l('$rawParts')),
    set('$source', call('$getIndex', call('$keys', call('$groupBy', call('$one', l('$template')), g('$raw'))), c(0))),
    // Assign only after successful compilation, so a SyntaxError does not poison
    // the compiled-function cache. No user code has executed at this point.
    store('$compiled', call('$Function', l('$source'))),
  ]);

  // Execute the generated function as an enumerable getter on a fresh object.
  // Unlike groupBy, this preserves the actual return value (including objects,
  // undefined, symbols, BigInt and promises) rather than converting it to a key.
  m.func('$invoke', [p('$function')], [E], [p('$descriptor'), p('$receiver')], [
    set('$descriptor', call('$create', l('$function'))),
    drop(call('$define', l('$descriptor'), g('$getterKey'), g('$protoDescriptor'))),
    drop(call('$define', l('$descriptor'), g('$enumerableKey'), g('$protoDescriptor'))),
    set('$receiver', call('$create', nil())),
    drop(call('$defineIndex', l('$receiver'), c(0), l('$descriptor'))),
    call('$getIndex', call('$values', l('$receiver')), c(0)),
  ]);
  m.func('$run', [], [E], [], [
    ['if', ['ref.is_null', g('$compiled')], [call('$initialize')]],
    call('$invoke', g('$compiled')),
  ]);
  m.exportFunction('run', '$run');
  if (autoRun) {
    m.func('$autoRun', [], [], [], [drop(call('$run'))]);
    m.start = '$autoRun';
  }
  return m;
}

/** Package a FunctionBody as standalone Wasm. Compilation does not execute it. */
export function compile(source, options = {}) {
  return makeModule(source, options).toBytes();
}

/** Return readable WAT generated from exactly the same IR as the binary. */
export function emitWat(source, options = {}) {
  return makeModule(source, options).toWat();
}

/** Produce both representations without constructing the IR twice. */
export function build(source, options = {}) {
  const module = makeModule(source, options);
  return { bytes: module.toBytes(), wat: module.toWat() };
}
