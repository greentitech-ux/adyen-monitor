// chamadosTI.js
// Chamado de suporte tecnico (TI). Existem DUAS modalidades:
//
// - 'presencial': o tecnico vai ate a loja. Fluxo: ABERTO (aguardando o
//   tecnico chegar) -> INICIADO (check-in na loja, com itens de "antes") ->
//   CONCLUIDO (checkout: itens de "depois" + observacao + pecas + assinatura
//   de quem recebeu na loja).
// - 'remoto': atuacao a distancia pelo time de Suporte, sem visita. Fluxo:
//   ABERTO -> CONCLUIDO direto (concluirRemoto: so a observacao do que foi
//   feito, sem check-in/assinatura). Pode inclusive nascer JA CONCLUIDO
//   (jaResolvido na criacao) - e o registro retroativo de uma atuacao que o
//   Suporte ja resolveu, pra manter o banco de evidencias alimentado.
//
// Chamados antigos sem o campo `modalidade` sao presenciais (era a unica
// modalidade que existia). Todo chamado tem `prioridade` + `slaPrazo` (ver
// prioridades.js). Pode nascer vinculado a uma solicitacao de Suporte de TI
// (ver solicitacoes.js) aprovada, ou ser aberto direto pelo Master/Suporte.
const db = require('./firestore');
const { createCache } = require('./liveCache');
const prioridades = require('./prioridades');
const ticketCounter = require('./ticketCounter');

const COLLECTION = db.collection('chamadosTI');

const STATUSES = ['ABERTO', 'INICIADO', 'CONCLUIDO', 'CANCELADO'];
const MODALIDADES = ['presencial', 'remoto'];

function modalidadeDe(chamado) {
  return chamado && chamado.modalidade === 'remoto' ? 'remoto' : 'presencial';
}

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

