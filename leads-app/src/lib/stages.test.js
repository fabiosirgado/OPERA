import { describe, it, expect } from "vitest";
import { movedPosition } from "./stages.js";

const all = [
  { id: "q", position: 50, is_base: true }, { id: "r1", position: 60 }, { id: "r2", position: 70 },
  { id: "c", position: 90 }, { id: "d", position: 999, is_base: true },
].map((s) => ({ is_base: false, ...s }));

describe("ordem das etapas", () => {
  it("move uma etapa para antes ou depois da vizinha, sem mexer nas outras", () => {
    expect(movedPosition(all, "r2", -1)).toBe(55);
    expect(movedPosition(all, "r2", 1)).toBe(544.5);
    expect(movedPosition(all, "r1", 1)).toBe(80);
  });
  it("não passa de Lead Qualificada nem de Lead desqualificada, nem mexe nas etapas base", () => {
    expect(movedPosition(all, "r1", -1)).toBeNull();
    expect(movedPosition(all, "c", 1)).toBeNull();
    expect(movedPosition(all, "q", 1)).toBeNull();
    expect(movedPosition(all, "x", 1)).toBeNull();
  });
});
