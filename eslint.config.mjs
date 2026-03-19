import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Catch unused variables
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Catch unused expressions
      "no-unused-expressions": "warn",
      // Catch unreachable code
      "no-unreachable": "warn",
      // Catch missing dependency arrays
      "react-hooks/exhaustive-deps": "warn",
      // Catch console statements
      "no-console": [
        "warn",
        { allow: ["warn", "error", "log"] },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/target/**",
  ]),
]);

export default eslintConfig;