async function create({ unidade, unidadeNome, titulo, descricao, tecnicoId, tecnicoEmail, solicitacaoId, criadoPorEmail, modalidade, prioridade, jaResolvido, observacaoResolucao, numeroTicket }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!titulo || !String(titulo).trim()) throw new Error('Descreva o chamado.');
  if (!tecnicoId) throw new Error('Escolha o responsável pelo chamado.');
  const mod = MODALIDADES.includes(modalidade) ? modalidade : 'presencial';
  // "abrir e ja fechar" so faz sentido no remoto - presencial exige a visita
  // (check-in/checkout com evidencias e assinatura)
  if (jaResolvido && mod !== 'remoto') throw new Error('Só chamados remotos podem nascer já resolvidos.');
  if (jaResolvido && !String(observacaoResolucao || '').trim()) throw new Error('Descreva o que foi feito na atuação.');

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const prio = prioridades.sanitizarPrioridade(prioridade);
  const registro = {
    id: doc.id,
    // Ticket # global (mesma sequencia da Central): herdado da solicitacao
    // que originou o chamado, ou novo - e o elo que junta o chamado com o
    // ticket de PAGAMENTO gerado pela cobranca (mesma numeracao)
    numeroTicket: numeroTicket != null ? numeroTicket : await ticketCounter.proximoTicket(),
    unidade,
    unidadeNome: unidadeNome || unidade,
    titulo: String(titulo).trim().slice(0, 200),
    descricao: descricao || '',
    modalidade: mod,
    prioridade: prio,
    slaPrazo: prioridades.slaPrazo(prio, agora),
    tecnicoId,
    tecnicoEmail,
    solicitacaoId: solicitacaoId || null,
    status: jaResolvido ? 'CONCLUIDO' : 'ABERTO',
    itensAntes: [],
    itensDepois: [],
    observacaoTecnico: jaResolvido ? String(observacaoResolucao).trim().slice(0, 2000) : '',
    pecas: [],
    // orcamento de peca (qualquer modalidade) e cobranca do atendimento -
    // ver salvarOrcamentoPecas/salvarCobranca
    orcamentoPecas: [],
    cobranca: null,
    // evidencias avulsas do chamado: observacao (texto) + N fotos cada -
    // ver adicionarEvidencia (diferente de itensAntes/Depois, que pertencem
    // ao check-in/checkout e tem 1 foto por item)
    evidencias: [],
    assinaturaNomeLoja: null,
    assinatura: null,
    resolvidoNaAbertura: !!jaResolvido,
    // data de execucao: quando o tecnico (ou Master) diz que a visita/atuacao
    // vai acontecer. O SLA cobre a TRIAGEM (ate o chamado ser atribuido e
    // ganhar essa data); a partir daqui o combinado passa a ser essa data
    dataExecucao: null,
    criadoPorEmail,
    criadoEm: agora,
    iniciadoEm: null,
    concluidoEm: jaResolvido ? agora : null,
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
  if (modalidadeDe(atual) !== 'presencial') throw new Error('Chamado remoto não tem check-in — use "Concluir atendimento remoto".');
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
  if (modalidadeDe(atual) !== 'presencial') throw new Error('Chamado remoto não tem checkout — use "Concluir atendimento remoto".');
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

// conclusao de chamado REMOTO: sem check-in, sem fotos, sem assinatura - so
// a observacao do que foi feito. Quem pode: o responsavel pelo chamado, ou
// um gestor (Master/Admin, ehGestor=true) fechando por ele
async function concluirRemoto(id, { observacaoTecnico, tecnicoId, ehGestor }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (modalidadeDe(atual) !== 'remoto') throw new Error('Chamado presencial precisa do check-in/checkout na loja.');
  if (!ehGestor && atual.tecnicoId !== tecnicoId) throw new Error('Esse chamado não é seu.');
  if (atual.status === 'CONCLUIDO') throw new Error('Esse chamado já foi concluído.');
  if (atual.status === 'CANCELADO') throw new Error('Esse chamado foi cancelado.');
  if (!String(observacaoTecnico || '').trim()) throw new Error('Descreva o que foi feito na atuação.');
  await COLLECTION.doc(id).update({
    status: 'CONCLUIDO',
    observacaoTecnico: String(observacaoTecnico).trim().slice(0, 2000),
    concluidoEm: new Date().toISOString(),
  });
  chamadosCache.invalidar();
  return getOne(id);
}

// chamados antigos (de antes do Ticket #) ganham numero na primeira vez que
// precisam de um - ex: na hora de enviar a cobranca
async function garantirTicket(id) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (atual.numeroTicket != null) return atual;
  await COLLECTION.doc(id).update({ numeroTicket: await ticketCounter.proximoTicket() });
  chamadosCache.invalidar();
  return getOne(id);
}

// edicao do Master: modalidade (presencial <-> remoto), status (ativo,
// concluido, cancelado, reaberto...) e prioridade - autonomia total pra
// corrigir qualquer chamado, em qualquer momento
async function editarMaster(id, { modalidade, status, prioridade }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  const merge = {};
  if (modalidade !== undefined) {
    if (!MODALIDADES.includes(modalidade)) throw new Error("Modalidade inválida: use 'presencial' ou 'remoto'.");
    merge.modalidade = modalidade;
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new Error('Status inválido.');
    merge.status = status;
    if (status === 'CONCLUIDO' && !atual.concluidoEm) merge.concluidoEm = new Date().toISOString();
    if (status === 'ABERTO') { merge.concluidoEm = null; merge.iniciadoEm = null; }
    if (status === 'INICIADO' && !atual.iniciadoEm) merge.iniciadoEm = new Date().toISOString();
  }
  if (prioridade !== undefined) {
    const prio = prioridades.sanitizarPrioridade(prioridade);
    merge.prioridade = prio;
    merge.slaPrazo = prioridades.slaPrazo(prio, atual.criadoEm);
  }
  if (!Object.keys(merge).length) throw new Error('Nada pra alterar.');
  await COLLECTION.doc(id).update(merge);
  chamadosCache.invalidar();
  return getOne(id);
}

