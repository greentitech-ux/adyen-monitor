// alertReport.js
// Relatorio do painel "Alertas de falha/fraude" do Monitor (recusas
// repetidas, tentativa Amex recusada, fraude suspeita nativa da Adyen, fim
// de periodo de disputa) - mesma logica de deteccao/agrupamento por cliente
// do renderAlerts()/renderAlertsAgrupados() em index.html, pra gerar
// CSV/PDF do mesmo jeito que o Relatorio de Fraude (fraudReport.js).
const PDFDocument = require('pdfkit');

function slugify(text) {
  return String(text || 'relatorio-alertas')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'relatorio-alertas';
}

// sem isso, toLocaleString usa o fuso do SO do servidor (UTC no Render), nao
// o horario de Brasilia - os horarios no relatorio ficavam 3h adiantados
const FUSO_BR = 'America/Sao_Paulo';

function fmtData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { timeZone: FUSO_BR }) + ' ' + d.toLocaleTimeString('pt-BR', { timeZone: FUSO_BR, hour: '2-digit', minute: '2-digit' });
}

function fmtMoney(v) {
  return 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizarNome(nome) {
  return String(nome || '').trim().toLowerCase();
}

// mesmas 4 regras do renderAlerts() em index.html
function construirAlertas(transacoes) {
  const alerts = [];
  const recusadas = transacoes.filter((d) => d.status === 'RECUSADO');
  const byClient = {};
  recusadas.forEach((d) => {
    const k = d.shopperReference || `${d.cardHolder || 'desconhecido'}::${d.last4 || '----'}`;
    (byClient[k] ||= []).push(d);
  });
  Object.values(byClient).forEach((list) => {
    if (list.length >= 2) {
      list.forEach((d) => alerts.push({ tipo: 'Tentativas repetidas recusadas', nome: d.cardHolder || d.nomeCliente || 'cliente', unidade: d.unidade, valor: d.valor, dt: d.dataHora }));
    }
  });
  recusadas.filter((d) => d.metodo === 'amex').forEach((d) => alerts.push({ tipo: 'Tentativa de venda Amex recusada', nome: d.cardHolder || d.nomeCliente || 'cliente', unidade: d.unidade, valor: d.valor, dt: d.dataHora }));
  transacoes.filter((d) => d.fraudeSuspeita && !(d.status || '').includes('CHARGEBACK')).forEach((d) => alerts.push({ tipo: 'Fraude suspeita (Adyen)', nome: d.cardHolder || d.nomeCliente || 'cliente', unidade: d.unidade, valor: d.valor, dt: d.dataHora }));
  transacoes.filter((d) => d.status === 'DISPUTE_DEFENSE_PERIOD_ENDED').forEach((d) => alerts.push({ tipo: 'Período de disputa encerrado', nome: d.cardHolder || d.nomeCliente || 'cliente', unidade: d.unidade, valor: d.valor, dt: d.dataHora }));
  return alerts;
}

// agrupa os alertas por cliente (mesmo nome) - cada linha do relatorio e um
// cliente, com os tipos de alerta que ele gerou e a contagem total
function agruparPorCliente(alerts) {
  const grupos = new Map();
  alerts.forEach((a) => {
    const chave = normalizarNome(a.nome) || 'desconhecido';
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(a);
  });
  return [...grupos.values()].map((lista) => {
    const ordenada = [...lista].sort((a, b) => (a.dt || '').localeCompare(b.dt || ''));
    const primeira = ordenada[0];
    const ultima = ordenada[ordenada.length - 1];
    const tipos = [...new Set(lista.map((a) => a.tipo))];
    const unidades = [...new Set(lista.map((a) => a.unidade).filter(Boolean))];
    return {
      cliente: primeira.nome || '(sem nome)',
      unidades: unidades.join(', '),
      tiposAlerta: tipos.join(' · '),
      quantidade: lista.length,
      valorTotal: lista.reduce((s, a) => s + (a.valor || 0), 0),
      primeiro: primeira.dt,
      ultimo: ultima.dt,
    };
  }).sort((a, b) => (b.ultimo || '').localeCompare(a.ultimo || ''));
}

const COLUNAS = [
  { key: 'cliente', label: 'Cliente' },
  { key: 'unidades', label: 'Unidade(s)' },
  { key: 'tiposAlerta', label: 'Tipo(s) de alerta' },
  { key: 'quantidade', label: 'Qtd. alertas' },
  { key: 'valorTotal', label: 'Valor envolvido' },
  { key: 'primeiro', label: 'Primeiro alerta' },
  { key: 'ultimo', label: 'Último alerta' },
];

function formatarCelula(key, valor) {
  if (key === 'valorTotal') return fmtMoney(valor);
  if (key === 'primeiro' || key === 'ultimo') return fmtData(valor);
  return valor;
}

function toCSV(linhas) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [COLUNAS.map((c) => escape(c.label)).join(',')];
  linhas.forEach((l) => out.push(COLUNAS.map((c) => escape(formatarCelula(c.key, l[c.key]))).join(',')));
  return '﻿' + out.join('\r\n');
}

