import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, parse } from '../src/compiler.js';

test('parses the supported JS subset', () => {
  const ast = parse('export function add(a,b){ const x=b*2; return a+x; }');
  assert.equal(ast.name, 'add');
  assert.deepEqual(ast.params, ['a', 'b']);
});

test('emits a genuinely zero-import Wasm module', async () => {
  const bytes = compile('export function add(a,b){ return a+b; }');
  const module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);

  const instance = await WebAssembly.instantiate(module, {});
  assert.equal(instance.exports.add(20, 22), 42);
});

test('supports locals, precedence, parentheses, and unary minus', async () => {
  const bytes = compile(`
    function calc(a, b) {
      let x = b * 2;
      const y = -(a - 3);
      return (x + y) / 2;
    }
  `);
  const instance = await WebAssembly.instantiate(bytes, {});
  assert.equal(instance.instance.exports.calc(7, 10), 8);
});

test('rejects unsupported or unresolved JS', () => {
  assert.throws(() => compile('function x(a){ return a ** 2; }'), SyntaxError);
  assert.throws(() => compile('function x(a){ return nope + a; }'), ReferenceError);
});
