#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { compile } from './compiler.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error(`usage: ${basename(process.argv[1])} <input.js> <output.wasm>`);
  process.exit(2);
}

const source = await readFile(input, 'utf8');
const bytes = compile(source);
await writeFile(output, bytes);
console.log(`${input} -> ${output} (${bytes.length} bytes)`);
