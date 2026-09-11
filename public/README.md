# API de Extração de Texto (PDF/DOCX/imagens) — ProvaFácil FANS

Primeiro passo do sistema: recebe um arquivo (questão enviada pelo professor
em PDF, DOCX ou imagem) e devolve o texto extraído, pronto para o professor
revisar/editar antes de salvar no banco de questões.

## OCR de imagens

O endpoint `POST /api/questoes/extrair-imagem` aceita imagens JPG/JPEG, PNG,
WEBP, GIF, BMP e TIFF de até 10 MB. O texto é reconhecido com OCR em português
e inglês e a resposta inclui uma estimativa de confiança (`confianca`). A
interface web também permite selecionar ou arrastar imagens. Anexos desses
formatos recebidos pelo endpoint de verificação de e-mail também são lidos
automaticamente.

## Rodando localmente (desenvolvimento)

Porta padrão agora é 80, o que exige privilégio de admin/root. Para testar
no seu PC sem sudo, use outra porta:

```bash
npm install
PORT=3001 npm start
