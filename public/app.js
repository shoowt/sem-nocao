'use strict';
/* ============ Sem Noção — cliente ============ */

const $app = document.getElementById('app');
const AVATARS = ['🐶', '🐱', '🦊', '🐸', '🐼', '🐨', '🐯', '🦄', '🐙', '🐧', '🦖', '👽', '🤡', '👻', '🐷', '🐵', '🦉', '🐢'];
const REACTIONS = ['😂', '💀', '🔥', '😱', '👏', '🤢', '😈', '❤️'];
const TARGETS = [3, 5, 8, 10, 15, 0];

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('sn:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('sn:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('sn:' + k); } catch {} },
};

let S = null;            // último estado vindo do servidor
let session = null;      // { code, token }
let es = null;           // EventSource
let clockOffset = 0;
let lastMsg = null;
const ui = {
  name: store.get('name') || '',
  avatar: store.get('avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)],
  selected: [], selRound: null, chosen: null, menuOpen: false,
};
const prev = { hand: new Set(), shown: new Set(), state: null, round: null };

// ---------- utilidades ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = 0; }, 2800);
  setTimeout(() => el.remove(), 3200);
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Algo deu errado.'), { status: r.status });
  return data;
}

async function act(type, extra = {}) {
  try { await post('/api/action', { code: session.code, token: session.token, type, ...extra }); }
  catch (e) { toast(e.message, true); }
}

// preenche as lacunas da carta-pergunta com as respostas
function fill(text, answers = []) {
  const parts = text.split('____');
  let html = esc(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    const a = answers[i - 1];
    const after = parts[i];
    if (a != null) {
      const clean = after.trim() ? a.replace(/\.\s*$/, '') : a;
      html += `<span class="ans">${esc(clean)}</span>`;
    } else html += '<span class="blank"></span>';
    html += esc(after);
  }
  // carta sem lacuna suficiente: põe o resto no fim
  for (let i = parts.length - 1; i < answers.length; i++) html += ` <span class="ans">${esc(answers[i])}</span>`;
  return html;
}

const avatarHTML = (p, cls = '') =>
  `<div class="avatar ${cls}" style="--c:${esc(p.color || '#c9bbff')}">${esc(p.avatar)}${p.isCzar ? '<span class="crown">👑</span>' : ''}</div>`;

const meP = () => S.players.find(p => p.id === S.me.id);
const nameOf = id => S.players.find(p => p.id === id)?.name || '?';
const inviteLink = () => `${location.origin}/sala/${S?.code || session?.code}`;

async function copyInvite() {
  const link = inviteLink();
  try { await navigator.clipboard.writeText(link); toast('Link copiado! Manda no grupo 💌'); }
  catch { prompt('Copie o link do convite:', link); }
}

// ---------- conexão ----------
function connect(sess) {
  session = sess;
  store.set('session', sess);
  if (location.pathname !== '/sala/' + sess.code) history.replaceState(null, '', '/sala/' + sess.code);
  if (es) es.close();
  $app.innerHTML = '<div class="center-msg"><div><div class="spinner"></div>Entrando na sala…</div></div>';
  es = new EventSource(`/api/events?code=${encodeURIComponent(sess.code)}&token=${encodeURIComponent(sess.token)}`);
  es.addEventListener('state', e => {
    S = JSON.parse(e.data);
    clockOffset = S.serverNow - Date.now();
    render();
  });
  es.addEventListener('react', e => floaty(JSON.parse(e.data)));
  es.addEventListener('kicked', e => {
    const { reason } = JSON.parse(e.data);
    leaveLocal(reason);
  });
  es.onerror = async () => {
    if (es.readyState !== EventSource.CLOSED) return; // o navegador já está reconectando
    try {
      await post('/api/join', { code: sess.code, token: sess.token });
      setTimeout(() => connect(sess), 1000);
    } catch (e) {
      if (e.status === 404) leaveLocal('Essa sala não existe mais. Crie uma nova!');
      else setTimeout(() => connect(sess), 2500);
    }
  };
}

function leaveLocal(msg) {
  if (es) es.close();
  es = null; S = null; session = null;
  store.del('session');
  history.replaceState(null, '', '/');
  renderHome(null);
  if (msg) toast(msg);
}

