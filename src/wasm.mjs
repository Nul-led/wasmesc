/** Small, deliberately limited binary + WAT emitter. No assembler dependency. */
const TYPES = Object.freeze({ i32: 0x7f, externref: 0x6f });
const textEncoder = new TextEncoder();

export function u32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError('Expected an unsigned 32-bit integer');
  }
  const bytes = [];
  do {
    const next = value & 0x7f;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}

export function i32(value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError('Expected a signed 32-bit integer');
  }
  const bytes = [];
  for (;;) {
    const next = value & 0x7f;
    value >>= 7;
    const done = (value === 0 && !(next & 0x40)) || (value === -1 && (next & 0x40));
    bytes.push(next | (done ? 0 : 0x80));
    if (done) return bytes;
  }
}

function name(text) {
  const bytes = textEncoder.encode(text);
  return [...u32(bytes.length), ...bytes];
}
function vector(items) { return [...u32(items.length), ...items.flat()]; }
function section(id, bytes) { return [id, ...u32(bytes.length), ...bytes]; }
function type(t) {
  if (!(t in TYPES)) throw new TypeError(`Unsupported value type: ${t}`);
  return TYPES[t];
}
function lookup(map, key) {
  if (!map.has(key)) throw new Error(`Unknown Wasm name: ${key}`);
  return map.get(key);
}

const SIMPLE = {
  unreachable: 0x00, return: 0x0f, drop: 0x1a,
  'i32.eqz': 0x45, 'i32.eq': 0x46, 'i32.ne': 0x47,
  'i32.lt_u': 0x49, 'i32.ge_u': 0x4f,
  'i32.add': 0x6a, 'i32.sub': 0x6b, 'i32.mul': 0x6c,
  'i32.and': 0x71, 'i32.or': 0x72,
};
const INDEXED = {
  call: 0x10, 'local.get': 0x20, 'local.set': 0x21,
  'local.tee': 0x22, 'global.get': 0x23, 'global.set': 0x24,
};

function instructions(body, context) {
  return body.flatMap(node => instruction(node, context));
}
function instruction(node, context) {
  const [op, ...args] = node;
  if (op === 'i32.const') return [0x41, ...i32(args[0])];
  if (op === 'ref.null') return [0xd0, type('externref')];
  if (op === 'ref.is_null') return [...instructions(args, context), 0xd1];
  if (op in INDEXED) {
    const [id, ...operands] = args;
    const map = op === 'call' ? context.functions : op.startsWith('local.') ? context.locals : context.globals;
    return [...instructions(operands, context), INDEXED[op], ...u32(lookup(map, id))];
  }
  if (op === 'i32.load16_u') {
    return [...instructions(args, context), 0x2f, 0x01, 0x00]; // align=2, offset=0
  }
  if (op === 'block' || op === 'loop') {
    const [label, body] = args;
    const nested = { ...context, labels: [...context.labels, label] };
    return [op === 'block' ? 0x02 : 0x03, 0x40, ...instructions(body, nested), 0x0b];
  }
  if (op === 'if') {
    const [condition, yes, no] = args;
    const nested = { ...context, labels: [...context.labels, null] };
    return [
      ...instruction(condition, context), 0x04, 0x40, ...instructions(yes, nested),
      ...(no ? [0x05, ...instructions(no, nested)] : []), 0x0b,
    ];
  }
  if (op === 'br' || op === 'br_if') {
    const [label, ...operands] = args;
    const index = context.labels.lastIndexOf(label);
    if (index < 0) throw new Error(`Unknown branch label: ${label}`);
    return [...instructions(operands, context), op === 'br' ? 0x0c : 0x0d, ...u32(context.labels.length - 1 - index)];
  }
  if (op in SIMPLE) return [...instructions(args, context), SIMPLE[op]];
  throw new Error(`Unsupported opcode: ${op}`);
}

function watInstruction(node, indent = '    ') {
  const [op, ...args] = node;
  if (op === 'block' || op === 'loop') {
    return `(${op} ${args[0]}\n${args[1].map(n => indent + '  ' + watInstruction(n, indent + '  ')).join('\n')}\n${indent})`;
  }
  if (op === 'if') {
    const [condition, yes, no] = args;
    const arm = (tag, nodes) => `(${tag}\n${nodes.map(n => indent + '    ' + watInstruction(n, indent + '    ')).join('\n')}\n${indent}  )`;
    return `(if ${watInstruction(condition, indent)}\n${indent}  ${arm('then', yes)}${no ? '\n' + indent + '  ' + arm('else', no) : ''}\n${indent})`;
  }
  if (op === 'ref.null') return '(ref.null extern)';
  return `(${op}${args.length ? ' ' : ''}${args.map(a => Array.isArray(a) ? watInstruction(a, indent) : a).join(' ')})`;
}

