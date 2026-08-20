// Test-only ESM loader hook: stub raw CSS imports so real client packages
// (e.g. dsh-client-ui-primitives with katex CSS) can be imported in Node.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".css")) {
    return { url: "data:text/javascript,export default {};", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith("data:text/javascript")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  return nextLoad(url, context);
}
