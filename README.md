# ProvaFácil FANS — Extração e persistência de questões

A aplicação recebe um arquivo (questão enviada pelo professor em PDF, DOCX ou imagem), extrai o texto para revisão e permite salvar a versão revisada no **Cloud Firestore**, banco de dados do Firebase.

## Funcionalidades

- Extração de texto de PDF, DOCX e imagens por OCR.
- Salvamento manual da questão revisada em `POST /api/questoes`.
- Salvamento do corpo e dos anexos extraídos na seção de verificação de e-mails.
- Consulta das últimas questões em `GET /api/questoes`.
- Exclusão de questões em `DELETE /api/questoes/:id`, com confirmação na interface.
- Importação de mensagens e anexos de uma caixa Gmail via IMAP.

## Configurando o Firebase

1. No [Firebase Console](https://console.firebase.google.com/), crie ou selecione um projeto.
2. Ative o **Cloud Firestore** em modo de produção ou teste, conforme a política de acesso desejada.
3. Em **Configurações do projeto → Contas de serviço**, gere uma nova chave privada.
4. No ambiente do servidor, configure `FIREBASE_SERVICE_ACCOUNT_JSON` com o conteúdo JSON da chave em uma única linha. Como alternativa, configure `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY` separadamente.
5. Nunca envie a chave privada para o navegador, para o Git ou para o arquivo `public/index.html`. O SDK usado é o Firebase Admin SDK, executado somente no servidor.

A coleção criada automaticamente será `questoes`. Cada documento contém `texto`, `tipoOrigem`, `nomeArquivo`, metadados de extração, `criadoEm` e `atualizadoEm`.

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
- `POST /api/questoes` — corpo JSON: `{ "texto": "...", "tipoOrigem": "pdf", "nomeArquivo": "..." }`
- `GET /api/questoes?limite=50`
- `DELETE /api/questoes/:id`
- `POST /api/questoes/verificar-email`
