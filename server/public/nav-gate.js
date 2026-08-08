// nav-gate.js
// Esconde do menu hamburguer o que o acesso NAO tem permissao de usar.
// Master e Admin veem tudo; os demais so veem os links das secoes que
// receberam na tela de Usuarios (+ Painel, Ajuda e Sair, que sao de todos).
// Roda em toda pagina que tem o nav-drawer (incluido junto de
// notif-central.js). So ESCONDE - nunca mostra: links master-only que a
// propria pagina ja esconde (Usuarios, Grupos...) continuam como estao.
// Os cabecalhos de grupo do menu somem sozinhos quando todos os itens
// ficam escondidos (ver initNavDrawerAccordion nas paginas).
(function () {
  const token = localStorage.getItem('authToken');
  if (!token) return;

  // id do link -> secoes que liberam (basta UMA). null = sempre visivel.
  const REGRAS = {
    'nav-monitor': ['monitor'],
    'nav-lancamento': ['lancamento'],
    'nav-fechamentos': ['fechamentos'],
    'nav-entregas': ['entregas'],
    'nav-entrega-lancamento': ['entregas-lancamento'],
    'nav-ifood': ['ifood'],
    'nav-relatorios': ['disputas'],
    'nav-cofre': ['cofre'],
    'nav-solicitacoes': ['solicitacoes'],
    // o Historico tambem serve pra quem recebe cards atribuidos
    // (tecnico/manutencao) - mesmo criterio do card no Painel
    'nav-historico': ['solicitacoes', 'manutencao', 'tecnico'],
    'nav-tecnico': ['tecnico', 'suporte'],
    'nav-tecnico-self': ['tecnico', 'suporte'],
    'nav-ativos-ti': ['ativos-ti'],
    'nav-manutencao': ['manutencao'],
    'nav-inventario': ['inventario'],
    'nav-abastecimento': ['abastecimento-carrinho', 'abastecimento-loja'],
    'nav-parque': ['parque'],
    'nav-parque-checkin': ['parque-checkin'],
    'nav-mensalistas': ['parque'],
    'nav-festas': ['festas'],
  };

  function aplicar(me) {
    if (!me || me.role === 'master' || me.isAdmin) return; // gestao ve tudo
    const secoes = (me.permissions && me.permissions.sections) || [];
    for (const [id, exigidas] of Object.entries(REGRAS)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (!exigidas.some((s) => secoes.includes(s))) el.classList.add('hidden');
    }
  }

  fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => {
      if (!me) return;
      aplicar(me);
      // reaplica depois do boot da pagina (alguns boots dao remove('hidden')
      // em links do menu sem olhar permissao)
      setTimeout(() => aplicar(me), 800);
      setTimeout(() => aplicar(me), 2500);
    })
    .catch(() => { /* API fora do ar - menu fica como esta */ });
})();
