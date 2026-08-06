// parque.js
// Controle de entrada do parque de trampolins (Saltiverso Patteo) - um
// registro por check-in de um responsavel trazendo N criancas pra pular.
// Mesmo padrao de sangrias.js: colecao Firestore propria, cache curto via
// liveCache.js, CRUD simples (criar/listAll/listByUnidades/atualizar/
// remover).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('parqueCheckins');

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
  observacao, adultoCortesia, quantAC, criancas, usou,
  criadoPorId, criadoPorEmail,
}) {
  const { tempo, criancasOk } = validarPayload({ unidade, responsavel, dataUtilizacao, tempoMinutos, criancas });
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
    timeInicial: inicio,
    timeFinal: inicio ? somarMinutos(inicio, tempo) : null,
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
    timeFinal: somarMinutos(inicio, atual.tempoMinutos),
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
  if (patch.timeInicial !== undefined || patch.tempoMinutos !== undefined) {
    const inicioBase = merge.timeInicial || atual.timeInicial;
    if (inicioBase) merge.timeFinal = somarMinutos(inicioBase, tempo);
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
      timeFinal: somarMinutos(c.horarioPrevisto, c.tempoMinutos),
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

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
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

module.exports = { TEMPOS_VALIDOS, criar, checkin, listAll, listByUnidades, getOne, atualizar, remover, buscarPorCpf, rodarAutoCheckins, invalidar: () => parqueCache.invalidar() };
