// notif-central.js
// Notificacoes que precisam aparecer em QUALQUER pagina logada, nao so no
// Painel/Historico (que ja tinham a sua propria versao antes disso
// existir): solicitacao nova na Central (toast com som, mesmo padrao de
// painel.html) e fraude CONFIRMADA no Monitor (overlay em cima de tudo,
// mais chamativo que o toast de canto, porque e mais critico). Um arquivo
// so pra nao precisar copiar esse bloco em ~20 paginas toda vez que mudar
// algo (ex: duracao da notificacao) - unica pagina que ja carrega HTML/JS
// externo nessa base, o resto sempre foi tudo inline por pagina.
(function () {
  if (window.__ZENITH_NOTIF_CENTRAL__) return;
  window.__ZENITH_NOTIF_CENTRAL__ = true;

  const AUTH_TOKEN = localStorage.getItem('authToken');
  if (!AUTH_TOKEN) return;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const style = document.createElement('style');
  style.textContent = `
    .zn-notif-wrap{position:fixed;top:14px;right:14px;z-index:100000;display:flex;flex-direction:column;gap:10px;max-width:min(360px,calc(100vw - 28px));}
    .zn-notif{background:var(--panel);border:2px solid var(--warn);border-radius:12px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.55);animation:zn-notif-in .18s ease,zn-notif-pulse 1.6s ease-in-out infinite;font-family:var(--sans);}
    .zn-notif .zn-titulo{font-size:13px;font-weight:700;color:var(--text);}
    .zn-notif .zn-corpo{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.4;}
    .zn-notif .zn-direcionado{font-size:11px;color:var(--accent);margin-top:6px;font-family:var(--mono);}
    .zn-notif button.zn-ok{margin-top:10px;width:100%;background:var(--accent);color:#06202b;border:none;border-radius:8px;padding:9px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:var(--sans);}
    @keyframes zn-notif-pulse{0%,100%{border-color:var(--warn);}50%{border-color:var(--accent);}}
    @keyframes zn-notif-in{from{opacity:0;transform:translateX(16px);}to{opacity:1;transform:translateX(0);}}

    .zn-fraude-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100001;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;}
    .zn-fraude-banner{background:var(--panel);border:2px solid var(--bad);border-radius:14px;padding:20px 22px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:zn-notif-in .2s ease,zn-fraude-pulse 1.1s ease-in-out infinite;font-family:var(--sans);}
    .zn-fraude-banner .zn-f-titulo{font-size:16px;font-weight:800;color:var(--bad);}
    .zn-fraude-banner .zn-f-corpo{font-size:13px;color:var(--text);margin-top:10px;line-height:1.5;}
    .zn-fraude-banner .zn-f-motivo{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4;}
    .zn-fraude-banner button.zn-f-ok{margin-top:16px;width:100%;background:var(--bad);color:#fff;border:none;border-radius:8px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--sans);}
    @keyframes zn-fraude-pulse{0%,100%{border-color:var(--bad);}50%{border-color:#ff8080;}}
  `;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'zn-notif-wrap';
  document.body.appendChild(wrap);

  let audioCtx = null;
  function tocarBeep(padrao) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      padrao.forEach(([delay, freq]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.28, audioCtx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + 0.35);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + delay);
        osc.stop(audioCtx.currentTime + delay + 0.4);
      });
    } catch (e) { /* navegador pode bloquear audio antes de alguma interacao - so nao toca */ }
  }
  const tocarSomSolicitacao = () => tocarBeep([[0, 880], [0.18, 1160]]);
  const tocarSomFraude = () => tocarBeep([[0, 660], [0.16, 660], [0.32, 880]]);

  const ICONES_TIPO = { estorno: '💳', 'ajuste-fechamento': '🧾', compra: '🛒', manutencao: '🔧', 'suporte-ti': '💻', pagamento: '💸', nota: '📄', 'quebra-caixa': '⚠️' };
  const LABELS_TIPO = { estorno: 'Estorno', 'ajuste-fechamento': 'Ajuste de fechamento', compra: 'Compra', manutencao: 'Manutenção', 'suporte-ti': 'Suporte TI', pagamento: 'Pagamento', nota: 'Nota fiscal', 'quebra-caixa': 'Quebra de caixa' };

  function mostrarNotificacaoSolicitacao(card) {
    if (card.notificacaoVista) return;
    const elId = 'zn-notif-' + card.tipo + '-' + card.id;
    if (document.getElementById(elId)) return;
    const el = document.createElement('div');
    el.className = 'zn-notif';
    el.id = elId;
    el.innerHTML = `
      <div class="zn-titulo">🔔 Nova solicitação</div>
      <div class="zn-corpo">${ICONES_TIPO[card.tipo] || '📋'} ${escapeHtml(LABELS_TIPO[card.tipo] || card.tipo)} · ${escapeHtml(card.unidadeNome || card.unidade || '—')}<br>${escapeHtml(card.titulo || '')}</div>
      ${(card.atribuidosEmails && card.atribuidosEmails.length) ? `<div class="zn-direcionado">👤 atribuído a ${escapeHtml(card.atribuidosEmails.join(', '))}</div>` : (card.direcionadoParaEmail ? `<div class="zn-direcionado">👤 direcionado a ${escapeHtml(card.direcionadoParaEmail)}</div>` : '')}
      <button type="button" class="zn-ok">✓ Sinalizar (já vi)</button>
    `;
    el.querySelector('.zn-ok').addEventListener('click', () => marcarVistoNotificacao(card.tipo, card.id));
    wrap.appendChild(el);
    tocarSomSolicitacao();
  }

  async function marcarVistoNotificacao(tipo, id) {
    removerNotificacaoSolicitacao(tipo, id);
    try { await fetch(`/api/central/${tipo}/${id}/marcar-visto`, { method: 'POST' }); } catch (e) { /* proxima visita tenta de novo */ }
  }
  function removerNotificacaoSolicitacao(tipo, id) {
    const el = document.getElementById('zn-notif-' + tipo + '-' + id);
    if (el) el.remove();
  }

  // paginas que ja tem a sua propria versao desse toast (painel.html e
  // central-historico.html, de antes desse arquivo existir) sinalizam com
  // essa flag pra nao duplicar toast/som - so o overlay de fraude roda nelas
  async function initSolicitacoes(es, isMaster, isAdmin) {
    if (window.__ZENITH_SOLICITACAO_NOTIF_OWN__) return;
    if (!isMaster && !isAdmin) return;
    try {
      const cards = await fetch('/api/central').then((r) => r.json());
      cards.filter((c) => c.status === 'PENDENTE' && !c.notificacaoVista).forEach(mostrarNotificacaoSolicitacao);
    } catch (e) { /* sem dados agora, o SSE ainda pega o que chegar dai pra frente */ }
    ['refund-requested', 'solicitacao-criada', 'fechamento-edicao-solicitada'].forEach((evento) => {
      es.addEventListener(evento, async (e) => {
        const registro = JSON.parse(e.data);
        const tipo = registro.tipo || (evento === 'fechamento-edicao-solicitada' ? 'ajuste-fechamento' : 'estorno');
        try {
          const cards = await fetch('/api/central').then((r) => r.json());
          const card = cards.find((c) => c.tipo === tipo && c.id === registro.id);
          if (card) mostrarNotificacaoSolicitacao(card);
        } catch (err) { /* ignora - proximo evento tenta de novo */ }
      });
    });
    es.addEventListener('central-notificacao-vista', (e) => {
      const info = JSON.parse(e.data);
      removerNotificacaoSolicitacao(info.tipo, info.id);
    });
  }

  // fraude CONFIRMADA (nivel FRAUDE) e critica o bastante pra sobrepor a
  // tela inteira, em qualquer pagina - SUSPEITO fica so no badge/lista do
  // Monitor mesmo, sem esse alarme (senao vira ruido demais no dia a dia)
  function mostrarFraude(registro) {
    if (registro.nivel !== 'FRAUDE') return;
    const bg = document.createElement('div');
    bg.className = 'zn-fraude-bg';
    bg.innerHTML = `
      <div class="zn-fraude-banner">
        <div class="zn-f-titulo">🚨 Fraude confirmada</div>
        <div class="zn-f-corpo">${escapeHtml(registro.unidade || '—')} · ${escapeHtml(registro.clienteNome || 'Cliente não identificado')}${registro.valor != null ? ` · R$ ${Number(registro.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}</div>
        ${registro.motivo ? `<div class="zn-f-motivo">${escapeHtml(registro.motivo)}</div>` : ''}
        <button type="button" class="zn-f-ok">✓ OK, entendi</button>
      </div>`;
    bg.querySelector('.zn-f-ok').addEventListener('click', () => bg.remove());
    document.body.appendChild(bg);
    tocarSomFraude();
  }

  function initFraude(es, isMaster, sections) {
    if (!isMaster && !sections.includes('monitor')) return;
    es.addEventListener('fraude-marcada', (e) => {
      try { mostrarFraude(JSON.parse(e.data)); } catch (err) { /* ignora evento malformado */ }
    });
  }

  fetch('/api/me').then((r) => r.json()).then((me) => {
    const isMaster = me.role === 'master';
    const isAdmin = !!me.isAdmin;
    const sections = isMaster ? [] : (me.permissions?.sections || []);
    const es = new EventSource('/api/stream?token=' + encodeURIComponent(AUTH_TOKEN));
    initSolicitacoes(es, isMaster, isAdmin);
    initFraude(es, isMaster, sections);
  }).catch(() => { /* sem /api/me agora (sessao expirando?) - a propria pagina ja trata isso no fetch dela */ });
})();
