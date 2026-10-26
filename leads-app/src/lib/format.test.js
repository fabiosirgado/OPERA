import { describe, it, expect } from "vitest";
import { dueFrom, dueParts, fmtRel, isAllDay, localInput } from "./format.js";

const today = () => localInput(Date.now()).slice(0, 10);

describe("Tarefas sem hora", () => {
  it("guarda o dia às 23:59:59 e reconhece-o como sem hora", () => {
    const due = dueFrom("2026-11-03", "");
    expect(isAllDay(due)).toBe(true);
    expect(dueParts(due)).toEqual({ date: "2026-11-03", time: "" });
  });

  it("com hora fica como antes", () => {
    const due = dueFrom("2026-11-03", "10:30");
    expect(isAllDay(due)).toBe(false);
    expect(dueParts(due)).toEqual({ date: "2026-11-03", time: "10:30" });
  });

  it("uma hora com segundos (ex.: 23:59 escolhido à mão) não passa por sem hora", () => {
    expect(isAllDay(dueFrom("2026-11-03", "23:59"))).toBe(false);
    expect(isAllDay(new Date().toISOString())).toBe(false);
  });

  it("mostra só o dia, sem hora", () => {
    expect(fmtRel(dueFrom(today(), ""))).toBe("Hoje");
    expect(fmtRel(dueFrom(today(), "09:15"))).toBe("Hoje 09:15");
    expect(fmtRel(dueFrom("2030-02-07", ""))).toBe("07/02");
  });
});