const LARGURAS = { cliente: 110, unidades: 100, tiposAlerta: 220, quantidade: 65, valorTotal: 85, primeiro: 85, ultimo: 85 };

function writePDF(res, { titulo, subtitulo, linhas, nomeArquivo }) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(nomeArquivo || titulo)}.pdf"`);
  doc.pipe(res);

  const tableX = doc.page.margins.left;
  const tableWidth = COLUNAS.reduce((s, c) => s + LARGURAS[c.key], 0);

  const totalClientes = linhas.length;
  const totalAlertas = linhas.reduce((s, l) => s + l.quantidade, 0);
  const valorTotal = linhas.reduce((s, l) => s + l.valorTotal, 0);

  function cabecalhoPagina() {
    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ZENITH OPS · RELATÓRIO DE ALERTAS', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo, tableX, 64);
  }

  function resumo(y) {
    const itens = [
      [String(totalClientes), 'clientes com alerta'],
      [String(totalAlertas), 'alertas no total'],
      [fmtMoney(valorTotal), 'valor envolvido'],
    ];
    let x = tableX;
    itens.forEach(([val, lbl]) => {
      doc.fontSize(16).fillColor('#111').text(val, x, y);
      doc.fontSize(8).fillColor('#666').text(lbl.toUpperCase(), x, y + 20, { width: 160, characterSpacing: 0.5 });
      x += 165;
    });
    return y + 46;
  }

  function linhaCabecalhoTabela(y) {
    doc.rect(tableX, y, tableWidth, 20).fill('#eef1f4');
    doc.fillColor('#333').fontSize(8);
    let x = tableX;
    for (const c of COLUNAS) {
      doc.text(c.label.toUpperCase(), x + 4, y + 6, { width: LARGURAS[c.key] - 8 });
      x += LARGURAS[c.key];
    }
    return y + 20;
  }

  cabecalhoPagina();
  let y = resumo(90);
  y = linhaCabecalhoTabela(y);

  if (!linhas.length) {
    doc.fontSize(10).fillColor('#888').text('Nenhum alerta encontrado nesse período.', tableX, y + 12);
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
    for (const c of COLUNAS) {
      const valor = formatarCelula(c.key, linha[c.key]);
      doc.text(String(valor ?? ''), x + 4, y + 5, { width: LARGURAS[c.key] - 8, height: alturaLinha - 4, ellipsis: true });
      x += LARGURAS[c.key];
    }
    doc.moveTo(tableX, y + alturaLinha).lineTo(tableX + tableWidth, y + alturaLinha).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += alturaLinha;
  }

  doc.end();
}

module.exports = { slugify, construirAlertas, agruparPorCliente, toCSV, writePDF };
