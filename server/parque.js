// parque.js
// Controle de entrada do parque de trampolins (Saltiverso Patteo) - um
// registro por check-in de um responsavel trazendo N criancas pra pular.
// Mesmo padrao de sangrias.js: colecao Firestore propria, cache curto via
// liveCache.js, CRUD simples (criar/listAll/listByUnidades/atualizar/
// remover).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('parqueCheckins');
// depois de enviado, o check-in nao pode ser excluido direto - qualquer
// exclusao passa por um pedido de correcao (parqueEdicoes) que so e
// aplicado quando o Master aprova, mesmo fluxo do fechamento de caixa
// (fechamentosLive.js) e das entregas (entregasLive.js)
const EDITS = db.collection('parqueEdicoes');
// checkout antecipado (emergencia) guarda o tempo que sobrou como credito
// pro mesmo CPF usar numa proxima visita - um doc por CPF, ver checkout()/
// registrarCredito()/creditoPorCpf()/usarCredito() mais abaixo
const CREDITOS = db.collection('parqueCreditos');

const TEMPOS_VALIDOS = [30, 60, 90, 120, 150, 180, 210, 240];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function validarHora(hora, label) {
  if (!hora || !/^\d{2}:\d{2}(:\d{2})?$/.test(hora)) throw new Error(`Informe ${label} válido.`);
  return hora.length === 5 ? `${hora}:00` : hora;
}

// soma minutos a um horario HH:MM(:SS) e devolve no mesmo formato HH:MM:SS
function somarMinutos(hora, minutos) {
  const [h, m] = hora.split(':').map(Number);
  const total = h * 60 + m + minutos;
  const hh = Math.floor((total % 1440) / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

function paraMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

const FUSO_BR = 'America/Sao_Paulo';
// hora atual em Brasilia, no formato HH:MM:SS - usada pelo botao de
// check-in (o horario que realmente conta pra pulseira e o do check-in
// fisico, nao o cadastro/pagamento que pode ter acontecido bem antes)
function horaAgoraBrasilia() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO_BR, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  const hora = o.hour === '24' ? '00' : o.hour;
  return `${hora}:${o.minute}:${o.second}`;
}

// data de hoje em Brasilia, no formato YYYY-MM-DD - usada pela varredura de
// auto check-in pra so mexer em registros do dia
function hojeBrasiliaISO() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}

function sanitizarCriancas(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((c) => ({
      nome: String((c && c.nome) || '').trim().slice(0, 120),
      dataNascimento: (c && c.dataNascimento) || null,
    }))
    .filter((c) => c.nome)
    .slice(0, 30);
}

// timeInicial NAO faz mais parte do cadastro - a compra/cadastro de acesso
// costuma acontecer bem antes da pessoa efetivamente entrar (minutos ou ate
// horas depois), entao o horario que realmente conta e definido no momento
// do check-in (ver funcao checkin() abaixo), nao aqui
function validarPayload({ unidade, responsavel, dataUtilizacao, tempoMinutos, criancas }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!responsavel || !String(responsavel.nome || '').trim()) throw new Error('Informe o nome do responsável.');
  if (!responsavel.contato || !String(responsavel.contato).trim()) throw new Error('Informe o contato do responsável.');
  if (!dataUtilizacao || !/^\d{4}-\d{2}-\d{2}$/.test(dataUtilizacao)) throw new Error('Data de utilização inválida.');
  const tempo = Number(tempoMinutos);
  if (!TEMPOS_VALIDOS.includes(tempo)) throw new Error('Escolha um tempo válido.');
  const criancasOk = sanitizarCriancas(criancas);
  if (!criancasOk.length) throw new Error('Cadastre pelo menos uma criança.');
  return { tempo, criancasOk };
}

