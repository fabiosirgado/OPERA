# OPERA Leads: Fase 2 (pipeline e ficha da lead)

Tudo isto está aplicado só no projeto Supabase de **testes**. A produção não foi tocada.

## Feito

**Ecrãs** ([leads-app/src/screens](../../leads-app/src/screens/)), com o design do protótipo:
* **Pipeline geral**, em quadro e em lista:
  * Filtros por cliente, etiqueta e texto.
  * Seis ordenações no quadro; ordenação por qualquer coluna na lista.
  * 50 leads de cada vez, com "Mostrar mais".
  * Indicadores no topo e arrastar entre etapas (no computador).
* **Ficha da lead**:
  * Ligar, WhatsApp, email e mudar de cliente.
  * Barra de etapas, contacto, qualificação, etiquetas e responsável no cliente.
  * Tarefas com atalhos de data; notas com resultados rápidos, afixar e editar; histórico.
  * Dados pessoais (RGPD): exportar e apagar a pedido do titular.
* **Hoje**: tarefas atrasadas, de hoje e de amanhã, com Ligar, Abrir e Feita.
* **Nova lead** com aviso de duplicado. **Nova etapa** com pré-visualização. **Gerir etiquetas.**
* **Vista do cliente**: só as suas leads, aviso das qualificadas, endereço dos portais, "Só as minhas", nova lead ("A OPERA contacta" ou "Fico eu com ela").
* **Pesquisa global** no menu: nome, telefone, email, interesse, qualificação, notas e etiquetas. Atalhos / e Ctrl+K, setas e Enter.
* **Tempo real**: o quadro, a lista Hoje e a ficha aberta atualizam-se sozinhos.

**Regras de negócio no servidor** ([supabase/migrations](../../supabase/migrations/)), com testes:
* A etapa inicial depende da origem. Nenhuma lead nasce com tarefa automática (decisão do Fábio, que substitui a regra 6).
* Duplicados pelo telefone normalizado ou pelo email, dentro do mesmo cliente.
* **Ligar:**
  * soma uma tentativa e regista a chamada;
  * preenche a primeira chamada (para o Time to Lead);
  * fecha a próxima Chamada;
  * passa a lead de uma etapa de entrada para Follow Up OPERA.
* **Lead Qualificada:** cancela as tarefas, cria "Confirmar com o cliente" a 24 h e põe o aviso ao cliente na fila.
* **Lead desqualificada:** cancela as tarefas.
* Cada mudança de etapa fica no histórico com origem, destino, autor e hora. As notas editadas ficam marcadas.
* As exportações do titular ficam no registo de atividade.

**Teste de carga** (projeto de testes, plano Free do Supabase): 100 mil leads em 20 clientes, 300 mil eventos e 30 mil tarefas em aberto. Tempos medidos como gestor, com a cache já aquecida:

| Consulta | Tempo |
|---|---|
| Coluna do quadro (50 leads) | 0,03 s |
| Página 10 de uma coluna | 0,006 s |
| Lista ordenada por nome | 0,002 s |
| Totais por etapa | 0,09 s |
| Filtro de texto | 0,005 s |
| Indicadores do topo | 0,11 s |
| Lista Hoje | 0,12 s |
| Pesquisa global (nome, telefone, notas) | 0,11 a 0,15 s |
| Ficha da lead (lead, histórico, tarefas) | 0,001 a 0,003 s |

No browser, o pipeline com 100 mil leads abriu em menos de 3 segundos, contando com o login. Depois do teste, os dados de carga foram apagados.

## Ainda não
* **Ligar** abre o telefone e regista a tentativa. A ligação pela CloudTalk, com a duração e a gravação, chega na Fase 6.
* **Aviso ao cliente** quando a lead fica qualificada: fica na fila (`lead_notifications`). O envio por email chega na Fase 7.
* **Importar e exportar Excel** chegam na Fase 3. Por agora, a exportação dos dados do titular é feita em JSON.
