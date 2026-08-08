// relatorios.js
// Relatorio periodico de transacoes (PDF+CSV): gera o retrato do periodo
// ANTES de apagar o dado bruto, pra manter o historico consultavel mesmo sem
// guardar cada transacao pra sempre. Depois de gerar, aciona store.pruneOld()
// pro periodo coberto - chargeback e fraude nunca sao apagados (retidos pra
// sempre, ver store.js), o resto (aprovado/recusado/estornado sem disputa)
// sai do banco depois que o relatorio existe.
const db = require('./firestore'); // garante que o app do firebase-admin ja foi inicializado
const store = require('./store');
const { toCSV, resumoPorStatus, gerarPDFBuffer, slugify } = require('./reportExport');
const { resolverBucket, comBucket } = require('./storageBucket');

// a cada quantos dias roda (tambem define o tamanho da janela coberta) -
// ex: 2 = gera relatorio de seg+ter na quarta, depois apaga o que nao e
// chargeback/fraude daqueles 2 dias
const INTERVALO_DIAS = Number(process.env.RELATORIO_INTERVALO_DIAS || 2);
// os PDFs/CSVs em si ficam guardados bem mais tempo que o dado bruto - sao
// pequenos e sao exatamente o "historico" que substitui a transacao crua
const RETENCAO_RELATORIOS_DIAS = 180;

// mesma protecao do backup.js: o job roda "no boot + a cada N dias", mas em
// hospedagem com sleep (Render free) o boot acontece a cada acesso depois de
// um periodo ocioso - sem guarda, CADA acordada gerava PDF+CSV, subia os 2
// arquivos pro Storage e varria o bucket inteiro (limparAntigos). O cooldown
// persiste a ultima tentativa num doc de meta e pula o job ate a janela do
// intervalo quase fechar (folga de 2h pro timer do dia certo nao ser pulado).
const COOLDOWN_MS = INTERVALO_DIAS * 24 * 60 * 60 * 1000 - 2 * 60 * 60 * 1000;
const META_DOC = db.collection('meta').doc('relatorioStatus');

// forcar:true ignora o cooldown - usado pelo botao "Gerar relatório agora"
// do Master (POST /api/relatorios/rodar), que e uma acao explicita e rara
async function rodarRelatorio({ forcar = false } = {}) {
  if (!forcar) {
    const statusSnap = await META_DOC.get();
    const ultimaTentativaEm = statusSnap.exists ? statusSnap.data().ultimaTentativaEm : null;
    if (ultimaTentativaEm && Date.now() - new Date(ultimaTentativaEm).getTime() < COOLDOWN_MS) {
      return { pulou: true, motivo: 'Relatório já gerado dentro da janela - pulado pra não regerar a cada reinício do servidor.', ultimaTentativaEm };
    }
  }
  // grava a tentativa ANTES de gerar - se o processo reiniciar no meio, o
  // proximo boot nao repete o trabalho em seguida
  await META_DOC.set({ ultimaTentativaEm: new Date().toISOString() }, { merge: true });

  const fim = new Date();
  const inicio = new Date(fim.getTime() - INTERVALO_DIAS * 24 * 60 * 60 * 1000);

  const doPeriodo = store.allTransactions()
    .filter((t) => {
      const ts = t.dataHora ? new Date(t.dataHora).getTime() : null;
      return ts !== null && ts >= inicio.getTime() && ts < fim.getTime();
    })
    .sort((a, b) => (a.dataHora || '').localeCompare(b.dataHora || ''));

  const resumo = resumoPorStatus(doPeriodo);
  const titulo = `Relatório de transações — ${inicio.toLocaleDateString('pt-BR')} a ${fim.toLocaleDateString('pt-BR')}`;
  const subtitulo = `Gerado em ${fim.toLocaleString('pt-BR')} · ${resumo.total} eventos`;

  const carimbo = fim.toISOString().replace(/[:.]/g, '-');
  const base = `relatorios/${carimbo}`;
  const csv = toCSV(doPeriodo);
  const pdf = await gerarPDFBuffer({ titulo, subtitulo, resumo, transacoes: doPeriodo });

  await comBucket((bucket) => Promise.all([
    bucket.file(`${base}.csv`).save(csv, { contentType: 'text/csv; charset=utf-8' }),
    bucket.file(`${base}.pdf`).save(pdf, { contentType: 'application/pdf' }),
  ]));

  // so agora, com o relatorio ja salvo, apaga do banco o que nao e
  // chargeback/fraude e caiu dentro da janela coberta
  const removidos = await store.pruneOld(inicio.getTime());
  await limparAntigos();

  console.log(`Relatório gerado: ${base} (${resumo.total} eventos no período, ${removidos} removidos do banco).`);
  return { base: carimbo, resumo, removidos, inicio: inicio.toISOString(), fim: fim.toISOString() };
}

async function limparAntigos() {
  const bucket = await resolverBucket();
  const [arquivos] = await bucket.getFiles({ prefix: 'relatorios/' });
  const limite = Date.now() - RETENCAO_RELATORIOS_DIAS * 24 * 60 * 60 * 1000;
  await Promise.all(
    arquivos
      .filter((f) => new Date(f.metadata.timeCreated).getTime() < limite)
      .map((f) => f.delete().catch(() => {})),
  );
}

// junta o .pdf e o .csv do mesmo carimbo numa unica linha pra listagem
async function listarRelatorios() {
  const bucket = await resolverBucket();
  const [arquivos] = await bucket.getFiles({ prefix: 'relatorios/' });
  const porBase = {};
  arquivos.forEach((f) => {
    const nome = f.name.replace('relatorios/', '');
    const base = nome.replace(/\.(pdf|csv)$/, '');
    const ext = nome.endsWith('.pdf') ? 'pdf' : nome.endsWith('.csv') ? 'csv' : null;
    if (!ext) return;
    porBase[base] = porBase[base] || { base, criadoEm: f.metadata.timeCreated };
    porBase[base][ext] = true;
  });
  return Object.values(porBase).sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
}

async function baixarArquivo(nomeComExtensao, res) {
  if (!/^[a-zA-Z0-9_.-]+\.(pdf|csv)$/.test(nomeComExtensao)) return res.sendStatus(400);
  const ext = nomeComExtensao.endsWith('.pdf') ? 'pdf' : 'csv';
  res.setHeader('Content-Type', ext === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(nomeComExtensao)}.${ext}"`);
  const bucket = await resolverBucket();
  bucket.file(`relatorios/${nomeComExtensao}`)
    .createReadStream()
    .on('error', () => { if (!res.headersSent) res.sendStatus(404); })
    .pipe(res);
}

module.exports = { rodarRelatorio, listarRelatorios, baixarArquivo, INTERVALO_DIAS };
