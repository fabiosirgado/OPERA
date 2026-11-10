import { useEffect, useRef } from "react";
import { sb } from "../../supabase.js";
import { mountDashboard } from "./dashboard.js";
import { mountAcessos, mountGestao } from "./gestao.js";
import "./admin.css";

// Dashboard Admin: KPIs comerciais, financeiros e de operação da própria OPERA.
// Só aparece a quem está em opera_admin_acessos; o servidor volta a verificar o nível em cada pedido.
export default function AdminDashboard({ nivel, onOpenLead }) {
  const box = useRef(null);
  const openRef = useRef(onOpenLead);
  openRef.current = onOpenLead;

  useEffect(() => {
    const load = async (inicio, fim) => {
      const { data, error } = await sb.rpc("opera_admin_dados", { p_inicio: inicio, p_fim: fim });
      if (error) throw error;
      return data || {};
    };
    const pages = nivel === "total" ? { gestao: mountGestao, acessos: mountAcessos } : {};
    const dash = mountDashboard(box.current, { load, nivel, pages, onOpenLead: (id) => openRef.current?.(id) });
    return () => dash.destroy();
  }, [nivel]);

  return <div ref={box} />;
}
