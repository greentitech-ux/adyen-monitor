// fraudReport.js
// Relatorio de fraude, pra apresentar pra diretoria/CEO depois de um surto
// de tentativas: agrupa o historico de marcacoes (fraudMarks.listHistorico,
// que inclui as ja removidas) por cliente e resume quantidade de tentativas,
// se algum pedido passou (foi aprovado) e qual acao foi tomada.
const PDFDocument = require('pdfkit');

function slugify(text) {
  return String(text || 'relatorio-fraude')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'relatorio-fraude';
}

function fmtData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtMoney(v) {
  return 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const AUTOR_DETECCAO_AUTOMATICA = 'deteccao-automatica@sistema';

// agrupa o historico de marcas por cliente (mesmo nome) e monta uma linha de
// resumo por incidente - cada "incidente" e todo o conjunto de tentativas
// daquele cliente dentro do periodo pedido
function agruparPorCliente(historico) {
  const grupos = new Map();
  historico.forEach((m) => {
    const chave = (m.clienteNome || '').trim().toLowerCase() || ('pedido:' + m.pedidoId);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(m);
  });
  return [...grupos.values()].map((marcas) => {
    const ordenadas = [...marcas].sort((a, b) => (a.criadoEm || '').localeCompare(b.criadoEm || ''));
    const primeira = ordenadas[0];
    const ultima = ordenadas[ordenadas.length - 1];
    const aprovados = marcas.filter((m) => m.statusPedido === 'APROVADO');
    const ativos = marcas.filter((m) => !m.removido);
    const removidos = marcas.filter((m) => m.removido);
    const unidades = [...new Set(marcas.map((m) => m.unidade).filter(Boolean))];
    const todasAutomaticas = marcas.every((m) => m.criadoPorEmail === AUTOR_DETECCAO_AUTOMATICA);
    const acao = !ativos.length
      ? 'Todas as marcações removidas (falso positivo)'
      : todasAutomaticas
      ? 'Detecção automática (troca de cartão / cliente já conhecido)'
      : 'Marcado manualmente pelo time';
    return {
      cliente: primeira.clienteNome || '(sem nome)',
      unidades: unidades.join(', '),
      tentativas: marcas.length,
      primeira: primeira.criadoEm,
      ultima: ultima.criadoEm,
      pedidoAprovado: aprovados.length ? 'SIM' : 'NÃO',
      valorAprovado: aprovados.reduce((s, m) => s + (m.valor || 0), 0),
      ativos: ativos.length,
      removidos: removidos.length,
      acao,
    };
  }).sort((a, b) => (b.ultima || '').localeCompare(a.ultima || ''));
}

const COLUNAS = [
  { key: 'cliente', label: 'Cliente' },
  { key: 'unidades', label: 'Unidade(s)' },
  { key: 'tentativas', label: 'Tentativas' },
  { key: 'pedidoAprovado', label: 'Passou?' },
  { key: 'valorAprovado', label: 'Valor aprovado' },
  { key: 'ativos', label: 'Ativos' },
  { key: 'removidos', label: 'Removidos' },
  { key: 'acao', label: 'Ação tomada' },
  { key: 'primeira', label: 'Primeira tentativa' },
  { key: 'ultima', label: 'Última tentativa' },
];

function formatarCelula(key, valor) {
  if (key === 'valorAprovado') return fmtMoney(valor);
  if (key === 'primeira' || key === 'ultima') return fmtData(valor);
  return valor;
}

function toCSV(linhas) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [COLUNAS.map((c) => escape(c.label)).join(',')];
  linhas.forEach((l) => out.push(COLUNAS.map((c) => escape(formatarCelula(c.key, l[c.key]))).join(',')));
  // BOM no inicio - sem isso o Excel/Sheets as vezes le acentos errado num CSV UTF-8
  return '﻿' + out.join('\r\n');
}

// larguras em pt somando ~770 (A4 paisagem menos margens de 36pt de cada lado)
const LARGURAS = { cliente: 100, unidades: 90, tentativas: 55, pedidoAprovado: 50, valorAprovado: 70, ativos: 40, removidos: 55, acao: 160, primeira: 75, ultima: 75 };

function writePDF(res, { titulo, subtitulo, linhas }) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(titulo)}.pdf"`);
  doc.pipe(res);

  const tableX = doc.page.margins.left;
  const tableWidth = COLUNAS.reduce((s, c) => s + LARGURAS[c.key], 0);

  const totalIncidentes = linhas.length;
  const totalTentativas = linhas.reduce((s, l) => s + l.tentativas, 0);
  const totalPassaram = linhas.filter((l) => l.pedidoAprovado === 'SIM').length;
  const valorTotalAprovado = linhas.reduce((s, l) => s + l.valorAprovado, 0);

  function cabecalhoPagina() {
    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ZENITH OPS · RELATÓRIO DE FRAUDE', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo, tableX, 64);
  }

  function resumo(y) {
    const itens = [
      [String(totalIncidentes), 'clientes monitorados'],
      [String(totalTentativas), 'tentativas no total'],
      [String(totalPassaram), 'conseguiram passar'],
      [fmtMoney(valorTotalAprovado), 'valor aprovado envolvido'],
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
    doc.fontSize(10).fillColor('#888').text('Nenhuma marcação de fraude encontrada nesse período.', tableX, y + 12);
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

module.exports = { slugify, agruparPorCliente, toCSV, writePDF };
