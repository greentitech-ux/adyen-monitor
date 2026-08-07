// fechamentosReport.js
// Relatorio (CSV/PDF) dos Fechamentos de caixa no periodo filtrado - mesma
// tabela mostrada no painel "Fechamentos" de fechamentos.html, pra levar
// pra fora do sistema (ex: apresentar caixa/quebra do periodo pra alguem
// que nao acessa o dashboard).
const PDFDocument = require('pdfkit');

function slugify(text) {
  return String(text || 'relatorio-fechamentos')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'relatorio-fechamentos';
}

function fmtData(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

function fmtMoney(v) {
  return 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const COLUNAS = [
  { key: 'data', label: 'Data' },
  { key: 'unidadeNome', label: 'Unidade' },
  { key: 'gerente', label: 'Gerente' },
  { key: 'faturamento', label: 'Faturamento' },
  { key: 'totalDeclarado', label: 'Total declarado' },
  { key: 'diferenca', label: 'Diferença' },
  { key: 'quebra', label: 'Quebra' },
  { key: 'adyen', label: 'Adyen' },
  { key: 'ifood', label: 'Ifood' },
  { key: 'food99', label: '99Food' },
  { key: 'pix', label: 'Pix' },
  { key: 'loja', label: 'Loja' },
  { key: 'observacao', label: 'Observação' },
];

function formatarCelula(key, valor) {
  if (key === 'data') return fmtData(valor);
  if (['faturamento', 'totalDeclarado', 'diferenca', 'quebra', 'adyen', 'ifood', 'food99', 'pix', 'loja'].includes(key)) return fmtMoney(valor);
  return valor ?? '';
}

// linhas ja vem ordenadas/filtradas de quem chama - so preparamos os campos
// que a tabela usa (cada fechamento ja carrega o proprio unidadeNome)
function prepararLinhas(fechamentos) {
  return [...fechamentos]
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''))
    .map((f) => ({
      data: f.data,
      unidadeNome: f.unidadeNome || f.unidade,
      gerente: f.gerente || '—',
      faturamento: f.faturamento || 0,
      totalDeclarado: f.totalDeclarado || 0,
      diferenca: f.diferenca || 0,
      quebra: f.quebra || 0,
      adyen: f.adyen || 0,
      ifood: f.ifood || 0,
      food99: f.food99 || 0,
      pix: f.pix || 0,
      loja: f.loja || 0,
      observacao: f.observacao || f.obsDif || '—',
    }));
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

// larguras em pt somando ~761 (A4 paisagem menos margens de 36pt de cada lado) -
// colunas de dinheiro com espaço suficiente pra valores tipo "R$ 1.400,00"
// sem cortar (testado com relatorio real e visto que 50pt cortava)
const LARGURAS = {
  data: 58, unidadeNome: 58, gerente: 46, faturamento: 64, totalDeclarado: 64,
  diferenca: 58, quebra: 56, adyen: 58, ifood: 58, food99: 54, pix: 54, loja: 58, observacao: 75,
};

function writePDF(res, { titulo, subtitulo, linhas, nomeArquivo }) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(nomeArquivo || titulo)}.pdf"`);
  doc.pipe(res);

  const tableX = doc.page.margins.left;
  const tableWidth = COLUNAS.reduce((s, c) => s + LARGURAS[c.key], 0);

  const totalFechamentos = linhas.length;
  const faturamentoTotal = linhas.reduce((s, l) => s + l.faturamento, 0);
  const declaradoTotal = linhas.reduce((s, l) => s + l.totalDeclarado, 0);
  const diferencaTotal = linhas.reduce((s, l) => s + l.diferenca, 0);

  function cabecalhoPagina() {
    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ZENITH OPS · RELATÓRIO DE FECHAMENTOS', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo, tableX, 64);
  }

  function resumo(y) {
    const itens = [
      [String(totalFechamentos), 'fechamentos no período'],
      [fmtMoney(faturamentoTotal), 'faturamento total'],
      [fmtMoney(declaradoTotal), 'total declarado'],
      [fmtMoney(diferencaTotal), 'diferença de caixa'],
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
    doc.fontSize(10).fillColor('#888').text('Nenhum fechamento encontrado nesse período.', tableX, y + 12);
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

module.exports = { slugify, prepararLinhas, toCSV, writePDF };
