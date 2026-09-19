#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { compile } from './compiler.js';
import { compileDynamic } from './dynamic.js';

const args = process.argv.slice(2);
const dynamic = args[0] === '--dynamic';
if (dynamic) args.shift();
const [input, output] = args;

if (!input || !output || args.length !== 2) {
  console.error(`usage: ${basename(process.argv[1])} [--dynamic] <input.js> <output.wasm>`);
  process.exit(2);
}

const source = await readFile(input, 'utf8');
const bytes = dynamic ? compileDynamic(source) : compile(source);
await writeFile(output, bytes);
console.log(`${input} -> ${output} (${bytes.length} bytes, ${dynamic ? 'dynamic' : 'static'} backend)`);
