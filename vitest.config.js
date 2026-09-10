import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic extracted into src/lib/* — the progress,
// volume and front-matter math that is easy to break and hard to notice. The
// stateful/DOM layers are exercised by the app itself, not here.
export default defineConfig({
  test: {
    // Default to node; the one suite that needs DOMParser opts into jsdom with a
    // `// @vitest-environment jsdom` docblock (see test/format.test.js).
    environment: "node",
    include: ["test/**/*.test.js"],
  },
});
