import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = mkdtempSync(join(tmpdir(), "opera-build-"));
const dist = (p) => join(OUT, p);

// Garante que o build continua a publicar o site atual sem expor código fonte nem configuração.
describe("build do site", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build-site.mjs", OUT], { cwd: ROOT, stdio: "ignore" });
  });
  afterAll(() => rmSync(OUT, { recursive: true, force: true }));

  it("publica as páginas existentes", () => {
    for (const p of ["index.html", "crm/index.html", "crm/app.jsx", "feedback.html"]) {
      expect(existsSync(dist(p)), p).toBe(true);
    }
  });

  it("não publica ficheiros privados", () => {
    for (const p of ["supabase", "docs", "leads-app", "scripts", "netlify", "node_modules", "package.json", "netlify.toml", "CRM-DEPLOY.md"]) {
      expect(existsSync(dist(p)), p).toBe(false);
    }
  });
});
