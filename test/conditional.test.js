import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDynamic, parseDynamic } from '../src/dynamic.js';
import { decodeJSValue } from '../src/jsvalue.js';

async function run(source) {
  const bytes = compileDynamic(source);
  const module = await WebAssembly.compile(bytes);
  const result = await WebAssembly.instantiate(module, {});
  const instance = result.instance ?? result;
  const name = WebAssembly.Module.exports(module).find((x) => (
    x.kind === 'function' && x.name !== '__wasmesc_alloc'
  )).name;
  const raw = instance.exports[name]();
  return {
    module,
    instance,
    value: decodeJSValue(raw, instance.exports.memory),
  };
}

test('parser gives conditional lower precedence than logical OR', () => {
  const program = parseDynamic('function f(){ return false || true ? 1 : 2; }');
  const expression = program.functions[0].statements[0].value;
  assert.equal(expression.type, 'conditional');
  assert.equal(expression.test.op, '||');
});

test('conditional expressions associate to the right', () => {
  const program = parseDynamic('function f(){ return false ? 1 : true ? 2 : 3; }');
  const expression = program.functions[0].statements[0].value;
  assert.equal(expression.type, 'conditional');
  assert.equal(expression.alternate.type, 'conditional');
});

test('conditional expression returns selected numeric values', async () => {
  const yes = await run('function answer(){ return true ? 42 : 7; }');
  assert.equal(yes.value, 42);

  const no = await run('function answer(){ return false ? 42 : 7; }');
  assert.equal(no.value, 7);
});

test('conditional expression preserves string and object JSValues', async () => {
  const string = await run('function answer(){ return 0 ? "no" : "yes"; }');
  assert.equal(string.value, 'yes');

  const object = await run(`
    function answer() {
      const first = { value: 42 };
      const second = { value: 7 };
      return (true ? first : second) === first;
    }
  `);
  assert.equal(object.value, true);
});

test('only the selected consequent branch executes', async () => {
  const { value } = await run(`
    function left(object) {
      object.value = 10;
      return 1;
    }

    function right(object) {
      object.value = 20;
      return 2;
    }

    export function answer() {
      const object = { value: 0 };
      true ? left(object) : right(object);
      return object.value;
    }
  `);
  assert.equal(value, 10);
});

test('only the selected alternate branch executes', async () => {
  const { value } = await run(`
    function left(object) {
      object.value = 10;
      return 1;
    }

    function right(object) {
      object.value = 20;
      return 2;
    }

    export function answer() {
      const object = { value: 0 };
      false ? left(object) : right(object);
      return object.value;
    }
  `);
  assert.equal(value, 20);
});

test('nested conditional expressions evaluate right-associatively', async () => {
  const first = await run('function answer(){ return false ? 1 : true ? 2 : 3; }');
  assert.equal(first.value, 2);

  const second = await run('function answer(){ return false ? 1 : false ? 2 : 3; }');
  assert.equal(second.value, 3);
});

test('conditional expressions compose with logical operators', async () => {
  const { value } = await run(`
    function answer() {
      return (0 || 5) ? ("" || "selected") : "other";
    }
  `);
  assert.equal(value, 'selected');
});

test('both branches participate in static property and string collection', async () => {
  const falseBranch = await run(`
    function answer() {
      return false ? { hidden: "unused" }.hidden : "selected";
    }
  `);
  assert.equal(falseBranch.value, 'selected');

  const trueBranch = await run(`
    function answer() {
      return true ? { hidden: "selected" }.hidden : "unused";
    }
  `);
  assert.equal(trueBranch.value, 'selected');
});

test('conditional expressions work inside arithmetic', async () => {
  const { value } = await run('function answer(){ return 10 + (true ? 2 : 5) * 3; }');
  assert.equal(value, 16);
});

test('conditional expressions preserve zero imports', async () => {
  const { module, value } = await run('function answer(){ return true ? 42 : 0; }');
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(value, 42);
});
