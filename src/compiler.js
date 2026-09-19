import {
  ValType,
  encodeFunctionBody,
  f64Bytes,
  functionType,
  moduleBytes,
  section,
  u32,
  vec,
  wasmString,
} from './wasm.js';

const KEYWORDS = new Set(['export', 'function', 'return', 'let', 'const']);

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
      i = source.indexOf('\n', i + 2);
      if (i === -1) break;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      const value = source.slice(start, i);
      tokens.push({ type: KEYWORDS.has(value) ? value : 'id', value, pos: start });
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      const start = i;
      const match = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) throw new SyntaxError(`Invalid number at ${i}`);
      i += match[0].length;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new SyntaxError(`Invalid finite number at ${start}`);
      tokens.push({ type: 'number', value, pos: start });
      continue;
    }

    if ('()+-*/{},;='.includes(ch)) {
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
    let left = this.parsePrefix();
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

  parsePrefix() {
    if (this.maybe('-')) return { type: 'unary', op: '-', value: this.parsePrefix() };
    if (this.maybe('+')) return { type: 'unary', op: '+', value: this.parsePrefix() };

    if (this.peek('number')) return { type: 'number', value: this.take('number').value };
    if (this.peek('id')) return { type: 'id', name: this.take('id').value };

    if (this.maybe('(')) {
      const value = this.parseExpression();
      this.take(')');
      return value;
    }

    const token = this.tokens[this.i];
    throw new SyntaxError(`Expected expression at ${token.pos}`);
  }
}

function compileExpression(node, scope) {
  switch (node.type) {
    case 'number':
      return [0x44, ...f64Bytes(node.value)]; // f64.const
    case 'id': {
      const index = scope.get(node.name);
      if (index === undefined) throw new ReferenceError(`Unknown identifier: ${node.name}`);
      return [0x20, ...u32(index)]; // local.get
    }
    case 'unary': {
      const value = compileExpression(node.value, scope);
      if (node.op === '+') return value;
      return [...value, 0x9a]; // f64.neg
    }
    case 'binary': {
      const opcode = { '+': 0xa0, '-': 0xa1, '*': 0xa2, '/': 0xa3 }[node.op];
      return [
        ...compileExpression(node.left, scope),
        ...compileExpression(node.right, scope),
        opcode,
      ];
    }
    default:
      throw new Error(`Unknown AST node: ${node.type}`);
  }
}

export function parse(source) {
  return new Parser(source).parseProgram();
}

export function compile(source) {
  const ast = parse(source);
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
      instructions.push(...compileExpression(statement.init, scope));
      instructions.push(0x21, ...u32(localIndex)); // local.set
      locals.push(ValType.f64);
      scope.set(statement.name, localIndex);
      continue;
    }

    if (statement.type === 'return') {
      instructions.push(...compileExpression(statement.value, scope));
      instructions.push(0x0f); // return
      returned = true;
      continue;
    }
  }

  const typeSection = section(1, vec([
    functionType(ast.params.map(() => ValType.f64), [ValType.f64]),
  ]));

  const functionSection = section(3, vec([[...u32(0)]]));

  const exportSection = section(7, vec([[
    ...wasmString(ast.name),
    0x00, // function export
    ...u32(0),
  ]]));

  const codeSection = section(10, vec([
    encodeFunctionBody({ locals, instructions }),
  ]));

  return moduleBytes([typeSection, functionSection, exportSection, codeSection]);
}
