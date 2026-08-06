// refunds.js
// Fila de solicitacoes de estorno. Dois jeitos de entrar nela:
// - origem "interno": um usuario Leitor pede estorno de um pedido Aprovado
//   (com uma observacao explicando o motivo), confirmando com a propria
//   senha (veja auth.verifyPassword, chamado em index.js antes de criar o
//   registro).
// - origem "cliente": o CLIENTE FINAL preenche um formulario publico (sem
//   login, ver estorno-cliente.html) contando os dados da venda (nao tem
//   acesso ao pspReference/pedidoId interno) e anexa o comprovante da
//   maquininha - mesmos campos do Google Forms que a empresa ja usava.
// De qualquer origem, o Master acompanha a mesma fila e Aprova (e executa o
// estorno na Adyen por fora) ou Rejeita (com um motivo).
const db = require('./firestore');
const { createCache } = require('./liveCache');
const ticketCounter = require('./ticketCounter');
const centralChat = require('./centralChat');

const refundsRef = db.collection('refundRequests');
// 'CONVERTIDO': o ticket saiu de Estorno e virou um dos tipos gerais (ver
// converterParaSolicitacao) - o registro fica de historico, quem continua a
// historia e o novo registro em solicitacoes.js (convertidoParaId)
const STATUSES = ['PENDENTE', 'APROVADO', 'REJEITADO', 'CONVERTIDO'];
// 'conversao': registro nascido de um ticket de outro tipo que virou Estorno
// (ver converterParaEstorno em solicitacoes.js) - os dados ja foram
// validados na criacao do ticket original, entao pula a validacao normal
const ORIGENS = ['interno', 'cliente', 'conversao'];


async function create({
  pedidoId, unidade, unidadeNome, observacao, origem,
  motivoEstorno, motivoOutro, valorVenda, formaPagamento, bandeira, ultimos4,
  dataVenda, horaVenda, valorEstornar, nomeCliente, telefoneCliente, anexos,
  requestedById, requestedByEmail, direcionadoParaId, direcionadoParaEmail,
  numeroTicket, convertidoDeTipo, convertidoDeId,
}) {
  origem = ORIGENS.includes(origem) ? origem : 'interno';

  if (origem === 'interno') {
    if (!pedidoId) throw new Error('pedidoId é obrigatório.');
    if (!String(observacao || '').trim()) throw new Error('Descreva o motivo do estorno.');
  } else if (origem === 'cliente') {
    if (!unidade) throw new Error('Selecione a loja onde comprou.');
    if (!motivoEstorno) throw new Error('Selecione o motivo do estorno.');
    if (motivoEstorno === 'Outro' && !String(motivoOutro || '').trim()) throw new Error('Explique o motivo do estorno.');
    if (valorVenda == null || valorVenda === '') throw new Error('Informe o valor total da venda.');
    if (!formaPagamento) throw new Error('Selecione a forma de pagamento.');
    if (!bandeira) throw new Error('Selecione a bandeira do cartão.');
    if (!dataVenda) throw new Error('Informe a data da venda.');
    if (valorEstornar == null || valorEstornar === '') throw new Error('Informe o valor a estornar.');
    if (!Array.isArray(anexos) || !anexos.length) throw new Error('Anexe o comprovante da maquininha.');
  }

  const doc = refundsRef.doc();
  const agora = new Date().toISOString();
  // numeroTicket normalmente e novo (Ticket #10000 em diante, sequencia unica
  // compartilhada com solicitacoes.js/fechamentosLive.js) - so vem
  // pre-definido quando esse registro nasce de uma conversao de outro ticket
  // (ver converterParaEstorno em solicitacoes.js), pra manter o mesmo numero
  const ticket = numeroTicket != null ? numeroTicket : await ticketCounter.proximoTicket();
  const registro = {
    id: doc.id,
    numeroTicket: ticket,
    // trilha de qual(is) tipo(s) esse ticket ja passou
    historicoTipos: [{ tipo: 'estorno', em: agora, porEmail: requestedByEmail || null }],
    // preenchido só quando esse registro NASCEU de uma conversão de outro
    // ticket (ver converterParaSolicitacao) - referencia de onde ele veio
    convertidoDeTipo: convertidoDeTipo || null,
    convertidoDeId: convertidoDeId || null,
    // preenchido quando ESSE ticket vira outro tipo (ver converterParaSolicitacao)
    // - status vira 'CONVERTIDO' e esses dois campos apontam pro registro que
    // continua a historia do ticket
    convertidoParaTipo: null,
    convertidoParaId: null,
    origem,
    pedidoId: pedidoId || null,
    unidade: unidade || null,
    unidadeNome: unidadeNome || unidade || null,
    observacao: String(observacao || '').trim(),
    motivoEstorno: motivoEstorno || null,
    motivoOutro: motivoOutro ? String(motivoOutro).trim() : null,
    valorVenda: valorVenda != null && valorVenda !== '' ? Number(valorVenda) || 0 : null,
    formaPagamento: formaPagamento || null,
    bandeira: bandeira || null,
    ultimos4: ultimos4 ? String(ultimos4).slice(-4) : null,
    dataVenda: dataVenda || null,
    horaVenda: horaVenda || null,
    valorEstornar: valorEstornar != null && valorEstornar !== '' ? Number(valorEstornar) || 0 : null,
    nomeCliente: nomeCliente ? String(nomeCliente).trim().slice(0, 120) : null,
    telefoneCliente: telefoneCliente ? String(telefoneCliente).trim().slice(0, 30) : null,
    anexos: Array.isArray(anexos) ? anexos : [],
    status: 'PENDENTE',
    requestedById: requestedById || null,
    requestedByEmail: requestedByEmail || null,
    // Master/Admin escolhido por quem lançou (opcional, ver grupos.js) - so
    // um "pra quem e mais direto", nao restringe quem mais pode decidir
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    // notificacao (popup com som) fica ativa ate QUALQUER Master/Admin
    // sinalizar que viu - ver marcarNotificacaoVista
    notificacaoVista: false,
    notificacaoVistaPorEmail: null,
    notificacaoVistaEm: null,
    motivoDecisao: '',
    decidedByEmail: null,
    criadoEm: agora,
    decidedEm: null,
  };
  await doc.set(registro);
  refundsCache.invalidar();
  return registro;
}

