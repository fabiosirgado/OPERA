import { createClient } from "@supabase/supabase-js";

// Só valores públicos: o URL do projeto e a chave publicável (protegida pelo RLS).
// Os deploys de pré visualização apontam para o projeto de testes, a produção para o projeto real.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const configError = !SUPABASE_URL || !SUPABASE_KEY
  ? "Faltam as variáveis VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY."
  : "";

// Tipo de link de email com que a pessoa chegou (convite ou recuperação de palavra passe).
// Tem de ser lido antes de o cliente do Supabase consumir o endereço. Os links novos passam pela página
// /entrar/, que já entrou e volta com ?via=recovery; os antigos trazem o tipo no fim do endereço (#type=).
export const ARRIVED_VIA = (() => {
  try {
    const via = new URLSearchParams(window.location.search).get("via");
    if (via) {
      const u = new URL(window.location.href);
      u.searchParams.delete("via");
      window.history.replaceState(null, "", u.pathname + u.search + u.hash);
      return via;
    }
    return new URLSearchParams(window.location.hash.slice(1)).get("type") || "";
  } catch {
    return "";
  }
})();

export const sb = configError ? null : createClient(SUPABASE_URL, SUPABASE_KEY);
