// fechamentosLive.js
// Fechamentos de caixa lançados direto pela loja (substitui o processo manual
// via AppSheet + planilha). Um documento por unidade+data (nao deixa lançar
// duas vezes o mesmo dia sem querer). Depois de lançado, o registro NAO pode
// ser editado direto - qualquer correção passa por um pedido de edição
// (fechamentoEdicoes) que só é aplicado quando o Master aprova; o valor
// anterior sempre fica guardado no historico do proprio fechamento.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('fechamentosLive');
const EDITS = db.collection('fechamentoEdicoes');


function docId(unidade, data) {
  return `${unidade}__${data}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

const CAMPOS_NUMERICOS = [
  'caixaInicial', 'caixaFinal', 'delivery', 'carryout', 'pickup', 'loja',
  'adyen', 'ifood', 'food99', 'pix', 'pixCnpj', 'outros', 'totalSaida',
  'faturamento', 'totalDeclarado', 'quebra', 'tc', 'cancelados',
  'entradaDinheiro', 'deposito',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Faturamento = canais de venda; Total Declarado = formas de pagamento
// (maquininhas + iFood + 99Food + Pix + Pix CNPJ + Outros) + dinheiro -
// sempre recalculado a partir dos campos que realmente compoem cada um,
// nunca confiado do que o cliente mandar. Usado tanto no lançamento quanto
// em qualquer correção aprovada depois (senao uma correção que mexe em
// "delivery", por exemplo, deixaria o Faturamento desatualizado)
// "explicitos" (opcional): campos que uma correcao mudou de proposito - se
// for justamente faturamento/totalDeclarado, respeita o valor dado em vez
// de recalcular por cima (escape hatch raro do Master, ver editarDireto)
function recomputarTotais(r, explicitos) {
  if (!explicitos || !Object.prototype.hasOwnProperty.call(explicitos, 'faturamento')) {
    r.faturamento = +(num(r.delivery) + num(r.carryout) + num(r.pickup) + num(r.loja)).toFixed(2);
  }
  if (!explicitos || !Object.prototype.hasOwnProperty.call(explicitos, 'totalDeclarado')) {
    r.totalDeclarado = +(num(r.adyen) + num(r.ifood) + num(r.food99) + num(r.pix) + num(r.pixCnpj) + num(r.outros) + num(r.entradaDinheiro)).toFixed(2);
  }
  r.diferenca = +(r.totalDeclarado - r.faturamento).toFixed(2);
  return r;
}

// itens informativos (maquininhas e saidas de caixa detalhadas) - guardados
// pra dar transparencia/auditoria, mas quem soma pro fechamento e o cliente
// (campos.adyen e campos.totalSaida ja vem com a soma pronta)
function sanitizarItens(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((item) => ({ descricao: String(item?.descricao || '').slice(0, 200), valor: num(item?.valor) }))
    .filter((item) => item.descricao || item.valor);
}

// KPI's extras definidos por grupo (ver grupos.js) - campo:valor livre, nao
// tem uma lista fixa igual CAMPOS_NUMERICOS porque cada franquia define os
// proprios (Master monta pela tela de Grupos). Aqui so limita tamanho/tipo,
// quem decide QUAIS campos fazem sentido pra cada unidade e o cadastro do
// grupo, nao esse modulo.
function sanitizarKpisExtras(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  Object.entries(obj).slice(0, 40).forEach(([campo, valor]) => {
    const chave = String(campo).slice(0, 60);
    if (!chave) return;
    out[chave] = num(valor);
  });
  return out;
}

async function create({ unidade, unidadeNome, grupo, data, gerente, campos, kpisExtras, observacao, detalhesMaquinas, detalhesSaidas, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');

  const id = docId(unidade, data);
  const ref = COLLECTION.doc(id);
  const existente = await ref.get();
  if (existente.exists) {
    throw new Error('Já existe um fechamento lançado para essa unidade nessa data. Peça uma correção em vez de lançar de novo.');
  }

  const registro = { id, unidade, unidadeNome: unidadeNome || unidade, grupo: grupo || 'MANUAL', data, gerente: gerente || '' };
  CAMPOS_NUMERICOS.forEach((c) => { registro[c] = num(campos?.[c]); });
  recomputarTotais(registro);
  registro.kpisExtras = sanitizarKpisExtras(kpisExtras);
  registro.observacao = observacao || null;
  registro.detalhesMaquinas = sanitizarItens(detalhesMaquinas);
  registro.detalhesSaidas = sanitizarItens(detalhesSaidas);

  const agora = new Date().toISOString();
  registro.criadoPorId = criadoPorId;
  registro.criadoPorEmail = criadoPorEmail;
  registro.criadoEm = agora;
  registro.atualizadoEm = agora;
  registro.historico = [];

  await ref.set(registro);
  fechamentosCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const fechamentosCache = createCache(listAllUncached, 20 * 1000);
const listAll = fechamentosCache.cached;


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

// tipo 'campo': corrige o valor de um campo já lançado (mudancas: {campo:valor}).
// tipo 'item': adiciona um item novo que faltou lançar (ex: esqueceu uma
// maquininha, ou uma saída que não passou pela Sangria) - soma em cima do
// que já existe, não substitui
const TIPOS_ITEM_NOVO = ['maquininha', 'saida'];

async function solicitarEdicao({ fechamentoId, tipoCorrecao, mudancas, itemNovo, motivo, anexos, solicitadoPorId, solicitadoPorEmail }) {
  const atual = await getOne(fechamentoId);
  if (!atual) throw new Error('Fechamento não encontrado.');
  if (!motivo || !String(motivo).trim()) throw new Error('Descreva o motivo da correção.');

  const pedido = {
    id: null,
    fechamentoId,
    unidade: atual.unidade,
    unidadeNome: atual.unidadeNome,
    data: atual.data,
    tipoCorrecao: tipoCorrecao === 'item' ? 'item' : 'campo',
    mudancas: {},
    itemNovo: null,
    motivo: String(motivo).trim(),
    anexos: Array.isArray(anexos) ? anexos : [],
    status: 'PENDENTE',
    solicitadoPorId,
    solicitadoPorEmail,
    criadoEm: null,
    decididoPorEmail: null,
    decididoEm: null,
    motivoDecisao: null,
  };

  if (pedido.tipoCorrecao === 'item') {
    if (!itemNovo || !TIPOS_ITEM_NOVO.includes(itemNovo.tipo)) throw new Error('Escolha o tipo do item (maquininha ou saída).');
    const valor = num(itemNovo.valor);
    if (valor <= 0) throw new Error('Informe o valor do item.');
    pedido.itemNovo = { tipo: itemNovo.tipo, descricao: String(itemNovo.descricao || '').slice(0, 200), valor };
  } else {
    const camposValidos = {};
    Object.entries(mudancas || {}).forEach(([campo, valor]) => {
      if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = num(valor);
    });
    if (!Object.keys(camposValidos).length) throw new Error('Nenhum campo válido para corrigir.');
    pedido.mudancas = camposValidos;
  }

  const ref = EDITS.doc();
  const agora = new Date().toISOString();
  pedido.id = ref.id;
  pedido.criadoEm = agora;
  await ref.set(pedido);
  return pedido;
}

// campos de texto (alem dos numericos) que o Master tambem pode corrigir
// direto - unidade/data ficam de fora de proposito (mudar isso e apagar e
// relancar, nao "corrigir")
const CAMPOS_TEXTO = ['gerente', 'observacao'];

// edicao direta: so o Master usa isso (o resto passa por solicitarEdicao +
// decidirEdicao). Como o Master e quem aprovaria a propria solicitacao,
// pedir-e-aprovar pra si mesmo e so atrito - aqui a mudanca e aplicada na
// hora, mas ainda fica registrada no historico do fechamento pra auditoria
async function editarDireto({ fechamentoId, mudancas, mudancasKpis, motivo, editadoPorEmail }) {
  const atual = await getOne(fechamentoId);
  if (!atual) throw new Error('Fechamento não encontrado.');
  const camposValidos = {};
  Object.entries(mudancas || {}).forEach(([campo, valor]) => {
    if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = num(valor);
    else if (CAMPOS_TEXTO.includes(campo)) camposValidos[campo] = String(valor ?? '').slice(0, 500);
  });
  // kpisExtras e um mapa livre (campo definido pelo grupo, ver grupos.js) -
  // aqui e um PATCH: so os campos informados mudam, o resto do mapa
  // permanece igual (diferente de mudancas, que sobrescreve campo por campo
  // mas nao apaga os que nao vieram)
  const kpisValidos = {};
  Object.entries(mudancasKpis || {}).forEach(([campo, valor]) => {
    const chave = String(campo).slice(0, 60);
    if (chave) kpisValidos[chave] = num(valor);
  });
  if (!Object.keys(camposValidos).length && !Object.keys(kpisValidos).length) {
    throw new Error('Nenhum campo válido para alterar.');
  }

  const valoresAnteriores = {};
  Object.keys(camposValidos).forEach((campo) => { valoresAnteriores[campo] = atual[campo]; });
  const merged = { ...atual, ...camposValidos };
  recomputarTotais(merged, camposValidos);
  const novosValores = { ...camposValidos, faturamento: merged.faturamento, totalDeclarado: merged.totalDeclarado, diferenca: merged.diferenca };

  let kpisExtrasNovo = atual.kpisExtras || {};
  if (Object.keys(kpisValidos).length) {
    kpisExtrasNovo = { ...kpisExtrasNovo, ...kpisValidos };
    novosValores.kpisExtras = kpisExtrasNovo;
  }

  const historico = [...(atual.historico || []), {
    em: new Date().toISOString(),
    por: editadoPorEmail,
    motivo: (motivo && String(motivo).trim()) || '(edição direta do Master)',
    valoresAnteriores,
    valoresNovos: Object.keys(kpisValidos).length ? { ...camposValidos, kpisExtras: kpisValidos } : camposValidos,
  }];

  const ref = COLLECTION.doc(fechamentoId);
  await ref.update({ ...novosValores, historico, atualizadoEm: new Date().toISOString() });
  fechamentosCache.invalidar();
  return { ...atual, ...novosValores, historico };
}


// exclui o fechamento lançado de vez - poder do Master, mesma logica de
// editarDireto (aplicado na hora, sem passar por fila de aprovacao)
async function remove(id) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Fechamento não encontrado.');
  await COLLECTION.doc(id).delete();
  fechamentosCache.invalidar();
}

async function listarEdicoes() {
  const snap = await EDITS.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}

async function getEdicao(id) {
  const doc = await EDITS.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// exclui so o PEDIDO de ajuste (o registro na fila de solicitacoes) - poder
// do Master de limpar a fila. Se o pedido ja tinha sido aprovado, o
// fechamento em si (ja alterado por decidirEdicao) nao e desfeito; pra
// corrigir o fechamento depois disso o Master usa editarDireto normalmente.
async function removerEdicao(id) {
  await EDITS.doc(id).delete();
}

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

  if (status === 'APROVADO') {
    const fechRef = COLLECTION.doc(pedido.fechamentoId);
    const fechDoc = await fechRef.get();
    if (fechDoc.exists) {
      const atual = fechDoc.data();
      let camposMudados; // pra saber o que recalcular/registrar no historico
      let novosValores;

      if (pedido.tipoCorrecao === 'item') {
        const { tipo, descricao, valor } = pedido.itemNovo;
        if (tipo === 'maquininha') {
          novosValores = {
            detalhesMaquinas: [...(atual.detalhesMaquinas || []), { descricao, valor }],
            adyen: +(num(atual.adyen) + valor).toFixed(2),
          };
          camposMudados = { adyen: novosValores.adyen };
        } else {
          novosValores = {
            detalhesSaidas: [...(atual.detalhesSaidas || []), { descricao, valor }],
            totalSaida: +(num(atual.totalSaida) + valor).toFixed(2),
          };
          camposMudados = { totalSaida: novosValores.totalSaida };
        }
      } else {
        novosValores = { ...pedido.mudancas };
        camposMudados = pedido.mudancas;
      }

      const valoresAnteriores = {};
      Object.keys(camposMudados).forEach((campo) => { valoresAnteriores[campo] = atual[campo]; });
      const merged = { ...atual, ...novosValores };
      recomputarTotais(merged, camposMudados);
      novosValores.faturamento = merged.faturamento;
      novosValores.totalDeclarado = merged.totalDeclarado;
      novosValores.diferenca = merged.diferenca;

      const historico = [...(atual.historico || []), {
        em: new Date().toISOString(),
        por: decididoPorEmail,
        motivo: pedido.motivo,
        valoresAnteriores,
        valoresNovos: pedido.tipoCorrecao === 'item' ? { itemNovo: pedido.itemNovo } : pedido.mudancas,
      }];
      await fechRef.update({ ...novosValores, historico, atualizadoEm: new Date().toISOString() });
      fechamentosCache.invalidar();
    }
  }
  return { ...pedido, status };
}


module.exports = { CAMPOS_NUMERICOS, create, listAll, listByUnidades, getOne, solicitarEdicao, listarEdicoes, getEdicao, decidirEdicao, editarDireto, removerEdicao, remove };
