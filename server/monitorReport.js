// monitorReport.js
// Relatorios (CSV/PDF) dos paineis do Monitor de transacoes (Transacoes,
// Pedidos repetidos, Chargeback, Pedidos que mudaram de status, Comparativo
// por unidade) - mesmo padrao visual/estrutural de fraudReport.js,
// alertReport.js e fechamentosReport.js, mas genérico o bastante pra servir
// os 5 formatos de tabela diferentes (colunas/larguras definidas por quem
// chama, ver as funcoes prepararXxx abaixo).
const PDFDocument = require('pdfkit');

const FUSO_BR = 'America/Sao_Paulo';

function slugify(text) {
  return String(text || 'relatorio')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'relatorio';
}

// nome de arquivo identificavel: pedido explicito do usuario pra nao ter
// varios "relatorio-transacoes.csv" genericos sem saber de qual loja e -
// inclui a(s) unidade(s) filtrada(s) (codigo/nome/iniciais); sem filtro,
// cai pra "todas-unidades"
function nomeArquivoComUnidades(base, unidades) {
  const lista = (unidades || []).filter(Boolean);
  if (!lista.length) return slugify(`${base}-todas-unidades`);
  if (lista.length <= 3) return slugify(`${base}-${lista.join('-')}`);
  return slugify(`${base}-${lista.length}-unidades`);
}

function fmtDT(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: FUSO_BR }) + ' ' + d.toLocaleTimeString('pt-BR', { timeZone: FUSO_BR, hour: '2-digit', minute: '2-digit' });
}

function fmtMoney(v) {
  return 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function agoraBrasiliaFmt() {
  return new Date().toLocaleString('pt-BR', { timeZone: FUSO_BR });
}

function toCSV(colunas, linhas) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [colunas.map((c) => escape(c.label)).join(',')];
  linhas.forEach((l) => out.push(colunas.map((c) => escape(l[c.key] ?? '')).join(',')));
  // BOM no inicio - sem isso o Excel/Sheets as vezes le acentos errado num CSV UTF-8
  return '﻿' + out.join('\r\n');
}

function writePDF(res, { titulo, subtitulo, colunas, linhas, nomeArquivo, resumo }) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.pdf"`);
  doc.pipe(res);

  const tableX = doc.page.margins.left;
  const tableWidth = colunas.reduce((s, c) => s + c.largura, 0);

  function cabecalhoPagina() {
    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ZENITH OPS · RELATÓRIO DE MONITORAMENTO', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo, tableX, 64);
  }

  function blocoResumo(y) {
    if (!resumo || !resumo.length) return y;
    let x = tableX;
    resumo.forEach(([val, lbl]) => {
      doc.fontSize(16).fillColor('#111').text(String(val), x, y);
      doc.fontSize(8).fillColor('#666').text(lbl.toUpperCase(), x, y + 20, { width: 160, characterSpacing: 0.5 });
      x += 165;
    });
    return y + 46;
  }

  function linhaCabecalhoTabela(y) {
    doc.rect(tableX, y, tableWidth, 20).fill('#eef1f4');
    doc.fillColor('#333').fontSize(8);
    let x = tableX;
    for (const c of colunas) {
      doc.text(c.label.toUpperCase(), x + 4, y + 6, { width: c.largura - 8 });
      x += c.largura;
    }
    return y + 20;
  }

  cabecalhoPagina();
  let y = blocoResumo(90);
  y = linhaCabecalhoTabela(y);

  if (!linhas.length) {
    doc.fontSize(10).fillColor('#888').text('Nenhum registro encontrado nesse período.', tableX, y + 12);
  }

  doc.fontSize(8).fillColor('#222');
  const alturaLinha = 18;
  for (const linha of linhas) {
    if (y + alturaLinha > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = linhaCabecalhoTabela(doc.page.margins.top);
      doc.fontSize(8).fillColor('#222');
    }
    let x = tableX;
    for (const c of colunas) {
      doc.text(String(linha[c.key] ?? ''), x + 4, y + 5, { width: c.largura - 8, height: alturaLinha - 4, ellipsis: true });
      x += c.largura;
    }
    doc.moveTo(tableX, y + alturaLinha).lineTo(tableX + tableWidth, y + alturaLinha).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += alturaLinha;
  }

  doc.end();
}

