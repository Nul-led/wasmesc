// A FunctionBody: return statements are allowed; import/export are not.
console.log('Hello from Wasm instantiated with {}');
return {
  answer: 6 * 7,
  text: 'Hello 🌍',
  squares: [1, 2, 3, 4].map(x => x * x),
};
