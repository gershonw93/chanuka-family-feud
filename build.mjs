// Builds two single-file versions of the game:
//  - latke-feud.html: the claude.ai artifact (uses the artifact's shared database)
//  - web/index.html:  the public site (uses the Supabase table public.kv)
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";

const SUPABASE_URL = "https://tcnhhjakjdyzozbwnbqy.supabase.co";
const SUPABASE_KEY = "sb_publishable_8svqqYi_4Tl8dFRuDv7fqA_3sEmrqZb"; // publishable key, safe in the browser

const out = await build({
  entryPoints: ["src/app.jsx"], bundle: true, write: false, format: "iife",
  jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
  target: "es2019", minify: false, legalComments: "none",
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const tpl = readFileSync("src/template.html", "utf8");

const artifact = tpl.replace("/*__CONFIG__*/", "").replace("/*__APP__*/", () => js);
writeFileSync("latke-feud.html", artifact);

const BUILD = Date.now().toString(36);
const config = `window.LF_BACKEND = ${JSON.stringify({ url: SUPABASE_URL, key: SUPABASE_KEY })}; window.LF_BUILD = ${JSON.stringify(BUILD)};`;
const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#071338">
<meta name="description" content="A Hanukkah survey party game. The TV hosts the board, phones join with a room code.">
<meta property="og:title" content="Latke Feud">
<meta property="og:description" content="Our family Hanukkah game. Open the link, type the room code, buzz in!">
<meta property="og:image" content="/thumb.png">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%95%8E%3C/text%3E%3C/svg%3E">
`;
const web = head + tpl
  .replace('<link rel="artifact-thumbnail" href="thumb.png">\n', "")
  .replace("/*__CONFIG__*/", () => config)
  .replace("/*__APP__*/", () => js)
  .replace("<style>", "</head>\n<body>\n<style>") + "\n</body>\n</html>\n";
mkdirSync("web", { recursive: true });
writeFileSync("web/index.html", web);
copyFileSync("thumb.png", "web/thumb.png");
writeFileSync("web/version.json", JSON.stringify({ build: BUILD }));
writeFileSync("web/vercel.json", JSON.stringify({ headers: [
  { source: "/", headers: [{ key: "Cache-Control", value: "no-cache" }] },
  { source: "/version.json", headers: [{ key: "Cache-Control", value: "no-store" }] },
] }, null, 2));
console.log("built latke-feud.html and web/index.html");
