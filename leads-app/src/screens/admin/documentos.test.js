import { describe, it, expect } from "vitest";
import { nifValido } from "./documentos.js";

describe("nifValido", () => {
  it("aceita NIF e NIPC reais", () => {
    expect(nifValido("514524715")).toBe(true);
    expect(nifValido("516486900")).toBe(true);
    expect(nifValido("238 799 670")).toBe(true);
  });
  it("recusa dígito de controlo errado e formatos inválidos", () => {
    expect(nifValido("514524716")).toBe(false);
    expect(nifValido("12345678")).toBe(false);
    expect(nifValido("abc")).toBe(false);
  });
});