async function criar({
  unidade, unidadeNome, colaboradorId, colaboradorNome,
  responsavel, dataUtilizacao, tempoMinutos, timeInicial, horarioPrevisto,
  observacao, adultoCortesia, quantAC, criancas, usou, minutosExtras,
  criadoPorId, criadoPorEmail,
}) {
  const { tempo, criancasOk } = validarPayload({ unidade, responsavel, dataUtilizacao, tempoMinutos, criancas });
  // minutosExtras: credito de tempo guardado de um checkout antecipado
  // anterior (ver checkout()/usarCredito() abaixo) - soma por cima do
  // tempo contratado normal, nao muda o "bucket" escolhido (TEMPOS_VALIDOS)
  const extras = Math.max(0, Math.min(240, num(minutosExtras)));
  // timeInicial e opcional na criacao (usado so pela importacao da planilha
  // antiga, que ja tem o horario real de visitas que ja aconteceram) - no
  // fluxo normal do formulario isso fica em branco ate o check-in
  const inicio = timeInicial ? validarHora(timeInicial, 'o horário inicial') : null;
  // horario previsto: definido na hora da venda ("a pessoa pretende entrar
  // as X"). Se o check-in manual (botao "Fazer check-in") acontecer antes
  // desse horario, tudo bem, o relogio comeca no horario real do check-in
  // normalmente. Se ninguem fizer o check-in ate esse horario, o sistema
  // inicia sozinho NESSE horario e avisa a equipe (ver rodarAutoCheckins)
  const previsto = horarioPrevisto ? validarHora(horarioPrevisto, 'o horário previsto') : null;
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    colaboradorId: colaboradorId || criadoPorId,
    colaboradorNome: colaboradorNome || criadoPorEmail,
    responsavel: {
      nome: String(responsavel.nome).trim().slice(0, 150),
      cpf: String(responsavel.cpf || '').trim().slice(0, 20),
      contato: String(responsavel.contato).trim().slice(0, 30),
      email: String(responsavel.email || '').trim().slice(0, 150),
      cep: String(responsavel.cep || '').trim().slice(0, 300),
      endereco: String(responsavel.endereco || '').trim().slice(0, 300),
      numero: String(responsavel.numero || '').trim().slice(0, 20),
      complemento: String(responsavel.complemento || '').trim().slice(0, 100),
    },
    dataUtilizacao,
    tempoMinutos: tempo,
    minutosExtras: extras,
    timeInicial: inicio,
    timeFinal: inicio ? somarMinutos(inicio, tempo + extras) : null,
    iniciado: !!inicio,
    horarioPrevisto: previsto,
    autoCheckin: false, // vira true so se o check-in for disparado pela varredura (ver rodarAutoCheckins)
    observacao: String(observacao || '').slice(0, 300),
    adultoCortesia: adultoCortesia === true,
    quantAC: adultoCortesia === true ? Math.max(0, Math.min(10, num(quantAC) || 1)) : 0,
    criancas: criancasOk,
    pulseiras: criancasOk.length,
    usou: usou !== false,
    termoAssinado: false,
    criadoPorId,
    criadoPorEmail,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  parqueCache.invalidar();
  return registro;
}

