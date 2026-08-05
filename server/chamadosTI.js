// chamadosTI.js
// Chamado de suporte tecnico (TI) atribuido a um tecnico especifico, que vai
// ate a loja resolver. Fluxo: ABERTO (criado, aguardando o tecnico chegar) ->
// INICIADO (tecnico fez check-in na loja, com foto do "antes") -> CONCLUIDO
// (tecnico finalizou, com foto do "depois" + observacao + pecas compradas,
// se precisou). Pode nascer vinculado a uma solicitacao de Suporte de TI (ver
// solicitacoes.js) aprovada, ou ser criado direto pelo Master.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('chamadosTI');

const STATUSES = ['ABERTO', 'INICIADO', 'CONCLUIDO', 'CANCELADO'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sanitizarPecas(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((item) => ({ descricao: String(item?.descricao || '').slice(0, 200), valor: num(item?.valor), observacao: String(item?.observacao || '').slice(0, 300) }))
    .filter((item) => item.descricao || item.valor);
}

async function create({ unidade, unidadeNome, titulo, descricao, tecnicoId, tecnicoEmail, solicitacaoId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!titulo || !String(titulo).trim()) throw new Error('Descreva o chamado.');
  if (!tecnicoId) throw new Error('Escolha o técnico responsável.');

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    titulo: String(titulo).trim().slice(0, 200),
    descricao: descricao || '',
    tecnicoId,
    tecnicoEmail,
    solicitacaoId: solicitacaoId || null,
    status: 'ABERTO',
    fotosAntes: [],
    fotosDepois: [],
    observacaoTecnico: '',
    pecas: [],
    criadoPorEmail,
    criadoEm: agora,
    iniciadoEm: null,
    concluidoEm: null,
  };
  await doc.set(registro);
  chamadosCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const chamadosCache = createCache(listAllUncached, 20 * 1000);
const listAll = chamadosCache.cached;

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// check-in: tecnico chegou na loja, registra como esta antes de mexer
async function iniciar(id, { fotosAntes, tecnicoId }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (atual.tecnicoId !== tecnicoId) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'ABERTO') throw new Error('Esse chamado já foi iniciado.');
  await COLLECTION.doc(id).update({
    status: 'INICIADO',
    fotosAntes: Array.isArray(fotosAntes) ? fotosAntes : [],
    iniciadoEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

// finalizar: foto do depois, observacao do que foi feito, pecas compradas (se precisou)
async function concluir(id, { fotosDepois, observacaoTecnico, pecas, tecnicoId }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (atual.tecnicoId !== tecnicoId) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'INICIADO') throw new Error('Precisa fazer o check-in antes de concluir.');
  await COLLECTION.doc(id).update({
    status: 'CONCLUIDO',
    fotosDepois: Array.isArray(fotosDepois) ? fotosDepois : [],
    observacaoTecnico: String(observacaoTecnico || '').slice(0, 2000),
    pecas: sanitizarPecas(pecas),
    concluidoEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

async function cancelar(id, { motivo }) {
  await COLLECTION.doc(id).update({ status: 'CANCELADO', motivoCancelamento: motivo || null });
  chamadosCache.invalidar();
  return getOne(id);
}

module.exports = { STATUSES, create, listAll, getOne, iniciar, concluir, cancelar };
