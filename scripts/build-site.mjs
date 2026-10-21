// Copia as páginas estáticas do site para dist/, sem as alterar.
// Tudo o que é código fonte, documentação ou configuração fica de fora do que é publicado.
import { cpSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = process.argv[2] || join(ROOT, "dist");

const EXCLUDE = new Set([
  ".git", ".gitignore", ".netlify", ".DS_Store", ".claude",
  "dist", "node_modules", "leads-app", "scripts", "supabase", "netlify", "docs", "tests",
  "package.json", "package-lock.json", "netlify.toml",
]);
const isPrivate = (name) => EXCLUDE.has(name) || name.endsWith(".md") || name.startsWith(".env");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const copied = [];
for (const name of readdirSync(ROOT)) {
  if (isPrivate(name)) continue;
  cpSync(join(ROOT, name), join(OUT, name), { recursive: true });
  copied.push(name);
}
console.log(`build-site: ${copied.length} entradas copiadas para ${OUT}`);
