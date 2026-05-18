#!/usr/bin/env node
/**
 * Node ESM exige extensão .js em imports relativos; tsc com moduleResolution
 * "bundler" não as adiciona — corrige dist/ após o build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

function fixImports(file) {
  const dir = path.dirname(file);
  let src = fs.readFileSync(file, "utf8");
  const next = src.replace(
    /from (['"])(\.\.?\/[^'"]+)\1/g,
    (match, quote, imp) => {
      if (/\.(js|json|mjs|wasm|node)$/.test(imp)) return match;
      const asJs = path.join(dir, `${imp}.js`);
      if (fs.existsSync(asJs)) return `from ${quote}${imp}.js${quote}`;
      const asIndex = path.join(dir, imp, "index.js");
      if (fs.existsSync(asIndex)) return `from ${quote}${imp}/index.js${quote}`;
      return match;
    },
  );
  if (next !== src) fs.writeFileSync(file, next);
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) fixImports(p);
  }
}

walk(distRoot);
console.log("fix-dist-esm: imports relativos em dist/ atualizados");