// ---------- identidade/fraude (replica a logica do index.html pra ficar
// consistente com o que aparece na tela - ver capearIdentidadesEmMassa e
// fraudeInfoDoPedido no front) ----------
function orderKey(t) {
  return t.merchantReference || t.originalReference || t.pspReference;
}
function chaveClienteIdentificavel(d) {
  if (d.last4) return `cartao:${d.last4}:${d.cardHolder || d.nomeCliente || ''}`;
  if (d.cardHolder) return `nome:${d.cardHolder}`;
  if (d.nomeCliente) return `nome:${d.nomeCliente}`;
  return null;
}
function identidadeFraudeDoPedido(d) {
  const nome = (d.nomeCliente || d.cardHolder || '').trim().toLowerCase();
  return nome || null;
}

// remove os pedidos ja marcados como FRAUDE (direto ou herdado pelo mesmo
// cliente) e, das identidades que passarem de 4 tentativas no periodo, so
// mantem as 2 mais recentes - mesma protecao de KPI aplicada na tela
function semFraudeECapeado(rows, marcasAtivas) {
  const porPedido = {};
  const chavesClienteFraude = new Set();
  marcasAtivas.forEach((m) => {
    porPedido[m.pedidoId] = m;
    if (m.nivel === 'FRAUDE' && m.clienteChave) chavesClienteFraude.add(m.clienteChave);
  });
  const semFraude = rows.filter((t) => {
    const direto = porPedido[orderKey(t)];
    if (direto && direto.nivel === 'FRAUDE') return false;
    const chave = chaveClienteIdentificavel(t);
    if (chave && chavesClienteFraude.has(chave)) return false;
    return true;
  });

  const porIdentidade = new Map();
  semFraude.forEach((d) => {
    const idKey = identidadeFraudeDoPedido(d);
    if (!idKey) return;
    (porIdentidade.get(idKey) || porIdentidade.set(idKey, []).get(idKey)).push(d);
  });
  const excluidos = new Set();
  porIdentidade.forEach((grupo) => {
    if (grupo.length <= 4) return;
    const ordenado = [...grupo].sort((a, b) => (b.dataHora || '').localeCompare(a.dataHora || ''));
    ordenado.slice(2).forEach((d) => excluidos.add(orderKey(d)));
  });
  return excluidos.size ? semFraude.filter((d) => !excluidos.has(orderKey(d))) : semFraude;
}

// ---------- deteccao de pedidos repetidos (mesmo algoritmo do front) ----------
const JANELA_REPETIDOS_MS = 30 * 60 * 1000;
const LIMIAR_REPETIDOS = 2;
function detectarPedidosRepetidos(rows) {
  const aprovadas = rows.filter((d) => d.status === 'APROVADO').slice().sort((a, b) => (a.dataHora || '').localeCompare(b.dataHora || ''));
  const byClient = {};
  aprovadas.forEach((d) => {
    const k = chaveClienteIdentificavel(d);
    if (!k) return;
    (byClient[k] = byClient[k] || []).push(d);
  });
  const grupos = [];
  Object.values(byClient).forEach((list) => {
    let cluster = [];
    list.forEach((d) => {
      const t = new Date(d.dataHora).getTime();
      const ultimo = cluster[cluster.length - 1];
      if (ultimo && t - new Date(ultimo.dataHora).getTime() > JANELA_REPETIDOS_MS) {
        if (cluster.length >= LIMIAR_REPETIDOS) grupos.push(cluster);
        cluster = [];
      }
      cluster.push(d);
    });
    if (cluster.length >= LIMIAR_REPETIDOS) grupos.push(cluster);
  });
  return grupos;
}