// ---------- HOME ----------
function renderHome(inviteCode) {
  const last = store.get('session');
  $app.innerHTML = `
  <section class="home">
    <div class="hero">
      <h1 class="logo"><span class="a">Sem</span> <span class="b">Noção</span></h1>
      <p class="tag">Complete a frase com a resposta mais absurda. Até 6 amigos, um juiz por rodada e zero filtro.</p>
      <div class="hero-cards" aria-hidden="true">
        <div class="card q">Eu bebo para esquecer <span class="blank"></span>.</div>
        <div class="card">Um momento de silêncio.</div>
        <div class="card">Ensinar um robô a amar.</div>
      </div>
    </div>
    <form class="panel join-panel" id="joinForm" autocomplete="off">
      ${inviteCode
        ? `<div class="invite-note">🎉 Você foi convidado para a sala <b>${esc(inviteCode)}</b></div>`
        : `<h2>Bora jogar?</h2>`}
      ${!inviteCode && last ? `<button type="button" class="btn ghost block" data-act="resume" style="margin-bottom:18px">↩ Voltar para a sala ${esc(last.code)}</button>` : ''}
      <div class="field">
        <label class="label" for="nm">Seu nome</label>
        <input id="nm" class="input" maxlength="16" placeholder="Como te chamam?" value="${esc(ui.name)}" required>
      </div>
      <div class="field">
        <span class="label">Escolha seu avatar</span>
        <div class="avatar-grid">
          ${AVATARS.map(a => `<button type="button" data-act="avatar" data-v="${a}" aria-pressed="${a === ui.avatar}" aria-label="Avatar ${a}">${a}</button>`).join('')}
        </div>
      </div>
      ${inviteCode
        ? `<input type="hidden" id="code" value="${esc(inviteCode)}">
           <button class="btn pink block" type="submit" data-mode="join">Entrar na sala</button>
           <div class="or">ou</div>
           <button class="btn ghost block" type="button" data-act="create">Criar uma sala nova</button>`
        : `<button class="btn block" type="submit" data-mode="create">Criar sala</button>
           <div class="or">ou entre com um código</div>
           <div class="join-row">
             <input id="code" class="input code" maxlength="4" placeholder="ABCD" aria-label="Código da sala">
             <button class="btn pink" type="button" data-act="join">Entrar</button>
           </div>`}
    </form>
  </section>`;

  const nm = document.getElementById('nm');
  nm.addEventListener('input', () => { ui.name = nm.value; });
  const codeIn = document.getElementById('code');
  if (codeIn && codeIn.type !== 'hidden') {
    codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); homeJoin(); } });
  }
  document.getElementById('joinForm').addEventListener('submit', e => {
    e.preventDefault();
    if (inviteCode) homeJoin(); else homeCreate();
  });
  if (!ui.name) nm.focus();
}

function readName() {
  const name = (document.getElementById('nm')?.value || '').trim();
  if (!name) { toast('Digite seu nome primeiro 🙂', true); document.getElementById('nm')?.focus(); return null; }
  ui.name = name; store.set('name', name); store.set('avatar', ui.avatar);
  return name;
}

async function homeCreate() {
  const name = readName(); if (!name) return;
  try { connect(await post('/api/create', { name, avatar: ui.avatar })); }
  catch (e) { toast(e.message, true); }
}

async function homeJoin() {
  const code = (document.getElementById('code')?.value || '').trim().toUpperCase();
  if (code.length !== 4) { toast('O código tem 4 letras.', true); return; }
  const name = readName(); if (!name) return;
  const last = store.get('session');
  try {
    connect(await post('/api/join', { code, name, avatar: ui.avatar, token: last?.code === code ? last.token : undefined }));
  } catch (e) { toast(e.message, true); }
}

// ---------- barra superior / reações ----------
function topbar(extra = '') {
  const inGame = S.state !== 'lobby';
  return `
  <header class="topbar">
    <div class="logo"><span class="a">Sem</span> <span class="b">Noção</span></div>
    ${extra}
    <button class="chip code" data-act="copy" title="Copiar link do convite"><span class="muted">sala</span> ${esc(S.code)} 🔗</button>
    <div class="menu">
      <button class="chip" data-act="menu" aria-expanded="${ui.menuOpen}" aria-label="Menu">☰</button>
      ${ui.menuOpen ? `<div class="menu-pop">
        <button data-act="copy">🔗 Copiar convite</button>
        ${S.me.isHost && inGame ? '<button data-act="tolobby">🏠 Voltar todos ao lobby</button>' : ''}
        <button data-act="leave">🚪 Sair da sala</button>
      </div>` : ''}
    </div>
  </header>`;
}

