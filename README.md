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