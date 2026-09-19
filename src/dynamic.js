import {
  ValType,
  encodeFunctionBody,
  functionType,
  moduleBytes,
  s32,
  s64,
  section,
  u32,
  vec,
  wasmString,
} from './wasm.js';
import { JSValue, numberToBits } from './jsvalue.js';

const KEYWORDS = new Set([
  'export', 'function', 'return', 'let', 'const',
  'true', 'false', 'null', 'undefined',
]);

function tokenize(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      if (end === -1) break;
      i = end;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      const value = source.slice(start, i);
      tokens.push({ type: KEYWORDS.has(value) ? value : 'id', value, pos: start });
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i;
      const match = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) throw new SyntaxError(`Invalid number at ${i}`);
      i += match[0].length;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new SyntaxError(`Invalid finite number at ${start}`);
      tokens.push({ type: 'number', value, pos: start });
      continue;
    }

    if ('()+-*/{},;=:.'.includes(ch)) {
      tokens.push({ type: ch, value: ch, pos: i });
      i += 1;
      continue;
    }

    throw new SyntaxError(`Unsupported token ${JSON.stringify(ch)} at ${i}`);
  }

  tokens.push({ type: 'eof', value: '', pos: source.length });
  return tokens;
}

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.i = 0;
  }

  peek(type) {
    return this.tokens[this.i].type === type;
  }

  take(type) {
    const token = this.tokens[this.i];
    if (token.type !== type) {
      throw new SyntaxError(`Expected ${type} at ${token.pos}, got ${token.type}`);
    }
    this.i += 1;
    return token;
  }

  maybe(type) {
    if (!this.peek(type)) return null;
    return this.take(type);
  }

  parseProgram() {
    this.maybe('export');
    this.take('function');
    const name = this.take('id').value;
    this.take('(');
    const params = [];
    if (!this.peek(')')) {
      do {
        params.push(this.take('id').value);
      } while (this.maybe(','));
    }
    this.take(')');
    this.take('{');

    const statements = [];
    while (!this.peek('}')) statements.push(this.parseStatement());
    this.take('}');
    this.take('eof');

    if (!statements.some((s) => s.type === 'return')) {
      throw new SyntaxError('Function must contain a return statement');
    }
    if (new Set(params).size !== params.length) throw new SyntaxError('Duplicate parameter');

    return { type: 'function', name, params, statements };
  }

  parseStatement() {
    if (this.peek('let') || this.peek('const')) {
      const kind = this.tokens[this.i++].type;
      const name = this.take('id').value;
      this.take('=');
      const init = this.parseExpression();
      this.maybe(';');
      return { type: 'var', kind, name, init };
    }

    if (this.maybe('return')) {
      const value = this.parseExpression();
      this.maybe(';');
      return { type: 'return', value };
    }

    const token = this.tokens[this.i];
    throw new SyntaxError(`Unsupported statement at ${token.pos}`);
  }

  parseExpression(minPrecedence = 0) {
    let left = this.parseUnary();
    const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };

    while (true) {
      const op = this.tokens[this.i].type;
      const p = precedence[op] ?? -1;
      if (p < minPrecedence) break;
      this.i += 1;
      const right = this.parseExpression(p + 1);
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  parseUnary() {
    if (this.maybe('-')) return { type: 'unary', op: '-', value: this.parseUnary() };
    if (this.maybe('+')) return { type: 'unary', op: '+', value: this.parseUnary() };
    return this.parsePostfix();
  }

  parsePostfix() {
    let value = this.parsePrimary();
    while (this.maybe('.')) {
      value = { type: 'member', object: value, property: this.take('id').value };
    }
    return value;
  }

  parsePrimary() {
    if (this.peek('number')) return { type: 'number', value: this.take('number').value };
    if (this.maybe('true')) return { type: 'literal', value: true };
    if (this.maybe('false')) return { type: 'literal', value: false };
    if (this.maybe('null')) return { type: 'literal', value: null };
    if (this.maybe('undefined')) return { type: 'literal', value: undefined };
    if (this.peek('id')) return { type: 'id', name: this.take('id').value };

    if (this.maybe('(')) {
      const value = this.parseExpression();
      this.take(')');
      return value;
    }

    if (this.maybe('{')) {
      const properties = [];
      if (!this.peek('}')) {
        do {
          const key = this.take('id').value;
          this.take(':');
          properties.push({ key, value: this.parseExpression() });
        } while (this.maybe(','));
      }
      this.take('}');
      return { type: 'object', properties };
    }

    const token = this.tokens[this.i];
    throw new SyntaxError(`Expected expression at ${token.pos}`);
  }
}

const Op = Object.freeze({
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  return: 0x0f,
  call: 0x10,
  localGet: 0x20,
  localSet: 0x21,
  localTee: 0x22,
  globalGet: 0x23,
  globalSet: 0x24,
  i32Load: 0x28,
  i64Load: 0x29,
  i32Store: 0x36,
  i64Store: 0x37,
  i32Const: 0x41,
  i64Const: 0x42,
  i32Eqz: 0x45,
  i32Eq: 0x46,
  f64Ne: 0x62,
  i32Add: 0x6a,
  i32Sub: 0x6b,
  i32Mul: 0x6c,
  i64Or: 0x84,
  f64Neg: 0x9a,
  f64Add: 0xa0,
  f64Sub: 0xa1,
  f64Mul: 0xa2,
  f64Div: 0xa3,
  i32WrapI64: 0xa7,
  i64ExtendI32U: 0xad,
  i64ReinterpretF64: 0xbd,
  f64ReinterpretI64: 0xbf,
});

