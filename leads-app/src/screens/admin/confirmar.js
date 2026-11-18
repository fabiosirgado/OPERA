// Botão em dois toques para ações que não se desfazem com facilidade (enviar ao cliente, cancelar, apagar).
// O 1.º toque arma o botão e mostra, na própria linha, um aviso que fica até a pessoa decidir: não há tempo limite.
// Ao lado aparece "Cancelar"; ao cancelar, o aviso passa a dizer claramente que nada foi feito.
export function confirmar2(btn, label, fn, { aviso, confirmar = "Confirmar", cancelado = "Cancelado. Nada foi feito." } = {}) {
  let armado = false;
  const cancelar = document.createElement("button");
  cancelar.type = "button";
  cancelar.textContent = "Cancelar";
  const nota = document.createElement("div");
  nota.className = "aviso-confirmar";
  nota.setAttribute("role", "status");
  const mostra = (texto, tipo) => {
    nota.textContent = texto;
    nota.className = "aviso-confirmar " + tipo;
    const linha = btn.closest(".item");
    if (linha) linha.append(nota); else (btn.parentElement ?? btn).after(nota);
  };
  const desarmar = () => { armado = false; btn.textContent = label; btn.classList.remove("armado"); cancelar.remove(); };
  cancelar.addEventListener("click", () => { desarmar(); mostra(cancelado, "cancelado"); });
  btn.addEventListener("click", () => {
    if (!armado) {
      armado = true;
      btn.textContent = confirmar;
      btn.classList.add("armado");
      btn.after(cancelar);
      mostra(typeof aviso === "function" ? aviso() : aviso || `Ainda não foi feito. Carrega em "${confirmar}" para continuar, ou em "Cancelar".`, "pendente");
      return;
    }
    desarmar();
    nota.remove();
    fn();
  });
}
