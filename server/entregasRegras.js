// entregasRegras.js
// Regra de pagamento por unidade do app de Entregas (motoboys) - definida
// pelo Master em /entregas-regras.html. Duas formas de uma unidade operar:
//
//   - modo "fixo": a unidade tem valores próprios de R$ por Entrega, Retorno,
//     Fora de Área e Encosta/Ajuda de Custo, além de quanto a Cooperativa
//     recebe por Entrega. O lançamento da loja manda só as CONTAGENS
//     (entrega/retorno/extra/foraDeArea) e o servidor calcula o valor a
//     pagar, a ajuda de custo e o repasse da COOP (ver calcular() abaixo) -
//     nunca confia em valor de dinheiro vindo do cliente pra unidade "fixo".
//   - modo "plataforma": a unidade não tem valor fixo - o pagamento é o que
//     uma plataforma externa (GAMI, NEXT, etc.) informar naquele dia, então
//     a loja continua digitando o valor à mão (como sempre foi).
//
// Sem regra cadastrada, a unidade fica em "plataforma" por padrão (não muda
// o comportamento atual até o Master configurar).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('entregasRegras');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function defaultRegra(unidade) {
  return {
    unidade,
    modo: 'plataforma',
    plataformaNome: '',
    valorEntrega: 0,
    valorRetorno: 0,
    valorFA: 0,
    valorEncosta: 0,
    valorCooperativa: 0,
    atualizadoEm: null,
    atualizadoPorEmail: null,
  };
}

async function listAllUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const regrasCache = createCache(listAllUncached, 20 * 1000);
const listAll = regrasCache.cached;

async function getPara(unidade) {
  const doc = await COLLECTION.doc(unidade).get();
  return doc.exists ? doc.data() : defaultRegra(unidade);
}

async function salvar(unidade, campos, atualizadoPorEmail) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const modo = campos?.modo === 'fixo' ? 'fixo' : 'plataforma';
  const registro = {
    unidade,
    modo,
    plataformaNome: String(campos?.plataformaNome || '').trim().slice(0, 40),
    valorEntrega: num(campos?.valorEntrega),
    valorRetorno: num(campos?.valorRetorno),
    valorFA: num(campos?.valorFA),
    valorEncosta: num(campos?.valorEncosta),
    valorCooperativa: num(campos?.valorCooperativa),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail,
  };
  await COLLECTION.doc(unidade).set(registro);
  regrasCache.invalidar();
  return registro;
}

// motivos aceitos pra remover a Encosta/Ajuda de Custo de um lançamento -
// ex: entregador atrasou, saiu antes do fim do turno, gerou algum prejuízo
const MOTIVOS_REMOCAO_ENCOSTA = ['atraso', 'saiu_antes', 'prejuizo', 'outro'];

// calcula os valores de um lançamento a partir das contagens digitadas pela
// loja + a regra "fixo" da unidade. Só chamada quando regra.modo === 'fixo' -
// no modo "plataforma" os valores continuam vindo direto do formulário.
//
// Extra paga a mesma taxa da Entrega (mesmo entregador, mesma corrida).
// A Cooperativa só recebe sobre a soma de ENTREGAS - de propósito NÃO soma
// extra/retorno/fora de área, senão uma única corrida contaria como vários
// recebimentos pra COOP.
function calcular(regra, { entrega, retorno, extra, foraDeArea, encostaRemovida }) {
  const entregaCount = num(entrega);
  const retornoCount = num(retorno);
  const extraCount = num(extra);
  const foraDeAreaCount = num(foraDeArea);

  const ajudaCusto = encostaRemovida ? 0 : num(regra.valorEncosta);
  const valor = (entregaCount + extraCount) * num(regra.valorEntrega)
    + retornoCount * num(regra.valorRetorno)
    + foraDeAreaCount * num(regra.valorFA)
    + ajudaCusto;
  const coopRecebe = entregaCount * num(regra.valorCooperativa);

  return {
    ajudaCusto: +ajudaCusto.toFixed(2),
    valor: +valor.toFixed(2),
    coopRecebe: +coopRecebe.toFixed(2),
  };
}

module.exports = { listAll, getPara, salvar, calcular, defaultRegra, MOTIVOS_REMOCAO_ENCOSTA };
