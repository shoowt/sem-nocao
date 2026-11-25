// Sem Noção — servidor multiplayer (sem dependências)
// Rode com:  node server.js   (porta padrão 3000, ou defina PORT)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 6;
const HAND_SIZE = 10;
const RESULT_SECONDS = 12;          // tempo mostrando o vencedor antes da próxima rodada
const OFFLINE_GRACE_LOBBY = 15000;  // ms até remover quem caiu no lobby
const OFFLINE_GRACE_GAME = 90000;   // ms até remover quem caiu durante a partida
const WAIT_OFFLINE_MS = 20000;      // por quanto tempo a rodada ainda espera quem caiu (ex.: F5)

// ---------- Cartas ----------
const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cartas.json'), 'utf8'));
const BLACK = RAW.black.map((text, i) => ({
  id: 'b' + i,
  text,
  pick: Math.min(3, Math.max(1, (text.match(/____/g) || []).length)),
}));
const WHITE = [...new Set(RAW.white)].map((text, i) => ({ id: 'w' + i, text }));
const WHITE_BY_ID = new Map(WHITE.map(c => [c.id, c]));

const AVATARS = ['🐶', '🐱', '🦊', '🐸', '🐼', '🐨', '🐯', '🦄', '🐙', '🐧', '🦖', '👽', '🤡', '👻', '🐷', '🐵', '🦉', '🐢'];
const COLORS = ['#ff5c28', '#2f6fed', '#14a06f', '#e0a400', '#8a4fd8', '#d9364f'];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const uid = (n = 12) => crypto.randomBytes(n).toString('base64url');

// ---------- Salas ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    players: new Map(),   // id -> player
    order: [],            // ordem dos assentos (sentido horário)
    clients: new Map(),   // id -> Set<res>
    state: 'lobby',       // lobby | picking | judging | result | over
    settings: { target: 8, rando: false, firstCzar: 'random' },
    whiteDeck: [], whiteDiscard: [], blackDeck: [],
    czarIndex: 0,
    round: null,
    rando: { score: 0, won: [] },
    timer: null,
    lastActivity: Date.now(),
    message: null,
  };
  rooms.set(room.code, room);
  return room;
}

function drawWhite(room) {
  if (!room.whiteDeck.length) {
    room.whiteDeck = shuffle(room.whiteDiscard);
    room.whiteDiscard = [];
  }
  return room.whiteDeck.pop() || null;
}

function refill(room, p) {
  while (p.hand.length < HAND_SIZE) {
    const c = drawWhite(room);
    if (!c) break;
    p.hand.push(c);
  }
}

const randoActive = room => room.settings.rando || room.order.length === 2;

function addPlayer(room, name, avatar, isBot = false) {
  const usedColors = new Set([...room.players.values()].map(p => p.color));
  const p = {
    id: uid(6),
    token: uid(18),
    name,
    avatar: AVATARS.includes(avatar) ? avatar : AVATARS[crypto.randomInt(AVATARS.length)],
    color: COLORS.find(c => !usedColors.has(c)) || COLORS[0],
    hand: [],
    score: 0,
    won: [],
    offlineTimer: null,
    isBot,
    botTimer: null,
  };
  room.players.set(p.id, p);
  room.order.push(p.id);
  if (!room.hostId) room.hostId = p.id;
  if (room.state !== 'lobby' && room.state !== 'over') refill(room, p);
  return p;
}

