-- Objetivo de conversão da Ana: 10% até dezembro, 20% a partir do período de janeiro (26/12 a 25/01).
-- Pedido do Fábio, 2026-11-12. Os restantes objetivos da Ana mantêm-se.
do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$0.20::float8 obj_conversao$a$;
  new1 constant text := $a$(case when r.fim::date >= date '2027-01-25' then 0.20 else 0.10 end)::float8 obj_conversao$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, old1, new1);
  if length(d) - n <> length(new1) - length(old1) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
