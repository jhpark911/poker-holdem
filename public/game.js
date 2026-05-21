'use strict';

// ─── Core Utilities (defined first — used everywhere) ─────────────────────────

function el(id)  { return document.getElementById(id); }
function fmt(n)  { return Number(n).toLocaleString(); }
function esc(s)  {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function streetKo(s) {
  return { waiting:'대기중', preflop:'프리플랍', flop:'플랍',
           turn:'턴', river:'리버', showdown:'쇼다운' }[s] || s;
}

// ─── Korean Hand Description ──────────────────────────────────────────────────

const RANK_KO = {
  'A':'에이스','K':'킹','Q':'퀸','J':'잭','T':'10',
  '9':'9','8':'8','7':'7','6':'6','5':'5','4':'4','3':'3','2':'2'
};
function rankKo(s) { return RANK_KO[s.charAt(0)] || s.charAt(0); }

function handDescrKo(handName, descr) {
  if (!descr) return handName;
  let m;
  if (descr === 'Royal Flush') return '로열 플러시';
  if ((m = descr.match(/Straight Flush,\s*(\S+)\s*High/)))  return rankKo(m[1]) + ' 하이 스트레이트 플러시';
  if ((m = descr.match(/Four of a Kind,\s*(\S+)/)))          return rankKo(m[1]) + ' 포카드';
  if ((m = descr.match(/Full House,\s*(\S+)'s over (\S+)/))) return rankKo(m[1]) + ' 풀 오브 ' + rankKo(m[2]);
  if ((m = descr.match(/Flush,\s*(\S+)\s*High/)))            return m[1].charAt(0) === 'A' ? '넛 플러시' : rankKo(m[1]) + ' 하이 플러시';
  if ((m = descr.match(/Straight,\s*(\S+)\s*High/)))         return rankKo(m[1]) + ' 하이 스트레이트';
  if ((m = descr.match(/Three of a Kind,\s*(\S+)/)))         return rankKo(m[1]) + ' 트리플';
  if ((m = descr.match(/Two Pair,\s*(\S+)'s\s*&\s*(\S+)/))) return rankKo(m[1]) + ' / ' + rankKo(m[2]) + ' 투 페어';
  if ((m = descr.match(/Pair,\s*(\S+)/)))                    return rankKo(m[1]) + ' 원 페어';
  if ((m = descr.match(/^(\S+)\s*High$/)))                   return rankKo(m[1]) + ' 하이';
  return descr;
}

const socket = io();
let state       = null;
let mySeat      = null;
let prevActions = {};
let prevHandNum = 0;
let prevCommLen = 0;
let timerInterval      = null;
let audioCtx           = null;
let showdownRevealTime = null;
let lastShowdownHand   = -1;
let showdownTimer      = null;

// ─── Audio (Web Audio API) ────────────────────────────────────────────────────

function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, type, duration, vol = 0.25, startDelay = 0) {
  try {
    const ctx  = getAudio();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + startDelay);
    gain.gain.setValueAtTime(vol, ctx.currentTime + startDelay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startDelay + duration);
    osc.start(ctx.currentTime + startDelay);
    osc.stop(ctx.currentTime + startDelay + duration);
  } catch(e) {}
}

function soundMyTurn() {
  playTone(880, 'sine', 0.15, 0.35);
  playTone(1100,'sine', 0.15, 0.3, 0.16);
}

function soundCardDeal() {
  playTone(300, 'triangle', 0.07, 0.2);
  playTone(250, 'triangle', 0.06, 0.15, 0.06);
}

function soundWin() {
  playTone(523, 'sine', 0.2, 0.35);
  playTone(659, 'sine', 0.2, 0.35, 0.18);
  playTone(784, 'sine', 0.3, 0.4,  0.36);
}

// ─── Toast ────────────────────────────────────────────────────────────────────

const _tc = document.createElement('div');
_tc.id = 'toast-container';
document.body.appendChild(_tc);

function showToast(msg, type) {
  const colors = { fold:'#555', check:'#1a5fa8', call:'#1a5fa8', raise:'#b84800', allin:'#b03020', win:'#b8860b' };
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
  getAudio(); // unlock AudioContext on first user gesture
  const name = document.getElementById('inp-name').value.trim();
  const room = document.getElementById('inp-room').value.trim().toUpperCase() || randCode();
  if (!name) { showLobbyErr('이름을 입력하세요'); return; }
  socket.emit('join-room', { roomCode: room, playerName: name });
}

function showLobbyErr(msg) {
  document.getElementById('lobby-err').textContent = msg;
}

// ─── Timer UI ─────────────────────────────────────────────────────────────────

function startTimerUI(actionStartTime, cfgTimer) {
  stopTimerUI();
  if (!cfgTimer || !actionStartTime) return;
  const wrap  = document.getElementById('timer-wrap');
  const bar   = document.getElementById('timer-bar');
  const label = document.getElementById('timer-label');
  if (!wrap) return;
  wrap.style.display = 'flex';

  timerInterval = setInterval(() => {
    const elapsed   = (Date.now() - actionStartTime) / 1000;
    const remaining = Math.max(0, cfgTimer - elapsed);
    const pct       = (remaining / cfgTimer) * 100;

    bar.style.width = pct + '%';
    label.textContent = Math.ceil(remaining) + 's';

    if (pct > 50)       bar.style.background = '#27ae60';
    else if (pct > 25)  bar.style.background = '#f39c12';
    else                bar.style.background = '#c0392b';

    if (remaining <= 0) stopTimerUI();
  }, 100);
}

function stopTimerUI() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const wrap = document.getElementById('timer-wrap');
  if (wrap) wrap.style.display = 'none';
}

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('state', (s) => {
  const prevState = state;

  // Detect action changes → toast
  if (s.handNumber !== prevHandNum) { prevActions = {}; prevHandNum = s.handNumber; }
  s.players.forEach(p => {
    if (p.lastAction && p.lastAction !== (prevActions[p.seat] || '')) {
      const la   = p.lastAction;
      const type = la.startsWith('폴드') ? 'fold'
        : la.startsWith('체크') ? 'check'
        : la.startsWith('콜')   ? 'call'
        : la.startsWith('레이즈') ? 'raise'
        : la.startsWith('올인') ? 'allin' : '';
      showToast(`${p.name}: ${la}`, type);
      prevActions[p.seat] = la;
    }
  });

  // Sound: my turn
  const me = s.players.find(p => p.isMe);
  if (me && s.actionSeat === me.seat &&
      ['preflop','flop','turn','river'].includes(s.street) &&
      (!prevState || prevState.actionSeat !== me.seat)) {
    soundMyTurn();
  }

  // Sound: new community cards
  if (s.communityCards.length > prevCommLen) {
    soundCardDeal();
  }
  prevCommLen = s.communityCards.length;

  // Sound + toast: win
  if (s.showdownData && (!prevState || !prevState.showdownData)) {
    if (me && s.showdownData.winners.some(w => w.seat === me.seat)) {
      soundWin();
      showToast('승리! 🏆', 'win');
    }
  }

  state = s;
  if (me) mySeat = me.seat;

  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display  = 'flex';

  document.getElementById('room-code-disp').textContent = s.roomCode;
  document.getElementById('hand-num').textContent        = s.handNumber;
  document.getElementById('street-label').textContent    = streetKo(s.street);

  renderTable(s);
  renderControls(s);
  renderMeta(s);
  renderLog(s);
  renderShowdown(s);
  renderStats(s);
});

socket.on('err', (msg) => {
  showLobbyErr(msg);
  alert(msg);
});

socket.on('room-deleted', () => {
  state  = null;
  mySeat = null;
  el('game').style.display  = 'none';
  el('lobby').style.display = 'flex';
  el('inp-room').value = '';
  showLobbyErr('방이 삭제되었습니다.');
});

// ─── Oval Seat Positions ──────────────────────────────────────────────────────
// [left%, top%] — center of seat, relative to #table-wrap
// Seat 0 = me (bottom center), then clockwise

// Evenly distribute N players around the oval.
// i=0 (me) = 6 o'clock; subsequent seats spread clockwise.
// cx=50, cy=48, rx=42, ry=38 — slightly offset upward so bottom seat stays inside table-wrap
function seatPosition(idx, total) {
  const a = Math.PI - idx * (2 * Math.PI / total);
  return [
    Math.round((50 + 42 * Math.sin(a)) * 10) / 10,
    Math.round((48 - 38 * Math.cos(a)) * 10) / 10,
  ];
}

function ovalOrderedPlayers(players) {
  const me = players.find(p => p.isMe);
  if (!me) return players;
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const myIdx  = sorted.findIndex(p => p.seat === me.seat);
  const result = [];
  for (let i = 0; i < sorted.length; i++) {
    result.push(sorted[(myIdx + i) % sorted.length]);
  }
  return result;
}

// ─── Table Render ─────────────────────────────────────────────────────────────

function renderTable(s) {
  const wrap = document.getElementById('table-wrap');

  // Remove old seats
  wrap.querySelectorAll('.seat').forEach(el => el.remove());

  // Community cards
  const cc = document.getElementById('community-cards');
  const prevCards = Array.from(cc.children).map(el => el.dataset.card);
  cc.innerHTML = '';
  s.communityCards.forEach((c, i) => {
    const el = cardEl(c);
    el.dataset.card = c;
    if (i >= prevCards.length) el.classList.add('card-flip');
    cc.appendChild(el);
  });

  document.getElementById('pot-display').textContent =
    s.pot > 0 ? `팟: ${fmt(s.pot)}` : '';
  document.getElementById('street-indicator').textContent =
    ['preflop','flop','turn','river'].includes(s.street) ? streetKo(s.street).toUpperCase() : '';

  // Seats
  const ordered = ovalOrderedPlayers(s.players);
  ordered.forEach((p, i) => {
    const [lp, tp] = seatPosition(i, ordered.length);
    const div = buildSeat(p, s);
    div.style.left = lp + '%';
    div.style.top  = tp + '%';
    wrap.appendChild(div);
  });
}

function buildSeat(p, s) {
  const div = document.createElement('div');
  div.className = 'seat'
    + (p.isMe               ? ' mine'    : '')
    + (p.seat === s.actionSeat ? ' active' : '')
    + (p.folded             ? ' folded'  : '')
    + (!p.connected         ? ' offline' : '');

  // Winner flash
  if (s.showdownData && s.showdownData.winners.some(w => w.seat === p.seat)) {
    div.classList.add('winner-flash');
  }

  // Badges
  let badges = '';
  if (p.seat === s.hostSeat)   badges += '<span class="badge host">HOST</span>';
  if (p.seat === s.dealerSeat) badges += '<span class="badge d">D</span>';
  if (p.seat === s.sbSeat)     badges += '<span class="badge sb">SB</span>';
  if (p.seat === s.bbSeat)     badges += '<span class="badge bb">BB</span>';

  // Status tag
  let stag = '';
  if (p.folded)        stag = '<span class="stag fold">FOLD</span>';
  else if (p.allIn)    stag = '<span class="stag allin">ALL-IN</span>';
  else if (!p.connected) stag = '<span class="stag disc">OFFLINE</span>';
  if (p.isBot)         stag += '<span class="stag bot">BOT</span>';

  // Last action
  let la = '';
  if (p.lastAction) {
    const cls = p.lastAction.startsWith('폴드')    ? 'la-fold'
      : p.lastAction.startsWith('체크')            ? 'la-check'
      : p.lastAction.startsWith('콜')              ? 'la-call'
      : p.lastAction.startsWith('레이즈')           ? 'la-raise'
      : p.lastAction.startsWith('올인')             ? 'la-allin' : '';
    la = `<span class="last-action ${cls}">${esc(p.lastAction)}</span>`;
  }

  // Hole cards — only show my own cards; opponents are always hidden in seat panel
  let cardsHtml = '';
  if (p.isMe && p.holeCards && p.holeCards.length) {
    cardsHtml = p.holeCards.map(c => cardEl(c).outerHTML).join('');
  }

  // Chip stack visualization
  const chipHtml = renderChipStack(p.chips, s.cfgBB || 200);

  div.innerHTML = `
    <div class="seat-top">${badges}${stag}${la}</div>
    <div class="seat-name">${esc(p.name)}${p.isMe ? ' <em>(나)</em>' : ''}</div>
    <div class="seat-chips">${fmt(p.chips)}</div>
    ${p.bet > 0 ? `<div class="seat-bet">배팅 ${fmt(p.bet)}</div>` : ''}
    ${chipHtml}
    <div class="seat-cards">${cardsHtml}</div>
  `;
  return div;
}

// ─── Chip Stack Visualization ─────────────────────────────────────────────────

const CHIP_DENOMS = [
  { bb: 500, cls: 'chip-500bb', label: '500' },
  { bb: 100, cls: 'chip-100bb', label: '100' },
  { bb:  25, cls: 'chip-25bb',  label: '25'  },
  { bb:   5, cls: 'chip-5bb',   label: '5'   },
  { bb:   1, cls: 'chip-1bb',   label: '1'   },
];

function renderChipStack(chips, bbValue) {
  if (!chips || chips <= 0) return '';
  const totalBB = Math.round(chips / bbValue);
  let remaining = totalBB;
  const tokens  = [];

  for (const d of CHIP_DENOMS) {
    const count = Math.floor(remaining / d.bb);
    if (count > 0) {
      tokens.push({ ...d, count });
      remaining -= count * d.bb;
    }
  }

  if (!tokens.length) return '';

  const html = tokens.map(t =>
    `<span class="chip-token ${t.cls}" title="${t.count}×${t.label}BB">×${t.count}</span>`
  ).join('');

  return `<div class="chip-stack">${html}</div>`;
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function renderControls(s) {
  const ctrl = document.getElementById('controls');
  const me   = s.players.find(p => p.isMe);

  if (!me || me.seat !== s.actionSeat || me.folded || me.allIn
      || s.street === 'waiting' || s.street === 'showdown') {
    ctrl.style.display = 'none';
    stopTimerUI();
    return;
  }
  ctrl.style.display = 'flex';

  // Timer
  if (s.actionStartTime && s.cfgTimer > 0) {
    startTimerUI(s.actionStartTime, s.cfgTimer);
  } else {
    stopTimerUI();
  }

  const toCall   = s.currentBet - me.bet;
  const canCheck = toCall <= 0;

  document.getElementById('btn-fold').style.display =
    canCheck ? 'none' : 'inline-block';
  document.getElementById('btn-check-call').textContent =
    canCheck ? '체크' : `콜  ${fmt(toCall)}`;

  const maxBet   = me.chips + me.bet;
  const minTotal = s.minRaise;

  const ri = document.getElementById('raise-inp');
  ri.min   = minTotal;
  ri.max   = maxBet;
  if (!ri.value || parseInt(ri.value) < minTotal) ri.value = minTotal;

  const raiseRow = document.getElementById('raise-row');
  raiseRow.style.display = maxBet > s.currentBet ? 'flex' : 'none';

  const minLabel = document.getElementById('raise-min-label');
  if (minLabel) minLabel.textContent = maxBet > s.currentBet ? `최소 레이즈: ${fmt(minTotal)}칩` : '';

  // Preset bet buttons
  const livePot = s.pot;
  document.querySelectorAll('.preset-btn').forEach(btn => {
    const pct = parseInt(btn.dataset.pct);
    const val = Math.max(minTotal, Math.min(maxBet, Math.round(livePot * pct / 100 / 100) * 100));
    btn.onclick = () => { ri.value = val; };
  });

  document.getElementById('action-label').textContent =
    `내 차례 | 칩 ${fmt(me.chips)} | 콜 ${fmt(toCall)} | 최소 레이즈 ${fmt(minTotal)}`;
}

// ─── Meta buttons ─────────────────────────────────────────────────────────────

function renderMeta(s) {
  const me   = s.players.find(p => p.isMe);
  const bots = s.players.filter(p => p.isBot);
  const isWaiting  = s.street === 'waiting';
  const isHost     = me && me.seat === s.hostSeat;
  const inBetween  = isWaiting || s.street === 'showdown';

  el('btn-start').style.display      = isWaiting ? 'inline-block' : 'none';
  el('btn-rebuy').style.display      = (me && (me.chips === 0 || inBetween)) ? 'inline-block' : 'none';
  el('btn-add-bot').style.display    = inBetween && s.players.length < 9 ? 'inline-block' : 'none';
  el('btn-remove-bot').style.display = bots.length > 0 && inBetween ? 'inline-block' : 'none';
  el('btn-show-cfg').style.display    = isHost && isWaiting ? 'inline-block' : 'none';
  el('btn-delete-room').style.display = isHost && isWaiting ? 'inline-block' : 'none';

  // Update rebuy label with current cfgRebuy
  el('btn-rebuy').textContent = `리바이 (+${fmt(s.cfgRebuy)})`;

  // Fill settings inputs if visible
  if (isHost && isWaiting) {
    const cfgPanel = el('settings-panel');
    if (cfgPanel.style.display !== 'none') {
      setIfEmpty('cfg-sb',    s.cfgSB);
      setIfEmpty('cfg-bb',    s.cfgBB);
      setIfEmpty('cfg-start', s.cfgStartChips);
      setIfEmpty('cfg-rebuy', s.cfgRebuy);
      setIfEmpty('cfg-timer', s.cfgTimer);
    }
  }
}

function setIfEmpty(id, val) {
  const inp = document.getElementById(id);
  if (inp && !inp.dataset.dirty) inp.value = val;
}

// ─── Showdown overlay ─────────────────────────────────────────────────────────

function clearShowdownTimer() {
  if (showdownTimer) { clearInterval(showdownTimer); showdownTimer = null; }
}

function renderShowdown(s) {
  const overlay = el('showdown-overlay');
  const box     = el('showdown-box');

  if (!s.showdownData) { overlay.style.display = 'none'; clearShowdownTimer(); return; }
  overlay.style.display = 'flex';

  const sd             = s.showdownData;
  const isRealShowdown = sd.hands && sd.hands.length > 0;
  let html = '<h2>쇼다운 🃏</h2>';

  if (isRealShowdown) {
    html += '<div class="sd-hand-names">';
    sd.hands.forEach(h => {
      const ko  = handDescrKo(h.handName, h.handDescr || '');
      const win = sd.winners.some(w => w.seat === h.seat);
      html += `<div class="sd-hand-row${win ? ' sd-hand-winner' : ''}">
        <span class="sd-hand-player">${esc(h.name)}</span>
        <span class="sd-hand-label">${ko}</span>
      </div>`;
    });
    html += '</div>';

    if (s.communityCards && s.communityCards.length > 0) {
      html += '<div class="sd-board"><div class="sd-board-label">보드</div><div class="sd-board-cards">';
      s.communityCards.forEach(c => { html += cardEl(c).outerHTML; });
      html += '</div></div>';
    }

    html += '<table class="sd-table"><tr><th>플레이어</th><th>홀 카드</th></tr>';
    sd.hands.forEach(h => {
      html += `<tr>
        <td>${esc(h.name)}</td>
        <td>${h.holeCards.map(c => cardEl(c).outerHTML).join('')}</td>
      </tr>`;
    });
    html += '</table>';
  }

  html += '<div class="sd-winners">';
  sd.winners.forEach(w => {
    html += `<div class="sd-winner">🏆 ${esc(w.name)} +${fmt(w.amount)}${w.handName ? ' <span style="color:#aaa;font-size:.85em">('+esc(w.handName)+')</span>' : ''}</div>`;
  });
  html += '</div>';

  if (isRealShowdown) {
    html += `<div id="sd-countdown-wrap">
      <div id="sd-bar-bg"><div id="sd-bar"></div></div>
      <span id="sd-sec">20s</span>
    </div>`;
  }

  box.innerHTML = html;

  if (isRealShowdown) {
    if (s.handNumber !== lastShowdownHand) {
      lastShowdownHand   = s.handNumber;
      showdownRevealTime = Date.now();
      clearShowdownTimer();
      showdownTimer = setInterval(() => {
        const rem = Math.max(0, 20 - (Date.now() - showdownRevealTime) / 1000);
        const bar = el('sd-bar'), sec = el('sd-sec');
        if (bar) bar.style.width = (rem / 20 * 100) + '%';
        if (sec) sec.textContent = Math.ceil(rem) + 's';
        if (rem <= 0) { clearShowdownTimer(); overlay.style.display = 'none'; }
      }, 100);
    } else if (showdownRevealTime) {
      const rem = Math.max(0, 20 - (Date.now() - showdownRevealTime) / 1000);
      const bar = el('sd-bar'), sec = el('sd-sec');
      if (bar) bar.style.width = (rem / 20 * 100) + '%';
      if (sec) sec.textContent = Math.ceil(rem) + 's';
    }
  }
}

// ─── Stats Drawer ─────────────────────────────────────────────────────────────

function renderStats(s) {
  const content = document.getElementById('stats-content');
  if (!content) return;

  let html = '';

  // Player stats
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">플레이어 성적</div>';
  const players = [...s.players].sort((a, b) => {
    const na = a.chips - (a.buyIn || s.cfgStartChips);
    const nb = b.chips - (b.buyIn || s.cfgStartChips);
    return nb - na;
  });
  players.forEach(p => {
    const st  = s.stats[p.seat] || { wins: 0, totalWon: 0 };
    const buyIn = p.buyIn || s.cfgStartChips;
    const net   = p.chips - buyIn;
    const netStr   = (net >= 0 ? '+' : '-') + fmt(Math.abs(net));
    const netClass = net >= 0 ? 'stats-pos' : 'stats-neg';
    html += `<div class="stats-row">
      <span class="stats-name">${esc(p.name)}${p.isBot ? ' 🤖' : ''}</span>
      <div class="stats-detail">
        <span class="stats-chip-val">칩: ${fmt(p.chips)}</span>
        <span class="${netClass}">손익: ${netStr}</span>
        <span class="stats-buyin">바이인: ${fmt(buyIn)}</span>
        <span class="stats-win-small">${st.wins}승</span>
      </div>
    </div>`;
  });
  html += '</div>';

  // Hand history
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">최근 핸드 기록</div>';
  if (!s.handHistory || s.handHistory.length === 0) {
    html += '<div style="color:#555;font-size:.82rem">아직 기록 없음</div>';
  } else {
    s.handHistory.forEach(h => {
      html += `<div class="hist-entry">
        <div class="hist-hand">Hand #${h.handNumber}</div>`;
      h.winners.forEach(w => {
        html += `<div class="hist-winner">🏆 ${esc(w.name)} +${fmt(w.amount)}</div>`;
        if (w.handName) html += `<div class="hist-hand-name">${esc(w.handName)}</div>`;
      });
      html += '</div>';
    });
  }
  html += '</div>';

  content.innerHTML = html;
}

// ─── Log ──────────────────────────────────────────────────────────────────────

function renderLog(s) {
  const list = document.getElementById('log-list');
  list.innerHTML = s.log.map(m => `<div class="log-entry">${esc(m)}</div>`).join('');
}

// ─── Action Buttons ───────────────────────────────────────────────────────────

el('btn-fold').addEventListener('click', () =>
  socket.emit('action', { action: 'fold' }));

el('btn-check-call').addEventListener('click', () => {
  if (!state) return;
  const me     = state.players.find(p => p.isMe);
  const toCall = state.currentBet - (me ? me.bet : 0);
  socket.emit('action', { action: toCall <= 0 ? 'check' : 'call' });
});

el('btn-raise').addEventListener('click', () => {
  const amount = parseInt(document.getElementById('raise-inp').value);
  if (isNaN(amount)) return;
  socket.emit('action', { action: 'raise', amount });
});

el('btn-allin').addEventListener('click', () =>
  socket.emit('action', { action: 'allin' }));

el('btn-start').addEventListener('click', () =>
  socket.emit('start-game'));

el('btn-rebuy').addEventListener('click', () =>
  socket.emit('rebuy'));

el('btn-add-bot').addEventListener('click', () =>
  socket.emit('add-bot'));

el('btn-remove-bot').addEventListener('click', () =>
  socket.emit('remove-bot'));

el('btn-delete-room').addEventListener('click', () => {
  if (confirm('방을 삭제하면 모든 플레이어가 로비로 이동합니다. 삭제할까요?')) {
    socket.emit('delete-room');
  }
});

// Settings panel toggle (host only)
el('btn-show-cfg').addEventListener('click', () => {
  const panel = el('settings-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block' && state) {
    el('cfg-sb').value    = state.cfgSB;
    el('cfg-bb').value    = state.cfgBB;
    el('cfg-start').value = state.cfgStartChips;
    el('cfg-rebuy').value = state.cfgRebuy;
    el('cfg-timer').value = state.cfgTimer;
  }
});

['cfg-sb','cfg-bb','cfg-start','cfg-rebuy','cfg-timer'].forEach(id => {
  document.getElementById(id).addEventListener('input', function() {
    this.dataset.dirty = '1';
  });
});

el('btn-apply-cfg').addEventListener('click', () => {
  socket.emit('configure-room', {
    sb:         parseInt(el('cfg-sb').value)    || 0,
    bb:         parseInt(el('cfg-bb').value)    || 0,
    startChips: parseInt(el('cfg-start').value) || 0,
    rebuy:      parseInt(el('cfg-rebuy').value) || 0,
    timer:      parseInt(el('cfg-timer').value) || 0,
  });
  ['cfg-sb','cfg-bb','cfg-start','cfg-rebuy','cfg-timer'].forEach(id => {
    delete document.getElementById(id).dataset.dirty;
  });
  el('settings-panel').style.display = 'none';
});

// Stats drawer
el('btn-stats-toggle').addEventListener('click', openStats);
el('btn-stats-close').addEventListener('click', closeStats);
el('stats-overlay').addEventListener('click', closeStats);

function openStats() {
  el('stats-drawer').classList.add('open');
  el('stats-overlay').style.display = 'block';
}
function closeStats() {
  el('stats-drawer').classList.remove('open');
  el('stats-overlay').style.display = 'none';
}

// ─── Master Admin Panel ───────────────────────────────────────────────────────

let adminAuthed = false;

function adminPw() { return el('admin-pw') ? el('admin-pw').value : ''; }

function openAdminModal() {
  el('admin-modal').style.display = 'flex';
  if (!adminAuthed) el('admin-pw').focus();
}

function closeAdminModal() {
  el('admin-modal').style.display = 'none';
  el('admin-pw').value = '';
  el('admin-err').textContent = '';
  el('admin-rooms-panel').style.display = 'none';
  el('admin-login-panel').style.display = 'block';
  adminAuthed = false;
}

el('btn-admin-open').addEventListener('click', openAdminModal);
el('btn-admin-close').addEventListener('click', closeAdminModal);

el('admin-modal').addEventListener('click', (e) => {
  if (e.target === el('admin-modal')) closeAdminModal();
});

el('btn-admin-login').addEventListener('click', () => {
  socket.emit('admin-list-rooms', { password: adminPw() });
});

el('admin-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') el('btn-admin-login').click();
});

el('btn-admin-refresh').addEventListener('click', () => {
  if (adminAuthed) socket.emit('admin-list-rooms', { password: adminPw() });
});

socket.on('admin-room-list', (list) => {
  adminAuthed = true;
  el('admin-err').textContent = '';
  el('admin-login-panel').style.display = 'none';
  el('admin-rooms-panel').style.display = 'block';
  el('admin-room-count').textContent = `방 목록 (${list.length}개)`;

  const container = el('admin-room-list');
  if (list.length === 0) {
    container.innerHTML = '<div class="admin-empty">현재 활성 방이 없습니다.</div>';
    return;
  }

  container.innerHTML = list.map(r => `
    <div class="admin-room-row">
      <div class="admin-room-info">
        <span class="admin-room-code">${esc(r.code)}</span>
        <span class="admin-room-detail">
          👤 ${r.playerCount}명${r.botCount > 0 ? ` + 🤖${r.botCount}봇` : ''} &nbsp;|&nbsp;
          ${streetKo(r.street)}${r.started ? ' · Hand #' + r.handNumber : ' · 미시작'}
        </span>
      </div>
      <button class="btn-admin-del" data-code="${esc(r.code)}">삭제</button>
    </div>
  `).join('');

  container.querySelectorAll('.btn-admin-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.code;
      if (confirm(`방 [${code}] 을 삭제하시겠습니까?\n참가자 전원이 로비로 이동됩니다.`)) {
        socket.emit('admin-delete-room', { password: adminPw(), roomCode: code });
      }
    });
  });
});

socket.on('admin-err', (msg) => {
  el('admin-err').textContent = msg;
});

// ─── Card Rendering ───────────────────────────────────────────────────────────

const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_CLASS  = { s: 'spade', h: 'heart', d: 'diamond', c: 'club' };

function cardEl(card) {
  const el2 = document.createElement('span');
  if (!card || card === '??' || card === 'back') {
    el2.className = 'card back';
    el2.innerHTML = '<span class="card-rank-top"></span><span class="card-suit-center"></span><span class="card-rank-bot"></span>';
    return el2;
  }
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const sym  = SUIT_SYMBOL[suit] || suit;
  el2.className = `card ${SUIT_CLASS[suit] || ''}`;
  el2.innerHTML = `
    <span class="card-rank-top">${rank}</span>
    <span class="card-suit-center">${sym}</span>
    <span class="card-rank-bot">${rank}${sym}</span>
  `;
  return el2;
}

