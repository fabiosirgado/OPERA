-- Dashboard Admin: a conversão R1 → fecho (e R1 → R2) conta como R1 todas as leads que tiveram R1 ou R2 no período
-- (pedido do Fábio, 2026-11-11). Quem está em R2 já fez a R1, mesmo que a lead tenha saltado a etapa R1 no gestor.
-- Cada lead conta uma vez, mesmo que tenha passado pelas duas.

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$(select count(distinct lead_id) from ev where fase = 'R2' and dia between par.i and par.f)::int r2,$a$;
  new1 constant text := $a$(select count(distinct lead_id) from ev where fase = 'R2' and dia between par.i and par.f)::int r2, (select count(distinct lead_id) from ev where fase in ('R1','R2') and dia between par.i and par.f)::int r1_total,$a$;
  old2 constant text := $a$r.r2::float8 / nullif(r.r1, 0) conv_r1_r2$a$;
  new2 constant text := $a$r.r2::float8 / nullif(r.r1_total, 0) conv_r1_r2$a$;
  old3 constant text := $a$r.fechos::float8 / nullif(r.r1, 0) conv_r1_fecho$a$;
  new3 constant text := $a$r.fechos::float8 / nullif(r.r1_total, 0) conv_r1_fecho$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(replace(replace(d, old1, new1), old2, new2), old3, new3);
  if length(d) - n <> length(new1) - length(old1) + length(new2) - length(old2) + length(new3) - length(old3) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