const reactBar = () =>
  `<div class="react-bar" role="toolbar" aria-label="Reações">${REACTIONS.map(e => `<button data-act="react" data-v="${e}" aria-label="Reagir ${e}">${e}</button>`).join('')}</div>`;

function floaty({ emoji, name, color }) {
  const el = document.createElement('div');
  el.className = 'floaty';
  el.style.left = (8 + Math.random() * 84) + '%';
  el.style.setProperty('--dx', (Math.random() * 120 - 60) + 'px');
  el.innerHTML = `<span class="e">${esc(emoji)}</span><span class="n" style="color:${esc(color)}">${esc(name)}</span>`;
  document.getElementById('reactions-layer').append(el);
  setTimeout(() => el.remove(), 3300);
}

// ---------- LOBBY ----------
function renderLobby() {
  const host = S.me.isHost;
  const seats = [];
  for (let i = 0; i < S.maxPlayers; i++) {
    const p = S.players[i];
    seats.push(p
      ? `<div class="seat ${p.online ? '' : 'off'}">
          ${host && p.id !== S.me.id ? `<button class="kick" data-act="kick" data-id="${p.id}" title="Remover">✕</button>` : ''}
          ${avatarHTML(p, 'lg')}
          <div class="nm">${esc(p.name)}${p.id === S.me.id ? ' (você)' : ''}</div>
          <div class="tag">${p.isHost ? '⭐ anfitrião' : p.isBot ? '🤖 bot' : p.online ? 'pronto' : 'offline'}</div>
        </div>`
      : host && i === S.players.length
        ? `<button class="seat empty addbot" data-act="addbot">+ Adicionar bot 🤖</button>`
        : `<div class="seat empty">esperando<span class="dots"></span></div>`);
  }
  const s = S.settings;
  const dis = host ? '' : 'disabled';
  const hostName = S.players.find(p => p.isHost)?.name || 'o anfitrião';
  $app.innerHTML = `
  ${topbar()}
  <section class="lobby">
    <div class="panel">
      <h2>Sala de espera</h2>
      <div class="code-box">
        <div class="big">${esc(S.code)}</div>
        <div class="hint">Manda esse código (ou o link) pra galera.<br>${S.players.length}/${S.maxPlayers} jogadores</div>
        <button class="btn small" data-act="copy">🔗 Copiar link</button>
      </div>
      <div class="seats">${seats.join('')}</div>
    </div>
    <div class="stack">
      <div class="panel">
        <h2>Regras da casa</h2>
        <div class="field">
          <span class="label">Pontos para vencer</span>
          <div class="opts">${TARGETS.map(t => `<button class="opt" data-act="target" data-v="${t}" aria-pressed="${s.target === t}" ${dis}>${t || '∞ até acabar'}</button>`).join('')}</div>
        </div>
        <div class="field">
          <label class="label" for="fc">💩 Quem fez cocô mais recentemente?</label>
          <select id="fc" class="input" ${dis}>
            <option value="random" ${s.firstCzar === 'random' ? 'selected' : ''}>🎲 Sortear (ninguém quer admitir)</option>
            ${S.players.map(p => `<option value="${p.id}" ${s.firstCzar === p.id ? 'selected' : ''}>${esc(p.avatar)} ${esc(p.name)}</option>`).join('')}
          </select>
          <small style="color:var(--muted);font-weight:700">Essa pessoa começa como juiz. 👑</small>
        </div>
        <div class="field">
          <label class="toggle">
            <input type="checkbox" id="rando" ${S.randoActive ? 'checked' : ''} ${host && S.players.length !== 2 ? '' : 'disabled'}>
            <span>🎲 Carta do Monte
              <small>${S.players.length === 2 ? 'Ligada automaticamente com 2 jogadores.' : 'Uma resposta aleatória entra na disputa.'}</small></span>
          </label>
        </div>
        ${host
          ? `<button class="btn mint block" data-act="start" ${S.players.length < 2 ? 'disabled' : ''}>${S.players.length < 2 ? 'Esperando mais gente…' : 'Começar partida'}</button>`
          : `<div class="invite-note" style="margin:0;text-align:center">Esperando ${esc(hostName)} começar<span class="dots"></span></div>`}
      </div>
      <div class="panel">
        <details>
          <summary>Como jogar</summary>
          <ol class="rules" style="margin-top:12px">
            <li>Cada um recebe <b>10 cartas brancas</b> (respostas).</li>
            <li>O <b>juiz</b> 👑 lê a carta preta em voz alta.</li>
            <li>Os outros escolhem em segredo a resposta mais engraçada (algumas cartas pedem 2 ou 3, na ordem).</li>
            <li>O juiz revela as respostas embaralhadas, lê cada combinação e escolhe a melhor.</li>
            <li>Quem jogou a vencedora ganha <b>1 ponto</b> e fica com a carta preta.</li>
            <li>Todo mundo completa a mão até 10 e o juiz passa pro próximo.</li>
          </ol>
        </details>
      </div>
    </div>
  </section>
  ${reactBar()}`;

  document.getElementById('fc')?.addEventListener('change', e => act('settings', { firstCzar: e.target.value }));
  document.getElementById('rando')?.addEventListener('change', e => act('settings', { rando: e.target.checked }));
}

