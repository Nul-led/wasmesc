import {
  ValType,
  encodeFunctionBody,
  f64Bytes,
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
  'if', 'else', 'while', 'break', 'continue',
]);

const MULTI_CHAR_TOKENS = ['===', '!==', '<=', '>='];

function readHexEscape(source, start, length) {
  const text = source.slice(start, start + length);
  if (text.length !== length || !/^[0-9A-Fa-f]+$/.test(text)) {
    throw new SyntaxError('Invalid hexadecimal string escape at ' + start);
  }
  return { value: Number.parseInt(text, 16), end: start + length };
}

function readStringLiteral(source, start) {
  const quote = source[start];
  let i = start + 1;
  let value = '';

  while (i < source.length) {
    const ch = source[i++];

    if (ch === quote) return { value, end: i };
    if (ch === '\n' || ch === '\r') {
      throw new SyntaxError('Unterminated string literal at ' + start);
    }
    if (ch !== '\\') {
      value += ch;
      continue;
    }

    if (i >= source.length) throw new SyntaxError('Unterminated string literal at ' + start);
    const escape = source[i++];

    const simple = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      0: '\0',
      '\\': '\\',
      "'": "'",
      '"': '"',
    };
    if (Object.hasOwn(simple, escape)) {
      value += simple[escape];
      continue;
    }

    if (escape === 'x') {
      const decoded = readHexEscape(source, i, 2);
      value += String.fromCharCode(decoded.value);
      i = decoded.end;
      continue;
    }

    if (escape === 'u') {
      if (source[i] === '{') {
        const close = source.indexOf('}', i + 1);
        if (close === -1) throw new SyntaxError('Unterminated Unicode escape at ' + start);
        const hex = source.slice(i + 1, close);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) {
          throw new SyntaxError('Invalid Unicode escape at ' + i);
        }
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff) throw new SyntaxError('Unicode code point out of range');
        value += String.fromCodePoint(codePoint);
        i = close + 1;
        continue;
      }

      const decoded = readHexEscape(source, i, 4);
      value += String.fromCharCode(decoded.value);
      i = decoded.end;
      continue;
    }

    if (escape === '\n') continue;
    if (escape === '\r') {
      if (source[i] === '\n') i += 1;
      continue;
    }

    value += escape;
  }

  throw new SyntaxError('Unterminated string literal at ' + start);
}

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

    if (ch === '"' || ch === "'") {
      const string = readStringLiteral(source, i);
      tokens.push({ type: 'string', value: string.value, pos: i });
      i = string.end;
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

    const multi = MULTI_CHAR_TOKENS.find((token) => source.startsWith(token, i));
    if (multi) {
      tokens.push({ type: multi, value: multi, pos: i });
      i += multi.length;
      continue;
    }

    if ('()+-*/[]{},;=:.<>!'.includes(ch)) {
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

  peekNext(type) {
    return this.tokens[this.i + 1]?.type === type;
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

  parseBlock() {
    this.take('{');
    const statements = [];
    while (!this.peek('}')) statements.push(this.parseStatement());
    this.take('}');
    return statements;
  }

  parseFunction() {
    const exported = Boolean(this.maybe('export'));
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
    const statements = this.parseBlock();

    if (new Set(params).size !== params.length) {
      throw new SyntaxError('Duplicate parameter in function ' + name);
    }

    return { type: 'function', name, params, statements, exported };
  }

  parseProgram() {
    const functions = [];
    while (!this.peek('eof')) functions.push(this.parseFunction());
    this.take('eof');

    if (functions.length === 0) throw new SyntaxError('Expected at least one function');

    const names = new Set();
    for (const fn of functions) {
      if (names.has(fn.name)) throw new SyntaxError('Duplicate function: ' + fn.name);
      names.add(fn.name);
    }

    if (!functions.some((fn) => fn.exported)) functions[0].exported = true;
    return { type: 'program', functions };
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

    if (this.maybe('if')) {
      this.take('(');
      const test = this.parseExpression();
      this.take(')');
      const consequent = this.parseBlock();
      let alternate = null;
      if (this.maybe('else')) {
        alternate = this.peek('if') ? [this.parseStatement()] : this.parseBlock();
      }
      return { type: 'if', test, consequent, alternate };
    }

    if (this.maybe('while')) {
      this.take('(');
      const test = this.parseExpression();
      this.take(')');
      const body = this.parseBlock();
      return { type: 'while', test, body };
    }

    if (this.maybe('break')) {
      this.maybe(';');
      return { type: 'break' };
    }

    if (this.maybe('continue')) {
      this.maybe(';');
      return { type: 'continue' };
    }

    if (this.peek('id')) {
      const start = this.i;
      const target = this.parseExpression();
      if (this.maybe('=')) {
        if (target.type !== 'id' && target.type !== 'member' && target.type !== 'index') {
          throw new SyntaxError('Invalid assignment target');
        }
        const value = this.parseExpression();
        this.maybe(';');
        return { type: 'assign', target, value };
      }
      this.i = start;
    }

    const expression = this.parseExpression();
    this.maybe(';');
    return { type: 'expression', expression };
  }

  parseExpression(minPrecedence = 0) {
    let left = this.parseUnary();
    const precedence = {
      '===': 0,
      '!==': 0,
      '<': 1,
      '<=': 1,
      '>': 1,
      '>=': 1,
      '+': 2,
      '-': 2,
      '*': 3,
      '/': 3,
    };

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
    if (this.maybe('!')) return { type: 'unary', op: '!', value: this.parseUnary() };
    return this.parsePostfix();
  }

  parsePostfix() {
    let value = this.parsePrimary();

    while (true) {
      if (this.maybe('.')) {
        value = { type: 'member', object: value, property: this.take('id').value };
        continue;
      }

      if (this.maybe('[')) {
        const index = this.parseExpression();
        this.take(']');
        value = { type: 'index', object: value, index };
        continue;
      }

      if (this.maybe('(')) {
        const args = [];
        if (!this.peek(')')) {
          do {
            args.push(this.parseExpression());
          } while (this.maybe(','));
        }
        this.take(')');
        value = { type: 'call', callee: value, args };
        continue;
      }

      break;
    }

    return value;
  }

  parsePrimary() {
    if (this.peek('number')) return { type: 'number', value: this.take('number').value };
    if (this.peek('string')) return { type: 'string', value: this.take('string').value };
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

    if (this.maybe('[')) {
      const elements = [];
      if (!this.peek(']')) {
        do {
          elements.push(this.parseExpression());
        } while (this.maybe(','));
      }
      this.take(']');
      return { type: 'array', elements };
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
  drop: 0x1a,
  localGet: 0x20,
  localSet: 0x21,
  localTee: 0x22,
  globalGet: 0x23,
  globalSet: 0x24,
  i32Load: 0x28,
  i64Load: 0x29,
  i32Load16U: 0x2f,
  i32Store: 0x36,
  i64Store: 0x37,
  i32Store16: 0x3b,
  i32Const: 0x41,
  i64Const: 0x42,
  f64Const: 0x44,
  i32Eqz: 0x45,
  i32Eq: 0x46,
  i32Ne: 0x47,
  i32LtS: 0x48,
  i32GeU: 0x4f,
  i64Eq: 0x51,
  f64Eq: 0x61,
  f64Ne: 0x62,
  f64Lt: 0x63,
  f64Gt: 0x64,
  f64Le: 0x65,
  f64Ge: 0x66,
  i32Add: 0x6a,
  i32Sub: 0x6b,
  i32Mul: 0x6c,
  i32And: 0x71,
  i32Xor: 0x73,
  i64And: 0x83,
  i64Or: 0x84,
  f64Neg: 0x9a,
  f64Add: 0xa0,
  f64Sub: 0xa1,
  f64Mul: 0xa2,
  f64Div: 0xa3,
  i32WrapI64: 0xa7,
  i32TruncF64S: 0xaa,
  i64ExtendI32U: 0xad,
  f64ConvertI32U: 0xb8,
  i64ReinterpretF64: 0xbd,
  f64ReinterpretI64: 0xbf,
});

const RuntimeFn = Object.freeze({
  alloc: 0,
  objectNew: 1,
  objectSet: 2,
  objectGet: 3,
  numberFromF64: 4,
  truthy: 5,
  strictEqual: 6,
  arrayNew: 7,
  arraySet: 8,
  arrayGet: 9,
  stringEqual: 10,
  stringConcat: 11,
  add: 12,
});

const RuntimeFunctionCount = 13;

const emptyBlock = 0x40;

function i32Const(value) {
  return [Op.i32Const, ...s32(value)];
}

function i64Const(value) {
  return [Op.i64Const, ...s64(value)];
}

function f64Const(value) {
  return [Op.f64Const, ...f64Bytes(value)];
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

function booleanFromI32(instructions) {
  return [
    ...instructions,
    Op.if, ValType.i64,
      ...i64Const(JSValue.TRUE),
    Op.else,
      ...i64Const(JSValue.FALSE),
    Op.end,
  ];
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
  // +0 head entry pointer:i32, +4 property-write count:i32.
  // Each property write allocates a 16-byte linked entry:
  // +0 next:i32, +4 keyId:i32, +8 value:i64.
  //
  // The capacity argument is retained in the runtime ABI for now, but the
  // linked representation does not require pre-sizing.
  return encodeFunctionBody({
    locals: [ValType.i32],
    instructions: [
      ...i32Const(8),
      ...call(RuntimeFn.alloc),
      ...localSet(1),

      ...localGet(1),
      ...i32Const(0),
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
  // Property writes prepend an entry, so reads naturally implement
  // last-write-wins semantics without fixed object capacity.
  return encodeFunctionBody({
    locals: [ValType.i32, ValType.i32],
    instructions: [
      ...localGet(0),
      Op.i32WrapI64,
      ...localSet(3),

      ...i32Const(16),
      ...call(RuntimeFn.alloc),
      ...localSet(4),

      ...localGet(4),
      ...localGet(3),
      Op.i32Load, ...memarg(2, 0),
      Op.i32Store, ...memarg(2, 0),

      ...localGet(4),
      ...localGet(1),
      Op.i32Store, ...memarg(2, 4),

      ...localGet(4),
      ...localGet(2),
      Op.i64Store, ...memarg(3, 8),

      ...localGet(3),
      ...localGet(4),
      Op.i32Store, ...memarg(2, 0),

      ...localGet(0),
      ...i64Const(JSValue.TAG_MASK),
      Op.i64And,
      ...i64Const(JSValue.ARRAY),
      Op.i64Eq,
      Op.if, emptyBlock,
      Op.else,
        ...localGet(3),
        ...localGet(3),
        Op.i32Load, ...memarg(2, 4),
        ...i32Const(1),
        Op.i32Add,
        Op.i32Store, ...memarg(2, 4),
      Op.end,

      ...localGet(0),
    ],
  });
}

function objectGetBody() {
  return encodeFunctionBody({
    locals: [ValType.i32, ValType.i32],
    instructions: [
      ...localGet(1),
      Op.i32Eqz,
      Op.if, emptyBlock,
        ...localGet(0),
        ...i64Const(JSValue.TAG_MASK),
        Op.i64And,
        ...i64Const(JSValue.ARRAY),
        Op.i64Eq,
        Op.if, emptyBlock,
          ...localGet(0),
          Op.i32WrapI64,
          Op.i32Load, ...memarg(2, 4),
          Op.f64ConvertI32U,
          ...call(RuntimeFn.numberFromF64),
          Op.return,
        Op.end,
      Op.end,

      ...localGet(0),
      Op.i32WrapI64,
      ...localSet(2),

      ...localGet(2),
      Op.i32Load, ...memarg(2, 0),
      ...localSet(3),

      Op.block, emptyBlock,
        Op.loop, emptyBlock,
          ...localGet(3),
          Op.i32Eqz,
          Op.brIf, ...u32(1),

          ...localGet(3),
          Op.i32Load, ...memarg(2, 4),
          ...localGet(1),
          Op.i32Eq,
          Op.if, emptyBlock,
            ...localGet(3),
            Op.i64Load, ...memarg(3, 8),
            Op.return,
          Op.end,

          ...localGet(3),
          Op.i32Load, ...memarg(2, 0),
          ...localSet(3),
          Op.br, ...u32(0),
        Op.end,
      Op.end,

      ...i64Const(JSValue.UNDEFINED),
    ],
  });
}

function numberFromF64Body() {
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

function truthyBody() {
  const falseyTags = [JSValue.UNDEFINED, JSValue.NULL, JSValue.FALSE, JSValue.CANONICAL_NAN];
  const instructions = [];

  for (const value of falseyTags) {
    instructions.push(
      ...localGet(0),
      ...i64Const(value),
      Op.i64Eq,
      Op.if, emptyBlock,
        ...i32Const(0),
        Op.return,
      Op.end,
    );
  }

  instructions.push(
    ...localGet(0),
    ...i64Const(JSValue.TAG_MASK),
    Op.i64And,
    ...i64Const(JSValue.STRING),
    Op.i64Eq,
    Op.if, emptyBlock,
      ...localGet(0),
      Op.i32WrapI64,
      Op.i32Load, ...memarg(2, 0),
      Op.i32Eqz,
      Op.i32Eqz,
      Op.return,
    Op.end,

    ...localGet(0),
    Op.f64ReinterpretI64,
    ...f64Const(0),
    Op.f64Ne,
  );

  return encodeFunctionBody({ instructions });
}

function strictEqualBody() {
  return encodeFunctionBody({
    instructions: [
      ...localGet(0),
      ...i64Const(JSValue.CANONICAL_NAN),
      Op.i64Eq,
      Op.if, emptyBlock,
        ...i32Const(0),
        Op.return,
      Op.end,

      ...localGet(1),
      ...i64Const(JSValue.CANONICAL_NAN),
      Op.i64Eq,
      Op.if, emptyBlock,
        ...i32Const(0),
        Op.return,
      Op.end,

      ...localGet(0),
      ...localGet(1),
      Op.i64Eq,
      Op.if, emptyBlock,
        ...i32Const(1),
        Op.return,
      Op.end,

      ...localGet(0),
      ...i64Const(JSValue.TAG_MASK),
      Op.i64And,
      ...i64Const(JSValue.STRING),
      Op.i64Eq,
      Op.if, emptyBlock,
        ...localGet(1),
        ...i64Const(JSValue.TAG_MASK),
        Op.i64And,
        ...i64Const(JSValue.STRING),
        Op.i64Eq,
        Op.if, emptyBlock,
          ...localGet(0),
          ...localGet(1),
          ...call(RuntimeFn.stringEqual),
          Op.return,
        Op.end,
        ...i32Const(0),
        Op.return,
      Op.end,

      ...localGet(1),
      ...i64Const(JSValue.TAG_MASK),
      Op.i64And,
      ...i64Const(JSValue.STRING),
      Op.i64Eq,
      Op.if, emptyBlock,
        ...i32Const(0),
        Op.return,
      Op.end,

      ...localGet(0),
      Op.f64ReinterpretI64,
      ...f64Const(0),
      Op.f64Eq,
      ...localGet(1),
      Op.f64ReinterpretI64,
      ...f64Const(0),
      Op.f64Eq,
      Op.i32And,
    ],
  });
}

function arrayNewBody() {
  return encodeFunctionBody({
    locals: [ValType.i32],
    instructions: [
      ...i32Const(8),
      ...call(RuntimeFn.alloc),
      ...localSet(1),

      ...localGet(1),
      ...i32Const(0),
      Op.i32Store, ...memarg(2, 0),

      ...localGet(1),
      ...localGet(0),
      Op.i32Store, ...memarg(2, 4),

      ...i64Const(JSValue.ARRAY),
      ...localGet(1),
      Op.i64ExtendI32U,
      Op.i64Or,
    ],
  });
}

function arraySetBody() {
  return encodeFunctionBody({
    locals: [ValType.i32, ValType.i32],
    instructions: [
      ...localGet(1),
      ...i32Const(0),
      Op.i32LtS,
      Op.if, emptyBlock,
        ...localGet(0),
        Op.return,
      Op.end,

      ...localGet(0),
      Op.i32WrapI64,
      ...localSet(3),

      ...localGet(1),
      ...localGet(3),
      Op.i32Load, ...memarg(2, 4),
      Op.i32GeU,
      Op.if, emptyBlock,
        ...localGet(3),
        ...localGet(1),
        ...i32Const(1),
        Op.i32Add,
        Op.i32Store, ...memarg(2, 4),
      Op.end,

      ...i32Const(16),
      ...call(RuntimeFn.alloc),
      ...localSet(4),

      ...localGet(4),
      ...localGet(3),
      Op.i32Load, ...memarg(2, 0),
      Op.i32Store, ...memarg(2, 0),

      ...localGet(4),
      ...localGet(1),
      ...i32Const(-2147483648),
      Op.i32Xor,
      Op.i32Store, ...memarg(2, 4),

      ...localGet(4),
      ...localGet(2),
      Op.i64Store, ...memarg(3, 8),

      ...localGet(3),
      ...localGet(4),
      Op.i32Store, ...memarg(2, 0),

      ...localGet(0),
    ],
  });
}

function arrayGetBody() {
  return encodeFunctionBody({
    locals: [ValType.i32, ValType.i32, ValType.i32],
    instructions: [
      ...localGet(1),
      ...i32Const(0),
      Op.i32LtS,
      Op.if, emptyBlock,
        ...i64Const(JSValue.UNDEFINED),
        Op.return,
      Op.end,

      ...localGet(0),
      Op.i32WrapI64,
      ...localSet(2),

      ...localGet(1),
      ...i32Const(-2147483648),
      Op.i32Xor,
      ...localSet(4),

      ...localGet(2),
      Op.i32Load, ...memarg(2, 0),
      ...localSet(3),

      Op.block, emptyBlock,
        Op.loop, emptyBlock,
          ...localGet(3),
          Op.i32Eqz,
          Op.brIf, ...u32(1),

          ...localGet(3),
          Op.i32Load, ...memarg(2, 4),
          ...localGet(4),
          Op.i32Eq,
          Op.if, emptyBlock,
            ...localGet(3),
            Op.i64Load, ...memarg(3, 8),
            Op.return,
          Op.end,

          ...localGet(3),
          Op.i32Load, ...memarg(2, 0),
          ...localSet(3),
          Op.br, ...u32(0),
        Op.end,
      Op.end,

      ...i64Const(JSValue.UNDEFINED),
    ],
  });
}

function stringEqualBody() {
  return encodeFunctionBody({
    locals: [ValType.i32, ValType.i32, ValType.i32, ValType.i32],
    instructions: [
      ...localGet(0),
      Op.i32WrapI64,
      ...localSet(2),

      ...localGet(1),
      Op.i32WrapI64,
      ...localSet(3),

      ...localGet(2),
      Op.i32Load, ...memarg(2, 0),
      ...localGet(3),
      Op.i32Load, ...memarg(2, 0),
      Op.i32Ne,
      Op.if, emptyBlock,
        ...i32Const(0),
        Op.return,
      Op.end,

      ...localGet(2),
      Op.i32Load, ...memarg(2, 0),
      ...localSet(4),

      ...i32Const(0),
      ...localSet(5),

      Op.block, emptyBlock,
        Op.loop, emptyBlock,
          ...localGet(5),
          ...localGet(4),
          Op.i32GeU,
          Op.brIf, ...u32(1),

          ...localGet(2),
          ...i32Const(4),
          Op.i32Add,
          ...localGet(5),
          ...i32Const(2),
          Op.i32Mul,
          Op.i32Add,
          Op.i32Load16U, ...memarg(1, 0),

          ...localGet(3),
          ...i32Const(4),
          Op.i32Add,
          ...localGet(5),
          ...i32Const(2),
          Op.i32Mul,
          Op.i32Add,
          Op.i32Load16U, ...memarg(1, 0),

          Op.i32Ne,
          Op.if, emptyBlock,
            ...i32Const(0),
            Op.return,
          Op.end,

          ...localGet(5),
          ...i32Const(1),
          Op.i32Add,
          ...localSet(5),
          Op.br, ...u32(0),
        Op.end,
      Op.end,

      ...i32Const(1),
    ],
  });
}

function stringConcatBody() {
  return encodeFunctionBody({
    locals: [
      ValType.i32, ValType.i32, ValType.i32, ValType.i32,
      ValType.i32, ValType.i32, ValType.i32,
    ],
    instructions: [
      ...localGet(0),
      Op.i32WrapI64,
      ...localSet(2),

      ...localGet(1),
      Op.i32WrapI64,
      ...localSet(3),

      ...localGet(2),
      Op.i32Load, ...memarg(2, 0),
      ...localSet(4),

      ...localGet(3),
      Op.i32Load, ...memarg(2, 0),
      ...localSet(5),

      ...localGet(4),
      ...localGet(5),
      Op.i32Add,
      ...localSet(8),

      ...i32Const(4),
      ...localGet(8),
      ...i32Const(2),
      Op.i32Mul,
      Op.i32Add,
      ...call(RuntimeFn.alloc),
      ...localSet(6),

      ...localGet(6),
      ...localGet(8),
      Op.i32Store, ...memarg(2, 0),

      ...i32Const(0),
      ...localSet(7),

      Op.block, emptyBlock,
        Op.loop, emptyBlock,
          ...localGet(7),
          ...localGet(4),
          Op.i32GeU,
          Op.brIf, ...u32(1),

          ...localGet(6),
          ...i32Const(4),
          Op.i32Add,
          ...localGet(7),
          ...i32Const(2),
          Op.i32Mul,
          Op.i32Add,

          ...localGet(2),
          ...i32Const(4),
          Op.i32Add,
          ...localGet(7),
          ...i32Const(2),
          Op.i32Mul,
          Op.i32Add,
          Op.i32Load16U, ...memarg(1, 0),
          Op.i32Store16, ...memarg(1, 0),

          ...localGet(7),
          ...i32Const(1),
          Op.i32Add,
          ...localSet(7),
          Op.br, ...u32(0),
        Op.end,
      Op.end,

      ...i32Const(0),
      ...localSet(7),

      Op.block, emptyBlock,
        Op.loop, emptyBlock,
          ...localGet(7),
          ...localGet(5),
          Op.i32GeU,
          Op.brIf, ...u32(1),

          ...localGet(6),
          ...i32Const(4),
          Op.i32Add,
          ...localGet(4),
          ...localGet(7),
          Op.i32Add,
          ...i32Const(2),
          Op.i32Mul,
          Op.i32Add,

          ...localGet(3),
          ...i32Const(4),
          Op.i32Add,
          ...localGet(7),
          ...i32Const(2),
          Op.i32Mul,
          Op.i32Add,
          Op.i32Load16U, ...memarg(1, 0),
          Op.i32Store16, ...memarg(1, 0),

          ...localGet(7),
          ...i32Const(1),
          Op.i32Add,
          ...localSet(7),
          Op.br, ...u32(0),
        Op.end,
      Op.end,

      ...i64Const(JSValue.STRING),
      ...localGet(6),
      Op.i64ExtendI32U,
      Op.i64Or,
    ],
  });
}

function addBody() {
  return encodeFunctionBody({
    instructions: [
      ...localGet(0),
      ...i64Const(JSValue.TAG_MASK),
      Op.i64And,
      ...i64Const(JSValue.STRING),
      Op.i64Eq,
      Op.if, emptyBlock,
        ...localGet(1),
        ...i64Const(JSValue.TAG_MASK),
        Op.i64And,
        ...i64Const(JSValue.STRING),
        Op.i64Eq,
        Op.if, emptyBlock,
          ...localGet(0),
          ...localGet(1),
          ...call(RuntimeFn.stringConcat),
          Op.return,
        Op.end,
        ...i64Const(JSValue.UNDEFINED),
        Op.return,
      Op.end,

      ...localGet(1),
      ...i64Const(JSValue.TAG_MASK),
      Op.i64And,
      ...i64Const(JSValue.STRING),
      Op.i64Eq,
      Op.if, emptyBlock,
        ...i64Const(JSValue.UNDEFINED),
        Op.return,
      Op.end,

      ...localGet(0),
      Op.f64ReinterpretI64,
      ...localGet(1),
      Op.f64ReinterpretI64,
      Op.f64Add,
      ...call(RuntimeFn.numberFromF64),
    ],
  });
}

function collectPropertyNames(program) {
  const names = new Set();

  function visitExpression(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'string') return;
    if (node.type === 'array') {
      node.elements.forEach(visitExpression);
      return;
    }
    if (node.type === 'index') {
      visitExpression(node.object);
      visitExpression(node.index);
      return;
    }
    if (node.type === 'object') {
      for (const property of node.properties) {
        names.add(property.key);
        visitExpression(property.value);
      }
      return;
    }
    if (node.type === 'member') {
      names.add(node.property);
      visitExpression(node.object);
      return;
    }
    if (node.type === 'call') {
      visitExpression(node.callee);
      node.args.forEach(visitExpression);
      return;
    }
    if (node.type === 'binary') {
      visitExpression(node.left);
      visitExpression(node.right);
      return;
    }
    if (node.type === 'unary') visitExpression(node.value);
  }

  function visitStatement(statement) {
    if (statement.type === 'var') visitExpression(statement.init);
    else if (statement.type === 'assign') {
      visitExpression(statement.target);
      visitExpression(statement.value);
    }
    else if (statement.type === 'return') visitExpression(statement.value);
    else if (statement.type === 'expression') visitExpression(statement.expression);
    else if (statement.type === 'if') {
      visitExpression(statement.test);
      statement.consequent.forEach(visitStatement);
      statement.alternate?.forEach(visitStatement);
    } else if (statement.type === 'while') {
      visitExpression(statement.test);
      statement.body.forEach(visitStatement);
    }
  }

  for (const fn of program.functions) fn.statements.forEach(visitStatement);

  const ids = new Map();
  if (names.has('length')) ids.set('length', 0);
  let next = 1;
  for (const name of names) {
    if (name === 'length') continue;
    ids.set(name, next++);
  }
  return ids;
}

function collectStringLiterals(program) {
  const values = new Set();

  function visitExpression(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'string') {
      values.add(node.value);
      return;
    }
    if (node.type === 'array') {
      node.elements.forEach(visitExpression);
      return;
    }
    if (node.type === 'index') {
      visitExpression(node.object);
      visitExpression(node.index);
      return;
    }
    if (node.type === 'object') {
      node.properties.forEach((property) => visitExpression(property.value));
      return;
    }
    if (node.type === 'member') {
      visitExpression(node.object);
      return;
    }
    if (node.type === 'call') {
      visitExpression(node.callee);
      node.args.forEach(visitExpression);
      return;
    }
    if (node.type === 'binary') {
      visitExpression(node.left);
      visitExpression(node.right);
      return;
    }
    if (node.type === 'unary') visitExpression(node.value);
  }

  function visitStatement(statement) {
    if (statement.type === 'var') visitExpression(statement.init);
    else if (statement.type === 'assign') {
      visitExpression(statement.target);
      visitExpression(statement.value);
    }
    else if (statement.type === 'return') visitExpression(statement.value);
    else if (statement.type === 'expression') visitExpression(statement.expression);
    else if (statement.type === 'if') {
      visitExpression(statement.test);
      statement.consequent.forEach(visitStatement);
      statement.alternate?.forEach(visitStatement);
    } else if (statement.type === 'while') {
      visitExpression(statement.test);
      statement.body.forEach(visitStatement);
    }
  }

  for (const fn of program.functions) fn.statements.forEach(visitStatement);
  return [...values];
}

function align(value, alignment = 8) {
  return Math.ceil(value / alignment) * alignment;
}

function stringData(value) {
  const bytes = [
    value.length & 0xff,
    (value.length >>> 8) & 0xff,
    (value.length >>> 16) & 0xff,
    (value.length >>> 24) & 0xff,
  ];

  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    bytes.push(unit & 0xff, unit >>> 8);
  }

  return bytes;
}

function layoutStringLiterals(program, start = 1024) {
  const pointers = new Map();
  const segments = [];
  let cursor = start;

  for (const value of collectStringLiterals(program)) {
    cursor = align(cursor);
    const bytes = stringData(value);
    pointers.set(value, cursor);
    segments.push({ offset: cursor, bytes });
    cursor += bytes.length;
  }

  return {
    pointers,
    segments,
    heapStart: align(cursor),
  };
}

function bindingIndex(scope, name) {
  const binding = scope.get(name);
  if (!binding) throw new ReferenceError('Unknown identifier: ' + name);
  return binding.index;
}

function compileArrayIndex(node, scope, propertyIds, functions) {
  return [
    ...compileExpression(node, scope, propertyIds, functions),
    Op.f64ReinterpretI64,
    Op.i32TruncF64S,
  ];
}

function compileExpression(node, scope, propertyIds, functions) {
  switch (node.type) {
    case 'number':
      return i64Const(numberToBits(node.value));
    case 'string': {
      const pointer = scope.stringLiterals.get(node.value);
      if (pointer === undefined) throw new Error('String literal was not interned');
      return [
        ...i64Const(JSValue.STRING),
        ...i64Const(BigInt(pointer)),
        Op.i64Or,
      ];
    }
    case 'literal': {
      const bits = node.value === undefined ? JSValue.UNDEFINED
        : node.value === null ? JSValue.NULL
          : node.value === true ? JSValue.TRUE
            : JSValue.FALSE;
      return i64Const(bits);
    }
    case 'id':
      return localGet(bindingIndex(scope, node.name));
    case 'unary': {
      const value = compileExpression(node.value, scope, propertyIds, functions);
      if (node.op === '+') return value;
      if (node.op === '!') {
        return booleanFromI32([
          ...value,
          ...call(RuntimeFn.truthy),
          Op.i32Eqz,
        ]);
      }
      return [
        ...value,
        Op.f64ReinterpretI64,
        Op.f64Neg,
        ...call(RuntimeFn.numberFromF64),
      ];
    }
    case 'binary': {
      if (node.op === '+') {
        return [
          ...compileExpression(node.left, scope, propertyIds, functions),
          ...compileExpression(node.right, scope, propertyIds, functions),
          ...call(RuntimeFn.add),
        ];
      }

      const arithmeticOpcode = {
        '-': Op.f64Sub,
        '*': Op.f64Mul,
        '/': Op.f64Div,
      }[node.op];

      if (arithmeticOpcode !== undefined) {
        return [
          ...compileExpression(node.left, scope, propertyIds, functions),
          Op.f64ReinterpretI64,
          ...compileExpression(node.right, scope, propertyIds, functions),
          Op.f64ReinterpretI64,
          arithmeticOpcode,
          ...call(RuntimeFn.numberFromF64),
        ];
      }

      const relationalOpcode = {
        '<': Op.f64Lt,
        '<=': Op.f64Le,
        '>': Op.f64Gt,
        '>=': Op.f64Ge,
      }[node.op];

      if (relationalOpcode !== undefined) {
        return booleanFromI32([
          ...compileExpression(node.left, scope, propertyIds, functions),
          Op.f64ReinterpretI64,
          ...compileExpression(node.right, scope, propertyIds, functions),
          Op.f64ReinterpretI64,
          relationalOpcode,
        ]);
      }

      if (node.op === '===' || node.op === '!==') {
        const condition = [
          ...compileExpression(node.left, scope, propertyIds, functions),
          ...compileExpression(node.right, scope, propertyIds, functions),
          ...call(RuntimeFn.strictEqual),
        ];
        if (node.op === '!==') condition.push(Op.i32Eqz);
        return booleanFromI32(condition);
      }

      throw new SyntaxError('Unsupported binary operator: ' + node.op);
    }
    case 'array': {
      const instructions = [
        ...i32Const(node.elements.length),
        ...call(RuntimeFn.arrayNew),
      ];
      node.elements.forEach((element, index) => {
        instructions.push(
          ...i32Const(index),
          ...compileExpression(element, scope, propertyIds, functions),
          ...call(RuntimeFn.arraySet),
        );
      });
      return instructions;
    }
    case 'index':
      return [
        ...compileExpression(node.object, scope, propertyIds, functions),
        ...compileArrayIndex(node.index, scope, propertyIds, functions),
        ...call(RuntimeFn.arrayGet),
      ];
    case 'object': {
      const instructions = [
        ...i32Const(node.properties.length),
        ...call(RuntimeFn.objectNew),
      ];
      for (const property of node.properties) {
        instructions.push(
          ...i32Const(propertyIds.get(property.key)),
          ...compileExpression(property.value, scope, propertyIds, functions),
          ...call(RuntimeFn.objectSet),
        );
      }
      return instructions;
    }
    case 'member':
      return [
        ...compileExpression(node.object, scope, propertyIds, functions),
        ...i32Const(propertyIds.get(node.property)),
        ...call(RuntimeFn.objectGet),
      ];
    case 'call': {
      if (node.callee.type !== 'id') {
        throw new SyntaxError('Only direct function calls are supported');
      }
      if (scope.has(node.callee.name)) {
        throw new SyntaxError('Calling local values is not supported: ' + node.callee.name);
      }
      const fn = functions.get(node.callee.name);
      if (!fn) throw new ReferenceError('Unknown function: ' + node.callee.name);
      if (node.args.length !== fn.paramCount) {
        throw new TypeError(
          'Function ' + node.callee.name + ' expects ' + fn.paramCount +
          ' arguments, got ' + node.args.length,
        );
      }
      return [
        ...node.args.flatMap((arg) => compileExpression(arg, scope, propertyIds, functions)),
        ...call(fn.index),
      ];
    }
    default:
      throw new Error('Unknown AST node: ' + node.type);
  }
}

function branchDepth(labels, kind) {
  const depth = labels.findIndex((label) => label === kind);
  if (depth === -1) throw new SyntaxError(kind + ' used outside of a loop');
  return depth;
}

function compileStatements(statements, scope, locals, propertyIds, functions, labels = []) {
  const instructions = [];

  for (const statement of statements) {
    if (statement.type === 'var') {
      if (scope.has(statement.name)) throw new SyntaxError('Duplicate local: ' + statement.name);
      const localIndex = scope.paramCount + locals.length;
      instructions.push(...compileExpression(statement.init, scope, propertyIds, functions));
      instructions.push(...localSet(localIndex));
      locals.push(ValType.i64);
      scope.set(statement.name, { index: localIndex, kind: statement.kind });
      continue;
    }

    if (statement.type === 'assign') {
      if (statement.target.type === 'id') {
        const binding = scope.get(statement.target.name);
        if (!binding) throw new ReferenceError('Unknown identifier: ' + statement.target.name);
        if (binding.kind === 'const') {
          throw new TypeError('Assignment to constant variable: ' + statement.target.name);
        }
        instructions.push(...compileExpression(statement.value, scope, propertyIds, functions));
        instructions.push(...localSet(binding.index));
        continue;
      }

      if (statement.target.type === 'index') {
        instructions.push(
          ...compileExpression(statement.target.object, scope, propertyIds, functions),
          ...compileArrayIndex(statement.target.index, scope, propertyIds, functions),
          ...compileExpression(statement.value, scope, propertyIds, functions),
          ...call(RuntimeFn.arraySet),
          Op.drop,
        );
        continue;
      }

      instructions.push(
        ...compileExpression(statement.target.object, scope, propertyIds, functions),
        ...i32Const(propertyIds.get(statement.target.property)),
        ...compileExpression(statement.value, scope, propertyIds, functions),
        ...call(RuntimeFn.objectSet),
        Op.drop,
      );
      continue;
    }

    if (statement.type === 'return') {
      instructions.push(...compileExpression(statement.value, scope, propertyIds, functions));
      instructions.push(Op.return);
      continue;
    }

    if (statement.type === 'expression') {
      instructions.push(...compileExpression(statement.expression, scope, propertyIds, functions));
      instructions.push(Op.drop);
      continue;
    }

    if (statement.type === 'if') {
      instructions.push(
        ...compileExpression(statement.test, scope, propertyIds, functions),
        ...call(RuntimeFn.truthy),
        Op.if, emptyBlock,
        ...compileStatements(
          statement.consequent,
          childScope(scope),
          locals,
          propertyIds,
          functions,
          ['if', ...labels],
        ),
      );
      if (statement.alternate) {
        instructions.push(
          Op.else,
          ...compileStatements(
            statement.alternate,
            childScope(scope),
            locals,
            propertyIds,
            functions,
            ['if', ...labels],
          ),
        );
      }
      instructions.push(Op.end);
      continue;
    }

    if (statement.type === 'while') {
      instructions.push(
        Op.block, emptyBlock,
          Op.loop, emptyBlock,
            ...compileExpression(statement.test, scope, propertyIds, functions),
            ...call(RuntimeFn.truthy),
            Op.i32Eqz,
            Op.brIf, ...u32(1),
            ...compileStatements(
              statement.body,
              childScope(scope),
              locals,
              propertyIds,
              functions,
              ['continue', 'break', ...labels],
            ),
            Op.br, ...u32(0),
          Op.end,
        Op.end,
      );
      continue;
    }

    if (statement.type === 'break') {
      instructions.push(Op.br, ...u32(branchDepth(labels, 'break')));
      continue;
    }

    if (statement.type === 'continue') {
      instructions.push(Op.br, ...u32(branchDepth(labels, 'continue')));
      continue;
    }

    throw new Error('Unknown statement type: ' + statement.type);
  }

  return instructions;
}

function childScope(parent) {
  const scope = new Map(parent);
  scope.paramCount = parent.paramCount;
  scope.stringLiterals = parent.stringLiterals;
  return scope;
}

export function parseDynamic(source) {
  return new Parser(source).parseProgram();
}

function compileSourceFunction(fn, propertyIds, functions, stringLiterals) {
  const scope = new Map();
  scope.paramCount = fn.params.length;
  scope.stringLiterals = stringLiterals;
  fn.params.forEach((name, index) => scope.set(name, { index, kind: 'param' }));

  const locals = [];
  const instructions = compileStatements(
    fn.statements,
    scope,
    locals,
    propertyIds,
    functions,
  );
  instructions.push(...i64Const(JSValue.UNDEFINED));
  return encodeFunctionBody({ locals, instructions });
}

export function compileDynamic(source) {
  const program = parseDynamic(source);
  const propertyIds = collectPropertyNames(program);
  const stringLayout = layoutStringLiterals(program);

  const functions = new Map();
  program.functions.forEach((fn, index) => {
    functions.set(fn.name, {
      index: RuntimeFunctionCount + index,
      typeIndex: RuntimeFunctionCount + index,
      paramCount: fn.params.length,
      exported: fn.exported,
    });
  });

  const runtimeTypes = [
    functionType([ValType.i32], [ValType.i32]),
    functionType([ValType.i32], [ValType.i64]),
    functionType([ValType.i64, ValType.i32, ValType.i64], [ValType.i64]),
    functionType([ValType.i64, ValType.i32], [ValType.i64]),
    functionType([ValType.f64], [ValType.i64]),
    functionType([ValType.i64], [ValType.i32]),
    functionType([ValType.i64, ValType.i64], [ValType.i32]),
    functionType([ValType.i32], [ValType.i64]),
    functionType([ValType.i64, ValType.i32, ValType.i64], [ValType.i64]),
    functionType([ValType.i64, ValType.i32], [ValType.i64]),
    functionType([ValType.i64, ValType.i64], [ValType.i32]),
    functionType([ValType.i64, ValType.i64], [ValType.i64]),
    functionType([ValType.i64, ValType.i64], [ValType.i64]),
  ];

  const sourceTypes = program.functions.map((fn) => (
    functionType(fn.params.map(() => ValType.i64), [ValType.i64])
  ));

  const typeSection = section(1, vec([...runtimeTypes, ...sourceTypes]));
  const functionSection = section(3, vec([
    ...runtimeTypes.map((_, index) => [...u32(index)]),
    ...program.functions.map((_, index) => [...u32(RuntimeFunctionCount + index)]),
  ]));
  const memoryPages = Math.max(1, Math.ceil((stringLayout.heapStart + 65536) / 65536));
  const memorySection = section(5, vec([[0x00, ...u32(memoryPages)]]));
  const globalSection = section(6, vec([[
    ValType.i32, 0x01,
    Op.i32Const, ...s32(stringLayout.heapStart), Op.end,
  ]]));

  const exports = program.functions
    .filter((fn) => fn.exported)
    .map((fn) => [
      ...wasmString(fn.name),
      0x00,
      ...u32(functions.get(fn.name).index),
    ]);
  exports.push([...wasmString('memory'), 0x02, ...u32(0)]);
  exports.push([...wasmString('__wasmesc_alloc'), 0x00, ...u32(RuntimeFn.alloc)]);
  const exportSection = section(7, vec(exports));

  const codeSection = section(10, vec([
    allocBody(),
    objectNewBody(),
    objectSetBody(),
    objectGetBody(),
    numberFromF64Body(),
    truthyBody(),
    strictEqualBody(),
    arrayNewBody(),
    arraySetBody(),
    arrayGetBody(),
    stringEqualBody(),
    stringConcatBody(),
    addBody(),
    ...program.functions.map((fn) => (
      compileSourceFunction(fn, propertyIds, functions, stringLayout.pointers)
    )),
  ]));

  const dataSection = stringLayout.segments.length === 0 ? null : section(11, vec(
    stringLayout.segments.map(({ offset, bytes }) => [
      0x00,
      Op.i32Const, ...s32(offset), Op.end,
      ...u32(bytes.length),
      ...bytes,
    ]),
  ));

  return moduleBytes([
    typeSection,
    functionSection,
    memorySection,
    globalSection,
    exportSection,
    codeSection,
    ...(dataSection ? [dataSection] : []),
  ]);
}

