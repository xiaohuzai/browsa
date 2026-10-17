// build/entries/marked-entry.mjs — stable ESM entry shape for the vendored
// marked bundle.
//
// The bundle used to be built from marked's CJS entry, whose `module.exports`
// is the CALLABLE `marked` function carrying every API member as a property
// (`marked.parse`, `marked.use`, `marked.setOptions`, …). render.js imports it
// as a default and tests monkeypatch `marked.parse`, so the callable-with-props
// shape is the contract — a plain `export * as default` namespace would be a
// frozen, non-callable object.
//
// marked 16 ships ESM only with NAMED exports, so this entry reattaches them
// onto the function. Rebuilding the vendor therefore cannot silently change
// the import shape again.
import * as markedNs from 'marked';

const { marked: markedFn, ...members } = markedNs;
const api = Object.assign(markedFn, members);

export default api;
