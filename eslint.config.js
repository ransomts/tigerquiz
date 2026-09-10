// Lint rules for tigerquiz. Deliberately close to eslint:recommended: tsc
// already catches type mistakes, so this is here for the things it cannot see —
// unused variables, accidental globals, unreachable code, await outside async.
//
// Two environments live in this repo. server.js, lib/ and the tooling are Node
// ES modules. public/ is classic browser scripts loaded with plain <script>
// tags and no bundler, so they share one global scope with the inline scripts
// in the HTML pages; that is why they are "script" rather than "module" and why
// their cross-file globals are declared below.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "data/**", "quizzes/**", "vendor/**"] },

  js.configs.recommended,

  {
    files: ["server.js", "lib/**/*.js", "tools/**/*.mjs", "test/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
  },

  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // Defined by a <script> the page loads before this one.
        io: "readonly",
        QRCode: "readonly",
      },
    },
    rules: {
      // A top-level const in a classic script is a global that the inline
      // script in host.html or edit.html consumes, so it only looks unused.
      // Mark those with /* exported Name */ rather than switching this off.
      "no-unused-vars": ["error", { args: "after-used", caughtErrors: "none" }],
    },
  },

  {
    // An empty catch is how this codebase says "the default is fine" around
    // localStorage and JSON.parse. Keep it deliberate rather than silent.
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
