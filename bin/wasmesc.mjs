#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { inspect } from 'node:util';
import { build, compile } from '../src/compiler.mjs';
import { probe } from '../src/probe.mjs';

const HELP = `Usage:
  wasmesc compile <body.js> [-o output.wasm] [--wat output.wat] [--start]
  wasmesc run <module.wasm> [--instantiate-only]
  wasmesc probe

Input is a JavaScript function body, not an ES module. Use return for a value.
--start executes the body during instantiation (and still exports run).
--instantiate-only avoids a second execution when loading a --start module.
Runtime loading always uses WebAssembly.instantiate(bytes, {}).
`;

async function save(path, bytes) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, bytes);
}

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h') { console.log(HELP); return; }
  if (command === 'probe') {
    if (rest.length) throw new Error('probe takes no arguments');
    console.table(await probe());
    return;
  }
  const input = rest.shift();
  if (!input || input.startsWith('-')) throw new Error(`${command} requires an input file`);
  if (command === 'compile') {
    let output = input.slice(0, input.length - extname(input).length) + '.wasm';
    let wat;
    let autoRun = false;
    while (rest.length) {
      const flag = rest.shift();
      if (flag === '--start') { autoRun = true; continue; }
      if (flag !== '-o' && flag !== '--wat') throw new Error(`Unknown option: ${flag}`);
      const path = rest.shift();
      if (!path || path.startsWith('-')) throw new Error(`${flag} requires a path`);
      if (flag === '-o') output = path; else wat = path;
    }
    // Never overwrite the source, or replace the Wasm binary with its WAT text.
    if (resolve(output) === resolve(input) || (wat && [resolve(input), resolve(output)].includes(resolve(wat)))) {
      throw new Error('Input, Wasm output, and WAT output paths must be distinct');
    }
    const source = await readFile(input, 'utf8');
    const options = { autoRun };
    const result = wat ? build(source, options) : { bytes: compile(source, options) };
    await save(output, result.bytes);
    if (wat) await save(wat, result.wat);
    console.log(`${output}: ${result.bytes.length} bytes${autoRun ? ' (runs during instantiation)' : ''}`);
    return;
  }
  if (command === 'run') {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--instantiate-only')) throw new Error('Unknown run option');
    const bytes = await readFile(input);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    if (rest[0] !== '--instantiate-only') {
      if (typeof instance.exports.run !== 'function') throw new Error('Module does not export run()');
      console.log(inspect(await instance.exports.run(), { colors: false, depth: 6 }));
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main(process.argv.slice(2)).catch(error => {
  console.error(`wasmesc: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});
