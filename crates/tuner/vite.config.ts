import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      check: {
        command: "vp run clippy",
        dependsOn: ["fmt:check"],
      },
    },
  },
});