const RuntimeFn = Object.freeze({
  alloc: 0,
  objectNew: 1,
  objectSet: 2,
  objectGet: 3,
  numberFromF64: 4,
  main: 5,
});

const emptyBlock = 0x40;

function i32Const(value) {
  return [Op.i32Const, ...s32(value)];
}

function i64Const(value) {
  return [Op.i64Const, ...s64(value)];
}

function localGet(index) {
  return [Op.localGet, ...u32(index)];
}

function localSet(index) {
  return [Op.localSet, ...u32(index)];
}

function call(index) {
  return [Op.call, ...u32(index)];
}

function memarg(align, offset = 0) {
  return [...u32(align), ...u32(offset)];
}

function allocBody() {
  return encodeFunctionBody({
    locals: [ValType.i32],
    instructions: [
      Op.globalGet, ...u32(0),
      Op.localTee, ...u32(1),
      ...localGet(0),
      Op.i32Add,
      Op.globalSet, ...u32(0),
      ...localGet(1),
    ],
  });
}

function objectNewBody() {
  // Object layout:
  // +0 capacity:i32, +4 used:i32,
  // then 16-byte entries { keyId:i32, padding:i32, value:i64 }.
  return encodeFunctionBody({
    locals: [ValType.i32],
    instructions: [
      ...i32Const(8),
      ...localGet(0),
      ...i32Const(16),
      Op.i32Mul,
      Op.i32Add,
      ...call(RuntimeFn.alloc),
      ...localSet(1),

      ...localGet(1),
      ...localGet(0),
      Op.i32Store, ...memarg(2, 0),

      ...localGet(1),
      ...i32Const(0),
      Op.i32Store, ...memarg(2, 4),

      ...i64Const(JSValue.OBJECT),
      ...localGet(1),
      Op.i64ExtendI32U,
      Op.i64Or,
    ],
  });
}

function objectSetBody() {
  // (object:i64, keyId:i32, value:i64) -> object:i64
  return encodeFunctionBody({
    locals: [ValType.i32, ValType.i32, ValType.i32],
    instructions: [
      ...localGet(0),
      Op.i32WrapI64,
      ...localSet(3),

      ...localGet(3),
      Op.i32Load, ...memarg(2, 4),
      ...localSet(4),

      ...localGet(3),
      ...i32Const(8),
      Op.i32Add,
      ...localGet(4),
      ...i32Const(16),
      Op.i32Mul,
      Op.i32Add,
      Op.localTee, ...u32(5),
      ...localGet(1),
      Op.i32Store, ...memarg(2, 0),

      ...localGet(5),
      ...localGet(2),
      Op.i64Store, ...memarg(3, 8),

      ...localGet(3),
      ...localGet(4),
      ...i32Const(1),
      Op.i32Add,
      Op.i32Store, ...memarg(2, 4),

      ...localGet(0),
    ],
  });
}

function objectGetBody() {
  // Search newest-to-oldest, matching JS object-literal last-write-wins behavior.
  return encodeFunctionBody({
    locals: [ValType.i32, ValType.i32, ValType.i32],
    instructions: [
      ...localGet(0),
      Op.i32WrapI64,
      ...localSet(2),

      ...localGet(2),
      Op.i32Load, ...memarg(2, 4),
      ...localSet(3),

      Op.block, emptyBlock,
        Op.loop, emptyBlock,
          ...localGet(3),
          Op.i32Eqz,
          Op.brIf, ...u32(1),

          ...localGet(3),
          ...i32Const(1),
          Op.i32Sub,
          Op.localTee, ...u32(3),

          ...localGet(2),
          ...i32Const(8),
          Op.i32Add,
          ...localGet(3),
          ...i32Const(16),
          Op.i32Mul,
          Op.i32Add,
          Op.localTee, ...u32(4),

          Op.i32Load, ...memarg(2, 0),
          ...localGet(1),
          Op.i32Eq,
          Op.if, emptyBlock,
            ...localGet(4),
            Op.i64Load, ...memarg(3, 8),
            Op.return,
          Op.end,

          Op.br, ...u32(0),
        Op.end,
      Op.end,

      ...i64Const(JSValue.UNDEFINED),
    ],
  });
}

function numberFromF64Body() {
  // Arithmetic NaNs are canonicalized so they cannot collide with tagged values.
  return encodeFunctionBody({
    instructions: [
      ...localGet(0),
      ...localGet(0),
      Op.f64Ne,
      Op.if, ValType.i64,
        ...i64Const(JSValue.CANONICAL_NAN),
      Op.else,
        ...localGet(0),
        Op.i64ReinterpretF64,
      Op.end,
    ],
  });
}

