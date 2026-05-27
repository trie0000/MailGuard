// Empty stubs for Node-only modules that @kenjiuno/msgreader's iconv-lite chain
// pulls in. Modern Unicode .msg files never actually invoke these, so empty
// implementations are sufficient.
export default {};
export const Buffer = { from: () => new Uint8Array(0), alloc: () => new Uint8Array(0) };
export const StringDecoder = class { write() { return ''; } end() { return ''; } };
