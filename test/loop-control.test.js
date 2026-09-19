import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic } from '../src/dynamic.js';
import { decodeJSValue } from '../src/jsvalue.js';

async function run(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  const instance = result.instance ?? result;
  const name = WebAssembly.Module.exports(module).find((x) => x.kind === 'function').name;
  return decodeJSValue(instance.exports[name]());
}

test('break exits the nearest while loop', async () => {
  const value = await run(`
    function f() {
      let i = 0;
      while (i < 10) {
        if (i === 5) {
          break;
        }
        i = i + 1;
      }
      return i;
    }
  `);
  assert.equal(value, 5);
});

test('continue branches back to the nearest loop header', async () => {
  const value = await run(`
    function f() {
      let i = 0;
      let total = 0;
      while (i < 6) {
        i = i + 1;
        if (i === 3) {
          continue;
        }
        total = total + i;
      }
      return total;
    }
  `);
  assert.equal(value, 18);
});

test('nested if blocks preserve break branch depth', async () => {
  const value = await run(`
    function f() {
      let i = 0;
      while (i < 10) {
        if (i >= 2) {
          if (i === 4) {
            break;
          }
        }
        i = i + 1;
      }
      return i;
    }
  `);
  assert.equal(value, 4);
});

test('break targets the nearest loop in nested loops', async () => {
  const value = await run(`
    function f() {
      let outer = 0;
      let count = 0;
      while (outer < 3) {
        let inner = 0;
        while (inner < 10) {
          if (inner === 2) {
            break;
          }
          count = count + 1;
          inner = inner + 1;
        }
        outer = outer + 1;
      }
      return count;
    }
  `);
  assert.equal(value, 6);
});

test('continue targets the nearest loop in nested loops', async () => {
  const value = await run(`
    function f() {
      let outer = 0;
      let count = 0;
      while (outer < 2) {
        let inner = 0;
        while (inner < 4) {
          inner = inner + 1;
          if (inner === 2) {
            continue;
          }
          count = count + 1;
        }
        outer = outer + 1;
      }
      return count;
    }
  `);
  assert.equal(value, 6);
});

test('break and continue outside loops are rejected', () => {
  assert.throws(() => compileDynamic('function f(){ break; return 0; }'), SyntaxError);
  assert.throws(() => compileDynamic('function f(){ continue; return 0; }'), SyntaxError);
});
