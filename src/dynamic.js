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

    const multi = MULTI_CHAR_TOKENS.find((token) => source.startsWith(token, i));
    if (multi) {
      tokens.push({ type: multi, value: multi, pos: i });
      i += multi.length;
      continue;
    }

    if ('()+-*/{},;=:.<>!'.includes(ch)) {
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
    const statements = this.parseBlock();
    this.take('eof');

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
        if (target.type !== 'id' && target.type !== 'member') {
          throw new SyntaxError('Invalid assignment target');
        }
        const value = this.parseExpression();
        this.maybe(';');
        return { type: 'assign', target, value };
      }
      this.i = start;
    }

    const token = this.tokens[this.i];
    throw new SyntaxError('Unsupported statement at ' + token.pos);
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
  drop: 0x1a,
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
  f64Const: 0x44,
  i32Eqz: 0x45,
  i32Eq: 0x46,
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
  truthy: 5,
  strictEqual: 6,
  main: 7,
});

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

      ...localGet(3),
      ...localGet(3),
      Op.i32Load, ...memarg(2, 4),
      ...i32Const(1),
      Op.i32Add,
      Op.i32Store, ...memarg(2, 4),

      ...localGet(0),
    ],
  });
}

function objectGetBody() {
  return encodeFunctionBody({
    locals: [ValType.i32, ValType.i32],
    instructions: [
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

function collectPropertyNames(ast) {
  const names = new Set();

  function visitExpression(node) {
    if (!node || typeof node !== 'object') return;
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
    else if (statement.type === 'if') {
      visitExpression(statement.test);
      statement.consequent.forEach(visitStatement);
      statement.alternate?.forEach(visitStatement);
    } else if (statement.type === 'while') {
      visitExpression(statement.test);
      statement.body.forEach(visitStatement);
    }
  }

  ast.statements.forEach(visitStatement);
  return new Map([...names].map((name, index) => [name, index + 1]));
}

function bindingIndex(scope, name) {
  const binding = scope.get(name);
  if (!binding) throw new ReferenceError('Unknown identifier: ' + name);
  return binding.index;
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
    case 'id':
      return localGet(bindingIndex(scope, node.name));
    case 'unary': {
      const value = compileExpression(node.value, scope, propertyIds);
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
      const arithmeticOpcode = {
        '+': Op.f64Add,
        '-': Op.f64Sub,
        '*': Op.f64Mul,
        '/': Op.f64Div,
      }[node.op];

      if (arithmeticOpcode !== undefined) {
        return [
          ...compileExpression(node.left, scope, propertyIds),
          Op.f64ReinterpretI64,
          ...compileExpression(node.right, scope, propertyIds),
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
          ...compileExpression(node.left, scope, propertyIds),
          Op.f64ReinterpretI64,
          ...compileExpression(node.right, scope, propertyIds),
          Op.f64ReinterpretI64,
          relationalOpcode,
        ]);
      }

      if (node.op === '===' || node.op === '!==') {
        const condition = [
          ...compileExpression(node.left, scope, propertyIds),
          ...compileExpression(node.right, scope, propertyIds),
          ...call(RuntimeFn.strictEqual),
        ];
        if (node.op === '!==') condition.push(Op.i32Eqz);
        return booleanFromI32(condition);
      }

      throw new SyntaxError('Unsupported binary operator: ' + node.op);
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
      throw new Error('Unknown AST node: ' + node.type);
  }
}

function branchDepth(labels, kind) {
  const depth = labels.findIndex((label) => label === kind);
  if (depth === -1) throw new SyntaxError(kind + ' used outside of a loop');
  return depth;
}

function compileStatements(statements, scope, locals, propertyIds, labels = []) {
  const instructions = [];

  for (const statement of statements) {
    if (statement.type === 'var') {
      if (scope.has(statement.name)) throw new SyntaxError('Duplicate local: ' + statement.name);
      const localIndex = scope.paramCount + locals.length;
      instructions.push(...compileExpression(statement.init, scope, propertyIds));
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
        instructions.push(...compileExpression(statement.value, scope, propertyIds));
        instructions.push(...localSet(binding.index));
        continue;
      }

      instructions.push(
        ...compileExpression(statement.target.object, scope, propertyIds),
        ...i32Const(propertyIds.get(statement.target.property)),
        ...compileExpression(statement.value, scope, propertyIds),
        ...call(RuntimeFn.objectSet),
        Op.drop,
      );
      continue;
    }

    if (statement.type === 'return') {
      instructions.push(...compileExpression(statement.value, scope, propertyIds));
      instructions.push(Op.return);
      continue;
    }

    if (statement.type === 'if') {
      instructions.push(
        ...compileExpression(statement.test, scope, propertyIds),
        ...call(RuntimeFn.truthy),
        Op.if, emptyBlock,
        ...compileStatements(
          statement.consequent,
          childScope(scope),
          locals,
          propertyIds,
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
            ...compileExpression(statement.test, scope, propertyIds),
            ...call(RuntimeFn.truthy),
            Op.i32Eqz,
            Op.brIf, ...u32(1),
            ...compileStatements(
              statement.body,
              childScope(scope),
              locals,
              propertyIds,
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
  return scope;
}

export function parseDynamic(source) {
  return new Parser(source).parseProgram();
}

export function compileDynamic(source) {
  const ast = parseDynamic(source);
  const propertyIds = collectPropertyNames(ast);
  const scope = new Map();
  scope.paramCount = ast.params.length;
  ast.params.forEach((name, index) => scope.set(name, { index, kind: 'param' }));

  const locals = [];
  const instructions = compileStatements(ast.statements, scope, locals, propertyIds);
  instructions.push(...i64Const(JSValue.UNDEFINED));

  const types = [
    functionType([ValType.i32], [ValType.i32]),
    functionType([ValType.i32], [ValType.i64]),
    functionType([ValType.i64, ValType.i32, ValType.i64], [ValType.i64]),
    functionType([ValType.i64, ValType.i32], [ValType.i64]),
    functionType([ValType.f64], [ValType.i64]),
    functionType([ValType.i64], [ValType.i32]),
    functionType([ValType.i64, ValType.i64], [ValType.i32]),
    functionType(ast.params.map(() => ValType.i64), [ValType.i64]),
  ];

  const typeSection = section(1, vec(types));
  const functionSection = section(3, vec([
    [...u32(0)], [...u32(1)], [...u32(2)], [...u32(3)],
    [...u32(4)], [...u32(5)], [...u32(6)], [...u32(7)],
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
    truthyBody(),
    strictEqualBody(),
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