// ---------- JOGO ----------
function playersBar() {
  const r = S.round;
  const items = S.players.map(p => {
    let st = '';
    if (!p.online) st = '<span class="st">offline</span>';
    else if (p.isCzar) st = '<span class="st cz">juiz</span>';
    else if (S.state === 'picking') st = p.submitted ? '<span class="st ok">✓ jogou</span>' : '<span class="st">pensando<span class="dots"></span></span>';
    else st = `<span class="st">${p.isHost ? 'anfitrião' : '&nbsp;'}</span>`;
    return `<div class="pl ${p.isCzar ? 'czar' : ''} ${p.id === S.me.id ? 'me' : ''} ${p.online ? '' : 'off'}">
      ${avatarHTML(p)}<div><div class="nm">${esc(p.name)}</div>${st}</div><div class="pts">${p.score}</div></div>`;
  });
  if (S.rando) items.push(`<div class="pl"><div class="avatar" style="--c:#cfcfe0">🎲</div><div><div class="nm">Carta do Monte</div><span class="st">aleatória</span></div><div class="pts">${S.rando.score}</div></div>`);
  return `<div class="players">${items.join('')}</div>`;
}

function waitingList() {
  const r = S.round;
  return `<div class="waiting">${S.players.filter(p => p.id !== r.czarId).map(p =>
    `<span class="w ${p.submitted ? 'done' : ''}">${avatarHTML({ ...p, isCzar: false })}${esc(p.name)} ${p.submitted ? '✓' : ''}</span>`).join('')}</div>`;
}

