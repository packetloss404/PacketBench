import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { APP_NAME } from "../src/lib/brand.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const repo = `https://github.com/packetloss404/${APP_NAME}`;
const values = {
  APP_NAME,
  VERSION: pkg.version,
  REPO_URL: repo,
  SITE_URL: `https://packetloss404.github.io/${APP_NAME}/`,
};
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const template = await readFile(path.join(root, "website/index.template.html"), "utf8");
const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
  if (!(key in values)) throw new Error(`Unknown page token ${key}`);
  return escapeHtml(values[key]);
});
if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error("Unresolved page token");
await writeFile(path.join(root, "docs/index.html"), html);
console.log(`Generated docs/index.html for ${APP_NAME} ${pkg.version}`);