function removePlayer(room, id, reason) {
  const p = room.players.get(id);
  if (!p) return;
  clearTimeout(p.offlineTimer);
  clearTimeout(p.botTimer);
  const seat = room.order.indexOf(id);
  room.whiteDiscard.push(...p.hand);
  room.players.delete(id);
  room.order.splice(seat, 1);
  for (const res of room.clients.get(id) || []) {
    try { res.write(`event: kicked\ndata: ${JSON.stringify({ reason })}\n\n`); res.end(); } catch {}
  }
  room.clients.delete(id);

  if (!room.order.length) { destroyRoom(room); return; }
  if (room.hostId === id) room.hostId = room.order[0];
  // mantém o juiz atual no lugar certo depois de tirar alguém de antes dele
  if (seat < room.czarIndex || (seat === room.czarIndex && room.state === 'result')) room.czarIndex--;

  const r = room.round;
  if (r && (room.state === 'picking' || room.state === 'judging')) {
    if (room.order.length < 2) {
      cancelRound(room);
      room.state = 'lobby';
      room.message = 'Jogadores insuficientes — de volta ao lobby.';
    } else if (r.czarId === id) {
      cancelRound(room);
      room.message = `${p.name} (juiz) saiu. Nova rodada!`;
      startRound(room, true);
    } else {
      const sub = r.submissions.get(id);
      if (sub) {
        r.submissions.delete(id);
        room.whiteDiscard.push(...sub);
        r.reveal = r.reveal.filter(x => x.ownerId !== id);
        if (room.state === 'judging' && r.reveal.length === 0) {
          cancelRound(room);
          startRound(room, true);
        }
      }
      checkAllSubmitted(room);
    }
  } else if (room.order.length < 2 && room.state !== 'lobby') {
    clearTimeout(room.timer);
    room.state = 'lobby';
  }
  broadcast(room);
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  for (const p of room.players.values()) clearTimeout(p.offlineTimer);
  rooms.delete(room.code);
}

// ---------- Rodadas ----------
function startGame(room) {
  room.whiteDeck = shuffle([...WHITE]);
  room.whiteDiscard = [];
  room.blackDeck = shuffle([...BLACK]);
  room.rando = { score: 0, won: [] };
  for (const p of room.players.values()) { p.hand = []; p.score = 0; p.won = []; }
  const fc = room.settings.firstCzar;
  room.czarIndex = room.order.includes(fc) ? room.order.indexOf(fc) : crypto.randomInt(room.order.length);
  room.round = null;
  room.roundNumber = 0;
  room.message = null;
  startRound(room, false);
}

function startRound(room, keepCzar) {
  clearTimeout(room.timer);
  if (!keepCzar && room.round) room.czarIndex++;
  room.czarIndex = ((room.czarIndex % room.order.length) + room.order.length) % room.order.length;
  const black = room.blackDeck.pop();
  if (!black) { endGame(room, 'Acabaram as cartas pretas!'); return; }
  for (const id of room.order) refill(room, room.players.get(id));
  room.roundNumber = (room.roundNumber || 0) + 1;
  room.round = {
    n: room.roundNumber,
    czarId: room.order[room.czarIndex],
    black,
    submissions: new Map(), // playerId -> [cards]
    reveal: [],             // [{sid, ownerId, cards, shown}]
    winner: null,
  };
  room.state = 'picking';
}

function cancelRound(room) {
  const r = room.round;
  if (!r) return;
  // devolve as cartas jogadas para a mão de quem jogou
  for (const [pid, cards] of r.submissions) {
    const p = room.players.get(pid);
    if (p) p.hand.push(...cards); else room.whiteDiscard.push(...cards);
  }
  r.submissions.clear();
  r.reveal = [];
  room.blackDeck.unshift(r.black); // carta preta volta pro fundo do monte
}

const isOnline = (room, id) => !!room.players.get(id)?.isBot || (room.clients.get(id)?.size || 0) > 0;
// quem caiu há pouco ainda conta como presente (dá tempo de recarregar a página)
const isPresent = (room, id) => isOnline(room, id) || Date.now() - (room.players.get(id)?.offlineSince || 0) < WAIT_OFFLINE_MS;

function checkAllSubmitted(room) {
  const r = room.round;
  if (room.state !== 'picking' || !r) return;
  const pending = room.order.filter(id => id !== r.czarId && isPresent(room, id) && !r.submissions.has(id));
  if (pending.length === 0 && r.submissions.size > 0) beginJudging(room);
}

