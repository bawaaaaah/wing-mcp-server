// The real configuration lives in tools/eslint (its own workspace, which carries the TypeScript 6
// that typescript-eslint's type-aware rules need). This file only makes `eslint .` find it.
export { default } from "./tools/eslint/eslint.config.js";
