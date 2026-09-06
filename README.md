# ProvaFácil FANS

Sistema web para gestão de banco de questões acadêmicas e geração automática de provas formatadas em ABNT.

Projeto interdisciplinar da disciplina **Projetos 1**, curso de Engenharia de Software — FANS (Faculdade de Nova Serrana).

## Sobre o projeto

O ProvaFácil centraliza a criação e o gerenciamento de questões, o fluxo de aprovação de provas pela direção e a geração automatizada do documento final da prova, já formatado em ABNT e pronto para envio à repografia.

## Funcionalidades

- Banco de questões com inserção via:
  - Digitação direta (caixa de texto)
  - Upload de PDF ou DOCX, com extração automática de texto e opção de edição em caso de erro
  - Envio por e-mail (texto no corpo ou anexo)
- Montagem de provas sem limite fixo de questões — a quantidade necessária para cada prova
- Fluxo de aprovação da prova pela direção
- Geração automática do documento final em PDF, formatado em ABNT
- Encaminhamento automático do PDF gerado para a repografia

## Stack

- **Front-end:** React
- **Back-end:** Node.js
- **Banco de dados:** a definir (Firebase ou MongoDB)
- **Deploy:** Vercel (provisório)

## Status

🚧 Em desenvolvimento.

## Equipe

- João Pedro Cordeiro
- Pedro Afonso Dias Raposo

**Orientador:** Prof. César Augusto de Oliveira Soares

## Como rodar o projeto

```bash
# Clone o repositório
git clone https://github.com/joaopcordeirons/provafacil-fans.git
cd provafacil-fans

# Instale as dependências (ajustar conforme estrutura front/back)
npm install

# Rode o projeto
npm start
```

> Instruções de instalação serão detalhadas conforme a estrutura do projeto for definida.
