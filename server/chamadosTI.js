// chamadosTI.js
// Chamado de suporte tecnico (TI) atribuido a um tecnico especifico, que vai
// ate a loja resolver. Fluxo: ABERTO (criado, aguardando o tecnico chegar) ->
// INICIADO (tecnico fez check-in na loja, com itens de "antes") -> CONCLUIDO
// (tecnico finalizou, com itens de "depois" + observacao + pecas compradas,
// se precisou, + assinatura de quem recebeu na loja). Pode nascer vinculado a
// uma solicitacao de Suporte de TI (ver solicitacoes.js) aprovada, ou ser
// criado direto pelo Master.
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

// itens de "antes"/"depois" - cada um e uma descricao + 1 foto (opcional),
// no mesmo espirito de lista dinamica das pecas/maquininhas/criancas ja
// usadas no resto do app. fotos ja vem processadas (upload feito na rota)
function sanitizarItensComFoto(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((item) => ({
      descricao: String(item?.descricao || '').slice(0, 300),
      foto: item?.foto && item.foto.path ? { nome: String(item.foto.nome || ''), path: item.foto.path, tipo: item.foto.tipo || 'application/octet-stream' } : null,
    }))
    .filter((item) => item.descricao || item.foto);
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
    itensAntes: [],
    itensDepois: [],
    observacaoTecnico: '',
    pecas: [],
    assinaturaNomeLoja: null,
    assinatura: null,
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

// check-in: tecnico chegou na loja, registra os itens de como esta antes de mexer
async function iniciar(id, { itensAntes, tecnicoId }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (atual.tecnicoId !== tecnicoId) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'ABERTO') throw new Error('Esse chamado já foi iniciado.');
  await COLLECTION.doc(id).update({
    status: 'INICIADO',
    itensAntes: sanitizarItensComFoto(itensAntes),
    iniciadoEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

// finalizar (checkout): itens do depois, observacao do que foi feito, pecas
// compradas (se precisou) e assinatura de quem recebeu o servico na loja -
// so fecha com o nome de quem assinou e a assinatura preenchidos
async function concluir(id, { itensDepois, observacaoTecnico, pecas, tecnicoId, assinaturaNomeLoja, assinatura }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (atual.tecnicoId !== tecnicoId) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'INICIADO') throw new Error('Precisa fazer o check-in antes de concluir.');
  if (!String(assinaturaNomeLoja || '').trim()) throw new Error('Informe o nome de quem está assinando pela loja.');
  if (!assinatura || !assinatura.path) throw new Error('Colete a assinatura de quem recebeu o serviço.');
  await COLLECTION.doc(id).update({
    status: 'CONCLUIDO',
    itensDepois: sanitizarItensComFoto(itensDepois),
    observacaoTecnico: String(observacaoTecnico || '').slice(0, 2000),
    pecas: sanitizarPecas(pecas),
    assinaturaNomeLoja: String(assinaturaNomeLoja).trim().slice(0, 200),
    assinatura: { nome: String(assinatura.nome || ''), path: assinatura.path, tipo: assinatura.tipo || 'image/png' },
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

// Master troca o tecnico responsavel de um chamado ja existente (ex: o
// tecnico escalado ficou indisponivel) - em qualquer status, igual o
// Master ja pode reatribuir o responsavel de qualquer solicitacao
async function reatribuir(id, { tecnicoId, tecnicoEmail }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (!tecnicoId) throw new Error('Escolha o técnico responsável.');
  await COLLECTION.doc(id).update({ tecnicoId, tecnicoEmail: tecnicoEmail || null });
  chamadosCache.invalidar();
  return getOne(id);
}

module.exports = { STATUSES, create, listAll, getOne, iniciar, concluir, cancelar, reatribuir };
