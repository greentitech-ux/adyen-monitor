// suporte-chat.js
// Widget flutuante de suporte (💬, canto inferior direito) presente em TODAS
// as telas do Zenith Ops - inclusive login e paginas publicas. Funciona SEM
// estar logado: qualquer pessoa inicia uma conversa com o time de Suporte
// (problema no computador, no sistema, de acesso...). A conversa fica salva
// no navegador (id + token proprios em localStorage), entao a pessoa pode
// fechar e voltar depois. Logado, nome/contato ja vem preenchidos do /api/me.
// O atendimento acontece na tela de Chamados TI (Suporte/Master/Admin).
(function () {
  if (window.__zenithSuporteChat) return;
  window.__zenithSuporteChat = true;

  const LS_ID = 'suporteChatId';
  const LS_TOKEN = 'suporteChatToken';
  let aberto = false;
  let pollTimer = null;
  let ultimoTotalMensagens = 0;

  const css = `
  .szc-btn{position:fixed;right:16px;bottom:16px;z-index:9000;width:52px;height:52px;border-radius:50%;
    background:#5cc8ff;color:#06202b;border:none;font-size:24px;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.45);
    display:flex;align-items:center;justify-content:center;transition:transform .12s ease;}
  .szc-btn:hover{transform:scale(1.06);}
  .szc-panel{position:fixed;right:16px;bottom:78px;z-index:9001;width:320px;max-width:calc(100vw - 32px);
    max-height:min(480px, calc(100vh - 110px));display:flex;flex-direction:column;overflow:hidden;
    background:#12161b;color:#e7ecf1;border:1px solid #232a33;border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.55);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Arial,sans-serif;}
  .szc-hidden{display:none!important;}
  .szc-head{padding:12px 14px;border-bottom:1px solid #232a33;display:flex;justify-content:space-between;align-items:center;gap:8px;}
  .szc-head b{font-size:13.5px;}
  .szc-head .szc-sub{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;color:#7d8896;margin-top:2px;}
  .szc-x{background:none;border:none;color:#7d8896;font-size:16px;cursor:pointer;padding:2px 6px;}
  .szc-x:hover{color:#e7ecf1;}
  .szc-corpo{padding:12px 14px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;}
  .szc-label{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;color:#7d8896;margin:2px 0 -4px;}
  .szc-input,.szc-textarea{width:100%;box-sizing:border-box;background:#181d24;border:1px solid #232a33;color:#e7ecf1;
    border-radius:8px;padding:9px 10px;font-size:13px;font-family:inherit;}
  .szc-input:focus,.szc-textarea:focus{outline:none;border-color:#5cc8ff;}
  .szc-textarea{resize:vertical;min-height:56px;}
  .szc-enviar{background:#5cc8ff;color:#06202b;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;}
  .szc-enviar:disabled{opacity:.5;cursor:default;}
  .szc-msg{max-width:85%;padding:8px 10px;border-radius:10px;font-size:12.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
  .szc-msg.visitante{align-self:flex-end;background:#12303a;color:#cfeeff;border:1px solid rgba(92,200,255,.25);}
  .szc-msg.suporte{align-self:flex-start;background:#181d24;border:1px solid #232a33;}
  .szc-msg .szc-quem{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;color:#7d8896;display:block;margin-bottom:2px;}
  .szc-rodape{padding:10px 12px;border-top:1px solid #232a33;display:flex;gap:6px;}
  .szc-rodape .szc-input{flex:1;}
  .szc-aviso{font-size:11.5px;color:#7d8896;text-align:center;}
  .szc-erro{font-size:11.5px;color:#ff5c5c;}
  .szc-fim{background:#181d24;border:1px dashed #232a33;color:#7d8896;border-radius:8px;padding:8px;font-size:11.5px;text-align:center;}
  .szc-link{background:none;border:none;color:#5cc8ff;font-size:12px;cursor:pointer;padding:0;}
  @media (max-width:480px){ .szc-panel{right:8px;bottom:72px;} .szc-btn{right:12px;bottom:12px;} }
  `;

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const btn = el('<button type="button" class="szc-btn" title="Falar com o Suporte" aria-label="Falar com o Suporte">💬</button>');
  const panel = el(`
    <div class="szc-panel szc-hidden" role="dialog" aria-label="Chat de suporte">
      <div class="szc-head">
        <div><b>💬 Suporte Zenith Ops</b><div class="szc-sub">computador · sistema · acesso</div></div>
        <button type="button" class="szc-x" title="Fechar">✕</button>
      </div>
      <div class="szc-corpo" id="szc-corpo"></div>
      <div class="szc-rodape szc-hidden" id="szc-rodape">
        <input type="text" class="szc-input" id="szc-nova-msg" placeholder="escreva sua mensagem..." maxlength="1000">
        <button type="button" class="szc-enviar" id="szc-enviar-msg">➤</button>
      </div>
    </div>`);
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const corpo = panel.querySelector('#szc-corpo');
  const rodape = panel.querySelector('#szc-rodape');

  // as rotas do chat sao publicas e nunca respondem 401, entao da pra usar o
  // fetch da pagina mesmo (nas telas logadas ele so acrescenta o Authorization,
  // que o backend ignora aqui)
  const rawFetch = (url, opts) => window.fetch(url, opts);

  function chatSalvo() {
    const id = localStorage.getItem(LS_ID);
    const token = localStorage.getItem(LS_TOKEN);
    return id && token ? { id, token } : null;
  }
  function limparChatSalvo() {
    localStorage.removeItem(LS_ID);
    localStorage.removeItem(LS_TOKEN);
  }

  async function dadosLogado() {
    const token = localStorage.getItem('authToken');
    if (!token) return null;
    try {
      const r = await rawFetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return null;
      const me = await r.json();
      return { nome: me.username || '', contato: me.email || '' };
    } catch (e) { return null; }
  }

  function renderFormInicial(prefill) {
    rodape.classList.add('szc-hidden');
    corpo.innerHTML = `
      <div class="szc-aviso">Conte pra gente o que está acontecendo — problema no computador, no sistema ou de acesso. Não precisa estar logado.</div>
      <div class="szc-label">Seu nome</div>
      <input type="text" class="szc-input" id="szc-nome" maxlength="120" value="${esc(prefill?.nome || '')}">
      <div class="szc-label">Contato (e-mail ou telefone)</div>
      <input type="text" class="szc-input" id="szc-contato" maxlength="120" value="${esc(prefill?.contato || '')}">
      <div class="szc-label">Mensagem</div>
      <textarea class="szc-textarea" id="szc-texto" maxlength="1000" placeholder="ex: não consigo entrar no sistema"></textarea>
      <button type="button" class="szc-enviar" id="szc-iniciar">Iniciar conversa</button>
      <div class="szc-erro szc-hidden" id="szc-erro-inicial"></div>`;
    corpo.querySelector('#szc-iniciar').addEventListener('click', iniciarConversa);
  }

  async function iniciarConversa() {
    const nome = corpo.querySelector('#szc-nome').value;
    const contato = corpo.querySelector('#szc-contato').value;
    const texto = corpo.querySelector('#szc-texto').value;
    const erroEl = corpo.querySelector('#szc-erro-inicial');
    const b = corpo.querySelector('#szc-iniciar');
    erroEl.classList.add('szc-hidden');
    b.disabled = true; b.textContent = 'Enviando...';
    try {
      const r = await rawFetch('/api/suporte-chat/iniciar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, contato, texto }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Não foi possível iniciar a conversa.');
      localStorage.setItem(LS_ID, data.id);
      localStorage.setItem(LS_TOKEN, data.token);
      await carregarConversa();
    } catch (err) {
      erroEl.textContent = err.message;
      erroEl.classList.remove('szc-hidden');
      b.disabled = false; b.textContent = 'Iniciar conversa';
    }
  }

  function renderConversa(chat) {
    const noFim = corpo.scrollTop + corpo.clientHeight >= corpo.scrollHeight - 30;
    corpo.innerHTML = (chat.mensagens || []).map((m) => `
      <div class="szc-msg ${m.de === 'visitante' ? 'visitante' : 'suporte'}">
        <span class="szc-quem">${m.de === 'visitante' ? esc(chat.nome || 'Você') : 'Suporte'}</span>${esc(m.texto)}
      </div>`).join('') || '<div class="szc-aviso">Sem mensagens ainda.</div>';
    if (chat.status !== 'ABERTO') {
      corpo.insertAdjacentHTML('beforeend', `<div class="szc-fim">Conversa finalizada pelo Suporte. Precisa de mais ajuda?<br><button type="button" class="szc-link" id="szc-nova-conversa">Iniciar nova conversa</button></div>`);
      corpo.querySelector('#szc-nova-conversa').addEventListener('click', async () => {
        limparChatSalvo();
        pararPoll();
        renderFormInicial(await dadosLogado());
      });
      rodape.classList.add('szc-hidden');
    } else {
      rodape.classList.remove('szc-hidden');
    }
    const total = (chat.mensagens || []).length;
    if (noFim || total !== ultimoTotalMensagens) corpo.scrollTop = corpo.scrollHeight;
    ultimoTotalMensagens = total;
  }

  async function carregarConversa() {
    const salvo = chatSalvo();
    if (!salvo) { renderFormInicial(await dadosLogado()); return; }
    try {
      const r = await rawFetch(`/api/suporte-chat/${encodeURIComponent(salvo.id)}?token=${encodeURIComponent(salvo.token)}`);
      if (r.status === 404) { limparChatSalvo(); renderFormInicial(await dadosLogado()); return; }
      const chat = await r.json();
      renderConversa(chat);
      iniciarPoll();
    } catch (e) { /* rede fora - tenta no proximo poll */ }
  }

  async function enviarMensagem() {
    const salvo = chatSalvo();
    if (!salvo) return;
    const input = panel.querySelector('#szc-nova-msg');
    const texto = input.value.trim();
    if (!texto) return;
    const b = panel.querySelector('#szc-enviar-msg');
    b.disabled = true;
    try {
      const r = await rawFetch(`/api/suporte-chat/${encodeURIComponent(salvo.id)}/mensagem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: salvo.token, texto }),
      });
      if (r.ok) { input.value = ''; await carregarConversa(); }
    } finally { b.disabled = false; }
  }

  function iniciarPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { if (aberto && chatSalvo()) carregarConversa(); }, 5000);
  }
  function pararPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  btn.addEventListener('click', () => {
    aberto = !aberto;
    panel.classList.toggle('szc-hidden', !aberto);
    if (!aberto) { pararPoll(); return; }
    // MASTER: o mesmo icone 💬 abre o ATENDIMENTO (lista de conversas) em
    // vez do formulario de visitante - so no Master
    if (ATEND.ehMaster) atendRenderLista();
    else carregarConversa();
  });
  panel.querySelector('.szc-x').addEventListener('click', () => { aberto = false; panel.classList.add('szc-hidden'); pararPoll(); });
  panel.querySelector('#szc-enviar-msg').addEventListener('click', enviarMensagem);
  panel.querySelector('#szc-nova-msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') enviarMensagem(); });

  // ================= LADO DO ATENDIMENTO (Master/Admin/tag Suporte) =========
  // - Mensagem nova de visitante: a caixa de dialogo ABRE SOZINHA em
  //   qualquer aba, com resposta inline. Fechou? O marcador e salvo e a
  //   conversa continua na tela de Chamados TI (💬 Chats de suporte).
  // - MASTER: o proprio icone 💬 vira a central de chats (lista + conversa).
  const ATEND = { ativo: false, ehMaster: false, chats: [], chatAberto: null, timer: null };
  const LS_ATEND_VISTO = 'szcAtendVisto:'; // + chatId -> "em" da ultima msg de visitante ja vista

  const badge = el('<span style="position:absolute;top:-4px;right:-4px;background:#ff5c5c;color:#fff;font-size:10.5px;font-weight:700;border-radius:10px;padding:1px 6px;display:none;font-family:ui-monospace,monospace;">0</span>');
  btn.style.position = 'fixed';
  btn.appendChild(badge);

  function authHeaders() {
    const t = localStorage.getItem('authToken');
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  function ultimaMsgVisitante(chat) {
    const msgs = chat.mensagens || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].de === 'visitante') return msgs[i];
      if (msgs[i].de === 'suporte') return null; // ja respondida
    }
    return null;
  }

  function atendAguardando() {
    return ATEND.chats.filter((c) => c.status === 'ABERTO' && ultimaMsgVisitante(c));
  }

  async function atendCarregar() {
    try {
      const r = await rawFetch('/api/suporte-chats', { headers: authHeaders() });
      if (!r.ok) return;
      ATEND.chats = await r.json();
      const fila = atendAguardando();
      badge.textContent = fila.length;
      badge.style.display = fila.length ? 'block' : 'none';
      // conversa aberta no momento: atualiza ao vivo
      if (aberto && ATEND.chatAberto) {
        const atual = ATEND.chats.find((c) => c.id === ATEND.chatAberto);
        if (atual) atendRenderConversa(atual, true);
      }
      // popup automatico: mensagem de visitante mais nova que o marcador
      const nova = fila.find((c) => {
        const m = ultimaMsgVisitante(c);
        return m && m.em > (localStorage.getItem(LS_ATEND_VISTO + c.id) || '');
      });
      if (nova && !aberto) {
        aberto = true;
        panel.classList.remove('szc-hidden');
        atendRenderConversa(nova);
      }
    } catch (e) { /* rede fora - tenta no proximo ciclo */ }
  }

  function atendMarcarVisto(chat) {
    const m = ultimaMsgVisitante(chat) || (chat.mensagens || [])[(chat.mensagens || []).length - 1];
    if (m) localStorage.setItem(LS_ATEND_VISTO + chat.id, m.em || new Date().toISOString());
  }

  function atendRenderLista() {
    ATEND.chatAberto = null;
    rodape.classList.add('szc-hidden');
    const abertos = ATEND.chats.filter((c) => c.status === 'ABERTO');
    corpo.innerHTML = '<div class="szc-aviso">💬 Chats de suporte — toque pra atender. A gestão completa fica em <b>Chamados TI</b>.</div>' + (abertos.map((c) => {
      const msgs = c.mensagens || [];
      const ultima = msgs[msgs.length - 1];
      const aguarda = !!ultimaMsgVisitante(c);
      return `<button type="button" class="szc-input" style="text-align:left;cursor:pointer;${aguarda ? 'border-color:#ff5c5c;' : ''}" data-atend-chat="${esc(c.id)}">
        <b style="font-size:12.5px;">${aguarda ? '🔴 ' : ''}${esc(c.nome)}</b>
        <span style="display:block;font-size:11px;color:#7d8896;">${esc((ultima && ultima.texto || '').slice(0, 60))}</span>
      </button>`;
    }).join('') || '<div class="szc-fim">Nenhuma conversa aberta. 🎉</div>') +
    '<button type="button" class="szc-link" id="szc-ir-tecnico" style="margin-top:4px;">abrir a tela de Chamados TI →</button>';
    corpo.querySelectorAll('[data-atend-chat]').forEach((b) => b.addEventListener('click', () => {
      const c = ATEND.chats.find((x) => x.id === b.dataset.atendChat);
      if (c) atendRenderConversa(c);
    }));
    corpo.querySelector('#szc-ir-tecnico').addEventListener('click', () => { location.href = '/tecnico.html'; });
  }

  function atendRenderConversa(chat, manterScroll) {
    ATEND.chatAberto = chat.id;
    rodape.classList.add('szc-hidden');
    const noFim = !manterScroll || corpo.scrollTop + corpo.clientHeight >= corpo.scrollHeight - 30;
    corpo.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
        <button type="button" class="szc-link" id="szc-atend-voltar">← conversas</button>
        <span style="font-size:11px;color:#7d8896;">${esc(chat.nome)} · ${esc(chat.contato || '')}</span>
      </div>` +
      (chat.mensagens || []).map((m) => `
      <div class="szc-msg ${m.de === 'visitante' ? 'suporte' : 'visitante'}">
        <span class="szc-quem">${m.de === 'visitante' ? esc(chat.nome || 'Visitante') : 'Suporte' + (m.autorEmail ? ' · ' + esc(m.autorEmail) : '')}</span>${esc(m.texto)}
      </div>`).join('') + `
      <div style="display:flex;gap:6px;">
        <input type="text" class="szc-input" id="szc-atend-msg" placeholder="responder..." maxlength="1000" style="flex:1;">
        <button type="button" class="szc-enviar" id="szc-atend-enviar">➤</button>
      </div>`;
    atendMarcarVisto(chat);
    atendAtualizarBadge();
    corpo.querySelector('#szc-atend-voltar').addEventListener('click', () => {
      if (ATEND.ehMaster) atendRenderLista();
      else { aberto = false; panel.classList.add('szc-hidden'); }
    });
    const input = corpo.querySelector('#szc-atend-msg');
    const enviar = async () => {
      const texto = input.value.trim();
      if (!texto) return;
      const b = corpo.querySelector('#szc-atend-enviar');
      b.disabled = true;
      try {
        const r = await rawFetch(`/api/suporte-chats/${encodeURIComponent(chat.id)}/responder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ texto }),
        });
        if (r.ok) {
          const atualizado = await r.json();
          const i = ATEND.chats.findIndex((c) => c.id === atualizado.id);
          if (i >= 0) ATEND.chats[i] = atualizado;
          atendMarcarVisto(atualizado);
          atendRenderConversa(atualizado);
        }
      } finally { b.disabled = false; }
    };
    corpo.querySelector('#szc-atend-enviar').addEventListener('click', enviar);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); enviar(); } });
    if (noFim) corpo.scrollTop = corpo.scrollHeight;
    input.focus();
  }

  function atendAtualizarBadge() {
    const fila = atendAguardando();
    badge.textContent = fila.length;
    badge.style.display = fila.length ? 'block' : 'none';
  }

  // fechar no X tambem salva o "visto" da conversa aberta - o popup nao
  // volta pra mesma mensagem; mensagem NOVA reabre
  panel.querySelector('.szc-x').addEventListener('click', () => {
    if (ATEND.chatAberto) {
      const c = ATEND.chats.find((x) => x.id === ATEND.chatAberto);
      if (c) atendMarcarVisto(c);
      ATEND.chatAberto = null;
    }
  });

  async function atendInit() {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    try {
      const r = await rawFetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      const me = await r.json();
      const secoes = (me.permissions && me.permissions.sections) || [];
      if (!(me.role === 'master' || me.isAdmin || secoes.includes('suporte'))) return;
      ATEND.ativo = true;
      ATEND.ehMaster = me.role === 'master';
      btn.title = 'Chats de suporte';
      await atendCarregar();
      // aba em segundo plano nao busca (ninguem esta olhando e a requisicao
      // so gastaria servidor/Firestore a toa) - ao voltar pra aba, atualiza
      // na hora. O SSE continua ligado, entao mensagem nova ainda chega.
      ATEND.timer = setInterval(() => { if (!document.hidden) atendCarregar(); }, 25 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && ATEND.ativo) atendCarregar(); });
      // SSE: mensagem nova chega na hora (o poll fica de rede de seguranca)
      try {
        const es = new EventSource('/api/stream?token=' + encodeURIComponent(token));
        es.addEventListener('suporte-chat', () => { atendCarregar(); });
      } catch (e) { /* sem SSE, o poll resolve */ }
    } catch (e) { /* segue como widget de visitante */ }
  }
  atendInit();
})();
