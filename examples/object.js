export function answer() {
  const config = {
    inner: { value: 21 },
    enabled: true,
  };
  return config.inner.value * 2;
}
