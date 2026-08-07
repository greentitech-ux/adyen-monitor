// centralCards.js
// Agregacao das 3 filas com aprovacao da Central de Solicitacoes - Estorno
// (refunds.js), Ajuste de Fechamento (fechamentosLive.js) e Compra/
// Manutencao/Suporte de TI/Pagamento/Nota (solicitacoes.js) - cada card
// normalizado no mesmo formato. Extraido de index.js pra ser reaproveitado
// tambem pelo relatorio diario por e-mail (relatorioMV.js), sem duplicar a
// logica de normalizacao (ver GET /api/central em index.js, que usa
// listarTodos() e ainda filtra por permissao do usuario logado).
const refunds = require('./refunds');
const fechamentosLive = require('./fechamentosLive');
const solicitacoes = require('./solicitacoes');

function fmtMoneyServer(v) {
  return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizarCard(tipo, r) {
  if (tipo === 'estorno') {
    const ehCliente = r.origem === 'cliente';
    const titulo = ehCliente
      ? `Estorno (cliente) · ${r.nomeCliente || 'sem nome informado'}`
      : `Estorno · pedido ${r.pedidoId}`;
    let observacao = r.observacao || '';
    if (ehCliente) {
      const linhas = [
        `Motivo: ${r.motivoEstorno}${r.motivoOutro ? ' - ' + r.motivoOutro : ''}`,
        `Valor da venda: ${fmtMoneyServer(r.valorVenda)} · Valor a estornar: ${fmtMoneyServer(r.valorEstornar)}`,
        `Forma de pagamento: ${r.formaPagamento}${r.bandeira ? ' · ' + r.bandeira : ''}${r.ultimos4 ? ' final ' + r.ultimos4 : ''}`,
        `Venda em ${r.dataVenda}${r.horaVenda ? ' às ' + r.horaVenda : ''}`,
        r.telefoneCliente ? `Telefone do cliente: ${r.telefoneCliente}` : null,
      ].filter(Boolean);
      observacao = linhas.join('\n');
    }
    return {
      ...r,
      tipo, id: r.id, unidade: r.unidade, unidadeNome: r.unidadeNome || r.unidade, status: r.status, criadoEm: r.criadoEm,
      titulo, observacao, anexos: r.anexos || [], valorEstimado: null,
      criadoPorId: r.requestedById, criadoPorEmail: r.requestedByEmail || (ehCliente ? 'pedido do cliente final' : ''),
      motivoDecisao: r.motivoDecisao, decididoPorEmail: r.decidedByEmail, decididoEm: r.decidedEm,
      chamadoId: null,
    };
  }
  if (tipo === 'ajuste-fechamento') {
    const desc = r.tipoCorrecao === 'item'
      ? `adicionar ${r.itemNovo?.tipo === 'maquininha' ? 'maquininha' : 'saída'} "${r.itemNovo?.descricao || ''}" (${fmtMoneyServer(r.itemNovo?.valor)})`
      : r.tipoCorrecao === 'excluir'
        ? 'excluir o lançamento inteiro'
        : r.tipoCorrecao === 'data'
          ? `corrigir a data para ${r.novaData}`
          : `corrigir ${Object.keys(r.mudancas || {}).join(', ')}`;
    return {
      ...r,
      tipo, id: r.id, unidade: r.unidade, unidadeNome: r.unidadeNome, status: r.status, criadoEm: r.criadoEm,
      titulo: `Ajuste de fechamento (${r.data}) - ${desc}`, observacao: r.motivo, anexos: r.anexos || [], valorEstimado: null,
      criadoPorId: r.solicitadoPorId, criadoPorEmail: r.solicitadoPorEmail,
      motivoDecisao: r.motivoDecisao, decididoPorEmail: r.decididoPorEmail, decididoEm: r.decididoEm,
      chamadoId: null, fechamentoId: r.fechamentoId,
    };
  }
  return {
    ...r,
    tipo, id: r.id, unidade: r.unidade, unidadeNome: r.unidadeNome, status: r.status, criadoEm: r.criadoEm,
    titulo: r.titulo, observacao: r.observacao, anexos: r.anexos || [], valorEstimado: r.valorEstimado, itens: r.itens || [],
    criadoPorId: r.criadoPorId, criadoPorEmail: r.criadoPorEmail,
    motivoDecisao: r.motivoDecisao, decididoPorEmail: r.decididoPorEmail, decididoEm: r.decididoEm,
    chamadoId: r.chamadoId,
  };
}

// todos os cards das 3 filas, SEM filtro de permissao (quem usa decide o
// corte: GET /api/central filtra por usuario logado, relatorioMV.js filtra
// por direcionadoParaEmail)
async function listarTodos() {
  const [estornos, ajustes, gerais] = await Promise.all([
    refunds.listAll(),
    fechamentosLive.listarEdicoes(),
    solicitacoes.listAll(),
  ]);
  return [
    ...estornos.map((r) => normalizarCard('estorno', r)),
    ...ajustes.map((r) => normalizarCard('ajuste-fechamento', r)),
    ...gerais.map((r) => normalizarCard(r.tipo, r)),
  ];
}

module.exports = { normalizarCard, fmtMoneyServer, listarTodos };
