// vaultExport.js
// Exporta o cofre de senhas (tudo, um grupo ou um subgrupo) em CSV (abre
// direto no Google Planilhas/Excel) ou PDF - so o Master exporta (veja
// auth.requireMaster em index.js). A senha vai em texto puro no arquivo
// exportado, de proposito: o objetivo e servir como inventario/backup
// utilizavel, nao so uma lista de titulos.
const PDFDocument = require('pdfkit');

function slugify(text) {
  return String(text || 'cofre')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'cofre';
}

const FUSO_BR = 'America/Sao_Paulo';

function fmtData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: FUSO_BR }) + ' ' + d.toLocaleTimeString('pt-BR', { timeZone: FUSO_BR, hour: '2-digit', minute: '2-digit' });
}

const COLUNAS = [
  { key: 'grupo', label: 'Grupo' },
  { key: 'subgrupo', label: 'Subgrupo' },
  { key: 'titulo', label: 'Título' },
  { key: 'url', label: 'URL' },
  { key: 'usuario', label: 'Usuário' },
  { key: 'senha', label: 'Senha' },
  { key: 'observacao', label: 'Observação' },
  { key: 'atualizadoEm', label: 'Atualizado em' },
];

function toCSV(rows) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const linhas = [COLUNAS.map((c) => escape(c.label)).join(',')];
  for (const r of rows) {
    linhas.push(COLUNAS.map((c) => escape(c.key === 'atualizadoEm' ? fmtData(r[c.key]) : r[c.key])).join(','));
  }
  // BOM no inicio - sem isso o Excel/Sheets as vezes le acentos errado num CSV UTF-8
  return '﻿' + linhas.join('\r\n');
}

// larguras em pt somando ~770 (A4 paisagem menos margens de 36pt de cada lado)
const LARGURAS = { grupo: 70, subgrupo: 80, titulo: 110, url: 130, usuario: 80, senha: 90, observacao: 130, atualizadoEm: 80 };

function writePDF(res, { titulo, subtitulo, rows }) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(titulo)}.pdf"`);
  doc.pipe(res);

  const tableX = doc.page.margins.left;
  const tableWidth = COLUNAS.reduce((s, c) => s + LARGURAS[c.key], 0);

  function cabecalhoPagina() {
    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ADYEN · COFRE DE SENHAS', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo, tableX, 64);
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
  let y = linhaCabecalhoTabela(90);

  if (!rows.length) {
    doc.fontSize(10).fillColor('#888').text('Nenhuma senha encontrada nesse escopo.', tableX, y + 12);
  }

  doc.fontSize(8).fillColor('#222');
  const alturaLinha = 18;
  for (const row of rows) {
    if (y + alturaLinha > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = linhaCabecalhoTabela(doc.page.margins.top);
      doc.fontSize(8).fillColor('#222');
    }
    let x = tableX;
    for (const c of COLUNAS) {
      const valor = c.key === 'atualizadoEm' ? fmtData(row[c.key]) : String(row[c.key] ?? '');
      doc.text(valor, x + 4, y + 5, { width: LARGURAS[c.key] - 8, height: alturaLinha - 4, ellipsis: true });
      x += LARGURAS[c.key];
    }
    doc.moveTo(tableX, y + alturaLinha).lineTo(tableX + tableWidth, y + alturaLinha).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += alturaLinha;
  }

  doc.end();
}

module.exports = { slugify, toCSV, writePDF };
