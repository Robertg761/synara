import { defineConfig, mergeConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

export default mergeConfig(
  browserConfig,
  defineConfig({
    test: {
      testNamePattern: /\[geometry:linux\]/,
      browser: {
        // `browser.viewport` (desktop 1280x800) is inherited from the base config on purpose —
        // one definition for every lane. Do not restate it here.
        fileParallelism: false,
      },
    },
  }),
);