// aciona o relogio de verdade: a pulseira/tempo contratado passa a valer a
// partir de AGORA, nao do horario em que a compra/cadastro foi feita
async function checkin(id) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  const inicio = horaAgoraBrasilia();
  const merge = {
    timeInicial: inicio,
    timeFinal: somarMinutos(inicio, atual.tempoMinutos + (atual.minutosExtras || 0)),
    iniciado: true,
    checkinEm: new Date().toISOString(),
  };
  await ref.update(merge);
  parqueCache.invalidar();
  return getOne(id);
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('dataUtilizacao', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const parqueCache = createCache(listAllUncached, 20 * 1000);
const listAll = parqueCache.cached;

// Firestore "in" aceita no maximo 30 valores por consulta
async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const lotes = [];
  for (let i = 0; i < unidades.length; i += 30) lotes.push(unidades.slice(i, i + 30));
  const resultados = await Promise.all(lotes.map((lote) => COLLECTION.where('unidade', 'in', lote).get()));
  return resultados.flatMap((snap) => snap.docs.map((d) => d.data()));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function atualizar(id, patch) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  const merge = {};

  if (patch.responsavel) {
    merge.responsavel = { ...atual.responsavel, ...patch.responsavel };
  }
  if (patch.dataUtilizacao !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dataUtilizacao)) throw new Error('Data inválida.');
    merge.dataUtilizacao = patch.dataUtilizacao;
  }
  const tempo = patch.tempoMinutos !== undefined ? Number(patch.tempoMinutos) : atual.tempoMinutos;
  if (patch.tempoMinutos !== undefined) {
    if (!TEMPOS_VALIDOS.includes(tempo)) throw new Error('Escolha um tempo válido.');
    merge.tempoMinutos = tempo;
  }
  if (patch.timeInicial !== undefined) {
    merge.timeInicial = validarHora(patch.timeInicial, 'o horário inicial');
    merge.iniciado = true; // ajuste manual do Master tambem conta como check-in feito
  }
  const extras = patch.minutosExtras !== undefined ? Math.max(0, Math.min(240, num(patch.minutosExtras))) : (atual.minutosExtras || 0);
  if (patch.minutosExtras !== undefined) merge.minutosExtras = extras;
  if (patch.timeInicial !== undefined || patch.tempoMinutos !== undefined || patch.minutosExtras !== undefined) {
    const inicioBase = merge.timeInicial || atual.timeInicial;
    if (inicioBase) merge.timeFinal = somarMinutos(inicioBase, tempo + extras);
  }
  if (patch.observacao !== undefined) merge.observacao = String(patch.observacao).slice(0, 300);
  if (patch.adultoCortesia !== undefined) {
    merge.adultoCortesia = patch.adultoCortesia === true;
    merge.quantAC = merge.adultoCortesia ? Math.max(0, Math.min(10, num(patch.quantAC) || 1)) : 0;
  }
  if (patch.criancas !== undefined) {
    const criancasOk = sanitizarCriancas(patch.criancas);
    if (!criancasOk.length) throw new Error('Cadastre pelo menos uma criança.');
    merge.criancas = criancasOk;
    merge.pulseiras = criancasOk.length;
  }
  if (patch.usou !== undefined) merge.usou = patch.usou === true;
  if (patch.termoAssinado !== undefined) merge.termoAssinado = patch.termoAssinado === true;
  if (patch.horarioPrevisto !== undefined) {
    merge.horarioPrevisto = patch.horarioPrevisto ? validarHora(patch.horarioPrevisto, 'o horário previsto') : null;
  }

  merge.atualizadoEm = new Date().toISOString();
  await ref.update(merge);
  parqueCache.invalidar();
  return getOne(id);
}

// varredura periodica (ver index.js): pra cada check-in do dia que ainda nao
// foi feito manualmente e ja passou do horarioPrevisto, inicia o relogio
// sozinha NESSE horario (nao no horario em que a varredura rodou, pra nao
// prejudicar o tempo contratado por atraso do job) e marca autoCheckin=true
// pra equipe saber que ninguem confirmou a entrada fisica
async function rodarAutoCheckins() {
  const hoje = hojeBrasiliaISO();
  const agora = horaAgoraBrasilia();
  const snap = await COLLECTION.where('iniciado', '==', false).get();
  const feitos = [];
  for (const doc of snap.docs) {
    const c = doc.data();
    if (!c.horarioPrevisto || c.dataUtilizacao !== hoje) continue;
    if (c.horarioPrevisto > agora) continue;
    const merge = {
      timeInicial: c.horarioPrevisto,
      timeFinal: somarMinutos(c.horarioPrevisto, c.tempoMinutos + (c.minutosExtras || 0)),
      iniciado: true,
      autoCheckin: true,
      checkinEm: new Date().toISOString(),
    };
    // eslint-disable-next-line no-await-in-loop
    await doc.ref.update(merge);
    feitos.push({ ...c, ...merge });
  }
  if (feitos.length) parqueCache.invalidar();
  return feitos;
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  await COLLECTION.doc(id).delete();
  parqueCache.invalidar();
}

