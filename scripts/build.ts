import { build, emptyDir } from "@deno/dnt";

await emptyDir("./npm");

await build({
  entryPoints: ["./src/mod.ts"],
  outDir: "./npm",
  "compilerOptions": {
    "lib": [
      "ESNext",
      "DOM",
    ],
  },
  shims: {
    // see JS docs for overview and more options
    deno: false,
  },
  package: {
    // package.json properties
    name: "scan-cropper",
    version: Deno.args[0],
    description: "",
    // license: "MIT",
    // repository: {
    //   type: "git",
    //   url: "git+https://github.com/username/repo.git",
    // },
    // bugs: {
    //   url: "https://github.com/username/repo/issues",
    // },
  },
  // postBuild() {
  //   // steps to run after building and before running the tests
  //   Deno.copyFileSync("LICENSE", "npm/LICENSE");
  //   Deno.copyFileSync("README.md", "npm/README.md");
  // },
});
