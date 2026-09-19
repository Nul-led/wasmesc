export const JSValue = Object.freeze({
  CANONICAL_NAN: 0x7ff8000000000000n,
  UNDEFINED: 0x7ff9000000000000n,
  NULL: 0x7ffa000000000000n,
  FALSE: 0x7ffb000000000000n,
  TRUE: 0x7ffc000000000000n,
  OBJECT: 0x7ffd000000000000n,
  STRING: 0x7ffe000000000000n,
  TAG_MASK: 0xffff000000000000n,
  PAYLOAD_MASK: 0x0000ffffffffffffn,
});

const bitsBuffer = new ArrayBuffer(8);
const bitsView = new DataView(bitsBuffer);

export function numberToBits(value) {
  if (Number.isNaN(value)) return JSValue.CANONICAL_NAN;
  bitsView.setFloat64(0, value, true);
  return bitsView.getBigUint64(0, true);
}

export function bitsToNumber(bits) {
  bitsView.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return bitsView.getFloat64(0, true);
}

export function encodeJSValue(value) {
  if (typeof value === 'number') return numberToBits(value);
  if (value === undefined) return JSValue.UNDEFINED;
  if (value === null) return JSValue.NULL;
  if (value === false) return JSValue.FALSE;
  if (value === true) return JSValue.TRUE;
  throw new TypeError(`Cannot encode ${typeof value} as a wasmesc JSValue yet`);
}

function payloadPointer(bits) {
  return Number(bits & JSValue.PAYLOAD_MASK);
}

function memoryBuffer(memory) {
  const buffer = memory?.buffer ?? memory;
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError('Decoding a string JSValue requires WebAssembly.Memory or an ArrayBuffer');
  }
  return buffer;
}

export function decodeJSValue(bits, memory = null) {
  bits = BigInt.asUintN(64, bits);
  const tag = bits & JSValue.TAG_MASK;
  if (tag === JSValue.UNDEFINED) return undefined;
  if (tag === JSValue.NULL) return null;
  if (tag === JSValue.FALSE) return false;
  if (tag === JSValue.TRUE) return true;
  if (tag === JSValue.OBJECT) {
    return Object.freeze({ type: 'object', pointer: payloadPointer(bits) });
  }
  if (tag === JSValue.STRING) {
    const pointer = payloadPointer(bits);
    if (memory === null) return Object.freeze({ type: 'string', pointer });

    const view = new DataView(memoryBuffer(memory));
    const length = view.getUint32(pointer, true);
    let value = '';
    for (let i = 0; i < length; i += 1) {
      value += String.fromCharCode(view.getUint16(pointer + 4 + i * 2, true));
    }
    return value;
  }
  return bitsToNumber(bits);
}

export function objectPointer(bits) {
  bits = BigInt.asUintN(64, bits);
  if ((bits & JSValue.TAG_MASK) !== JSValue.OBJECT) {
    throw new TypeError('JSValue is not an object');
  }
  return payloadPointer(bits);
}

export function stringPointer(bits) {
  bits = BigInt.asUintN(64, bits);
  if ((bits & JSValue.TAG_MASK) !== JSValue.STRING) {
    throw new TypeError('JSValue is not a string');
  }
  return payloadPointer(bits);
}
