# API de Extração de Texto (PDF/DOCX) — ProvaFácil FANS

Primeiro passo do sistema: recebe um arquivo (questão enviada pelo professor
em PDF ou DOCX) e devolve o texto extraído, pronto para o professor
revisar/editar antes de salvar no banco de questões.

## Rodando localmente (desenvolvimento)

Porta padrão agora é 80, o que exige privilégio de admin/root. Para testar
no seu PC sem sudo, use outra porta:

```bash
npm install
PORT=3001 npm start
```

Servidor sobe em `http://localhost:3001` (ou na porta que você definir; a
raiz `/` já serve a interface web de teste).

## Interface web de teste

Com o servidor rodando, abra a URL/porta correspondente no navegador
(ex.: `http://localhost:3001` em dev, ou `http://SEU_IP` em produção na porta 80).
Dá pra escolher PDF ou DOCX, arrastar o arquivo (ou clicar pra selecionar) e
ver o texto extraído, com botão de copiar.

<<<<<<< HEAD
## Recebendo questões por e-mail (Gmail)

1. Na conta do Gmail que vai receber as questões, ative a **verificação em
   duas etapas**: https://myaccount.google.com/security
2. Gere uma **senha de app**: https://myaccount.google.com/apppasswords
   (escolha "Outro" como aplicativo, dê um nome como "ProvaFacil" e copie a
   senha gerada — 16 caracteres, sem espaços na hora de usar).
3. Copie `.env.example` para `.env` e preencha:
   ```
   GMAIL_USER=seuprojeto@gmail.com
   GMAIL_APP_PASSWORD=asenhadeappaqui
   ```
4. Reinicie o servidor (`pm2 restart provafacil-extrair` em produção).
5. Chame `POST /api/questoes/verificar-email` (ou use o botão "Verificar
   agora" na interface web) para buscar e-mails não lidos, extrair o corpo
   e qualquer anexo em PDF/DOCX, e marcá-los como lidos.

**Não é webhook** — é IMAP por polling: cada chamada ao endpoint verifica a
caixa naquele momento. Se quiser verificação automática periódica, dá pra
adicionar um `setInterval` chamando `verificarNovosEmails()` no `server.js`,
ou agendar via `cron` batendo no endpoint de tempos em tempos.

=======
>>>>>>> 287d4f26d3144aecf0439488ff302f8010b307fd
## Endpoints

### `POST /api/questoes/extrair-pdf`

- Envie como `multipart/form-data`, campo **`arquivo`** contendo o PDF.
- Limite: 10MB, apenas `application/pdf`.

```bash
curl -F "arquivo=@questao.pdf" http://localhost:3001/api/questoes/extrair-pdf
```

```json
{
  "nomeArquivo": "questao.pdf",
  "paginas": 1,
  "texto": "Texto extraído do PDF aqui..."
}
```

### `POST /api/questoes/extrair-docx`

- Envie como `multipart/form-data`, campo **`arquivo`** contendo o DOCX.
- Limite: 10MB, apenas `.docx` (mimetype OOXML do Word).

```bash
curl -F "arquivo=@questao.docx" http://localhost:3001/api/questoes/extrair-docx
```

```json
{
  "nomeArquivo": "questao.docx",
  "texto": "Texto extraído do DOCX aqui...",
  "avisos": []
}
```

`avisos` traz mensagens do `mammoth` sobre elementos que não puderam ser
convertidos (ex.: estilos não mapeados) — útil para logs, não costuma
impedir a extração.

<<<<<<< HEAD
### `POST /api/questoes/verificar-email`

- Sem parâmetros. Requer `GMAIL_USER`/`GMAIL_APP_PASSWORD` no `.env`.
- Verifica e-mails não lidos, extrai corpo + anexos PDF/DOCX, marca como lidos.

```json
{
  "quantidade": 1,
  "emails": [
    {
      "de": "\"Prof. Teste\" <prof.teste@fans.edu.br>",
      "assunto": "Questão de Compiladores - Turma A",
      "data": "2026-09-08T12:00:00.000Z",
      "textoCorpo": "Segue a questão sobre análise léxica...",
      "anexos": [
        { "nomeArquivo": "questao.pdf", "tipo": "pdf", "paginas": 1, "texto": "..." }
      ]
    }
  ]
}
```

=======
>>>>>>> 287d4f26d3144aecf0439488ff302f8010b307fd
## Deploy em VPS (produção)

```bash
unzip provafacil-pdf-extract.zip
cd provafacil-pdf-extract
npm install --omit=dev
sudo npm start
```

A porta padrão agora é a **80** (HTTP puro, sem TLS). Portas abaixo de 1024
exigem privilégio de root no Linux — por isso o `sudo` acima (ou rode o
processo já como root, ou com `pm2` sob o usuário root).

Recomendado manter o processo vivo com **pm2**:

```bash
sudo npm install -g pm2
sudo pm2 start server.js --name provafacil-extrair
sudo pm2 save
sudo pm2 startup   # configura para subir sozinho no reboot da VPS
```

Não esqueça de liberar a porta 80 no Security Group da instância EC2/Lightsail
na AWS (Inbound rule: HTTP, porta 80, 0.0.0.0/0 ou o IP de quem for acessar).

Sem HTTPS, o tráfego (incluindo o texto das questões) vai em texto puro pela
rede — vale considerar TLS mais pra frente se o ambiente for sensível.

## Próximos passos sugeridos

- Salvar o texto extraído no banco (MongoDB/Firebase) vinculado à disciplina.
- Endpoint para o professor confirmar/editar o texto antes de persistir.
- Envio de questões por e-mail (parsing de corpo/anexo).
