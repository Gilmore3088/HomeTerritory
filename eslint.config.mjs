import { createRequire } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-plugin-react's default `version: "detect"` calls `context.getFilename()`,
// which ESLint 10 removed, so every rule the plugin contributes throws
// "contextOrFilename.getFilename is not a function" on the first file linted and
// the whole gate provides zero coverage. Naming the version skips detection;
// reading it from the installed package keeps it from drifting.
const reactVersion = createRequire(import.meta.url)("react/package.json").version;

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { react: { version: reactVersion } } },
  globalIgnores([".next/**", "node_modules/**"]),
]);