// ---------- preparo de colunas/linhas por tipo de relatorio ----------
function prepararTransacoes(txs) {
  const colunas = [
    { key: 'dataHora', label: 'Data/Hora', largura: 78 },
    { key: 'unidade', label: 'Unidade', largura: 48 },
    { key: 'nomeCliente', label: 'Nome do Cliente', largura: 95 },
    { key: 'status', label: 'Status', largura: 70 },
    { key: 'cardHolder', label: 'Nome no Cartão', largura: 85 },
    { key: 'metodo', label: 'Método', largura: 48 },
    { key: 'valor', label: 'Valor', largura: 65 },
    { key: 'last4', label: 'Final Cartão', largura: 60 },
    { key: 'bancoEmissor', label: 'Banco', largura: 75 },
    { key: 'motivo', label: 'Observação', largura: 110 },
  ];
  const linhas = [...txs].sort((a, b) => (b.dataHora || '').localeCompare(a.dataHora || '')).map((t) => ({
    dataHora: fmtDT(t.dataHora),
    unidade: t.unidade || '—',
    nomeCliente: t.nomeCliente || '—',
    status: t.status || '—',
    cardHolder: t.cardHolder || '—',
    metodo: t.metodo || '—',
    valor: fmtMoney(t.valor),
    last4: t.last4 ? '•• ' + t.last4 : '—',
    bancoEmissor: t.bancoEmissor || '—',
    motivo: (t.status !== 'APROVADO' && t.motivo) ? t.motivo : '—',
  }));
  return { colunas, linhas };
}

function prepararRepetidos(txs) {
  const colunas = [
    { key: 'cliente', label: 'Cliente', largura: 140 },
    { key: 'unidade', label: 'Unidade', largura: 70 },
    { key: 'quantidade', label: 'Qtd. pedidos', largura: 70 },
    { key: 'valorTotal', label: 'Valor total', largura: 80 },
    { key: 'primeira', label: 'Primeira tentativa', largura: 100 },
    { key: 'ultima', label: 'Última tentativa', largura: 100 },
    { key: 'minutos', label: 'Janela (min)', largura: 70 },
  ];
  const grupos = detectarPedidosRepetidos(txs);
  const linhas = grupos.map((grupo) => {
    const ordenado = [...grupo].sort((a, b) => (a.dataHora || '').localeCompare(b.dataHora || ''));
    const primeira = ordenado[0], ultima = ordenado[ordenado.length - 1];
    const minutos = Math.round((new Date(ultima.dataHora) - new Date(primeira.dataHora)) / 60000);
    return {
      cliente: ultima.cardHolder || ultima.nomeCliente || 'cliente desconhecido',
      unidade: ultima.unidade || '—',
      quantidade: grupo.length,
      valorTotal: fmtMoney(grupo.reduce((s, d) => s + (d.valor || 0), 0)),
      primeira: fmtDT(primeira.dataHora),
      ultima: fmtDT(ultima.dataHora),
      minutos,
    };
  }).sort((a, b) => b.quantidade - a.quantidade);
  return { colunas, linhas };
}

function prepararChargebacks(orders) {
  const colunas = [
    { key: 'pedidoId', label: 'Pedido', largura: 90 },
    { key: 'unidade', label: 'Unidade', largura: 60 },
    { key: 'cliente', label: 'Cliente', largura: 120 },
    { key: 'valor', label: 'Valor', largura: 65 },
    { key: 'last4', label: 'Final Cartão', largura: 65 },
    { key: 'dataCompra', label: 'Data compra', largura: 90 },
    { key: 'dataChargeback', label: 'Data chargeback', largura: 95 },
    { key: 'prazoDefesa', label: 'Prazo defesa', largura: 90 },
    { key: 'statusAtual', label: 'Status atual', largura: 90 },
  ];
  const linhas = [...orders].sort((a, b) => (b.ultimaAtualizacao || '').localeCompare(a.ultimaAtualizacao || '')).map((o) => ({
    pedidoId: o.pedidoId,
    unidade: o.unidade || '—',
    cliente: o.cliente || 'cliente desconhecido',
    valor: fmtMoney(o.valor),
    last4: o.last4 ? '•• ' + o.last4 : '—',
    dataCompra: fmtDT(o.dataCompra),
    dataChargeback: fmtDT(o.dataChargeback),
    prazoDefesa: o.prazoDefesa ? fmtDT(o.prazoDefesa) : '—',
    statusAtual: o.statusAtual || '—',
  }));
  return { colunas, linhas };
}

