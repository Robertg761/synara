import os from "node:os";
import path from "node:path";
import { defineConfig, mergeConfig } from "vite";

import appConfig from "../vite.config";

// The app config is a function of the Vite command (it decides whether to run the
// React Compiler), so resolve it for the same environment before layering overrides.
export default defineConfig((env) =>
  mergeConfig(appConfig(env), {
    resolve: {
      alias: {
        // Production-mode React with the Profiler enabled, so harness runs can report
        // real commit counts/durations without dev-build overhead skewing timings.
        "react-dom/client": "react-dom/profiling",
      },
    },
    build: {
      emptyOutDir: true,
      outDir: path.join(os.tmpdir(), "synara-perf-dist"),
      rollupOptions: {
        input: {
          index: path.resolve(import.meta.dirname, "index.html"),
          pipeline: path.resolve(import.meta.dirname, "pipeline.html"),
          concurrent: path.resolve(import.meta.dirname, "concurrent.html"),
        },
      },
    },
  }),
);
