// Ordem das etapas extra (depois de Lead Qualificada e antes de Lead desqualificada).
// A posição nova fica a meio entre as duas etapas seguintes no sentido do movimento, por isso nenhuma outra etapa muda.
// all: etapas visíveis para o cliente, ordenadas por posição. Devolve a posição nova, ou null se não puder mover.
export function movedPosition(all, id, dir) {
  const i = all.findIndex((s) => s.id === id);
  if (i < 0 || all[i].is_base) return null;
  const n = all[i + dir];
  if (!n || n.is_base) return null;
  const after = all[i + 2 * dir];
  if (!after) return null;
  return (n.position + after.position) / 2;
}