export class WasmModule {
  constructor() {
    this.types = [];
    this.imports = [];
    this.functions = [];
    this.globals = [];
    this.exports = [];
    this.memory = null;
    this.data = new Uint8Array();
    this.start = null;
  }
  signature(params, results) {
    const key = JSON.stringify([params, results]);
    let index = this.types.findIndex(t => t.key === key);
    if (index < 0) { index = this.types.length; this.types.push({ key, params, results }); }
    return index;
  }
  importFunction(id, module, field, params, results) {
    this.imports.push({ kind: 'func', id, module, field, params, results, type: this.signature(params, results) });
  }
  importGlobal(id, module, field, valueType = 'externref') {
    this.imports.push({ kind: 'global', id, module, field, valueType });
  }
  global(id, valueType = 'externref', initial = ['ref.null']) {
    this.globals.push({ id, valueType, initial });
  }
  func(id, params, results, locals, body) {
    this.functions.push({ id, params, results, locals, body, type: this.signature(params.map(p => p[1]), results) });
  }
  exportFunction(name, id) { this.exports.push({ name, id }); }
  maps() {
    return {
      functions: new Map([...this.imports.filter(i => i.kind === 'func'), ...this.functions].map((f, i) => [f.id, i])),
      globals: new Map([...this.imports.filter(i => i.kind === 'global'), ...this.globals].map((g, i) => [g.id, i])),
    };
  }
  toBytes() {
    const maps = this.maps();
    const sections = [];
    if (this.types.length) sections.push(section(1, vector(this.types.map(t => [0x60, ...vector(t.params.map(p => [type(p)])), ...vector(t.results.map(r => [type(r)]))]))));
    if (this.imports.length) sections.push(section(2, vector(this.imports.map(i => [
      ...name(i.module), ...name(i.field), ...(i.kind === 'func' ? [0x00, ...u32(i.type)] : [0x03, type(i.valueType), 0x00]),
    ]))));
    if (this.functions.length) sections.push(section(3, vector(this.functions.map(f => u32(f.type)))));
    if (this.memory) sections.push(section(5, vector([[0x01, ...u32(this.memory.pages), ...u32(this.memory.pages)]])));
    if (this.globals.length) sections.push(section(6, vector(this.globals.map(g => [type(g.valueType), 0x01, ...instruction(g.initial, { ...maps, locals: new Map(), labels: [] }), 0x0b]))));
    if (this.exports.length) sections.push(section(7, vector(this.exports.map(e => [...name(e.name), 0x00, ...u32(lookup(maps.functions, e.id))]))));
    if (this.start) sections.push(section(8, u32(lookup(maps.functions, this.start))));
    if (this.functions.length) sections.push(section(10, vector(this.functions.map(f => {
      const locals = new Map([...f.params, ...f.locals].map(([id], index) => [id, index]));
      const code = [...vector(f.locals.map(([, t]) => [0x01, type(t)])), ...instructions(f.body, { ...maps, locals, labels: [] }), 0x0b];
      return [...u32(code.length), ...code];
    }))));
    if (this.data.length) {
      // Avoid spreading a large source buffer into a function call (argument-count limit).
      const payload = [0x01, 0x00, 0x41, 0x00, 0x0b, ...u32(this.data.length)];
      for (const byte of this.data) payload.push(byte);
      sections.push(section(11, payload));
    }
    return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
  }
  toWat() {
    const parts = ['(module'];
    const result = ts => ts.length ? ` (result ${ts.join(' ')})` : '';
    for (const i of this.imports) {
      const entity = i.kind === 'func'
        ? `(func ${i.id}${i.params.length ? ` (param ${i.params.join(' ')})` : ''}${result(i.results)})`
        : `(global ${i.id} ${i.valueType})`;
      parts.push(`  (import ${JSON.stringify(i.module)} ${JSON.stringify(i.field)} ${entity})`);
    }
    if (this.memory) parts.push(`  (memory ${this.memory.pages} ${this.memory.pages})`);
    for (const g of this.globals) parts.push(`  (global ${g.id} (mut ${g.valueType}) ${watInstruction(g.initial)})`);
    for (const f of this.functions) {
      parts.push(`  (func ${f.id}${f.params.map(([id, t]) => ` (param ${id} ${t})`).join('')}${result(f.results)}`);
      for (const [id, t] of f.locals) parts.push(`    (local ${id} ${t})`);
      for (const node of f.body) parts.push('    ' + watInstruction(node));
      parts.push('  )');
    }
    for (const e of this.exports) parts.push(`  (export ${JSON.stringify(e.name)} (func ${e.id}))`);
    if (this.start) parts.push(`  (start ${this.start})`);
    if (this.data.length) parts.push(`  (data (i32.const 0) "${Array.from(this.data, b => '\\' + b.toString(16).padStart(2, '0')).join('')}")`);
    parts.push(')', '');
    return parts.join('\n');
  }
}
