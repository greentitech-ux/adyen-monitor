// solicitacoes.js
// Pedidos genericos da loja que nao sao nem estorno (refunds.js) nem
// correcao de fechamento (fechamentosLive.js solicitarEdicao) - Compra,
// Manutencao e Suporte de TI. Mesmo fluxo de fila-com-aprovacao dos outros
// dois: a loja pede, o Master aprova/rejeita (com motivo opcional), com
// anexo (foto/print/orcamento) e observacao. Aprovar um pedido de Suporte
// de TI cria um Chamado (ver chamadosTI.js) pro tecnico ir na loja.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('solicitacoes');

const TIPOS = ['compra', 'manutencao', 'suporte-ti'];
const STATUSES = ['PENDENTE', 'APROVADO', 'REJEITADO'];

// itens da lista de compra (nome do que comprar + quantidade) - so pra
// tipo "compra", mesmo padrao repetivel de MAQUINAS/SAIDAS do lancamento.
// O valor estimado continua existindo a parte (campo unico, opcional, pra
// quando o pedido ja tem um total definido)
function sanitizarItens(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((item) => ({
      descricao: String(item?.descricao || '').trim().slice(0, 200),
      quantidade: item?.quantidade != null && item.quantidade !== '' ? Number(item.quantidade) || 0 : null,
    }))
    .filter((item) => item.descricao);
}

async function create({ tipo, unidade, unidadeNome, titulo, valorEstimado, observacao, itens, anexos, ehOrcamento, criadoPorId, criadoPorEmail, direcionadoParaId, direcionadoParaEmail }) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de solicitação inválido.');
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!titulo || !String(titulo).trim()) throw new Error('Descreva o que está sendo pedido.');

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    tipo,
    unidade,
    unidadeNome: unidadeNome || unidade,
    titulo: String(titulo).trim().slice(0, 200),
    valorEstimado: valorEstimado != null && valorEstimado !== '' ? Number(valorEstimado) || 0 : null,
    observacao: observacao || '',
    itens: tipo === 'compra' ? sanitizarItens(itens) : [], // [{ descricao, quantidade }]
    anexos: Array.isArray(anexos) ? anexos : [], // [{ nome, path, tipo }]
    // destaca que o pedido e um orcamento (precisa de julgamento de quem tem
    // a tag Admin antes de aprovar, nao so registro de rotina)
    ehOrcamento: !!ehOrcamento,
    status: 'PENDENTE',
    criadoPorId,
    criadoPorEmail,
    // Master/Admin escolhido por quem lançou (opcional, ver grupos.js) - so
    // um "pra quem e mais direto", nao restringe quem mais pode decidir
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    // notificacao (popup com som) fica ativa ate QUALQUER Master/Admin
    // sinalizar que viu - ver marcarNotificacaoVista
    notificacaoVista: false,
    notificacaoVistaPorEmail: null,
    notificacaoVistaEm: null,
    criadoEm: agora,
    decididoPorEmail: null,
    decididoEm: null,
    motivoDecisao: null,
    chamadoId: null, // preenchido se virar Chamado de TI (tipo 'suporte-ti' aprovado)
  };
  await doc.set(registro);
  solicitacoesCache.invalidar();
  return registro;
}

async function marcarNotificacaoVista(id, { vistoPorEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({ notificacaoVista: true, notificacaoVistaPorEmail: vistoPorEmail, notificacaoVistaEm: new Date().toISOString() });
  solicitacoesCache.invalidar();
  return getOne(id);
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const solicitacoesCache = createCache(listAllUncached, 20 * 1000);
const listAll = solicitacoesCache.cached;

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateStatus(id, status, { motivoDecisao, decidedByEmail }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    status,
    motivoDecisao: motivoDecisao || null,
    decididoPorEmail: decidedByEmail,
    decididoEm: new Date().toISOString(),
  });
  solicitacoesCache.invalidar();
  return getOne(id);
}

async function vincularChamado(id, chamadoId) {
  await COLLECTION.doc(id).update({ chamadoId });
  solicitacoesCache.invalidar();
}

// edicao direta pelo Master - poder de corrigir qualquer campo do pedido
// (titulo, valor, observacao, itens, unidade), independente do status.
// So atualiza o que vier em `campos`, sem mexer em status/decisao/chamado.
async function update(id, campos) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  const patch = {};
  if (campos.titulo != null) {
    if (!String(campos.titulo).trim()) throw new Error('Descreva o que está sendo pedido.');
    patch.titulo = String(campos.titulo).trim().slice(0, 200);
  }
  if (campos.unidade != null) patch.unidade = campos.unidade;
  if (campos.unidadeNome != null) patch.unidadeNome = campos.unidadeNome;
  if (Object.prototype.hasOwnProperty.call(campos, 'valorEstimado')) {
    patch.valorEstimado = campos.valorEstimado != null && campos.valorEstimado !== '' ? Number(campos.valorEstimado) || 0 : null;
  }
  if (campos.observacao != null) patch.observacao = campos.observacao;
  if (campos.itens != null) patch.itens = (atual.tipo === 'compra') ? sanitizarItens(campos.itens) : [];
  if (campos.ehOrcamento != null) patch.ehOrcamento = !!campos.ehOrcamento;
  await ref.update(patch);
  solicitacoesCache.invalidar();
  return getOne(id);
}

async function remove(id) {
  await COLLECTION.doc(id).delete();
  solicitacoesCache.invalidar();
}

module.exports = { TIPOS, STATUSES, create, listAll, getOne, updateStatus, vincularChamado, update, remove, marcarNotificacaoVista };
