import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // A hook test needs a probe component that publishes the hook's return
    // value to the test body, and the only way to observe it *as rendered* is
    // to assign it during render — which `react-hooks/globals` forbids, quite
    // rightly, in real components.
    //
    // Publishing from an effect instead would satisfy the rule and quietly
    // gut the suite: effects flush inside `act()` too, so a hook that reset
    // its state in an effect rather than deriving it during render would look
    // identical. Mutation testing showed that difference is exactly what the
    // speaker-switch test catches.
    //
    // Scoped to test files, where nothing is rendered for a user.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "react-hooks/globals": "off" },
  },
]);

export default eslintConfig;