function beginJudging(room) {
  const r = room.round;
  const entries = [...r.submissions].map(([ownerId, cards]) => ({ ownerId, cards }));
  if (randoActive(room)) {
    const cards = [];
    for (let i = 0; i < r.black.pick; i++) { const c = drawWhite(room); if (c) cards.push(c); }
    if (cards.length === r.black.pick) entries.push({ ownerId: 'rando', cards });
  }
  r.reveal = shuffle(entries).map(e => ({ ...e, sid: uid(5), shown: false }));
  room.state = 'judging';
}

function pickWinner(room, sid) {
  const r = room.round;
  const entry = r.reveal.find(e => e.sid === sid);
  if (!entry) return;
  let winnerName, winnerAvatar, score;
  if (entry.ownerId === 'rando') {
    room.rando.score++; room.rando.won.push(r.black);
    winnerName = 'Carta do Monte'; winnerAvatar = '🎲'; score = room.rando.score;
  } else {
    const p = room.players.get(entry.ownerId);
    p.score++; p.won.push(r.black);
    winnerName = p.name; winnerAvatar = p.avatar; score = p.score;
  }
  r.winner = { sid, ownerId: entry.ownerId, name: winnerName, avatar: winnerAvatar, cards: entry.cards };
  for (const e of r.reveal) { e.shown = true; room.whiteDiscard.push(...e.cards); }
  r.submissions.clear();

  const target = room.settings.target;
  if (target > 0 && score >= target) { endGame(room, null); return; }
  if (!room.blackDeck.length) { endGame(room, 'Acabaram as cartas pretas!'); return; }
  room.state = 'result';
  room.nextAt = Date.now() + RESULT_SECONDS * 1000;
  room.timer = setTimeout(() => { if (room.state === 'result') { startRound(room, false); broadcast(room); } }, RESULT_SECONDS * 1000);
}

function endGame(room, reason) {
  clearTimeout(room.timer);
  room.state = 'over';
  room.message = reason;
}

