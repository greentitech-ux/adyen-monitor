// fechamentosLive.js
// Fechamentos de caixa lançados direto pela loja (substitui o processo manual
// via AppSheet + planilha). Um documento por unidade+data (nao deixa lançar
// duas vezes o mesmo dia sem querer). Depois de lançado, o registro NAO pode
// ser editado direto - qualquer correção passa por um pedido de edição
// (fechamentoEdicoes) que só é aplicado quando o Master aprova; o valor
// anterior sempre fica guardado no historico do proprio fechamento.
const db = require('./firestore');
const { createCache } = require('./liveCache');
const grupos = require('./grupos');

const COLLECTION = db.collection('fechamentosLive');
const EDITS = db.collection('fechamentoEdicoes');


function docId(unidade, data) {
  return `${unidade}__${data}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// dia anterior (string AAAA-MM-DD) - usado so pra achar o fechamento de
// ontem da mesma unidade (ver ajustePosDoDiaAnterior)
function diaAnterior(data) {
  const d = new Date(data + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CAMPOS_NUMERICOS = [
  'caixaInicial', 'caixaFinal', 'delivery', 'carryout', 'pickup', 'loja',
  'adyen', 'ifood', 'food99', 'pix', 'pixCnpj', 'outros', 'totalSaida',
  'faturamento', 'totalDeclarado', 'quebra', 'tc', 'cancelados',
  'entradaDinheiro', 'deposito', 'adyenPos',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// soma um mapa de extras (campo:valor) respeitando o sinal de cada campo
// (soma/subtrai no PROPRIO total, configurado no grupo - ver grupos.js).
// "soDestinoCruzado": usado quando queremos so os campos marcados como
// "tambem no outro total" (ex: TEF Credito é um Canal, mas tambem soma no
// Total Declarado por já ser forma de pagamento validada) - ignora os que
// não tem essa marcação. Campo sem definição no grupo (raro, ex: grupo foi
// editado depois do lançamento) soma normal (sinal soma, sem cruzamento).
function somaMapaComSinal(mapa, defs, { soDestinoCruzado } = {}) {
  const porCampo = new Map((defs || []).map((d) => [d.campo, d]));
  return Object.entries(mapa || {}).reduce((s, [campo, valor]) => {
    const def = porCampo.get(campo);
    if (soDestinoCruzado) {
      if (!def || !def.tambemNoOutroTotal) return s;
    }
    const sinal = def && def.operacao === 'subtrai' ? -1 : 1;
    return s + sinal * num(valor);
  }, 0);
}

// resolve as definições de canaisVendaExtras/formasPagamentoExtras do grupo
// da unidade (sinal soma/subtrai e cruzamento entre os 2 totais, ver
// grupos.js) - usa o grupo REAL da unidade, nao o id que o cliente mandou
async function defsExtrasDaUnidade(unidade) {
  const grupo = await grupos.grupoDaUnidade(unidade);
  return { canais: grupo?.canaisVendaExtras || [], formas: grupo?.formasPagamentoExtras || [] };
}

// loja que vende depois da meia-noite na maquininha: esse valor (adyenPos,
// lançado no dia D) já é contado no Total Declarado de D, mas o PRÓPRIO
// terminal só vai bater esse lote no fechamento de D+1 (é o ciclo dele, não
// o calendário) - sem desconto, D+1 contaria essa venda de novo e sobraria
// caixa. Calculado uma vez, na CRIAÇÃO do fechamento de D+1, a partir do
// adyenPos que D já tinha lançado até então (ver diaAnterior acima); fica
// guardado (não recalculado depois) - se D for corrigido mais tarde, a
// correção de D+1 é manual (mesmo fluxo de qualquer outra correção do app).
async function ajustePosDoDiaAnterior(unidade, data) {
  const ontem = await getOne(docId(unidade, diaAnterior(data)));
  return ontem ? -num(ontem.adyenPos) : 0;
}

// Faturamento = canais de venda; Total Declarado = formas de pagamento
// (maquininhas + iFood + 99Food + Pix + Pix CNPJ + Outros) + dinheiro -
// sempre recalculado a partir dos campos que realmente compoem cada um,
// nunca confiado do que o cliente mandar. Usado tanto no lançamento quanto
// em qualquer correção aprovada depois (senao uma correção que mexe em
// "delivery", por exemplo, deixaria o Faturamento desatualizado). Os campos
// fixos (Delivery/Carryout/... e Adyen/Ifood/...) sao os mesmos pra todo
// mundo; canaisVendaExtras/formasPagamentoExtras (definidos por grupo, ver
// grupos.js) somam POR CIMA desses (respeitando sinal e cruzamento entre os
// 2 totais - ver somaMapaComSinal), nunca substituem.
// "explicitos" (opcional): campos que uma correcao mudou de proposito - se
// for justamente faturamento/totalDeclarado, respeita o valor dado em vez
// de recalcular por cima (escape hatch raro do Master, ver editarDireto)
// "defsExtras" (opcional): {canais, formas} do grupo da unidade (ver
// defsExtrasDaUnidade) - sem isso, extras somam normal (sinal soma, sem
// cruzamento), mesmo comportamento de antes dessa feature.
function recomputarTotais(r, explicitos, defsExtras) {
  const canaisDefs = defsExtras?.canais || [];
  const formasDefs = defsExtras?.formas || [];
  if (!explicitos || !Object.prototype.hasOwnProperty.call(explicitos, 'faturamento')) {
    r.faturamento = +(
      num(r.delivery) + num(r.carryout) + num(r.pickup) + num(r.loja)
      + somaMapaComSinal(r.canaisVendaExtras, canaisDefs)
      + somaMapaComSinal(r.formasPagamentoExtras, formasDefs, { soDestinoCruzado: true })
    ).toFixed(2);
  }
  if (!explicitos || !Object.prototype.hasOwnProperty.call(explicitos, 'totalDeclarado')) {
    r.totalDeclarado = +(
      num(r.adyen) + num(r.adyenPos) + num(r.ajustePosAnterior)
      + num(r.ifood) + num(r.food99) + num(r.pix) + num(r.pixCnpj) + num(r.outros) + num(r.entradaDinheiro)
      + somaMapaComSinal(r.formasPagamentoExtras, formasDefs)
      + somaMapaComSinal(r.canaisVendaExtras, canaisDefs, { soDestinoCruzado: true })
    ).toFixed(2);
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

// campos extras definidos por grupo (ver grupos.js) - campo:valor livre, nao
// tem uma lista fixa igual CAMPOS_NUMERICOS porque cada franquia define os
// proprios (Master monta pela tela de Grupos). Aqui so limita tamanho/tipo,
// quem decide QUAIS campos fazem sentido pra cada unidade e o cadastro do
// grupo, nao esse modulo. Usado pros 3 mapas: kpisExtras, canaisVendaExtras,
// formasPagamentoExtras.
// "tipos" (opcional, so kpisExtras usa): mapa campo->tipo vindo do cadastro
// do grupo (ver tiposKpiDaUnidade) - decide se o valor e forçado pra numero
// (quantidade/moeda/kg, o padrao) ou guardado como texto (texto/arquivo, esse
// ultimo guarda o CAMINHO do arquivo no Storage, nao o numero).
function sanitizarMapaExtras(obj, tipos) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  Object.entries(obj).slice(0, 40).forEach(([campo, valor]) => {
    const chave = String(campo).slice(0, 60);
    if (!chave) return;
    const tipo = tipos && tipos[chave];
    out[chave] = (tipo === 'arquivo' || tipo === 'texto') ? String(valor ?? '').slice(0, 300) : num(valor);
  });
  return out;
}

// resolve campo->tipo dos kpisExtras configurados pro grupo da unidade (ver
// grupos.js) - usa o grupo REAL da unidade, nao o id que o cliente mandou no
// payload, pra nao confiar em um "grupo" desatualizado/errado vindo do form
async function tiposKpiDaUnidade(unidade) {
  const grupo = await grupos.grupoDaUnidade(unidade);
  const out = {};
  (grupo?.kpisExtras || []).forEach((k) => { out[k.campo] = k.tipo || 'quantidade'; });
  return out;
}

async function create({ unidade, unidadeNome, grupo, data, gerente, campos, kpisExtras, canaisVendaExtras, formasPagamentoExtras, observacao, detalhesMaquinas, detalhesMaquinasPos, detalhesSaidas, criadoPorId, criadoPorEmail }) {
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
  // desconto automatico da venda pos-meia-noite que ONTEM ja lançou na
  // Maquininha POS (ver ajustePosDoDiaAnterior) - calculado uma vez aqui, na
  // criação, e guardado (nao e recalculado se ontem for corrigido depois)
  registro.ajustePosAnterior = await ajustePosDoDiaAnterior(unidade, data);
  const tiposKpi = await tiposKpiDaUnidade(unidade);
  registro.kpisExtras = sanitizarMapaExtras(kpisExtras, tiposKpi);
  registro.canaisVendaExtras = sanitizarMapaExtras(canaisVendaExtras);
  registro.formasPagamentoExtras = sanitizarMapaExtras(formasPagamentoExtras);
  recomputarTotais(registro, null, await defsExtrasDaUnidade(unidade));
  registro.observacao = observacao || null;
  registro.detalhesMaquinas = sanitizarItens(detalhesMaquinas);
  registro.detalhesMaquinasPos = sanitizarItens(detalhesMaquinasPos);
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
// que já existe, não substitui. 'maquininhaPos' segue o mesmo esquema, mas
// pro fechamento SEGUINTE (se já existir) o desconto automático não é
// refeito - foi calculado uma vez na criação dele (ver ajustePosAnterior);
// se precisar, o Master corrige o dia seguinte manualmente também.
const TIPOS_ITEM_NOVO = ['maquininha', 'maquininhaPos', 'saida'];

async function solicitarEdicao({ fechamentoId, tipoCorrecao, mudancas, itemNovo, novaData, motivo, anexos, solicitadoPorId, solicitadoPorEmail, direcionadoParaId, direcionadoParaEmail }) {
  const atual = await getOne(fechamentoId);
  if (!atual) throw new Error('Fechamento não encontrado.');
  if (!motivo || !String(motivo).trim()) throw new Error('Descreva o motivo da correção.');

  const pedido = {
    id: null,
    fechamentoId,
    unidade: atual.unidade,
    unidadeNome: atual.unidadeNome,
    data: atual.data,
    tipoCorrecao: ['item', 'excluir', 'data'].includes(tipoCorrecao) ? tipoCorrecao : 'campo',
    mudancas: {},
    itemNovo: null,
    novaData: null,
    motivo: String(motivo).trim(),
    anexos: Array.isArray(anexos) ? anexos : [],
    status: 'PENDENTE',
    solicitadoPorId,
    solicitadoPorEmail,
    // Master/Admin escolhido por quem lançou (opcional, ver grupos.js) - so
    // um "pra quem e mais direto", nao restringe quem mais pode decidir
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    // notificacao (popup com som) fica ativa ate QUALQUER Master/Admin
    // sinalizar que viu - ver marcarNotificacaoVista
    notificacaoVista: false,
    notificacaoVistaPorEmail: null,
    notificacaoVistaEm: null,
    criadoEm: null,
    decididoPorEmail: null,
    decididoEm: null,
    motivoDecisao: null,
  };

  if (pedido.tipoCorrecao === 'item') {
    if (!itemNovo || !TIPOS_ITEM_NOVO.includes(itemNovo.tipo)) throw new Error('Escolha o tipo do item (maquininha, maquininha POS ou saída).');
    const valor = num(itemNovo.valor);
    if (valor <= 0) throw new Error('Informe o valor do item.');
    pedido.itemNovo = { tipo: itemNovo.tipo, descricao: String(itemNovo.descricao || '').slice(0, 200), valor };
  } else if (pedido.tipoCorrecao === 'excluir') {
    // nada mais pra validar - so o motivo, ja exigido acima. A exclusao de
    // fato so acontece se o Master aprovar (ver decidirEdicao); ate la o
    // fechamento continua intacto e visivel normalmente
  } else if (pedido.tipoCorrecao === 'data') {
    // mudar a data efetivamente troca o ID do documento (ver docId), entao
    // precisa validar aqui que a data e valida, diferente da atual e que o
    // destino esta livre (checado de novo na aprovacao, que e quando de
    // fato acontece - pode ter mudado nesse meio tempo)
    if (!novaData || !/^\d{4}-\d{2}-\d{2}$/.test(novaData)) throw new Error('Informe a data correta (AAAA-MM-DD).');
    if (novaData === atual.data) throw new Error('A data correta é igual à data atual do lançamento.');
    const colisao = await COLLECTION.doc(docId(atual.unidade, novaData)).get();
    if (colisao.exists) throw new Error('Já existe um fechamento lançado para essa unidade nessa data.');
    pedido.novaData = novaData;
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
  edicoesCache.invalidar();
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
// valida um patch de mapa livre (campo:valor) - usado pelos 3 "mudancasXxx"
// de editarDireto, mesmo formato de sanitizarMapaExtras mas sem limite de
// quantidade (e so um patch, nao o mapa inteiro)
function sanitizarPatchMapa(obj, tipos) {
  const out = {};
  Object.entries(obj || {}).forEach(([campo, valor]) => {
    const chave = String(campo).slice(0, 60);
    if (!chave) return;
    const tipo = tipos && tipos[chave];
    out[chave] = (tipo === 'arquivo' || tipo === 'texto') ? String(valor ?? '').slice(0, 300) : num(valor);
  });
  return out;
}

async function editarDireto({ fechamentoId, mudancas, mudancasKpis, mudancasCanais, mudancasFormas, motivo, editadoPorEmail }) {
  const atual = await getOne(fechamentoId);
  if (!atual) throw new Error('Fechamento não encontrado.');
  const camposValidos = {};
  Object.entries(mudancas || {}).forEach(([campo, valor]) => {
    if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = num(valor);
    else if (CAMPOS_TEXTO.includes(campo)) camposValidos[campo] = String(valor ?? '').slice(0, 500);
  });
  // kpisExtras/canaisVendaExtras/formasPagamentoExtras sao mapas livres
  // (campos definidos pelo grupo, ver grupos.js) - aqui e um PATCH: so os
  // campos informados mudam, o resto do mapa permanece igual (diferente de
  // mudancas, que sobrescreve campo por campo mas nao apaga os que nao vieram)
  const tiposKpi = await tiposKpiDaUnidade(atual.unidade);
  const kpisValidos = sanitizarPatchMapa(mudancasKpis, tiposKpi);
  const canaisValidos = sanitizarPatchMapa(mudancasCanais);
  const formasValidos = sanitizarPatchMapa(mudancasFormas);
  if (!Object.keys(camposValidos).length && !Object.keys(kpisValidos).length && !Object.keys(canaisValidos).length && !Object.keys(formasValidos).length) {
    throw new Error('Nenhum campo válido para alterar.');
  }

  const valoresAnteriores = {};
  Object.keys(camposValidos).forEach((campo) => { valoresAnteriores[campo] = atual[campo]; });

  const kpisExtrasNovo = Object.keys(kpisValidos).length ? { ...(atual.kpisExtras || {}), ...kpisValidos } : atual.kpisExtras;
  const canaisExtrasNovo = Object.keys(canaisValidos).length ? { ...(atual.canaisVendaExtras || {}), ...canaisValidos } : atual.canaisVendaExtras;
  const formasExtrasNovo = Object.keys(formasValidos).length ? { ...(atual.formasPagamentoExtras || {}), ...formasValidos } : atual.formasPagamentoExtras;

  const merged = { ...atual, ...camposValidos, canaisVendaExtras: canaisExtrasNovo, formasPagamentoExtras: formasExtrasNovo };
  recomputarTotais(merged, camposValidos, await defsExtrasDaUnidade(atual.unidade));
  const novosValores = { ...camposValidos, faturamento: merged.faturamento, totalDeclarado: merged.totalDeclarado, diferenca: merged.diferenca };
  if (Object.keys(kpisValidos).length) novosValores.kpisExtras = kpisExtrasNovo;
  if (Object.keys(canaisValidos).length) novosValores.canaisVendaExtras = canaisExtrasNovo;
  if (Object.keys(formasValidos).length) novosValores.formasPagamentoExtras = formasExtrasNovo;

  const valoresNovosHistorico = { ...camposValidos };
  if (Object.keys(kpisValidos).length) valoresNovosHistorico.kpisExtras = kpisValidos;
  if (Object.keys(canaisValidos).length) valoresNovosHistorico.canaisVendaExtras = canaisValidos;
  if (Object.keys(formasValidos).length) valoresNovosHistorico.formasPagamentoExtras = formasValidos;

  const historico = [...(atual.historico || []), {
    em: new Date().toISOString(),
    por: editadoPorEmail,
    motivo: (motivo && String(motivo).trim()) || '(edição direta do Master)',
    valoresAnteriores,
    valoresNovos: valoresNovosHistorico,
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

// cache de 20s: a fila de edicoes entra em TODA montagem da Central
// (todosCardsCentral em index.js - painel, historico e cada notificacao SSE
// refazem essa leitura) - sem cache era uma releitura completa da colecao
// fechamentoEdicoes por chamada. Toda mutacao da fila invalida.
async function listarEdicoesUncached() {
  const snap = await EDITS.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const edicoesCache = createCache(listarEdicoesUncached, 20 * 1000);
const listarEdicoes = edicoesCache.cached;

async function getEdicao(id) {
  const doc = await EDITS.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function marcarNotificacaoVistaEdicao(id, { vistoPorEmail }) {
  const ref = EDITS.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Pedido não encontrado.');
  await ref.update({ notificacaoVista: true, notificacaoVistaPorEmail: vistoPorEmail, notificacaoVistaEm: new Date().toISOString() });
  edicoesCache.invalidar();
  return getEdicao(id);
}

// exclui so o PEDIDO de ajuste (o registro na fila de solicitacoes) - poder
// do Master de limpar a fila. Se o pedido ja tinha sido aprovado, o
// fechamento em si (ja alterado por decidirEdicao) nao e desfeito; pra
// corrigir o fechamento depois disso o Master usa editarDireto normalmente.
async function removerEdicao(id) {
  await EDITS.doc(id).delete();
  edicoesCache.invalidar();
}

async function decidirEdicao(id, status, { decididoPorEmail, motivoDecisao }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = EDITS.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Pedido não encontrado.');
  const pedido = doc.data();
  if (pedido.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');

  // valida ANTES de marcar como decidido - mudar a data efetivamente troca o
  // ID do documento (ver docId), entao precisa garantir que o destino ainda
  // esta livre (pode ter mudado desde o pedido) antes de comprometer a decisao
  if (status === 'APROVADO' && pedido.tipoCorrecao === 'data') {
    const colisao = await COLLECTION.doc(docId(pedido.unidade, pedido.novaData)).get();
    if (colisao.exists) throw new Error('Já existe um fechamento lançado para essa unidade nessa data.');
  }

  await ref.update({
    status,
    decididoPorEmail,
    motivoDecisao: motivoDecisao || null,
    decididoEm: new Date().toISOString(),
  });
  edicoesCache.invalidar();

  if (status === 'APROVADO') {
    const fechRef = COLLECTION.doc(pedido.fechamentoId);
    const fechDoc = await fechRef.get();
    if (fechDoc.exists) {
      const atual = fechDoc.data();

      if (pedido.tipoCorrecao === 'excluir') {
        await fechRef.delete();
        fechamentosCache.invalidar();
        return { ...pedido, status };
      }

      if (pedido.tipoCorrecao === 'data') {
        const novoId = docId(pedido.unidade, pedido.novaData);
        const historico = [...(atual.historico || []), {
          em: new Date().toISOString(),
          por: decididoPorEmail,
          motivo: pedido.motivo,
          valoresAnteriores: { data: atual.data },
          valoresNovos: { data: pedido.novaData },
        }];
        await COLLECTION.doc(novoId).set({ ...atual, id: novoId, data: pedido.novaData, historico, atualizadoEm: new Date().toISOString() });
        await fechRef.delete();
        fechamentosCache.invalidar();
        return { ...pedido, status };
      }

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
        } else if (tipo === 'maquininhaPos') {
          novosValores = {
            detalhesMaquinasPos: [...(atual.detalhesMaquinasPos || []), { descricao, valor }],
            adyenPos: +(num(atual.adyenPos) + valor).toFixed(2),
          };
          camposMudados = { adyenPos: novosValores.adyenPos };
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
      recomputarTotais(merged, camposMudados, await defsExtrasDaUnidade(atual.unidade));
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


function invalidarCache() {
  fechamentosCache.invalidar();
}

module.exports = { CAMPOS_NUMERICOS, create, listAll, listByUnidades, getOne, solicitarEdicao, listarEdicoes, getEdicao, decidirEdicao, editarDireto, removerEdicao, remove, invalidarCache, marcarNotificacaoVistaEdicao };