// pedido de exclusao (unico tipo de correcao por enquanto - o resto do
// cadastro ja pode ser editado direto via atualizar()) - so aplica de
// verdade quando o Master aprova em decidirEdicao()
async function solicitarEdicao({ checkinId, motivo, solicitadoPorId, solicitadoPorEmail }) {
  const atual = await getOne(checkinId);
  if (!atual) throw new Error('Check-in não encontrado.');
  if (!motivo || !String(motivo).trim()) throw new Error('Descreva o motivo da correção.');
  const pendentes = await listarEdicoes();
  if (pendentes.some((p) => p.checkinId === checkinId && p.status === 'PENDENTE')) {
    throw new Error('Já existe um pedido de correção pendente para esse check-in.');
  }

  const ref = EDITS.doc();
  const pedido = {
    id: ref.id,
    checkinId,
    tipoCorrecao: 'excluir',
    unidade: atual.unidade,
    unidadeNome: atual.unidadeNome,
    responsavelNome: atual.responsavel?.nome || '',
    dataUtilizacao: atual.dataUtilizacao,
    motivo: String(motivo).trim(),
    status: 'PENDENTE',
    solicitadoPorId,
    solicitadoPorEmail,
    criadoEm: new Date().toISOString(),
    decididoPorEmail: null,
    decididoEm: null,
    motivoDecisao: null,
  };
  await ref.set(pedido);
  edicoesParqueCache.invalidar();
  return pedido;
}

