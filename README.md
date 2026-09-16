# ProvaFácil FANS — Extração e persistência de questões

A aplicação recebe um arquivo (questão enviada pelo professor em PDF, DOCX ou imagem), extrai o texto para revisão e permite salvar a versão revisada no **Cloud Firestore**, banco de dados do Firebase. A partir do banco de questões, o professor monta a prova selecionando questões e **gera a prova final no modelo oficial "Caderno de Provas" da FANS**, em PDF (pronto para imprimir) ou em DOCX (o mesmo layout, editável no Word).

## Funcionalidades

- **Painel do professor** (tela inicial): provas criadas no semestre, provas aprovadas pela direção, total de questões na banca e questões do assunto predominante, além da tabela de provas recentes com status editável (rascunho / em revisão / aprovada) e atalho para reabrir a prova no passo de revisão.
- Extração de texto de PDF, DOCX e imagens por OCR.
- Salvamento manual da questão revisada em `POST /api/questoes`.
- Editor visual para escrever questões com negrito, itálico, sublinhado, títulos, citações, listas e alinhamento.
- Salvamento do corpo e dos anexos extraídos na seção de verificação de e-mails.
- Consulta das últimas questões em `GET /api/questoes`.
- Exclusão de questões em `DELETE /api/questoes/:id`, com confirmação na interface.
- Importação de mensagens e anexos de uma caixa Gmail via IMAP.
- **Banco de Questões** em layout mestre-detalhe: filtros por período (atual/histórico) e por assunto, busca por palavra-chave, painel de detalhe com edição (`PUT /api/questoes/:id`) e exclusão.
- **Montagem da prova** em 3 passos: seleção das questões (com soma automática dos valores em relação aos 10,0 pontos), revisão/reordenação e preenchimento do cabeçalho.
- **Geração da prova no template oficial da FANS** (em ABNT) em `POST /api/provas/gerar-pdf` e `POST /api/provas/gerar-docx`: quadro de identificação com a logo (CURSO, DATA, ETAPA, PERÍODO, APROVAÇÃO DO COORDENADOR, ALUNO, VALOR), quadro de ORIENTAÇÕES GERAIS, faixas azuis `QUESTÃO N – (04 pontos)`, linha de referência `Ano/Banca/Órgão/Prova`, corpo em Arial 10 justificado, linhas pautadas para dissertativas e rodapé institucional em todas as páginas.
- O DOCX é gerado a partir de `assets/Template-Avaliacao-FANS.docx`: o gerador troca apenas o `word/document.xml` do template, então estilos, numeração, fontes, margens, rodapé e logo continuam sendo os do arquivo aprovado pela coordenação.

## Como montar uma prova

1. Em **Banco de Questões**, marque as questões desejadas (a seleção fica salva no navegador).
2. Clique em **Montar prova** — o resumo mostra quantas questões vieram do período atual, quantas do histórico e quanto falta para fechar 10,0 pontos.
3. Em **Continuar para revisão**, ajuste a ordem das questões, preencha os campos do cabeçalho (avaliação, curso, período, etapa, data, valor da prova, professor e as orientações gerais, uma por linha) e clique em **Gerar PDF da prova** ou em **Gerar DOCX (editável no Word)**. O download começa automaticamente; a prévia na tela aparece só para o PDF, já que o navegador não renderiza `.docx`.

O PDF é montado no servidor a partir dos dados que estão no Firestore (o navegador envia apenas os IDs e a ordem), e cada questão usada tem seu contador "usada em N provas" incrementado.

### Metadados de cada questão

Além do texto, cada questão guarda `assunto`, `periodo` (`atual` ou `historico`), `ano` e `valor` em pontos. Esses campos alimentam os filtros do banco e a soma da pontuação na montagem. Questões salvas antes dessa versão continuam funcionando: os campos ausentes recebem os padrões `Outros`, `atual` e `1` ponto.

## Configurando o Firebase

1. No [Firebase Console](https://console.firebase.google.com/), crie ou selecione um projeto.
2. Ative o **Cloud Firestore** em modo de produção ou teste, conforme a política de acesso desejada.
3. Em **Configurações do projeto → Contas de serviço**, gere uma nova chave privada.
4. No ambiente do servidor, configure `FIREBASE_SERVICE_ACCOUNT_JSON` com o conteúdo JSON da chave em uma única linha. Como alternativa, configure `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY` separadamente.
5. Nunca envie a chave privada para o navegador, para o Git ou para o arquivo `public/index.html`. O SDK usado é o Firebase Admin SDK, executado somente no servidor.

A coleção criada automaticamente será `questoes`. Cada documento contém `texto`, `conteudoHtml`, `tipoOrigem`, `nomeArquivo`, `assunto`, `periodo`, `ano`, `valor`, `usadaEm`, metadados de extração, `criadoEm` e `atualizadoEm`. O HTML salvo passa por uma sanitização server-side básica antes de ser persistido.

Sem as variáveis de Firebase, a aplicação continua iniciando e os endpoints de persistência retornam `503` com uma mensagem de configuração. Isso permite testar a extração antes de conectar um projeto real.

## Rodando localmente

```bash
npm install
cp .env.example .env
# edite .env e informe as credenciais necessárias
PORT=3001 npm start
```

Abra `http://localhost:3001`. Depois de extrair e revisar uma questão, use **Salvar questão**. O botão **Atualizar lista** consulta os documentos mais recentes do Firestore.

## Endpoints principais

- `GET /api/status`
- `POST /api/questoes/extrair-pdf`
- `POST /api/questoes/extrair-docx`
- `POST /api/questoes/extrair-imagem`
- `POST /api/questoes` — corpo JSON: `{ "texto": "...", "tipoOrigem": "pdf", "assunto": "Scrum", "periodo": "atual", "valor": 2.5 }`
- `GET /api/questoes?limite=50`
- `PUT /api/questoes/:id` — edita texto, assunto, período, ano e valor
- `DELETE /api/questoes/:id`
- `POST /api/provas/gerar-pdf` — corpo JSON: `{ "questaoIds": ["..."], "titulo": "Avaliação de Banco de Dados", "curso": "...", "periodo": "...", "etapa": "...", "data": "16/09/2026", "valorProva": "10,0", "professor": "...", "instrucoes": "uma orientação por linha", "linhasResposta": 5 }` — responde com o arquivo PDF
- `GET /api/provas?limite=20` — provas já geradas, para o painel
- `PATCH /api/provas/:id` — corpo JSON: `{ "status": "aprovada" }` (`rascunho`, `em_revisao` ou `aprovada`)
- `POST /api/provas/gerar-docx` — mesmo corpo JSON do endpoint acima — responde com o arquivo `.docx` no mesmo modelo
- `POST /api/questoes/verificar-email`