// ---------- Visão de cada jogador ----------
function viewFor(room, meId) {
  const me = room.players.get(meId);
  const r = room.round;
  const players = room.order.map(id => {
    const p = room.players.get(id);
    return {
      id, name: p.name, avatar: p.avatar, color: p.color, score: p.score,
      online: isOnline(room, id),
      isBot: p.isBot,
      isHost: id === room.hostId,
      isCzar: !!r && r.czarId === id && room.state !== 'lobby',
      submitted: !!r && room.state === 'picking' && r.submissions.has(id),
      won: p.won.map(b => b.text),
    };
  });
  let round = null;
  if (r && room.state !== 'lobby') {
    const mine = r.submissions.get(meId);
    round = {
      n: r.n,
      czarId: r.czarId,
      black: { text: r.black.text, pick: r.black.pick },
      submittedCount: r.submissions.size,
      waitingFor: room.order.filter(id => id !== r.czarId && !r.submissions.has(id)),
      mySubmission: mine ? mine.map(c => c.text) : null,
      reveal: room.state === 'picking' ? [] : r.reveal.map(e => ({
        sid: e.sid,
        shown: e.shown,
        mine: e.ownerId === meId,
        cards: e.shown || e.ownerId === meId ? e.cards.map(c => c.text) : null,
        owner: room.state === 'result' || room.state === 'over'
          ? (e.ownerId === 'rando' ? { name: 'Carta do Monte', avatar: '🎲' } : (() => { const o = room.players.get(e.ownerId); return o ? { name: o.name, avatar: o.avatar } : null; })())
          : null,
      })),
      winner: r.winner ? { sid: r.winner.sid, name: r.winner.name, avatar: r.winner.avatar, ownerId: r.winner.ownerId, cards: r.winner.cards.map(c => c.text) } : null,
    };
  }
  return {
    code: room.code,
    state: room.state,
    me: me ? { id: me.id, isHost: me.id === room.hostId, hand: me.hand.map(c => ({ id: c.id, text: c.text })) } : null,
    settings: room.settings,
    randoActive: randoActive(room),
    rando: randoActive(room) || room.rando.score ? { score: room.rando.score } : null,
    players,
    round,
    nextAt: room.state === 'result' ? room.nextAt : null,
    deck: { black: room.blackDeck.length, white: room.whiteDeck.length + room.whiteDiscard.length },
    message: room.message,
    maxPlayers: MAX_PLAYERS,
    serverNow: Date.now(),
  };
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- Bots ----------
const BOT_NAMES = [['Robozão', '🤖'], ['Bia Bot', '🦊'], ['Caio Bot', '🐸'], ['Duda Bot', '🦄'], ['Edu Bot', '🐙'], ['Fê Bot', '🐧']];

function scheduleBots(room) {
  const r = room.round;
  if (!r) return;
  for (const p of room.players.values()) {
    if (!p.isBot || p.botTimer) continue;
    let fn = null, delay = 0;
    if (room.state === 'picking' && r.czarId !== p.id && !r.submissions.has(p.id)) {
      delay = 1500 + crypto.randomInt(3000);
      fn = () => {
        if (room.state !== 'picking' || room.round !== r || r.submissions.has(p.id)) return;
        const cards = shuffle([...p.hand]).slice(0, r.black.pick);
        p.hand = p.hand.filter(c => !cards.includes(c));
        r.submissions.set(p.id, cards);
        checkAllSubmitted(room);
      };
    } else if (room.state === 'judging' && r.czarId === p.id) {
      delay = 1400 + crypto.randomInt(800);
      fn = () => {
        if (room.state !== 'judging' || room.round !== r) return;
        const hidden = r.reveal.find(e => !e.shown);
        if (hidden) hidden.shown = true;
        else pickWinner(room, r.reveal[crypto.randomInt(r.reveal.length)].sid);
      };
    }
    if (fn) p.botTimer = setTimeout(() => {
      p.botTimer = null;
      if (!room.players.has(p.id)) return;
      fn();
      broadcast(room);
    }, delay);
  }
}

function broadcast(room) {
  if (!rooms.has(room.code)) return;
  scheduleBots(room);
  room.lastActivity = Date.now();
  for (const [id, set] of room.clients) {
    const view = viewFor(room, id);
    for (const res of set) { try { send(res, 'state', view); } catch {} }
  }
}

// ---------- Ações ----------
function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

const actions = {
  settings(room, p, a) {
    if (p.id !== room.hostId || room.state !== 'lobby') return 'Só o anfitrião muda as regras no lobby.';
    const s = room.settings;
    if ([0, 3, 5, 8, 10, 15].includes(a.target)) s.target = a.target;
    if (typeof a.rando === 'boolean') s.rando = a.rando;
    if (a.firstCzar === 'random' || room.players.has(a.firstCzar)) s.firstCzar = a.firstCzar;
  },
  start(room, p) {
    if (p.id !== room.hostId) return 'Só o anfitrião pode começar.';
    if (room.state !== 'lobby' && room.state !== 'over') return 'O jogo já começou.';
    if (room.order.length < 2) return 'Precisa de pelo menos 2 jogadores.';
    startGame(room);
  },
  submit(room, p, a) {
    const r = room.round;
    if (room.state !== 'picking') return 'Não é hora de jogar cartas.';
    if (r.czarId === p.id) return 'O juiz não joga cartas nesta rodada.';
    if (r.submissions.has(p.id)) return 'Você já jogou.';
    const ids = Array.isArray(a.cards) ? a.cards : [];
    if (ids.length !== r.black.pick || new Set(ids).size !== ids.length) return `Escolha ${r.black.pick} carta(s).`;
    const cards = ids.map(id => p.hand.find(c => c.id === id));
    if (cards.some(c => !c)) return 'Carta inválida.';
    p.hand = p.hand.filter(c => !ids.includes(c.id));
    r.submissions.set(p.id, cards);
    checkAllSubmitted(room);
  },
  undo(room, p) {
    const r = room.round;
    if (room.state !== 'picking' || !r.submissions.has(p.id)) return 'Não dá pra desfazer agora.';
    p.hand.push(...r.submissions.get(p.id));
    r.submissions.delete(p.id);
  },
  force(room, p) {
    const r = room.round;
    if (p.id !== room.hostId && p.id !== r?.czarId) return 'Só o anfitrião ou o juiz.';
    if (room.state !== 'picking') return 'Nada para apressar.';
    if (r.submissions.size === 0 && !randoActive(room)) return 'Ninguém jogou ainda.';
    beginJudging(room);
  },
  reveal(room, p, a) {
    const r = room.round;
    if (room.state !== 'judging' || r.czarId !== p.id) return 'Só o juiz revela as cartas.';
    const e = r.reveal.find(x => x.sid === a.sid) || r.reveal.find(x => !x.shown);
    if (e) e.shown = true;
  },
  choose(room, p, a) {
    const r = room.round;
    if (room.state !== 'judging' || r.czarId !== p.id) return 'Só o juiz escolhe.';
    if (r.reveal.some(e => !e.shown)) return 'Revele todas as cartas antes de escolher.';
    pickWinner(room, a.sid);
  },
  next(room, p) {
    if (room.state !== 'result') return;
    if (p.id !== room.hostId && p.id !== room.round.czarId) return 'Só o anfitrião ou o juiz.';
    startRound(room, false);
  },
  lobby(room, p) {
    if (p.id !== room.hostId) return 'Só o anfitrião.';
    if (room.state === 'picking' || room.state === 'judging') cancelRound(room);
    clearTimeout(room.timer);
    room.state = 'lobby';
    room.round = null;
    room.message = null;
    for (const pl of room.players.values()) { pl.hand = []; }
  },
  addbot(room, p) {
    if (p.id !== room.hostId) return 'Só o anfitrião adiciona bots.';
    if (room.players.size >= MAX_PLAYERS) return `A sala está cheia (máximo ${MAX_PLAYERS}).`;
    const used = new Set([...room.players.values()].map(x => x.name));
    const [name, avatar] = BOT_NAMES.find(([n]) => !used.has(n)) || ['Bot ' + crypto.randomInt(100), '🤖'];
    addPlayer(room, name, avatar, true);
    room.message = `${name} entrou na sala!`;
  },
  kick(room, p, a) {
    if (p.id !== room.hostId || a.id === p.id) return 'Só o anfitrião remove jogadores.';
    const t = room.players.get(a.id);
    if (!t) return;
    room.message = `${t.name} foi removido(a).`;
    removePlayer(room, a.id, 'Você foi removido(a) pelo anfitrião.');
  },
  leave(room, p) {
    room.message = `${p.name} saiu da sala.`;
    removePlayer(room, p.id, 'Você saiu da sala.');
  },
  react(room, p, a) {
    const ok = ['😂', '💀', '🔥', '😱', '👏', '🤢', '😈', '❤️'];
    if (!ok.includes(a.emoji)) return;
    const now = Date.now();
    if (now - (p.lastReact || 0) < 400) return;
    p.lastReact = now;
    for (const set of room.clients.values())
      for (const res of set) { try { send(res, 'react', { emoji: a.emoji, name: p.name, color: p.color }); } catch {} }
    return 'noop';
  },
};

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 10000) { reject(new Error('grande demais')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function findPlayer(room, token) {
  if (!room || typeof token !== 'string') return null;
  for (const p of room.players.values()) if (p.token === token) return p;
  return null;
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA: qualquer rota desconhecida (ex.: /sala/ABCD) volta para o index
      if (!path.extname(file)) return serveStatic(req, res, '/index.html');
      res.writeHead(404); return res.end('Não encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;
  try {
    if (req.method === 'POST' && route === '/api/create') {
      const b = await readBody(req);
      const name = cleanName(b.name);
      if (!name) return json(res, 400, { error: 'Digite seu nome.' });
      const room = createRoom();
      const p = addPlayer(room, name, b.avatar);
      return json(res, 200, { code: room.code, token: p.token, id: p.id });
    }

    if (req.method === 'POST' && route === '/api/join') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase().trim());
      if (!room) return json(res, 404, { error: 'Sala não encontrada. Confira o código.' });
      const existing = findPlayer(room, b.token);
      if (existing) return json(res, 200, { code: room.code, token: existing.token, id: existing.id });
      const name = cleanName(b.name);
      if (!name) return json(res, 400, { error: 'Digite seu nome.' });
      if (room.players.size >= MAX_PLAYERS) return json(res, 409, { error: `A sala está cheia (máximo ${MAX_PLAYERS}).` });
      if ([...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase()))
        return json(res, 409, { error: 'Já tem alguém com esse nome na sala.' });
      const p = addPlayer(room, name, b.avatar);
      room.message = `${p.name} entrou na sala!`;
      broadcast(room);
      return json(res, 200, { code: room.code, token: p.token, id: p.id });
    }

    if (req.method === 'GET' && route === '/api/events') {
      const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
      const p = findPlayer(room, url.searchParams.get('token'));
      if (!p) return json(res, 404, { error: 'Sessão inválida.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      if (!room.clients.has(p.id)) room.clients.set(p.id, new Set());
      room.clients.get(p.id).add(res);
      clearTimeout(p.offlineTimer);
      broadcast(room);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
      req.on('close', () => {
        clearInterval(ping);
        const set = room.clients.get(p.id);
        if (!set) return;
        set.delete(res);
        if (set.size === 0 && room.players.has(p.id)) {
          const grace = room.state === 'lobby' || room.state === 'over' ? OFFLINE_GRACE_LOBBY : OFFLINE_GRACE_GAME;
          p.offlineTimer = setTimeout(() => {
            if (!isOnline(room, p.id) && room.players.has(p.id)) {
              room.message = `${p.name} caiu e saiu da sala.`;
              removePlayer(room, p.id, 'Você ficou offline por muito tempo.');
            }
          }, grace);
          p.offlineSince = Date.now();
          setTimeout(() => {
            if (rooms.has(room.code) && !isOnline(room, p.id)) { checkAllSubmitted(room); broadcast(room); }
          }, WAIT_OFFLINE_MS + 200);
          broadcast(room);
        }
      });
      return;
    }

    if (req.method === 'POST' && route === '/api/action') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase());
      const p = findPlayer(room, b.token);
      if (!p) return json(res, 404, { error: 'Sessão inválida.' });
      const fn = actions[b.type];
      if (!fn) return json(res, 400, { error: 'Ação desconhecida.' });
      room.message = null;
      const err = fn(room, p, b);
      if (err && err !== 'noop') return json(res, 400, { error: err });
      if (err !== 'noop') broadcast(room);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') return serveStatic(req, res, route);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Erro no servidor.' });
  }
});

// limpa salas abandonadas
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.clients.values()].some(s => s.size);
    if (!anyone && now - room.lastActivity > 30 * 60 * 1000) destroyRoom(room);
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`\n  🃏  Sem Noção rodando!\n`);
  console.log(`  Neste computador:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || [])
      if (a.family === 'IPv4' && !a.internal) console.log(`  Na mesma rede Wi-Fi: http://${a.address}:${PORT}`);
  console.log(`\n  ${BLACK.length} cartas pretas · ${WHITE.length} cartas brancas\n`);
});