function renderGame() {
  const r = S.round;
  const me = S.me;
  const iAmCzar = r.czarId === me.id;
  const pick = r.black.pick;

  // seleção local
  if (ui.selRound !== r.n) { ui.selected = []; ui.chosen = null; ui.selRound = r.n; }
  ui.selected = ui.selected.filter(id => me.hand.some(c => c.id === id));

  // carta preta (com preview das respostas)
  let qAnswers = [];
  if (S.state === 'picking') {
    if (r.mySubmission) qAnswers = r.mySubmission;
    else if (!iAmCzar) qAnswers = ui.selected.map(id => me.hand.find(c => c.id === id)?.text);
  } else if (S.state === 'result' && r.winner) qAnswers = r.winner.cards;
  const qCard = `<div class="card q q-big ${prev.round !== r.n ? 'enter' : ''}">${fill(r.black.text, qAnswers)}${pick > 1 ? `<span class="pick">Escolha ${pick}</span>` : ''}</div>`;

  // painel de status
  let status = '';
  const canForce = (me.isHost || iAmCzar) && (r.submittedCount > 0 || S.randoActive);
  if (S.state === 'picking') {
    if (iAmCzar) {
      status = `<h2>Você é o juiz! 👑</h2>
        <p>Lê a carta em voz alta (com drama) e espera as respostas chegarem.</p>
        ${waitingList()}
        ${canForce ? `<button class="btn ghost small" data-act="force">⏩ Não esperar mais ninguém</button>` : ''}`;
    } else if (r.mySubmission) {
      status = `<h2>Cartas jogadas! ✅</h2>
        <p>Agora é torcer. Esperando o resto da galera…</p>
        ${waitingList()}
        <button class="btn ghost small" data-act="undo">↩ Desfazer</button>
        ${canForce ? ` <button class="btn ghost small" data-act="force">⏩ Não esperar mais ninguém</button>` : ''}`;
    } else {
      const ready = ui.selected.length === pick;
      status = `<h2>${pick === 1 ? 'Escolha sua melhor carta' : `Escolha ${pick} cartas, na ordem`}</h2>
        <p>${pick === 1 ? 'Toque numa carta da sua mão pra ver como fica.' : 'A ordem que você tocar é a ordem das lacunas.'} Juiz da rodada: <b>${esc(nameOf(r.czarId))}</b> 👑</p>
        <button class="btn pink" data-act="submit" ${ready ? '' : 'disabled'}>${ready ? '🃏 Jogar ' + (pick > 1 ? 'cartas' : 'carta') : `Selecione ${pick - ui.selected.length} ${pick - ui.selected.length > 1 ? 'cartas' : 'carta'}`}</button>
        ${canForce ? ` <button class="btn ghost small" data-act="force">⏩ Apressar</button>` : ''}`;
    }
  } else if (S.state === 'judging') {
    const hidden = r.reveal.filter(x => !x.shown).length;
    if (iAmCzar) {
      status = `<h2>Hora de julgar! ⚖️</h2>
        <p>${hidden ? `Toque em cada carta pra revelar e leia a frase em voz alta. Faltam <b>${hidden}</b>.` : 'Tudo revelado! Toque na mais engraçada e confirme.'}</p>
        ${hidden ? `<button class="btn ghost" data-act="revealnext">👀 Revelar próxima</button>` : `<button class="btn sun" data-act="choose" ${ui.chosen ? '' : 'disabled'}>🏆 Essa é a melhor!</button>`}`;
    } else {
      status = `<h2>${esc(nameOf(r.czarId))} está julgando<span class="dots"></span></h2>
        <p>${hidden ? 'Segura o riso enquanto as cartas são reveladas. 🤭' : 'Decidindo a vencedora… pressão total!'}</p>`;
    }
  } else if (S.state === 'result' && r.winner) {
    const w = r.winner;
    const isMe = w.ownerId === me.id;
    const wp = S.players.find(p => p.id === w.ownerId);
    status = `<div class="result">
        ${avatarHTML({ avatar: w.avatar, color: wp?.color || '#cfcfe0' }, 'xl')}
        <div style="flex:1">
          <div class="who">${isMe ? 'Você ganhou o ponto! 🎉' : `${esc(w.name)} ganhou o ponto!`}</div>
          <div class="sentence">${fill(r.black.text, w.cards)}</div>
          <div class="timerbar"><i id="tbar"></i></div>
        </div>
      </div>
      ${me.isHost || iAmCzar ? '<button class="btn" data-act="next">Próxima rodada ▶</button>' : '<p>A próxima rodada já começa…</p>'}`;
  }

  // mesa (respostas reveladas)
  let table = '';
  if (S.state === 'judging' || S.state === 'result') {
    table = `<div class="table">${r.reveal.map((x, i) => {
      const isWin = S.state === 'result' && r.winner?.sid === x.sid;
      const clickable = S.state === 'judging' && iAmCzar;
      const showNow = x.shown && prev.shown.has(x.sid);
      const foot = x.owner ? `${x.owner.avatar} ${x.owner.name}` : x.mine ? 'sua resposta' : '';
      return `<button class="sub ${showNow ? 'shown' : ''} ${clickable ? 'clickable' : ''} ${ui.chosen === x.sid && S.state === 'judging' ? 'chosen' : ''} ${isWin ? 'win' : ''} ${x.mine ? 'mine' : ''}"
          data-sid="${x.sid}" data-shown="${x.shown}" ${clickable ? 'data-act="sub"' : 'tabindex="-1"'} style="animation-delay:${i * 60}ms">
        <div class="inner">
          <div class="face back">?<small>${x.mine ? 'sua' : `resposta ${i + 1}`}</small></div>
          <div class="face front sentence" data-foot="${esc(foot)}">${x.cards ? fill(r.black.text, x.cards) : ''}</div>
        </div>
      </button>`;
    }).join('')}</div>`;
  }

  // mão
  const locked = S.state !== 'picking' || iAmCzar || !!r.mySubmission;
  const hand = `
    <section class="hand-wrap">
      <div class="hand-head">
        <h3>Sua mão</h3>
        <span class="chip">🂠 ${S.deck.black} pretas restantes</span>
        <span class="chip">🏁 ${S.settings.target ? S.settings.target + ' pontos vence' : 'sem limite'}</span>
      </div>
      ${iAmCzar && S.state === 'picking' ? `<div class="czar-note"><span class="big">👑</span>Você é o juiz desta rodada — suas cartas descansam até a próxima.</div>` : ''}
      <div class="hand fan ${locked ? 'locked' : ''}">
        ${me.hand.map((c, i) => {
          const n = ui.selected.indexOf(c.id);
          return `<button class="card ${n >= 0 ? 'sel' : ''} ${prev.hand.has(c.id) ? '' : 'enter'}" style="--i:${i};--n:${me.hand.length}" data-act="card" data-id="${c.id}" ${locked ? 'tabindex="-1" aria-disabled="true"' : ''}>${esc(c.text)}${n >= 0 && !locked ? `<span class="num">${n + 1}</span>` : ''}</button>`;
        }).join('')}
      </div>
    </section>`;

  $app.innerHTML = `
    ${topbar(`<span class="chip">Rodada ${r.n}</span>`)}
    ${playersBar()}
    <section class="stage">
      ${S.state === 'picking' ? qCard : ''}
      <div class="status">${status}</div>
    </section>
    ${table ? `<section style="margin-bottom:26px">${table}</section>` : ''}
    ${hand}
    ${reactBar()}`;

  // vira as cartas recém-reveladas
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('.sub[data-shown="true"]:not(.shown)').forEach(el => el.classList.add('shown'));
  }));

  // barra de tempo do resultado
  const bar = document.getElementById('tbar');
  if (bar && S.nextAt) {
    const total = 12000;
    const left = Math.max(0, S.nextAt - (Date.now() + clockOffset));
    bar.style.transform = `scaleX(${left / total})`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = `transform ${left}ms linear`;
      bar.style.transform = 'scaleX(0)';
    }));
  }
}

