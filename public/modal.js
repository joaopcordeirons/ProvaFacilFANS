// Substitui os popups nativos do navegador (window.confirm / window.alert)
// por um modal próprio, reaproveitando o mesmo estilo visual (.modal-overlay
// / .modal-caixa / .modal-acoes) já usado no modal de "Excluir conta".
//
// Uso:
//   const ok = await confirmarAcao({ titulo, mensagem, textoConfirmar, perigo });
//   await avisar({ titulo, mensagem });

function criarModalBase() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-caixa" role="dialog" aria-modal="true">
      <h3></h3>
      <p></p>
      <div class="modal-acoes"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function fecharModal(overlay) {
  overlay.remove();
}

/**
 * Substitui window.confirm(). Retorna uma Promise<boolean>.
 * @param {{ titulo?: string, mensagem: string, textoConfirmar?: string, textoCancelar?: string, perigo?: boolean }} opcoes
 */
function confirmarAcao({
  titulo = 'Confirmar ação',
  mensagem,
  textoConfirmar = 'Confirmar',
  textoCancelar = 'Cancelar',
  perigo = false,
} = {}) {
  return new Promise((resolve) => {
    const overlay = criarModalBase();
    overlay.querySelector('h3').textContent = titulo;
    overlay.querySelector('p').textContent = mensagem;

    const acoes = overlay.querySelector('.modal-acoes');

    const btnCancelar = document.createElement('button');
    btnCancelar.type = 'button';
    btnCancelar.className = 'btn-secundario';
    btnCancelar.textContent = textoCancelar;

    const btnConfirmar = document.createElement('button');
    btnConfirmar.type = 'button';
    btnConfirmar.className = perigo ? 'btn-perigo' : 'btn-escuro';
    btnConfirmar.textContent = textoConfirmar;

    acoes.appendChild(btnCancelar);
    acoes.appendChild(btnConfirmar);

    const resolver = (valor) => {
      fecharModal(overlay);
      document.removeEventListener('keydown', aoTeclar);
      resolve(valor);
    };

    const aoTeclar = (evento) => {
      if (evento.key === 'Escape') resolver(false);
      if (evento.key === 'Enter') resolver(true);
    };

    btnCancelar.addEventListener('click', () => resolver(false));
    btnConfirmar.addEventListener('click', () => resolver(true));
    overlay.addEventListener('click', (evento) => {
      if (evento.target === overlay) resolver(false);
    });
    document.addEventListener('keydown', aoTeclar);

    btnConfirmar.focus();
  });
}

/**
 * Substitui window.alert(). Retorna uma Promise<void>, resolvida ao fechar.
 * @param {{ titulo?: string, mensagem: string, textoFechar?: string }} opcoes
 */
function avisar({ titulo = 'Aviso', mensagem, textoFechar = 'OK' } = {}) {
  return new Promise((resolve) => {
    const overlay = criarModalBase();
    overlay.querySelector('h3').textContent = titulo;
    overlay.querySelector('p').textContent = mensagem;

    const acoes = overlay.querySelector('.modal-acoes');
    const btnFechar = document.createElement('button');
    btnFechar.type = 'button';
    btnFechar.className = 'btn-escuro';
    btnFechar.textContent = textoFechar;
    acoes.appendChild(btnFechar);

    const resolver = () => {
      fecharModal(overlay);
      document.removeEventListener('keydown', aoTeclar);
      resolve();
    };

    const aoTeclar = (evento) => {
      if (evento.key === 'Escape' || evento.key === 'Enter') resolver();
    };

    btnFechar.addEventListener('click', resolver);
    overlay.addEventListener('click', (evento) => {
      if (evento.target === overlay) resolver();
    });
    document.addEventListener('keydown', aoTeclar);

    btnFechar.focus();
  });
}
