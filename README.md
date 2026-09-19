# wasmesc

Private research PoC workspace for exploring the WebAssembly/JavaScript import-object sandbox boundary described in Thomas Rinsma's Phrack 72 article, “Popping an alert from a sandboxed WebAssembly module”.

Source: https://phrack.org/issues/72/popping-an-alert-from-a-sandboxed-webassembly-module_md#article

## Status

Initial scaffolding only. No PoC implementation yet.

## Scope

The article investigates how JavaScript prototype-chain property lookup can expose unexpected WebAssembly imports when a host uses ordinary objects as an `importObject`. It also discusses defensive use of null-prototype import objects and import allow-listing.

This repository is intended for isolated reproduction and experimentation around that behavior.
