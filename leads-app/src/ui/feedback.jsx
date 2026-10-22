import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// Aviso curto no fundo do ecrã, como no protótipo.
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [msg, setMsg] = useState("");
  const timer = useRef();
  const show = useCallback((m) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(""), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className={`toast ${msg ? "on" : ""}`} role="status">{msg}</div>
    </ToastCtx.Provider>
  );
}

// Janela por cima do ecrã. Fecha com Esc ou ao carregar fora.
export function Modal({ title, onClose, wide, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ovl open" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`}>
        <div className="mh">
          {typeof title === "string" ? <h2>{title}</h2> : <div style={{ fontSize: 22, fontWeight: 700, minWidth: 0 }}>{title}</div>}
          <button type="button" className="x" onClick={onClose} aria-label="Fechar">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Executa uma ação assíncrona com estado de ocupado e aviso de erro.
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okMsg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg);
      return r ?? true;
    } catch (e) {
      toast(e?.message || "Ocorreu um erro. Tenta outra vez.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy];
}
