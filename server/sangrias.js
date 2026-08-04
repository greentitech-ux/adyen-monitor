// sangrias.js
// Sangrias (retiradas de caixa) registradas em campo - normalmente por quem
// visita as lojas ao longo do dia, ANTES do fechamento do dia ser lançado.
// Fica numa coleção separada, e só é mesclada com o fechamento do dia na
// hora da leitura (mesma lógica usada pra juntar as sangrias que vêm do
// AppSheet, em sheetsSync.js/mesclarLancamentosDoMesmoDia) - porque na hora
// que a sangria é registrada pode ainda não existir nenhum fechamento pra
// aquele dia.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('sangrias');


function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function criar({ unidade, unidadeNome, grupo, data, valor, descricao, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
  const v = num(valor);
  if (v <= 0) throw new Error('Informe o valor retirado.');

  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    grupo: grupo || 'MANUAL',
    data,
    valor: v,
    descricao: (descricao || '').slice(0, 300),
    criadoPorId,
    criadoPorEmail,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  sangriasCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const sangriasCache = createCache(listAllUncached, 20 * 1000);
const listAll = sangriasCache.cached;


// Firestore "in" aceita no maximo 30 valores por consulta
async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const lotes = [];
  for (let i = 0; i < unidades.length; i += 30) lotes.push(unidades.slice(i, i + 30));
  const resultados = await Promise.all(lotes.map((lote) => COLLECTION.where('unidade', 'in', lote).get()));
  return resultados.flatMap((snap) => snap.docs.map((d) => d.data()));
}

// formata a sangria como um "fechamento" mínimo (mesmo formato usado no
// resto do sistema), só com o valor retirado em totalSaida - assim dá pra
// mesclar com o fechamento real do dia usando a mesma função já validada
function comoFechamento(s) {
  return {
    id: `sangria-${s.id}`,
    gerente: s.criadoPorEmail || '',
    unidadeNome: s.unidadeNome,
    unidade: s.unidade,
    grupo: s.grupo,
    data: s.data,
    caixaInicial: 0, caixaFinal: 0, delivery: 0, carryout: 0, pickup: 0, loja: 0,
    adyen: 0, ifood: 0, food99: 0, pix: 0, pixCnpj: 0, outros: 0,
    somaMaq: 0, somaPOS: 0, entradaDinheiro: 0, deposito: 0,
    totalSaida: s.valor, faturamento: 0, totalDeclarado: 0, diferenca: 0,
    obsDif: null,
    observacao: s.descricao ? `Sangria: ${s.descricao}` : 'Sangria',
    quebra: 0, tc: 0, cancelados: 0,
  };
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// edicao/exclusao direta - poder do Master de corrigir ou apagar uma
// sangria lançada errado. Como a sangria só existe nessa coleção (o
// fechamento só a enxerga mesclada na leitura, ver comoFechamento), editar
// ou excluir aqui já reflete automaticamente em qualquer lugar que mostra
// o fechamento mesclado - não precisa (nem dá) mexer no fechamento em si
async function atualizar(id, { valor, descricao, data }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Sangria não encontrada.');
  const patch = {};
  if (valor != null && valor !== '') {
    const v = num(valor);
    if (v <= 0) throw new Error('Informe o valor retirado.');
    patch.valor = v;
  }
  if (descricao != null) patch.descricao = String(descricao).slice(0, 300);
  if (data != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
    patch.data = data;
  }
  await ref.update(patch);
  sangriasCache.invalidar();
  return getOne(id);
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Sangria não encontrada.');
  await COLLECTION.doc(id).delete();
  sangriasCache.invalidar();
}

module.exports = { criar, listAll, listByUnidades, comoFechamento, getOne, atualizar, remover };
