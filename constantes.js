// constantes.js
// Lista fixa dos cursos da instituição e dos períodos (1º ao 10º).
// Usado por auth.js (curso que o professor leciona), firebase.js (curso
// da questão/prova) e server.js (rota pública /api/constantes, que
// alimenta os formulários do front-end). Mudar a lista de cursos só
// precisa ser feito aqui.

const CURSOS_VALIDOS = [
  'Administração',
  'Biomedicina',
  'Ciências Contábeis',
  'Direito',
  'Educação Física',
  'Engenharia de Software',
  'Fisioterapia',
  'Pedagogia',
  'Psicologia',
];

const PERIODOS_VALIDOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

module.exports = { CURSOS_VALIDOS, PERIODOS_VALIDOS };
