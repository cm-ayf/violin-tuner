import { defineConfig } from "vite-plus";
import vize from "@vizejs/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  run: {
    cache: false,
    tasks: {
      dev: {
        command: "vp dev",
        dependsOn: ["@violin-tuner/dsp#build"],
      },
      build: {
        command: "vp build",
        dependsOn: ["typecheck"],
      },
      typecheck: {
        command: "tsc --runExternalCode --noEmit",
        dependsOn: ["@violin-tuner/dsp#build"],
      },
      check: {
        command: "vp check",
        dependsOn: ["typecheck", "@violin-tuner/dsp#check"],
      },
      test: {
        command: "vp test run",
        dependsOn: ["@violin-tuner/dsp#test"],
      },
      fmt: {
        command: "vp fmt",
        dependsOn: ["@violin-tuner/dsp#fmt"],
      },
    },
  },
  base: "/violin-tuner/",
  worker: { format: "es" },
  plugins: [
    vize(),
    VitePWA({
      registerType: "prompt",
      pwaAssets: {
        preset: "minimal-2023",
        image: "public/icon.svg",
      },
      manifest: {
        name: "Violin Tuner — A442",
        short_name: "Violin Tuner",
        description: "A=442 Hz、純正五度のバイオリンチューナー",
        lang: "ja",
        start_url: "/violin-tuner/",
        scope: "/violin-tuner/",
        display: "standalone",
        background_color: "#f5f3ed",
        theme_color: "#12251f",
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,wasm,png,svg,ico}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: "index.html",
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
  lint: {
    options: { typeAware: false, typeCheck: false },
    ignorePatterns: ["crates/tuner/pkg/**", "dist/**"],
  },
  fmt: { ignorePatterns: ["crates/tuner/pkg/**", "dist/**", "crates/tuner/target/**"] },
});
