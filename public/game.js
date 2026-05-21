'use strict';

const socket = io();
let state    = null;
let mySeat   = null;
let prevActions = {};
let prevHandNum = 0;

// ─── Toast ────────────────────────────────────────────────────────────────────

const _tc = document.createElement('div');
_tc.id = 'toast-container';
document.body.appendChild(_tc);

function showToast(msg, type) {
  const colors = { fold:'#555', check:'#2471a3', call:'#2471a3', raise:'#d35400', allin:'#c0392b' };
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.borderLeftColor = colors[type] || '#27ae60';
  t.textContent = msg;
  _tc.appendChild(t);
  setTimeout(() => t.remove(), 2300);
}

// ─── Lobby ───────────────────────────────────────────────────────────────────

function randCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

document.getElementById('btn-join').addEventListener('click', join);
document.getElementById('inp-name').addEventListener('keydown', e => e.key === 'Enter' && join());
document.getElementById('inp-room').addEventListener('keydown', e => e.key === 'Enter' && join());

function join() {
  const name = document.getElementById('inp-name').value.trim();
  const room = document.getElementById('inp-room').value.trim().toUpperCase() || randCode();
  if (!name) { showLobbyErr('이름을 입력하세요'); return; }
  socket.emit('join-room', { roomCode: room, playerName: name });
}

function showLobbyErr(msg) {
  document.getElementById('lobby-err').textContent = msg;
}

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('state', (s) => {
  // Detect action changes → show toasts
  if (s.handNumber !== prevHandNum) { prevActions = {}; prevHandNum = s.handNumber; }
  s.players.forEach(p => {
    if (p.lastAction && p.lastAction !== (prevActions[p.seat] || '')) {
      const la = p.lastAction;
      const type = la.startsWith('폴드') ? 'fold'
        : la.startsWith('체크') ? 'check'
        : la.startsWith('콜')   ? 'call'
        : la.startsWith('레이즈') ? 'raise'
        : la.startsWith('올인') ? 'allin' : '';
      showToast(`${p.name}: ${la}`, type);
      prevActions[p.seat] = la;
    }
  });

  state = s;
  const me = s.players.find(p => p.isMe);
  if (me) mySeat = me.seat;

  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display  = 'flex';

  document.getElementById('room-code-disp').textContent = s.roomCode;
  document.getElementById('hand-num').textContent        = s.handNumber;
  document.getElementById('street-label').textContent    = streetKo(s.street);

  renderBoard(s);
  renderSeats(s);
  renderControls(s);
  renderMeta(s);
  renderLog(s);
  renderShowdown(s);
});

socket.on('err', (msg) => {
  showLobbyErr(msg);
  alert(msg);
});

// ─── Board ────────────────────────────────────────────────────────────────────

function renderBoard(s) {
  const cc = document.getElementById('community-cards');
  cc.innerHTML = '';
  s.communityCards.forEach(c => cc.appendChild(cardEl(c)));
  document.getElementById('pot-display').textContent = `팟: ${fmt(s.pot)}`;
}

// ─── Seats ────────────────────────────────────────────────────────────────────

function renderSeats(s) {
  const area = document.getElementById('seats-area');
  area.innerHTML = '';

  s.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'seat'
      + (p.isMe           ? ' mine'       : '')
      + (p.seat === s.actionSeat ? ' active'  : '')
      + (p.folded         ? ' folded'     : '')
      + (!p.connected     ? ' offline'    : '');

    // Badges
    let badges = '';
    if (p.seat === s.dealerSeat) badges += '<span class="badge d">D</span>';
    if (p.seat === s.sbSeat)     badges += '<span class="badge sb">SB</span>';
    if (p.seat === s.bbSeat)     badges += '<span class="badge bb">BB</span>';

    // Status tag
    let statusTag = '';
    if (p.folded)       statusTag = '<span class="stag fold">FOLD</span>';
    else if (p.allIn)   statusTag = '<span class="stag allin">ALL-IN</span>';
    else if (!p.connected) statusTag = '<span class="stag disc">OFFLINE</span>';

    // Last action badge
    let lastActionBadge = '';
    if (p.lastAction) {
      const la  = p.lastAction;
      const cls = la.startsWith('폴드') ? 'la-fold'
        : la.startsWith('체크') ? 'la-check'
        : la.startsWith('콜')   ? 'la-call'
        : la.startsWith('레이즈') ? 'la-raise'
        : la.startsWith('올인') ? 'la-allin' : '';
      lastActionBadge = `<span class="last-action ${cls}">${esc(la)}</span>`;
    }

    // Cards
    let cardsHtml = '';
    if (p.holeCards && p.holeCards.length) {
      p.holeCards.forEach(c => {
        cardsHtml += cardEl(c).outerHTML;
      });
    }

    div.innerHTML = `
      <div class="seat-top">${badges}${statusTag}${lastActionBadge}</div>
      <div class="seat-name">${esc(p.name)}${p.isMe ? ' <em>(나)</em>' : ''}</div>
      <div class="seat-chips">${p.isMe ? '내 칩' : '칩'} ${fmt(p.chips)}</div>
      ${p.bet > 0 ? `<div class="seat-bet">배팅 ${fmt(p.bet)}</div>` : ''}
      <div class="seat-cards">${cardsHtml}</div>
    `;
    area.appendChild(div);
  });
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function renderControls(s) {
  const ctrl = document.getElementById('controls');
  const me   = s.players.find(p => p.isMe);

  if (!me || me.seat !== s.actionSeat || me.folded || me.allIn
      || s.street === 'waiting' || s.street === 'showdown') {
    ctrl.style.display = 'none';
    return;
  }
  ctrl.style.display = 'flex';

  const toCall = s.currentBet - me.bet;
  const canCheck = toCall <= 0;

  document.getElementById('btn-fold').style.display = canCheck ? 'none' : 'inline-block';
  document.getElementById('btn-check-call').textContent =
    canCheck ? '체크' : `콜  ${fmt(toCall)}`;

  const maxBet  = me.chips + me.bet;
  const minTotal = s.minRaise;

  const ri = document.getElementById('raise-inp');
  ri.min   = minTotal;
  ri.max   = maxBet;
  if (!ri.value || parseInt(ri.value) < minTotal) ri.value = minTotal;

  // Hide raise if can't afford minimum
  const raiseRow = document.getElementById('raise-row');
  raiseRow.style.display = maxBet > s.currentBet ? 'flex' : 'none';

  document.getElementById('action-label').textContent =
    `내 차례 | 칩 ${fmt(me.chips)} | 현재 최고 배팅 ${fmt(s.currentBet)}  |  최소 레이즈 ${fmt(minTotal)}`;
}

