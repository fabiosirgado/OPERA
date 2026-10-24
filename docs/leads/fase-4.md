# OPERA Leads: Fase 4 (Dashboard)

Tudo isto está aplicado só no projeto Supabase de **testes**. A produção não foi tocada.

## Feito

**Ecrã "Dashboard"** (só admin e gestores), com o design do protótipo:
* **Filtros:** cliente (todos ou um) e período (Hoje, 7 dias, 30 dias, Tudo).
* **Time to Lead (mediana):** da chegada da lead ao sistema até à primeira chamada, atendida ou não.
  * Conta só leads Meta e de portais; as leads BD ficam de fora.
  * Mostra o estado face ao objetivo, a média, a percentagem contactada em até 15 min e em até 1 h, quantas faltam contactar e a distribuição por intervalos.
  * O **objetivo** (15 min por defeito) só o admin muda.
* **Taxa de ocupação por gestor:** clientes ativos sobre o máximo de 8, leads em trabalho e tarefas atrasadas de cada gestor.
* **Números do período:**
  * leads que entraram (e média por dia);
  * chamadas feitas e atendidas;
  * atividades concluídas por tipo;
  * tarefas atrasadas agora;
  * qualificadas, com o tempo até qualificar;
  * desqualificadas;
  * taxa de qualificação;
  * leads BD recuperadas, sobre as BD trabalhadas.
* **Gráficos e tabela:**
  * leads que entraram por dia, com o valor de cada dia ao passar o rato;
  * leads por origem e atividades por tipo;
  * tabela por cliente.

Todos os números são calculados no servidor a partir do histórico de cada lead: chamadas registadas, mudanças de etapa e tarefas concluídas. Os clientes não têm acesso a este ecrã nem a estas funções.

## Rapidez

Medido no opera-testes com **150 mil leads, 600 mil eventos e 112 mil tarefas**, no plano gratuito:

| Período | Todos os clientes | Um cliente |
|---|---|---|
| Hoje | 0,9 s | |
| 7 dias | 1,8 s | 0,3 s |
| 30 dias | 2,6 s | |
| Tudo | 4,7 s | |

"Tudo" com todos os clientes é o caso mais pesado, porque percorre todo o histórico. No plano Pro (mais memória e processador) estes tempos baixam. Os dados de carga foram apagados no fim.

## Testes
* 5 testes novos (70 no total, todos a passar). Um cenário conhecido num cliente próprio confirma:
  * o Time to Lead, os intervalos e as por contactar;
  * as entradas, as chamadas, as atividades, a qualificação e as recuperadas;
  * as tarefas atrasadas, os períodos, as origens e a tabela por cliente;
  * que só a equipa OPERA vê o dashboard e a ocupação dos gestores;
  * que só o admin muda o objetivo.
* Verificado no browser como gestor, em computador e telemóvel.
