/** A file imported as its text: Vite `?raw` in tests, webpack `asset/source` in the build. */
declare module '*.sql?raw' {
  const text: string;
  export default text;
}
