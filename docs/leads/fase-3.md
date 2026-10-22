# OPERA Leads: Fase 3 (importar e exportar Excel)

Tudo isto está aplicado só no projeto Supabase de **testes**. A produção não foi tocada.

## Feito

**Ecrã "Importar e exportar"** (equipa OPERA), com o design do protótipo:
* **Ficheiros:** importa .xlsx, .xls e .csv, lidos no browser com o SheetJS 0.20.3, a versão oficial (a do registo npm é antiga e tem falhas de segurança conhecidas).
* **Colunas** reconhecidas pelo nome, com ou sem acentos: Nome, Telemóvel, Email, Origem, Interesse, Budget, Etapa, Etiquetas, Nota, Cliente e Data. Podem ser ajustadas à mão.
* **Cliente:** escolhido no ecrã ou lido da coluna Cliente.
* **Etapa:** escolhida no ecrã ou lida da coluna Etapa, primeiro pelo nome exato e depois por termos parecidos ("Contactado" vai para Follow Up, "Perdido" para desqualificada, "Qualificada" para Lead Qualificada). O que não se reconhece entra em Nova Lead BD.
* **Antes de confirmar:** leads novas, as que já existem (verificadas na base de dados), as que têm problemas (com a linha do Excel e o motivo) e quantas vão para cada etapa.
* **Duplicados:** ignorar, atualizar dados em falta ou criar na mesma.
* **Gravação:** feita no servidor em lotes de 250, com barra de progresso.
  * Cada lead importada tem entrada BD (fica fora do Time to Lead), nasce com uma Chamada se estiver antes de Qualificada e guarda a nota.
  * Etiquetas desconhecidas são criadas a cinzento.
* **Modelo Excel** para descarregar.

**Exportar**, sempre a partir do servidor, de 1000 em 1000 leads:
* **No ecrã:** por cliente, etapas e período; com ou sem notas e histórico; e formato pronto para importar no Pipedrive (Nome, Telefone, Email, Titulo, Origem, Nota).
* **Botões "Exportar Excel"** no pipeline (equipa OPERA) e **"Exportar contactos"** na vista do cliente (cada cliente só exporta as suas leads).
* **Cliente que sai:** "Exportar leads deste cliente" na ficha do cliente, antes e depois de o desativar. O admin pode exportar um cliente inativo durante os 6 meses.

Importações e exportações ficam no registo de atividade: quem, quando e quantas leads.

## Testes
* 15 testes novos (65 no total):
  * a lógica de Excel: colunas, etapas, clientes, linhas com problemas, leitura de ficheiros e os dois formatos de exportação;
  * as regras no servidor: só a equipa importa; os três modos de duplicados; erros por linha; etiquetas novas a cinzento; cada cliente só exporta as suas leads; paginação; registo de atividade.
* **Excel real de 5001 linhas no browser**, com linhas sem nome ou sem contacto, telefones repetidos no ficheiro, uma lead já existente e etapas escritas de várias formas:
  * Importado em **20 segundos**: 4982 criadas, 11 ignoradas por duplicado e 8 com problemas (as previstas).
  * A exportação dessas 5002 leads com histórico demorou **2,2 segundos**.
  * Os dados do teste foram apagados no fim.

## Nota
As leads importadas antes de Lead Qualificada nascem com uma Chamada para daí a 1 hora, como diz a regra 6. Numa importação grande, por exemplo da migração do Pipedrive na Fase 7, isso enche a lista Hoje de uma vez. Na Fase 7 proponho espalhar essas chamadas pelos dias seguintes.