async function listarEdicoesUncached() {
  const snap = await EDITS.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const edicoesParqueCache = createCache(listarEdicoesUncached, 20 * 1000);
const listarEdicoes = edicoesParqueCache.cached;

async function decidirEdicao(id, status, { decididoPorEmail, motivoDecisao }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = EDITS.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Pedido não encontrado.');
  const pedido = doc.data();
  if (pedido.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');

  await ref.update({
    status,
    decididoPorEmail,
    motivoDecisao: motivoDecisao || null,
    decididoEm: new Date().toISOString(),
  });
  edicoesParqueCache.invalidar();

  if (status === 'APROVADO' && pedido.tipoCorrecao === 'excluir') {
    await remover(pedido.checkinId);
  }
  return { ...pedido, status };
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

// checkout antecipado (emergencia): a familia precisa sair antes do tempo
// contratado acabar. Para o relogio NESSE momento (a crianca ja nao conta
// mais como "no parque agora"), mas o credito do tempo que sobrou so vira
// de verdade quando um Gerente da unidade (ou Master/Admin) aprova - ver
// aprovarCheckout() (quem aprova e checado no index.js, na camada de
// permissao). Enquanto pendente, da pra desfazer com retomarCheckout() se
// a crianca voltar a brincar antes de alguem decidir
async function checkout(id, { motivo } = {}) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (!atual.iniciado) throw new Error('Esse check-in ainda não teve o check-in físico feito.');
  if (atual.checkoutEm) throw new Error('Esse check-in já teve o check-out registrado.');
  const agora = horaAgoraBrasilia();
  const restanteMin = Math.max(0, paraMinutos(atual.timeFinal) - paraMinutos(agora));
  const merge = {
    checkoutEm: new Date().toISOString(),
    checkoutAntecipado: restanteMin > 0,
    tempoRestanteMin: restanteMin,
    motivoCheckout: String(motivo || '').trim().slice(0, 300),
    checkoutAprovado: false,
    checkoutAprovadoPorEmail: null,
    checkoutAprovadoEm: null,
  };
  await ref.update(merge);
  parqueCache.invalidar();
  return getOne(id);
}

// Gerente da unidade (ou Master/Admin) confirma a saida antecipada - so ai
// o tempo que sobrou vira credito de fato pro CPF (registrarCredito)
async function aprovarCheckout(id, { aprovadoPorEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (!atual.checkoutEm) throw new Error('Esse check-in não tem check-out pendente.');
  if (atual.checkoutAprovado) throw new Error('Esse check-out já foi aprovado.');
  await ref.update({
    checkoutAprovado: true,
    checkoutAprovadoPorEmail: aprovadoPorEmail,
    checkoutAprovadoEm: new Date().toISOString(),
  });
  parqueCache.invalidar();
  if (atual.tempoRestanteMin > 0 && atual.responsavel?.cpf) {
    await registrarCredito(atual.responsavel.cpf, atual.tempoRestanteMin, id);
  }
  return getOne(id);
}

// a crianca voltou a brincar antes do checkout ser aprovado - desfaz o
// checkout e retoma o relogio com EXATAMENTE o tempo que sobrava no
// momento da saida (a pausa nao conta contra o tempo contratado)
async function retomarCheckout(id) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (!atual.checkoutEm) throw new Error('Esse check-in não está com check-out pendente.');
  if (atual.checkoutAprovado) throw new Error('Esse check-out já foi aprovado e não pode mais ser desfeito.');
  const agora = horaAgoraBrasilia();
  await ref.update({
    timeFinal: somarMinutos(agora, atual.tempoRestanteMin || 0),
    checkoutEm: null,
    checkoutAntecipado: false,
    tempoRestanteMin: null,
    motivoCheckout: null,
    checkoutAprovado: false,
    checkoutAprovadoPorEmail: null,
    checkoutAprovadoEm: null,
  });
  parqueCache.invalidar();
  return getOne(id);
}

async function registrarCredito(cpf, minutos, origemCheckinId) {
  const chave = soDigitos(cpf);
  if (!chave || minutos <= 0) return;
  const ref = CREDITOS.doc(chave);
  const snap = await ref.get();
  const atual = snap.exists ? snap.data() : { cpf: chave, minutosDisponiveis: 0, historico: [] };
  await ref.set({
    cpf: chave,
    minutosDisponiveis: (atual.minutosDisponiveis || 0) + minutos,
    historico: [...(atual.historico || []), { minutos, origemCheckinId, criadoEm: new Date().toISOString() }].slice(-30),
    atualizadoEm: new Date().toISOString(),
  });
}

async function creditoPorCpf(cpf) {
  const chave = soDigitos(cpf);
  if (!chave) return null;
  const doc = await CREDITOS.doc(chave).get();
  if (!doc.exists || !(doc.data().minutosDisponiveis > 0)) return null;
  return doc.data();
}

// consome (parte d)o credito guardado - chamado quando um novo check-in
// aplica esse tempo (ver minutosExtras em criar()); minutos e sempre o que
// realmente vai ser aplicado, nunca mais do que o disponivel
async function usarCredito(cpf, minutos) {
  const chave = soDigitos(cpf);
  if (!chave) throw new Error('CPF inválido.');
  const ref = CREDITOS.doc(chave);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Esse cliente não tem crédito de tempo guardado.');
  const atual = snap.data();
  const usar = Math.max(0, Math.min(Number(minutos) || 0, atual.minutosDisponiveis || 0));
  if (usar <= 0) throw new Error('Nenhum crédito de tempo disponível pra esse CPF.');
  await ref.update({ minutosDisponiveis: atual.minutosDisponiveis - usar, atualizadoEm: new Date().toISOString() });
  return usar;
}

// pra autopreenchimento do formulario de check-in: acha o cadastro mais
// recente com o mesmo CPF (comparando so os digitos, ja que a planilha
// importada tem CPF as vezes com pontuacao e as vezes sem)
async function buscarPorCpf(cpf) {
  const alvo = soDigitos(cpf);
  if (!alvo) return null;
  const todos = await listAll();
  const encontrados = todos.filter((c) => soDigitos(c.responsavel?.cpf) === alvo);
  if (!encontrados.length) return null;
  encontrados.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  return encontrados[0];
}

module.exports = {
  TEMPOS_VALIDOS, criar, checkin, listAll, listByUnidades, getOne, atualizar, buscarPorCpf, rodarAutoCheckins,
  solicitarEdicao, listarEdicoes, decidirEdicao,
  checkout, aprovarCheckout, retomarCheckout, creditoPorCpf, usarCredito,
  invalidar: () => parqueCache.invalidar(),
};
