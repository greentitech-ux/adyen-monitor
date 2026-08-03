// refunds.js
// Fila de solicitacoes de estorno. Dois jeitos de entrar nela:
// - origem "interno": um usuario Leitor pede estorno de um pedido Aprovado
//   (com uma observacao explicando o motivo), confirmando com a propria
//   senha (veja auth.verifyPassword, chamado em index.js antes de criar o
//   registro).
// - origem "cliente": o CLIENTE FINAL preenche um formulario publico (sem
//   login, ver estorno-cliente.html) contando os dados da venda (nao tem
//   acesso ao pspReference/pedidoId interno) e anexa o comprovante da
//   maquininha - mesmos campos do Google Forms que a empresa ja usava.
// De qualquer origem, o Master acompanha a mesma fila e Aprova (e executa o
// estorno na Adyen por fora) ou Rejeita (com um motivo).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const refundsRef = db.collection('refundRequests');
const STATUSES = ['PENDENTE', 'APROVADO', 'REJEITADO'];
const ORIGENS = ['interno', 'cliente'];


async function create({
  pedidoId, unidade, unidadeNome, observacao, origem,
  motivoEstorno, motivoOutro, valorVenda, formaPagamento, bandeira, ultimos4,
  dataVenda, horaVenda, valorEstornar, nomeCliente, telefoneCliente, anexos,
  requestedById, requestedByEmail,
}) {
  origem = ORIGENS.includes(origem) ? origem : 'interno';

  if (origem === 'interno') {
    if (!pedidoId) throw new Error('pedidoId é obrigatório.');
    if (!String(observacao || '').trim()) throw new Error('Descreva o motivo do estorno.');
  } else {
    if (!unidade) throw new Error('Selecione a loja onde comprou.');
    if (!motivoEstorno) throw new Error('Selecione o motivo do estorno.');
    if (motivoEstorno === 'Outro' && !String(motivoOutro || '').trim()) throw new Error('Explique o motivo do estorno.');
    if (valorVenda == null || valorVenda === '') throw new Error('Informe o valor total da venda.');
    if (!formaPagamento) throw new Error('Selecione a forma de pagamento.');
    if (!bandeira) throw new Error('Selecione a bandeira do cartão.');
    if (!dataVenda) throw new Error('Informe a data da venda.');
    if (valorEstornar == null || valorEstornar === '') throw new Error('Informe o valor a estornar.');
    if (!Array.isArray(anexos) || !anexos.length) throw new Error('Anexe o comprovante da maquininha.');
  }

  const doc = refundsRef.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    origem,
    pedidoId: pedidoId || null,
    unidade: unidade || null,
    unidadeNome: unidadeNome || unidade || null,
    observacao: String(observacao || '').trim(),
    motivoEstorno: motivoEstorno || null,
    motivoOutro: motivoOutro ? String(motivoOutro).trim() : null,
    valorVenda: valorVenda != null && valorVenda !== '' ? Number(valorVenda) || 0 : null,
    formaPagamento: formaPagamento || null,
    bandeira: bandeira || null,
    ultimos4: ultimos4 ? String(ultimos4).slice(-4) : null,
    dataVenda: dataVenda || null,
    horaVenda: horaVenda || null,
    valorEstornar: valorEstornar != null && valorEstornar !== '' ? Number(valorEstornar) || 0 : null,
    nomeCliente: nomeCliente ? String(nomeCliente).trim().slice(0, 120) : null,
    telefoneCliente: telefoneCliente ? String(telefoneCliente).trim().slice(0, 30) : null,
    anexos: Array.isArray(anexos) ? anexos : [],
    status: 'PENDENTE',
    requestedById: requestedById || null,
    requestedByEmail: requestedByEmail || null,
    motivoDecisao: '',
    decidedByEmail: null,
    criadoEm: agora,
    decidedEm: null,
  };
  await doc.set(registro);
  refundsCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await refundsRef.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const refundsCache = createCache(listAllUncached, 20 * 1000);
const listAll = refundsCache.cached;


async function getOne(id) {
  const doc = await refundsRef.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateStatus(id, status, { motivoDecisao, decidedByEmail }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    status,
    motivoDecisao: motivoDecisao || '',
    decidedByEmail,
    decidedEm: new Date().toISOString(),
  });
  refundsCache.invalidar();
  return getOne(id);
}


module.exports = { STATUSES, create, listAll, getOne, updateStatus };
