// chamadosManutencao.js
// Chamado de manutencao atribuido a um ou mais responsaveis (hoje sao 2
// pessoas de manutencao - quem abre o chamado escolhe 1 ou os 2, e so quem
// foi escolhido enxerga o chamado). Nasce vinculado a uma solicitacao de
// Manutencao (ver solicitacoes.js) aprovada, ou criado direto pelo Master.
//
// Fluxo (mais rico que o de chamadosTI.js, por pedido do usuario):
//   ABERTO       - aguardando o(s) responsavel(is) aceitar ou recusar
//   RECUSADO     - responsavel recusou (fim de linha - Master reatribui/edita)
//   ACEITO       - aceitou e definiu a Data da Execucao
//   INICIADO     - fez check-in na loja (foto do "antes")
//   EM_ESPERA    - execucao pausada (ex: falta de peca) - pode retomar
//   CONCLUIDO    - finalizado (foto do "depois" + observacao + pecas)
//   CANCELADO    - cancelado (Master)
// Master tem autonomia total: pode editar qualquer campo ou excluir o
// chamado inteiro, em qualquer status.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('chamadosManutencao');

const STATUSES = ['ABERTO', 'RECUSADO', 'ACEITO', 'INICIADO', 'EM_ESPERA', 'CONCLUIDO', 'CANCELADO'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function validarData(data, label) {
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error(`Informe ${label} válida.`);
  return data;
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

function sanitizarResponsaveis(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((r) => ({ id: String(r?.id || ''), email: String(r?.email || '') }))
    .filter((r) => r.id);
}

async function create({ unidade, unidadeNome, titulo, descricao, responsaveis, solicitacaoId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!titulo || !String(titulo).trim()) throw new Error('Descreva o chamado.');
  const responsaveisOk = sanitizarResponsaveis(responsaveis);
  if (!responsaveisOk.length) throw new Error('Escolha quem vai fazer a manutenção.');

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    titulo: String(titulo).trim().slice(0, 200),
    descricao: descricao || '',
    responsaveis: responsaveisOk,
    solicitacaoId: solicitacaoId || null,
    status: 'ABERTO',
    dataExecucao: null,
    motivoRecusa: null,
    motivoEspera: null,
    itensAntes: [],
    itensDepois: [],
    observacaoResponsavel: '',
    pecas: [],
    assinaturaNomeLoja: null,
    assinatura: null,
    criadoPorEmail,
    criadoEm: agora,
    aceitoEm: null,
    recusadoEm: null,
    iniciadoEm: null,
    emEsperaEm: null,
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

function ehResponsavel(chamado, userId) {
  return (chamado.responsaveis || []).some((r) => r.id === userId);
}

async function aceitar(id, { userId, dataExecucao }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (!ehResponsavel(atual, userId)) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'ABERTO') throw new Error('Esse chamado já foi respondido.');
  await COLLECTION.doc(id).update({
    status: 'ACEITO',
    dataExecucao: validarData(dataExecucao, 'a data de execução'),
    aceitoEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

async function recusar(id, { userId, motivo }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (!ehResponsavel(atual, userId)) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'ABERTO') throw new Error('Esse chamado já foi respondido.');
  await COLLECTION.doc(id).update({
    status: 'RECUSADO',
    motivoRecusa: String(motivo || '').slice(0, 500) || null,
    recusadoEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

// check-in: chegou na loja, registra os itens de como esta antes de mexer
async function iniciar(id, { itensAntes, userId }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (!ehResponsavel(atual, userId)) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'ACEITO') throw new Error('Aceite o chamado e defina a data de execução antes de fazer o check-in.');
  await COLLECTION.doc(id).update({
    status: 'INICIADO',
    itensAntes: sanitizarItensComFoto(itensAntes),
    iniciadoEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

// pausa a execucao (ex: falta de peca) sem perder o que ja foi feito
async function marcarEmEspera(id, { userId, motivo }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (!ehResponsavel(atual, userId)) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'INICIADO') throw new Error('Só é possível colocar em espera um chamado já iniciado.');
  await COLLECTION.doc(id).update({
    status: 'EM_ESPERA',
    motivoEspera: String(motivo || '').slice(0, 500) || null,
    emEsperaEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

async function retomar(id, { userId }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (!ehResponsavel(atual, userId)) throw new Error('Esse chamado não é seu.');
  if (atual.status !== 'EM_ESPERA') throw new Error('Esse chamado não está em espera.');
  await COLLECTION.doc(id).update({ status: 'INICIADO' });
  chamadosCache.invalidar();
  return getOne(id);
}

// finalizar (checkout): itens do depois, observacao do que foi feito, pecas
// compradas (se precisou) e assinatura de quem recebeu o servico na loja -
// so fecha com o nome de quem assinou e a assinatura preenchidos
async function concluir(id, { itensDepois, observacaoResponsavel, pecas, userId, assinaturaNomeLoja, assinatura }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (!ehResponsavel(atual, userId)) throw new Error('Esse chamado não é seu.');
  if (!['INICIADO', 'EM_ESPERA'].includes(atual.status)) throw new Error('Precisa fazer o check-in antes de concluir.');
  if (!String(assinaturaNomeLoja || '').trim()) throw new Error('Informe o nome de quem está assinando pela loja.');
  if (!assinatura || !assinatura.path) throw new Error('Colete a assinatura de quem recebeu o serviço.');
  await COLLECTION.doc(id).update({
    status: 'CONCLUIDO',
    itensDepois: sanitizarItensComFoto(itensDepois),
    observacaoResponsavel: String(observacaoResponsavel || '').slice(0, 2000),
    pecas: sanitizarPecas(pecas),
    assinaturaNomeLoja: String(assinaturaNomeLoja).trim().slice(0, 200),
    assinatura: { nome: String(assinatura.nome || ''), path: assinatura.path, tipo: assinatura.tipo || 'image/png' },
    concluidoEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

// Master: autonomia total pra corrigir titulo/descricao/data/responsaveis ou
// forcar um status, em qualquer momento do fluxo
async function atualizar(id, patch) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  const merge = {};
  if (patch.titulo !== undefined) {
    if (!String(patch.titulo).trim()) throw new Error('Descreva o chamado.');
    merge.titulo = String(patch.titulo).trim().slice(0, 200);
  }
  if (patch.descricao !== undefined) merge.descricao = String(patch.descricao || '').slice(0, 2000);
  if (patch.dataExecucao !== undefined) merge.dataExecucao = patch.dataExecucao ? validarData(patch.dataExecucao, 'a data de execução') : null;
  if (patch.responsaveis !== undefined) {
    const responsaveisOk = sanitizarResponsaveis(patch.responsaveis);
    if (!responsaveisOk.length) throw new Error('Escolha quem vai fazer a manutenção.');
    merge.responsaveis = responsaveisOk;
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new Error('Status inválido.');
    merge.status = patch.status;
  }
  merge.atualizadoEm = new Date().toISOString();
  await COLLECTION.doc(id).update(merge);
  chamadosCache.invalidar();
  return getOne(id);
}

async function remover(id) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  await COLLECTION.doc(id).delete();
  chamadosCache.invalidar();
}

module.exports = { STATUSES, create, listAll, getOne, aceitar, recusar, iniciar, marcarEmEspera, retomar, concluir, atualizar, remover };