async function marcarNotificacaoVista(id, { vistoPorEmail }) {
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({ notificacaoVista: true, notificacaoVistaPorEmail: vistoPorEmail, notificacaoVistaEm: new Date().toISOString() });
  refundsCache.invalidar();
  return getOne(id);
}

async function listAllUncached() {
  const snap = await refundsRef.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const refundsCache = createCache(listAllUncached, 20 * 1000);
const listAll = refundsCache.cached;


async function getOne(id) {
  const doc = await refundsRef.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateStatus(id, status, { motivoDecisao, decidedByEmail }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    status,
    motivoDecisao: motivoDecisao || '',
    decidedByEmail,
    decidedEm: new Date().toISOString(),
  });
  refundsCache.invalidar();
  return getOne(id);
}


// edicao direta pelo Master - poder de corrigir qualquer campo do pedido de
// estorno (dado errado digitado pelo cliente, unidade errada, etc.),
// independente do status. So mexe no que vier em `campos`.
const CAMPOS_TEXTO = ['pedidoId', 'unidade', 'unidadeNome', 'observacao', 'motivoEstorno', 'motivoOutro', 'formaPagamento', 'bandeira', 'ultimos4', 'dataVenda', 'horaVenda', 'nomeCliente', 'telefoneCliente'];
const CAMPOS_NUMERICOS = ['valorVenda', 'valorEstornar'];
async function update(id, campos) {
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const patch = {};
  CAMPOS_TEXTO.forEach((campo) => { if (campos[campo] != null) patch[campo] = String(campos[campo]).trim() || null; });
  CAMPOS_NUMERICOS.forEach((campo) => {
    if (Object.prototype.hasOwnProperty.call(campos, campo)) {
      patch[campo] = campos[campo] != null && campos[campo] !== '' ? Number(campos[campo]) || 0 : null;
    }
  });
  await ref.update(patch);
  refundsCache.invalidar();
  return getOne(id);
}

async function remove(id) {
  await refundsRef.doc(id).delete();
  refundsCache.invalidar();
}

// troca o Master/Admin responsavel por um pedido de estorno ja existente -
// mesmo criterio do redirecionar() de solicitacoes.js (atribuidosIds/Emails
// e quem de fato enxerga o card na Central quando nao e Master)
async function redirecionar(id, { direcionadoParaId, direcionadoParaEmail, atribuidosIds, atribuidosEmails }) {
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    atribuidosIds: Array.isArray(atribuidosIds) ? atribuidosIds.filter(Boolean) : [],
    atribuidosEmails: Array.isArray(atribuidosEmails) ? atribuidosEmails.filter(Boolean) : [],
  });
  refundsCache.invalidar();
  return getOne(id);
}

// converte um pedido de Estorno num dos 5 tipos gerais da Central (Compra,
// Manutencao, Suporte de TI, Pagamento, Nota) - ex: virou uma manutencao em
// vez de reembolso ao cliente. Marca este registro como CONVERTIDO e cria um
// novo em solicitacoes.js com o MESMO numero de ticket, preservando o
// historico (ver historicoTipos/convertidoDeTipo/convertidoDeId). Require
// tardio de solicitacoes.js (dependencia "de efeito colateral", nao do
// modulo em si) pra evitar require circular no topo do arquivo, ja que
// solicitacoes.js tambem precisa chamar de volta pra converterParaEstorno.
async function converterParaSolicitacao(id, novoTipo, dadosExtras, porEmail) {
  const solicitacoes = require('./solicitacoes');
  if (!solicitacoes.TIPOS.includes(novoTipo)) throw new Error('Tipo de destino inválido.');
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status === 'CONVERTIDO') throw new Error('Este ticket já foi convertido.');
  const d = dadosExtras || {};
  const novo = await solicitacoes.create({
    tipo: novoTipo,
    unidade: d.unidade || atual.unidade,
    unidadeNome: d.unidadeNome || atual.unidadeNome || d.unidade || atual.unidade,
    titulo: d.titulo || atual.observacao || `Estorno #${atual.numeroTicket} convertido`,
    valorEstimado: d.valorEstimado != null && d.valorEstimado !== '' ? d.valorEstimado : atual.valorEstornar,
    observacao: d.observacao || atual.observacao || '',
    itens: d.itens,
    anexos: atual.anexos,
    ehOrcamento: false,
    fornecedor: d.fornecedor,
    vencimento: d.vencimento,
    criadoPorId: atual.requestedById,
    criadoPorEmail: atual.requestedByEmail,
    direcionadoParaId: atual.direcionadoParaId,
    direcionadoParaEmail: atual.direcionadoParaEmail,
    numeroTicket: atual.numeroTicket,
    convertidoDeTipo: 'estorno',
    convertidoDeId: atual.id,
  });
  await ref.update({
    status: 'CONVERTIDO',
    convertidoParaTipo: novoTipo,
    convertidoParaId: novo.id,
  });
  await centralChat.reatribuirCard('estorno', id, novoTipo, novo.id);
  refundsCache.invalidar();
  return novo;
}

module.exports = {
  STATUSES, create, listAll, getOne, updateStatus, update, remove, marcarNotificacaoVista, redirecionar,
  converterParaSolicitacao,
};
