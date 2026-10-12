// The WHATWG text codecs exist in every runtime core targets (Node, browsers, Electron), but
// `lib: es2022` does not declare them and core must not pull in DOM or Node types.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(
    label?: string,
    options?: { fatal?: boolean; ignoreBOM?: boolean },
  );
  decode(input?: Uint8Array): string;
}
