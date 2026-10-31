// Production build of the hosted site: web/ -> dist/, with app code bundled
// and minified into one file (no source maps), CSS minified, and the offline
// cache list updated to match. Firebase Hosting serves dist/.
//
//   node scripts/build-web.mjs
import { build } from "esbuild";
import { cpSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const src = `${root}web`, out = `${root}dist`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ["index.html", "manifest.webmanifest", "stations.json", "icons"]) cpSync(`${src}/${f}`, `${out}/${f}`, { recursive: true });

await build({
  entryPoints: [`${src}/app.js`],
  bundle: true, minify: true, format: "esm", target: "es2020",
  outfile: `${out}/app.js`, legalComments: "none", logLevel: "warning",
});
await build({ entryPoints: [`${src}/style.css`], minify: true, outfile: `${out}/style.css`, logLevel: "warning" });

// offline cache: new name per build so phones pick up updates, and only files that exist
const version = createHash("sha256").update(readFileSync(`${out}/app.js`)).update(readFileSync(`${out}/style.css`)).digest("hex").slice(0, 10);
const shell = ["/", "/index.html", "/style.css", "/app.js", "/manifest.webmanifest", "/stations.json", "/icons/icon-192.png", "/icons/icon-512.png"];
writeFileSync(`${out}/sw.js`, readFileSync(`${src}/sw.js`, "utf8")
  .replace(/const CACHE = "[^"]*";/, `const CACHE = "shell-${version}";`)
  .replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = ${JSON.stringify(shell)};`));

const size = (f) => (readFileSync(`${out}/${f}`).length / 1024).toFixed(0);
console.log(`dist/ built: app.js ${size("app.js")} KB, style.css ${size("style.css")} KB, cache shell-${version}`);
