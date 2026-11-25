// Bundles src/app.jsx into a single self-contained latke-feud.html (React + Tailwind from CDN).
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
const out = await build({
  entryPoints: ["src/app.jsx"], bundle: true, write: false, format: "iife",
  jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
  target: "es2019", minify: false, legalComments: "none",
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync("src/template.html", "utf8").replace("/*__APP__*/", () => js);
writeFileSync("latke-feud.html", html);
console.log("wrote latke-feud.html", (html.length / 1024).toFixed(1) + " KB");