// ─── Meta buttons ─────────────────────────────────────────────────────────────

function renderMeta(s) {
  const me = s.players.find(p => p.isMe);

  const btnStart = document.getElementById('btn-start');
  btnStart.style.display = (s.street === 'waiting' && !s.started) || s.street === 'waiting'
    ? 'inline-block' : 'none';

  const btnRebuy = document.getElementById('btn-rebuy');
  btnRebuy.style.display =
    (me && (me.chips === 0 || s.street === 'waiting' || s.street === 'showdown'))
      ? 'inline-block' : 'none';
}

// ─── Showdown overlay ─────────────────────────────────────────────────────────

function renderShowdown(s) {
  const overlay = document.getElementById('showdown-overlay');
  const box     = document.getElementById('showdown-box');

  if (!s.showdownData) { overlay.style.display = 'none'; return; }
  overlay.style.display = 'flex';

  const sd = s.showdownData;
  let html = '<h2>쇼다운</h2>';

  if (sd.hands && sd.hands.length) {
    html += '<table class="sd-table"><tr><th>플레이어</th><th>패</th><th>핸드</th></tr>';
    sd.hands.forEach(h => {
      html += `<tr>
        <td>${esc(h.name)}</td>
        <td>${h.holeCards.map(c => cardEl(c).outerHTML).join(' ')}</td>
        <td>${esc(h.handName)}</td>
      </tr>`;
    });
    html += '</table>';
  }

  html += '<div class="sd-winners">';
  sd.winners.forEach(w => {
    html += `<div class="sd-winner">🏆 ${esc(w.name)} +${fmt(w.amount)}칩${w.handName ? ' (' + esc(w.handName) + ')' : ''}</div>`;
  });
  html += '</div>';

  box.innerHTML = html;
}

// ─── Log ──────────────────────────────────────────────────────────────────────

function renderLog(s) {
  const list = document.getElementById('log-list');
  list.innerHTML = s.log.map(m => `<div class="log-entry">${esc(m)}</div>`).join('');
}

// ─── Action Buttons ───────────────────────────────────────────────────────────

document.getElementById('btn-fold').addEventListener('click', () =>
  socket.emit('action', { action: 'fold' }));

document.getElementById('btn-check-call').addEventListener('click', () => {
  if (!state) return;
  const me     = state.players.find(p => p.isMe);
  const toCall = state.currentBet - (me ? me.bet : 0);
  socket.emit('action', { action: toCall <= 0 ? 'check' : 'call' });
});

document.getElementById('btn-raise').addEventListener('click', () => {
  const amount = parseInt(document.getElementById('raise-inp').value);
  if (isNaN(amount)) return;
  socket.emit('action', { action: 'raise', amount });
});

document.getElementById('btn-allin').addEventListener('click', () =>
  socket.emit('action', { action: 'allin' }));

document.getElementById('btn-start').addEventListener('click', () =>
  socket.emit('start-game'));

document.getElementById('btn-rebuy').addEventListener('click', () =>
  socket.emit('rebuy'));

// ─── Card Rendering ───────────────────────────────────────────────────────────

const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_CLASS  = { s: 'spade', h: 'heart', d: 'diamond', c: 'club' };

function cardEl(card) {
  const el = document.createElement('span');
  if (!card || card === '??' || card === 'back') {
    el.className   = 'card back';
    el.textContent = '🂠';
    return el;
  }
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  el.className   = `card ${SUIT_CLASS[suit] || ''}`;
  el.textContent = `${rank}${SUIT_SYMBOL[suit] || suit}`;
  return el;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmt(n) { return Number(n).toLocaleString(); }
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function streetKo(s) {
  return { waiting:'대기중', preflop:'프리플랍', flop:'플랍',
           turn:'턴', river:'리버', showdown:'쇼다운' }[s] || s;
}
