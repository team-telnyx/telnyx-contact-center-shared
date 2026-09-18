// Evaluated before Next runtime modules: server-only env reads become inert in the browser bundle.
globalThis.process=globalThis.process||{env:{}};