// ---------- FIM DE JOGO ----------
function renderOver() {
  const ranking = [...S.players.map(p => ({ ...p })), ...(S.rando ? [{ id: 'rando', name: 'Carta do Monte', avatar: '🎲', color: '#cfcfe0', score: S.rando.score, won: [] }] : [])]
    .sort((a, b) => b.score - a.score);
  const champ = ranking[0];
  const tie = ranking.length > 1 && ranking[1].score === champ.score;
  const r = S.round;
  $app.innerHTML = `
    ${topbar()}
    <section class="panel over">
      <div style="font-size:60px">🏆</div>
      <h1>${tie ? 'Deu empate!' : `${esc(champ.name)} venceu!`}</h1>
      <p style="color:var(--ink-soft);font-weight:800;margin:0">${esc(S.message || (S.settings.target ? `Chegou a ${champ.score} pontos.` : 'Fim de jogo!'))}</p>
      <div class="podium">
        ${ranking.slice(0, 3).map((p, i) => `
          <div class="step p${i + 1}">
            ${avatarHTML({ ...p, isCzar: false }, 'lg')}
            <div class="nm">${esc(p.name)}</div>
            <div class="sc">${p.score} ${p.score === 1 ? 'ponto' : 'pontos'}</div>
            <div class="block">${i + 1}º</div>
          </div>`).join('')}
      </div>
      ${r?.winner ? `<div class="preview sentence" style="max-width:640px;margin:0 auto 22px"><span class="label">Jogada final de ${esc(r.winner.name)}</span>${fill(r.black.text, r.winner.cards)}</div>` : ''}
      ${S.me.isHost
        ? `<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn mint" data-act="start">🔁 Jogar de novo</button>
            <button class="btn ghost" data-act="tolobby">🏠 Voltar ao lobby</button></div>`
        : `<p style="font-weight:800;color:var(--ink-soft)">Esperando o anfitrião decidir a revanche<span class="dots"></span></p>`}
      <div class="trophies">
        ${ranking.filter(p => p.won?.length).map(p => `
          <div class="tw"><h4>${esc(p.avatar)} ${esc(p.name)}</h4>
          <ul>${p.won.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('')}
      </div>
    </section>
    ${reactBar()}`;
}

// ---------- render principal ----------
function render() {
  if (!S) return;
  if (S.message && S.message !== lastMsg) toast(S.message);
  lastMsg = S.message;

  const enteringResult = S.state === 'result' && prev.state !== 'result';
  const enteringOver = S.state === 'over' && prev.state !== 'over' && prev.state !== null;

  if (S.state === 'lobby') renderLobby();
  else if (S.state === 'over') renderOver();
  else renderGame();

  if (enteringResult) confetti(S.round?.winner?.ownerId === S.me.id ? 200 : 70);
  if (enteringOver) confetti(320);

  prev.state = S.state;
  prev.round = S.round?.n ?? null;
  prev.hand = new Set(S.me.hand.map(c => c.id));
  prev.shown = new Set((S.round?.reveal || []).filter(x => x.shown).map(x => x.sid));
}

// ---------- cliques ----------
const handlers = {
  avatar(el) {
    ui.avatar = el.dataset.v;
    document.querySelectorAll('.avatar-grid button').forEach(b => b.setAttribute('aria-pressed', b === el));
  },
  create: homeCreate,
  join: homeJoin,
  resume() { connect(store.get('session')); },
  copy() { ui.menuOpen = false; copyInvite(); if (S) render(); },
  menu() { ui.menuOpen = !ui.menuOpen; render(); },
  leave() {
    ui.menuOpen = false;
    if (!confirm('Sair da sala?')) { render(); return; }
    if (es) { es.close(); es = null; }
    act('leave').finally(() => leaveLocal('Você saiu da sala.'));
  },
  tolobby() {
    ui.menuOpen = false;
    if (S.state !== 'over' && !confirm('Encerrar a partida e voltar todos ao lobby?')) { render(); return; }
    act('lobby');
  },
  kick(el) { if (confirm(`Remover ${nameOf(el.dataset.id)} da sala?`)) act('kick', { id: el.dataset.id }); },
  target(el) { act('settings', { target: Number(el.dataset.v) }); },
  start() { act('start'); },
  addbot() { act('addbot'); },
  card(el) {
    const r = S.round;
    if (S.state !== 'picking' || r.czarId === S.me.id || r.mySubmission) return;
    const id = el.dataset.id;
    const pick = r.black.pick;
    const i = ui.selected.indexOf(id);
    if (i >= 0) ui.selected.splice(i, 1);
    else if (pick === 1) ui.selected = [id];
    else if (ui.selected.length < pick) ui.selected.push(id);
    else ui.selected[pick - 1] = id;
    render();
  },
  submit() { act('submit', { cards: ui.selected }); },
  undo() { act('undo'); },
  force() { act('force'); },
  sub(el) {
    if (el.dataset.shown !== 'true') act('reveal', { sid: el.dataset.sid });
    else { ui.chosen = el.dataset.sid; render(); }
  },
  revealnext() { act('reveal', {}); },
  choose() { if (ui.chosen) act('choose', { sid: ui.chosen }); },
  next() { act('next'); },
  react(el) { act('react', { emoji: el.dataset.v }); },
};

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) {
    if (ui.menuOpen && !e.target.closest('.menu')) { ui.menuOpen = false; render(); }
    return;
  }
  handlers[el.dataset.act]?.(el, e);
});

// ---------- confete ----------
function confetti(n) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = document.getElementById('confetti');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#ff5c28', '#16181d', '#9a9fab', '#2f6fed'];
  const parts = Array.from({ length: n }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 200, y: innerHeight * .35,
    vx: (Math.random() - .5) * 16, vy: -Math.random() * 14 - 4,
    s: 6 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * .3,
    c: colors[Math.floor(Math.random() * colors.length)], round: Math.random() < .3,
  }));
  let t = 0;
  (function frame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += .35; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.s / 2, 0, 7); ctx.fill(); }
      else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (++t < 200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })();
}

// ---------- início ----------
(function init() {
  const m = location.pathname.match(/^\/sala\/([A-Za-z]{4})\/?$/);
  const code = m ? m[1].toUpperCase() : null;
  const last = store.get('session');
  if (code && last?.code === code) connect(last);
  else renderHome(code);
})();