// data de execucao: o tecnico responsavel (ou Master/Admin) diz quando a
// visita/atuacao vai acontecer - isso encerra a fase de triagem do SLA
async function definirDataExecucao(id, { dataExecucao, tecnicoId, ehGestor }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (!ehGestor && atual.tecnicoId !== tecnicoId) throw new Error('Esse chamado não é seu.');
  if (dataExecucao && !/^\d{4}-\d{2}-\d{2}$/.test(dataExecucao)) throw new Error('Informe a data de execução válida (AAAA-MM-DD).');
  await COLLECTION.doc(id).update({ dataExecucao: dataExecucao || null });
  chamadosCache.invalidar();
  return getOne(id);
}

// evidencia: observacao (texto) + quantas fotos precisar - registrada em
// qualquer momento do chamado (fotos ja vem salvas pela rota)
function sanitizarFotos(fotos) {
  return (Array.isArray(fotos) ? fotos : [])
    .filter((f) => f && f.path)
    .map((f) => ({ nome: String(f.nome || 'foto'), path: f.path, tipo: f.tipo || 'application/octet-stream' }));
}

async function adicionarEvidencia(id, { descricao, fotos, autorEmail, autorNome }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  const descricaoLimpa = String(descricao || '').trim().slice(0, 500);
  const fotosOk = sanitizarFotos(fotos);
  if (!descricaoLimpa && !fotosOk.length) throw new Error('Escreva a observação da evidência (e/ou anexe fotos).');
  const nova = {
    descricao: descricaoLimpa,
    fotos: fotosOk,
    autorEmail: autorEmail || null,
    autorNome: autorNome || null,
    em: new Date().toISOString(),
  };
  await COLLECTION.doc(id).update({ evidencias: [...(atual.evidencias || []), nova] });
  chamadosCache.invalidar();
  return getOne(id);
}

// remover evidencia: so Master (rota) - indice na lista
async function removerEvidencia(id, indice) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  const lista = [...(atual.evidencias || [])];
  const i = Number(indice);
  if (!Number.isInteger(i) || i < 0 || i >= lista.length) throw new Error('Evidência não encontrada.');
  lista.splice(i, 1);
  await COLLECTION.doc(id).update({ evidencias: lista });
  chamadosCache.invalidar();
  return getOne(id);
}

// orcamento de peca: pode existir em qualquer modalidade (remoto tambem -
// ex: diagnostico a distancia que aponta a peca a comprar)
async function salvarOrcamentoPecas(id, lista) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  await COLLECTION.doc(id).update({ orcamentoPecas: sanitizarPecas(lista) });
  chamadosCache.invalidar();
  return getOne(id);
}

// cobranca do atendimento: valor + observacao + boleto anexado. O chamado
// pode se resolver sem custo (fica sem cobranca), ou ganhar valor depois -
// reembolso no remoto, valor fechado no presencial. Enviar a cobranca gera
// o ticket de PAGAMENTO na Central com a MESMA numeracao (ver rota)
async function salvarCobranca(id, { valor, descricao, boleto }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Chamado não encontrado.');
  if (atual.cobranca && atual.cobranca.enviadaEm) throw new Error('A cobrança desse chamado já foi enviada pra pagamento.');
  const cobranca = {
    ...(atual.cobranca || {}),
    valor: num(valor),
    descricao: String(descricao || '').trim().slice(0, 500),
    atualizadoEm: new Date().toISOString(),
  };
  if (boleto && boleto.path) cobranca.boleto = { nome: String(boleto.nome || 'boleto'), path: boleto.path, tipo: boleto.tipo || 'application/octet-stream' };
  await COLLECTION.doc(id).update({ cobranca });
  chamadosCache.invalidar();
  return getOne(id);
}

async function marcarCobrancaEnviada(id, { pagamentoId }) {
  const atual = await getOne(id);
  if (!atual || !atual.cobranca) throw new Error('Chamado sem cobrança.');
  await COLLECTION.doc(id).update({ cobranca: { ...atual.cobranca, enviadaEm: new Date().toISOString(), pagamentoId: pagamentoId || null } });
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

module.exports = {
  STATUSES, MODALIDADES, modalidadeDe, create, listAll, getOne, iniciar, concluir, concluirRemoto, cancelar, reatribuir,
  garantirTicket, editarMaster, definirDataExecucao, salvarOrcamentoPecas, salvarCobranca, marcarCobrancaEnviada,
  adicionarEvidencia, removerEvidencia,
};