function prepararMudaramStatus(orders) {
  const colunas = [
    { key: 'pedidoId', label: 'Pedido', largura: 90 },
    { key: 'unidade', label: 'Unidade', largura: 60 },
    { key: 'cliente', label: 'Cliente', largura: 120 },
    { key: 'valor', label: 'Valor', largura: 65 },
    { key: 'statusAtual', label: 'Status atual', largura: 85 },
    { key: 'historico', label: 'Histórico de status', largura: 250 },
    { key: 'ultimaAtualizacao', label: 'Última atualização', largura: 95 },
  ];
  const linhas = [...orders].sort((a, b) => (b.ultimaAtualizacao || '').localeCompare(a.ultimaAtualizacao || '')).map((o) => ({
    pedidoId: o.pedidoId,
    unidade: o.unidade || '—',
    cliente: o.cliente || 'cliente desconhecido',
    valor: fmtMoney(o.valor),
    statusAtual: o.statusAtual || '—',
    historico: (o.history || []).map((h) => `${h.status} (${fmtDT(h.dataHora)})`).join(' → '),
    ultimaAtualizacao: fmtDT(o.ultimaAtualizacao),
  }));
  return { colunas, linhas };
}

function prepararComparativoUnidade(txs) {
  const colunas = [
    { key: 'unidade', label: 'Unidade', largura: 90 },
    { key: 'total', label: 'Transações', largura: 90 },
    { key: 'taxa', label: 'Taxa aprov.', largura: 90 },
    { key: 'volumeAprovado', label: 'Volume aprovado', largura: 110 },
    { key: 'recusadas', label: 'Recusadas', largura: 90 },
    { key: 'estornos', label: 'Estornos', largura: 90 },
    { key: 'fraudes', label: 'Fraudes', largura: 90 },
    { key: 'chargebacks', label: 'Chargebacks', largura: 115 },
  ];
  const porUnidade = {};
  txs.forEach((t) => {
    const u = t.unidade || '—';
    const c = (porUnidade[u] = porUnidade[u] || { total: 0, aprovadas: 0, recusadas: 0, estornos: 0, fraudes: 0, chargebacks: 0, volumeAprovado: 0 });
    c.total++;
    if (t.status === 'APROVADO') { c.aprovadas++; c.volumeAprovado += t.valor || 0; }
    if (t.status === 'RECUSADO') c.recusadas++;
    if (t.status === 'ESTORNADO') c.estornos++;
    if (t.fraudeSuspeita) c.fraudes++;
    if ((t.status || '').includes('CHARGEBACK')) c.chargebacks++;
  });
  const linhas = Object.entries(porUnidade).sort((a, b) => b[1].total - a[1].total).map(([u, c]) => ({
    unidade: u,
    total: c.total,
    taxa: (c.total ? (c.aprovadas / c.total * 100) : 0).toFixed(1) + '%',
    volumeAprovado: fmtMoney(c.volumeAprovado),
    recusadas: c.recusadas,
    estornos: c.estornos,
    fraudes: c.fraudes,
    chargebacks: c.chargebacks,
  }));
  return { colunas, linhas };
}

module.exports = {
  FUSO_BR,
  slugify,
  nomeArquivoComUnidades,
  fmtDT,
  fmtMoney,
  agoraBrasiliaFmt,
  toCSV,
  writePDF,
  semFraudeECapeado,
  prepararTransacoes,
  prepararRepetidos,
  prepararChargebacks,
  prepararMudaramStatus,
  prepararComparativoUnidade,
};
