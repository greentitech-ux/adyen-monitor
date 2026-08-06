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

function validarPayload({ unidade, responsavel, dataUtilizacao, tempoMinutos, timeInicial, criancas }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!responsavel || !String(responsavel.nome || '').trim()) throw new Error('Informe o nome do responsável.');
  if (!responsavel.contato || !String(responsavel.contato).trim()) throw new Error('Informe o contato do responsável.');
  if (!dataUtilizacao || !/^\d{4}-\d{2}-\d{2}$/.test(dataUtilizacao)) throw new Error('Data de utilização inválida.');
  const tempo = Number(tempoMinutos);
  if (!TEMPOS_VALIDOS.includes(tempo)) throw new Error('Escolha um tempo válido.');
  const inicio = validarHora(timeInicial, 'o horário inicial');
  const criancasOk = sanitizarCriancas(criancas);
  if (!criancasOk.length) throw new Error('Cadastre pelo menos uma criança.');
  return { tempo, inicio, criancasOk };
}

async function criar({
  unidade, unidadeNome, colaboradorId, colaboradorNome,
  responsavel, dataUtilizacao, tempoMinutos, timeInicial,
  observacao, adultoCortesia, quantAC, criancas, usou,
  criadoPorId, criadoPorEmail,
}) {
  const { tempo, inicio, criancasOk } = validarPayload({ unidade, responsavel, dataUtilizacao, tempoMinutos, timeInicial, criancas });
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
      cep: String(responsavel.cep || '').trim().slice(0, 20),
      numero: String(responsavel.numero || '').trim().slice(0, 20),
      complemento: String(responsavel.complemento || '').trim().slice(0, 100),
    },
    dataUtilizacao,
    tempoMinutos: tempo,
    timeInicial: inicio,
    timeFinal: somarMinutos(inicio, tempo),
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
  }
  if (patch.timeInicial !== undefined || patch.tempoMinutos !== undefined) {
    merge.timeFinal = somarMinutos(merge.timeInicial || atual.timeInicial, tempo);
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

  merge.atualizadoEm = new Date().toISOString();
  await ref.update(merge);
  parqueCache.invalidar();
  return getOne(id);
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  await COLLECTION.doc(id).delete();
  parqueCache.invalidar();
}

module.exports = { TEMPOS_VALIDOS, criar, listAll, listByUnidades, getOne, atualizar, remover };
