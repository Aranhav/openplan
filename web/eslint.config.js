import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import { defineConfig, globalIgnores } from "eslint/config"
import globals from "globals"
import tseslint from "typescript-eslint"

export default defineConfig([
  globalIgnores([
    "dist",
    "src/components/ui",
    "src/hooks/use-mobile.ts",
    "src/routeTree.gen.ts",
    "src/lib/api/schema.d.ts",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: { globals: globals.browser },
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true, allowExportNames: ["useTheme"] },
      ],
    },
  },
  {
    files: ["*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
])
