// Puts the site (only the files the browser needs) on Cloudflare Pages, at
// https://specialistenplanning.pages.dev. Run from this folder:
//   npm run site:deploy
// The Worker is deployed separately (npm run worker:deploy).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const out = ".site";
const files = ["index.html", "app.js", "styles.css", "config.js", "handleiding.html", "handleiding.css"];
const folders = ["assets", "data"];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const file of files) fs.copyFileSync(file, `${out}/${file}`);
for (const folder of folders) fs.cpSync(folder, `${out}/${folder}`, { recursive: true });
// Headers a <meta> tag cannot set: nobody may show the planning inside a frame
// on another site.
fs.writeFileSync(`${out}/_headers`, [
  "/*",
  "  Content-Security-Policy: frame-ancestors 'none'",
  "  X-Content-Type-Options: nosniff",
  "  Referrer-Policy: no-referrer",
  "",
].join("\n"));

execFileSync("npx", ["wrangler", "pages", "deploy", out, "--project-name", "specialistenplanning", "--branch", "main", "--commit-dirty=true"], { stdio: "inherit" });
