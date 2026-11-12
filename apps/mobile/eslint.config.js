// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // Liquid Glass (stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md 5.5):
    // expo-glass-effect resolves its native view at module load, so a static
    // import would crash a binary without the module before any check runs.
    // src/lib/appearance/glass-module.ts is the ONE place that loads it, with
    // a guarded lazy require; everything else asks that wrapper.
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
    ignores: ["src/lib/appearance/glass-module.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "expo-glass-effect",
              message:
                "Load glass only through src/lib/appearance/glass-module.ts (GlassViewOrNull / GlassContainerOrNull).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value='expo-glass-effect']",
          message:
            "Load glass only through src/lib/appearance/glass-module.ts (GlassViewOrNull / GlassContainerOrNull).",
        },
        {
          selector: "ImportExpression[source.value='expo-glass-effect']",
          message:
            "Load glass only through src/lib/appearance/glass-module.ts (GlassViewOrNull / GlassContainerOrNull).",
        },
      ],
    },
  },
  {
    // Release tooling runs under Node, not React Native - give it the Node
    // globals the app config deliberately lacks (Buffer, process, ...).
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
      },
    },
  },
]);
