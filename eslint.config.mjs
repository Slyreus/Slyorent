import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    ".runtime/**",
    ".vinext/**",
    ".wrangler/**",
    "dist/**",
    "release/**",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat["recommended-latest"],
  jsxA11y.flatConfigs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    files: ["electron/**/*.mjs"],
    rules: {
      // Ces expressions suppriment explicitement les caractères de contrôle
      // des entrées non fiables avant affichage ou journalisation.
      "no-control-regex": "off",
    },
  },
  {
    files: ["electron/**/*.cjs"],
    rules: {
      // Le preload Electron sandboxé est chargé comme module CommonJS.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["app/page.tsx"],
    rules: {
      // Le lecteur ouvre des médias arbitraires fournis par l'utilisateur.
      // Une fausse piste VTT générique serait plus trompeuse qu'une absence
      // annoncée; les sous-titres intégrés restent gérés par le média.
      "jsx-a11y/media-has-caption": "off",
    },
  },
]);

export default eslintConfig;
