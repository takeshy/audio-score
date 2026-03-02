import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "browser",
  external: ["react", "react-dom", "react-dom/client"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  loader: {
    ".ts": "ts",
    ".tsx": "tsx",
  },
  plugins: [{
    name: "tf-global",
    setup(build) {
      build.onResolve({ filter: /^@tensorflow\/tfjs/ }, () => ({
        path: "@tensorflow/tfjs", namespace: "tf-global",
      }));
      build.onLoad({ filter: /.*/, namespace: "tf-global" }, () => ({
        contents: [
          // Proxy that defers all property access to globalThis.tf at call time,
          // not at module-init time (when tf hasn't been loaded from CDN yet).
          // getPrototypeOf returns the proxy itself so that esbuild's CJS interop
          // (Object.create(Object.getPrototypeOf(mod))) puts the proxy in the
          // prototype chain of the namespace object, making F.loadGraphModel etc.
          // resolve through the get trap.
          "var _p;",
          "_p = new Proxy({}, {",
          "  get: function(_, k) {",
          "    if (typeof k === 'symbol') return undefined;",
          "    return globalThis.tf ? globalThis.tf[k] : undefined;",
          "  },",
          "  getPrototypeOf: function() { return _p; }",
          "});",
          "module.exports = _p;",
        ].join("\n"),
        loader: "js",
      }));
      build.onResolve({ filter: /^@tonejs\/midi$/ }, () => ({
        path: "@tonejs/midi", namespace: "tonejs-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "tonejs-stub" }, () => ({
        contents: "module.exports = {};", loader: "js",
      }));
    },
  }],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
