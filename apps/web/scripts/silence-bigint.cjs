// Loaded via NODE_OPTIONS=--require so it runs BEFORE any package can call
// console.warn / console.log at import time. We need this because
// bigint-buffer's dist/node.js does `console.warn('bigint: Failed to load
// bindings...')` at module-evaluation time, which beats the Next.js
// instrumentation register() hook.
//
// The native binding falls back cleanly to a pure-JS implementation, so
// this is purely cosmetic - but the warning prints multiple times per
// tRPC poll and drowns the actual dev output.
const NOISE = [
  'bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)',
];

function silenceMethod(name) {
  const original = console[name].bind(console);
  console[name] = function patched(...args) {
    if (
      args.length >= 1 &&
      typeof args[0] === 'string' &&
      NOISE.some((needle) => args[0].includes(needle))
    ) {
      return;
    }
    original(...args);
  };
}
silenceMethod('warn');
silenceMethod('log');
silenceMethod('error');
