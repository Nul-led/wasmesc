const encoder = new TextEncoder();

export const ValType = Object.freeze({
  f64: 0x7c,
  externref: 0x6f,
});

export function u32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`u32 out of range: ${value}`);
  }
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

export function vec(items) {
  return [...u32(items.length), ...items.flat()];
}

export function wasmString(value) {
  const bytes = [...encoder.encode(value)];
  return [...u32(bytes.length), ...bytes];
}

export function section(id, payload) {
  return [id, ...u32(payload.length), ...payload];
}

export function f64Bytes(value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  return [...new Uint8Array(buf)];
}

export function moduleBytes(sections) {
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...sections.flat(),
  ]);
}

export function functionType(params, results) {
  return [0x60, ...vec(params.map((x) => [x])), ...vec(results.map((x) => [x]))];
}

export function encodeFunctionBody({ locals = [], instructions }) {
  const groups = [];
  for (const type of locals) {
    const last = groups.at(-1);
    if (last?.type === type) last.count += 1;
    else groups.push({ count: 1, type });
  }

  const localDecls = vec(groups.map(({ count, type }) => [...u32(count), type]));
  const body = [...localDecls, ...instructions, 0x0b];
  return [...u32(body.length), ...body];
}