function collectPropertyNames(ast) {
  const names = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      for (const property of node.properties) {
        names.add(property.key);
        visit(property.value);
      }
      return;
    }
    if (node.type === 'member') {
      names.add(node.property);
      visit(node.object);
      return;
    }
    if (node.type === 'binary') {
      visit(node.left);
      visit(node.right);
      return;
    }
    if (node.type === 'unary') visit(node.value);
  }

  for (const statement of ast.statements) {
    if (statement.type === 'var') visit(statement.init);
    else if (statement.type === 'return') visit(statement.value);
  }

  return new Map([...names].map((name, index) => [name, index + 1]));
}

function compileExpression(node, scope, propertyIds) {
  switch (node.type) {
    case 'number':
      return i64Const(numberToBits(node.value));
    case 'literal': {
      const bits = node.value === undefined ? JSValue.UNDEFINED
        : node.value === null ? JSValue.NULL
          : node.value === true ? JSValue.TRUE
            : JSValue.FALSE;
      return i64Const(bits);
    }
    case 'id': {
      const index = scope.get(node.name);
      if (index === undefined) throw new ReferenceError(`Unknown identifier: ${node.name}`);
      return localGet(index);
    }
    case 'unary': {
      const value = compileExpression(node.value, scope, propertyIds);
      if (node.op === '+') return value;
      return [
        ...value,
        Op.f64ReinterpretI64,
        Op.f64Neg,
        ...call(RuntimeFn.numberFromF64),
      ];
    }
    case 'binary': {
      const opcode = {
        '+': Op.f64Add,
        '-': Op.f64Sub,
        '*': Op.f64Mul,
        '/': Op.f64Div,
      }[node.op];
      return [
        ...compileExpression(node.left, scope, propertyIds),
        Op.f64ReinterpretI64,
        ...compileExpression(node.right, scope, propertyIds),
        Op.f64ReinterpretI64,
        opcode,
        ...call(RuntimeFn.numberFromF64),
      ];
    }
    case 'object': {
      const instructions = [
        ...i32Const(node.properties.length),
        ...call(RuntimeFn.objectNew),
      ];
      for (const property of node.properties) {
        instructions.push(
          ...i32Const(propertyIds.get(property.key)),
          ...compileExpression(property.value, scope, propertyIds),
          ...call(RuntimeFn.objectSet),
        );
      }
      return instructions;
    }
    case 'member':
      return [
        ...compileExpression(node.object, scope, propertyIds),
        ...i32Const(propertyIds.get(node.property)),
        ...call(RuntimeFn.objectGet),
      ];
    default:
      throw new Error(`Unknown AST node: ${node.type}`);
  }
}

export function parseDynamic(source) {
  return new Parser(source).parseProgram();
}

export function compileDynamic(source) {
  const ast = parseDynamic(source);
  const propertyIds = collectPropertyNames(ast);
  const scope = new Map();
  ast.params.forEach((name, index) => scope.set(name, index));

  const locals = [];
  const instructions = [];
  let returned = false;

  for (const statement of ast.statements) {
    if (returned) throw new SyntaxError('Unreachable statement after return');

    if (statement.type === 'var') {
      if (scope.has(statement.name)) throw new SyntaxError(`Duplicate local: ${statement.name}`);
      const localIndex = ast.params.length + locals.length;
      instructions.push(...compileExpression(statement.init, scope, propertyIds));
      instructions.push(...localSet(localIndex));
      locals.push(ValType.i64);
      scope.set(statement.name, localIndex);
      continue;
    }

    if (statement.type === 'return') {
      instructions.push(...compileExpression(statement.value, scope, propertyIds));
      instructions.push(Op.return);
      returned = true;
    }
  }

  const types = [
    functionType([ValType.i32], [ValType.i32]),
    functionType([ValType.i32], [ValType.i64]),
    functionType([ValType.i64, ValType.i32, ValType.i64], [ValType.i64]),
    functionType([ValType.i64, ValType.i32], [ValType.i64]),
    functionType([ValType.f64], [ValType.i64]),
    functionType(ast.params.map(() => ValType.i64), [ValType.i64]),
  ];

  const typeSection = section(1, vec(types));
  const functionSection = section(3, vec([
    [...u32(0)], [...u32(1)], [...u32(2)], [...u32(3)], [...u32(4)], [...u32(5)],
  ]));
  const memorySection = section(5, vec([[0x00, ...u32(1)]]));
  const globalSection = section(6, vec([[
    ValType.i32, 0x01,
    Op.i32Const, ...s32(1024), Op.end,
  ]]));
  const exportSection = section(7, vec([
    [...wasmString(ast.name), 0x00, ...u32(RuntimeFn.main)],
    [...wasmString('memory'), 0x02, ...u32(0)],
  ]));
  const codeSection = section(10, vec([
    allocBody(),
    objectNewBody(),
    objectSetBody(),
    objectGetBody(),
    numberFromF64Body(),
    encodeFunctionBody({ locals, instructions }),
  ]));

  return moduleBytes([
    typeSection,
    functionSection,
    memorySection,
    globalSection,
    exportSection,
    codeSection,
  ]);
}
