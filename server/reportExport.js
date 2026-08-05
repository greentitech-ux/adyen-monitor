// reportExport.js
// Monta o PDF/CSV do relatorio periodico de transacoes (aprovado, recusado,
// estornado, chargeback, fraude...). Puramente de renderizacao - quem decide
// QUAL periodo/dados entram e o relatorios.js. Mesmo padrao de tabela usado em
// vaultExport.js (cofre de senhas), adaptado pras colunas de transacao.
const PDFDocument = require('pdfkit');

function slugify(text) {
  return String(text || 'relatorio')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'relatorio';
}

function fmtData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtMoney(v) {
  return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const COLUNAS = [
  { key: 'dataHora', label: 'Data/Hora' },
  { key: 'unidade', label: 'Unidade' },
  { key: 'status', label: 'Status' },
  { key: 'cardHolder', label: 'Cliente' },
  { key: 'metodo', label: 'Método' },
  { key: 'last4', label: 'Final' },
  { key: 'valor', label: 'Valor' },
  { key: 'motivo', label: 'Motivo' },
  { key: 'pspReference', label: 'PSP Reference' },
];

// contagem por status + volume aprovado - vira o resumo do topo do PDF e a
// base pro que aparece na tela antes de rodar/baixar
function resumoPorStatus(transacoes) {
  const porStatus = {};
  let totalAprovado = 0;
  for (const t of transacoes) {
    porStatus[t.status] = (porStatus[t.status] || 0) + 1;
    if (t.status === 'APROVADO') totalAprovado += t.valor || 0;
  }
  return { total: transacoes.length, porStatus, totalAprovado: +totalAprovado.toFixed(2) };
}

function toCSV(transacoes) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const linhas = [COLUNAS.map((c) => escape(c.label)).join(',')];
  for (const t of transacoes) {
    linhas.push(COLUNAS.map((c) => {
      if (c.key === 'dataHora') return escape(fmtData(t[c.key]));
      if (c.key === 'valor') return escape(fmtMoney(t[c.key]));
      return escape(t[c.key]);
    }).join(','));
  }
  // BOM no inicio - sem isso o Excel/Sheets as vezes le acentos errado num CSV UTF-8
  return '﻿' + linhas.join('\r\n');
}

// larguras em pt somando ~770 (A4 paisagem menos margens de 36pt de cada lado)
const LARGURAS = { dataHora: 80, unidade: 70, status: 90, cardHolder: 120, metodo: 60, last4: 45, valor: 75, motivo: 140, pspReference: 100 };

function gerarPDFBuffer({ titulo, subtitulo, resumo, transacoes }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tableX = doc.page.margins.left;
    const tableWidth = COLUNAS.reduce((s, c) => s + LARGURAS[c.key], 0);

    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ZENITH OPS · RELATÓRIO DE TRANSAÇÕES', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo, tableX, 64);

    let y = 90;
    doc.fontSize(9).fillColor('#333');
    doc.text(`Total de eventos: ${resumo.total}    Volume aprovado: ${fmtMoney(resumo.totalAprovado)}`, tableX, y);
    y += 16;
    const resumoTexto = Object.entries(resumo.porStatus).map(([s, n]) => `${s}: ${n}`).join('   ') || 'nenhum evento no período';
    doc.text('Por status: ' + resumoTexto, tableX, y, { width: tableWidth });
    y += 28;

    function linhaCabecalhoTabela(yy) {
      doc.rect(tableX, yy, tableWidth, 20).fill('#eef1f4');
      doc.fillColor('#333').fontSize(8);
      let x = tableX;
      for (const c of COLUNAS) {
        doc.text(c.label.toUpperCase(), x + 4, yy + 6, { width: LARGURAS[c.key] - 8 });
        x += LARGURAS[c.key];
      }
      return yy + 20;
    }

    y = linhaCabecalhoTabela(y);
    if (!transacoes.length) {
      doc.fontSize(10).fillColor('#888').text('Nenhuma transação no período.', tableX, y + 12);
    }

    doc.fontSize(7.5).fillColor('#222');
    const alturaLinha = 16;
    for (const t of transacoes) {
      if (y + alturaLinha > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = linhaCabecalhoTabela(doc.page.margins.top);
        doc.fontSize(7.5).fillColor('#222');
      }
      let x = tableX;
      for (const c of COLUNAS) {
        const valor = c.key === 'dataHora' ? fmtData(t[c.key]) : c.key === 'valor' ? fmtMoney(t[c.key]) : String(t[c.key] ?? '');
        doc.text(valor, x + 4, y + 4, { width: LARGURAS[c.key] - 8, height: alturaLinha - 2, ellipsis: true });
        x += LARGURAS[c.key];
      }
      doc.moveTo(tableX, y + alturaLinha).lineTo(tableX + tableWidth, y + alturaLinha).strokeColor('#ddd').lineWidth(0.5).stroke();
      y += alturaLinha;
    }

    doc.end();
  });
}

module.exports = { slugify, toCSV, resumoPorStatus, gerarPDFBuffer };
