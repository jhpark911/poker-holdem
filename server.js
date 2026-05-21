'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { Hand }   = require('pokersolver');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static('public'));

const PORT            = process.env.PORT || 3000;
const MAX_SEATS       = 9;
const NEXT_HAND_DELAY_FOLD     = 5000;
const NEXT_HAND_DELAY_SHOWDOWN = 10000;

const DEFAULT_SB          = 100;
const DEFAULT_BB          = 200;
const DEFAULT_START_CHIPS = 20000;
const DEFAULT_REBUY       = 20000;
const DEFAULT_TIMER       = 30;

const rooms     = {};
const socketMap = {};

const BOT_NAMES  = ['Claude', 'Aria', 'Nova', 'Rex', 'Sage'];
const RANK_VAL   = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14};
const HAND_SCORE = {
  'High Card':10,'Pair':28,'Two Pair':48,'Three of a Kind':62,
  'Straight':72,'Flush':78,'Full House':86,'Four of a Kind':93,
  'Straight Flush':97,'Royal Flush':100,
};

// ─── Deck ─────────────────────────────────────────────────────────────────────

function newDeck() {
  const suits = ['s','h','d','c'];
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const deck  = [];
  for (const s of suits) for (const r of ranks) deck.push(r + s);
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Room / Player ────────────────────────────────────────────────────────────

function makeRoom(code) {
  return {
    code,
    players: [],
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    lastRaiseSize: DEFAULT_BB,
    dealerSeat: -1,
    sbSeat: -1,
    bbSeat: -1,
    actionSeat: -1,
    street: 'waiting',
    handNumber: 0,
    log: [],
    started: false,
    showdownData: null,
    hostSeat: -1,
    cfgSB: DEFAULT_SB,
    cfgBB: DEFAULT_BB,
    cfgStartChips: DEFAULT_START_CHIPS,
    cfgRebuy: DEFAULT_REBUY,
    cfgTimer: DEFAULT_TIMER,
    actionTimer: null,
    actionStartTime: null,
    stats: {},
    handHistory: [],
  };
}

function makePlayer(socketId, name, seat, startChips) {
  return {
    socketId,
    name,
    seat,
    chips: startChips,
    holeCards: [],
    bet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    actedThisStreet: false,
    connected: true,
    lastAction: '',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function addLog(room, msg) {
  room.log.unshift(msg);
  if (room.log.length > 40) room.log.length = 40;
}

const getP        = (room, seat) => room.players.find(p => p.seat === seat);
const getByName   = (room, name) => room.players.find(p => p.name === name);
const notFolded   = (room)       => room.players.filter(p => !p.folded);
const canBet      = (room)       => room.players.filter(p => !p.folded && !p.allIn);

function nextActiveSeat(room, fromSeat) {
  for (let i = 1; i <= MAX_SEATS; i++) {
    const s = (fromSeat + i) % MAX_SEATS;
    const p = getP(room, s);
    if (p && !p.folded) return s;
  }
  return -1;
}

function nextBettorSeat(room, fromSeat) {
  for (let i = 1; i <= MAX_SEATS; i++) {
    const s = (fromSeat + i) % MAX_SEATS;
    const p = getP(room, s);
    if (p && !p.folded && !p.allIn) return s;
  }
  return -1;
}

function isActionClosed(room) {
  const b = canBet(room);
  if (b.length === 0) return true;
  return b.every(p => p.actedThisStreet && p.bet === room.currentBet);
}

// ─── Side Pots ────────────────────────────────────────────────────────────────

function calcSidePots(players) {
  const data = players
    .map(p => ({ seat: p.seat, totalBet: p.totalBet, folded: p.folded }))
    .sort((a, b) => a.totalBet - b.totalBet);

  const pots = [];
  let prev = 0;
  for (const d of data) {
    if (d.totalBet <= prev) continue;
    const diff     = d.totalBet - prev;
    const count    = data.filter(x => x.totalBet > prev).length;
    const amount   = diff * count;
    const eligible = data.filter(x => !x.folded && x.totalBet >= d.totalBet).map(x => x.seat);
    if (amount > 0) pots.push({ amount, eligible });
    prev = d.totalBet;
  }
  return pots;
}

// ─── Timer ────────────────────────────────────────────────────────────────────

function clearActionTimer(room) {
  if (room.actionTimer) {
    clearTimeout(room.actionTimer);
    room.actionTimer = null;
  }
  room.actionStartTime = null;
}

function scheduleActionTimer(room) {
  clearActionTimer(room);
  if (!room.cfgTimer || room.cfgTimer <= 0) return;
  const seat = room.actionSeat;
  const p    = getP(room, seat);
  if (!p || p.isBot) return;
  room.actionStartTime = Date.now();
  room.actionTimer = setTimeout(() => {
    if (!rooms[room.code] || room.actionSeat !== seat) return;
    if (!['preflop','flop','turn','river'].includes(room.street)) return;
    handleAction(room, seat, 'fold');
  }, room.cfgTimer * 1000);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function ensureStats(room, seat) {
  if (!room.stats[seat]) room.stats[seat] = { wins: 0, totalWon: 0 };
}

function updateStats(room, winnerInfo) {
  const handRecord = {
    handNumber: room.handNumber,
    winners: winnerInfo.map(w => ({ name: w.name, amount: w.amount, handName: w.handName || '' })),
  };
  room.handHistory.unshift(handRecord);
  if (room.handHistory.length > 5) room.handHistory.length = 5;

  for (const w of winnerInfo) {
    ensureStats(room, w.seat);
    room.stats[w.seat].wins++;
    room.stats[w.seat].totalWon += w.amount;
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcast(room) {
  const livePot = room.pot + room.players.reduce((s, p) => s + p.bet, 0);

  for (const player of room.players) {
    const sock = io.sockets.sockets.get(player.socketId);
    if (!sock) continue;

    const isShowdown = !!room.showdownData;

    sock.emit('state', {
      roomCode:        room.code,
      street:          room.street,
      pot:             livePot,
      communityCards:  room.communityCards,
      currentBet:      room.currentBet,
      minRaise:        room.currentBet + room.lastRaiseSize,
      actionSeat:      room.actionSeat,
      dealerSeat:      room.dealerSeat,
      sbSeat:          room.sbSeat,
      bbSeat:          room.bbSeat,
      handNumber:      room.handNumber,
      log:             room.log.slice(0, 20),
      showdownData:    room.showdownData,
      started:         room.started,
      hostSeat:        room.hostSeat,
      cfgSB:           room.cfgSB,
      cfgBB:           room.cfgBB,
      cfgStartChips:   room.cfgStartChips,
      cfgRebuy:        room.cfgRebuy,
      cfgTimer:        room.cfgTimer,
      actionStartTime: room.actionStartTime,
      stats:           room.stats,
      handHistory:     room.handHistory,
      players: room.players.map(p => ({
        seat:       p.seat,
        name:       p.name,
        chips:      p.chips,
        bet:        p.bet,
        folded:     p.folded,
        allIn:      p.allIn,
        connected:  p.connected,
        isMe:       p.seat === player.seat,
        isBot:      !!p.isBot,
        lastAction: p.lastAction,
        holeCards:
          p.seat === player.seat
            ? p.holeCards
            : isShowdown
              ? (p.folded ? [] : p.holeCards)
              : (p.holeCards.length ? ['??','??'] : []),
      })),
    });
  }
  scheduleBotAct(room);
}

// ─── Collect bets ─────────────────────────────────────────────────────────────

function collectBets(room) {
  room.players.forEach(p => {
    room.pot += p.bet;
    p.bet = 0;
  });
}

// ─── Start Hand ───────────────────────────────────────────────────────────────

function startHand(room) {
  room.players.forEach(p => { if (p.isBot && p.chips <= 0) p.chips = room.cfgRebuy; });

  const eligible = room.players.filter(p => p.chips > 0 && p.connected);
  if (eligible.length < 2) {
    room.street = 'waiting';
    broadcast(room);
    return;
  }

  room.players.forEach(p => {
    p.holeCards       = [];
    p.bet             = 0;
    p.totalBet        = 0;
    p.folded          = p.chips <= 0 || !p.connected;
    p.allIn           = false;
    p.actedThisStreet = false;
    p.lastAction      = '';
  });

  room.communityCards = [];
  room.pot            = 0;
  room.currentBet     = 0;
  room.lastRaiseSize  = room.cfgBB;
  room.showdownData   = null;
  room.handNumber++;
  room.street         = 'preflop';

  if (room.dealerSeat === -1) {
    room.dealerSeat = eligible[0].seat;
  } else {
    room.dealerSeat = nextActiveSeat(room, room.dealerSeat);
  }

  if (eligible.length === 2) {
    room.sbSeat = room.dealerSeat;
    room.bbSeat = nextActiveSeat(room, room.sbSeat);
  } else {
    room.sbSeat = nextActiveSeat(room, room.dealerSeat);
    room.bbSeat = nextActiveSeat(room, room.sbSeat);
  }

  postBlind(room, room.sbSeat, room.cfgSB);
  postBlind(room, room.bbSeat, room.cfgBB);
  room.currentBet    = room.cfgBB;
  room.lastRaiseSize = room.cfgBB;

  room.deck = newDeck();
  room.players.filter(p => !p.folded).forEach(p => {
    p.holeCards = [room.deck.pop(), room.deck.pop()];
  });

  room.actionSeat = eligible.length === 2
    ? room.sbSeat
    : nextActiveSeat(room, room.bbSeat);

  addLog(room, `── Hand #${room.handNumber} ──`);
  addLog(room, `딜러: ${getP(room, room.dealerSeat).name}`);
  addLog(room, `${getP(room, room.sbSeat).name} SB ${room.cfgSB}`);
  addLog(room, `${getP(room, room.bbSeat).name} BB ${room.cfgBB}`);

  scheduleActionTimer(room);
  broadcast(room);
}

function postBlind(room, seat, amount) {
  const p = getP(room, seat);
  if (!p) return;
  const actual  = Math.min(amount, p.chips);
  p.chips      -= actual;
  p.bet        += actual;
  p.totalBet   += actual;
  if (p.chips === 0) p.allIn = true;
}

// ─── Action Handler ───────────────────────────────────────────────────────────

function handleAction(room, seat, action, amount) {
  const p = getP(room, seat);
  if (!p || p.folded || p.allIn || room.actionSeat !== seat) return;
  if (!['fold','check','call','raise','allin'].includes(action)) return;

  clearActionTimer(room);

  const toCall = room.currentBet - p.bet;

  switch (action) {

    case 'fold':
      p.folded = true;
      p.actedThisStreet = true;
      p.lastAction = '폴드';
      addLog(room, `${p.name} 폴드`);
      break;

    case 'check':
      if (toCall > 0) return;
      p.actedThisStreet = true;
      p.lastAction = '체크';
      addLog(room, `${p.name} 체크`);
      break;

    case 'call': {
      const actual = Math.min(toCall, p.chips);
      p.chips    -= actual;
      p.bet      += actual;
      p.totalBet += actual;
      if (p.chips === 0) p.allIn = true;
      p.actedThisStreet = true;
      p.lastAction = `콜 ${actual}`;
      addLog(room, `${p.name} 콜 ${actual}`);
      break;
    }

    case 'raise': {
      const raiseAmt = parseInt(amount);
      if (isNaN(raiseAmt)) return;
      const minTotal = room.currentBet + room.lastRaiseSize;
      const maxTotal = p.chips + p.bet;
      if (raiseAmt < minTotal && raiseAmt !== maxTotal) return;
      const finalAmt = Math.min(raiseAmt, maxTotal);
      const raiseBy  = finalAmt - room.currentBet;
      const cost     = finalAmt - p.bet;

      if (finalAmt >= minTotal) room.lastRaiseSize = raiseBy;
      room.currentBet = finalAmt;

      p.chips    -= cost;
      p.bet       = finalAmt;
      p.totalBet += cost;
      if (p.chips === 0) p.allIn = true;
      p.actedThisStreet = true;
      p.lastAction = `레이즈 → ${finalAmt}`;

      room.players.forEach(q => {
        if (q.seat !== seat && !q.folded && !q.allIn) q.actedThisStreet = false;
      });
      addLog(room, `${p.name} 레이즈 → ${finalAmt}`);
      break;
    }

    case 'allin': {
      const allInTotal = p.chips + p.bet;
      const cost       = p.chips;
      p.chips          = 0;
      p.bet            = allInTotal;
      p.totalBet      += cost;
      p.allIn          = true;
      p.actedThisStreet = true;
      p.lastAction = '올인';

      if (allInTotal > room.currentBet) {
        const raiseBy = allInTotal - room.currentBet;
        if (raiseBy >= room.lastRaiseSize) {
          room.lastRaiseSize = raiseBy;
          room.players.forEach(q => {
            if (q.seat !== seat && !q.folded && !q.allIn) q.actedThisStreet = false;
          });
        }
        room.currentBet = allInTotal;
      }
      addLog(room, `${p.name} 올인 (${allInTotal})`);
      break;
    }
  }

  const alive = notFolded(room);
  if (alive.length === 1) {
    collectBets(room);
    const winner = alive[0];
    winner.chips += room.pot;
    updateStats(room, [{ seat: winner.seat, name: winner.name, amount: room.pot, handName: '' }]);
    addLog(room, `${winner.name} 승리 (무경쟁) +${room.pot}`);
    room.showdownData = {
      winners: [{ seat: winner.seat, name: winner.name, amount: room.pot, handName: '' }],
      hands: [],
    };
    room.pot    = 0;
    room.street = 'showdown';
    broadcast(room);
    scheduleNextHand(room, NEXT_HAND_DELAY_FOLD);
    return;
  }

  if (isActionClosed(room)) {
    collectBets(room);
    room.actionSeat = -1;
    broadcast(room);
    setTimeout(() => { if (rooms[room.code]) advanceStreet(room); }, 700);
  } else {
    const next = nextBettorSeat(room, seat);
    if (next === -1) {
      collectBets(room);
      room.actionSeat = -1;
      broadcast(room);
      setTimeout(() => { if (rooms[room.code]) advanceStreet(room); }, 700);
    } else {
      room.actionSeat = next;
      scheduleActionTimer(room);
      broadcast(room);
    }
  }
}

// ─── Advance Street ───────────────────────────────────────────────────────────

function advanceStreet(room) {
  room.players.forEach(p => {
    p.bet             = 0;
    p.actedThisStreet = false;
    p.lastAction      = '';
  });
  room.currentBet    = 0;
  room.lastRaiseSize = room.cfgBB;

  const streets = ['preflop','flop','turn','river'];

  if (room.street === 'river' || !streets.includes(room.street)) {
    doShowdown(room);
    return;
  }

  switch (room.street) {
    case 'preflop':
      room.communityCards = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
      room.street = 'flop';
      addLog(room, `플롭: ${room.communityCards.join(' ')}`);
      break;
    case 'flop':
      room.communityCards.push(room.deck.pop());
      room.street = 'turn';
      addLog(room, `턴: ${room.communityCards[3]}`);
      break;
    case 'turn':
      room.communityCards.push(room.deck.pop());
      room.street = 'river';
      addLog(room, `리버: ${room.communityCards[4]}`);
      break;
  }

  if (canBet(room).length <= 1) {
    while (room.communityCards.length < 5) room.communityCards.push(room.deck.pop());
    broadcast(room);
    setTimeout(() => doShowdown(room), 1500);
    return;
  }

  const firstBettor = nextBettorSeat(room, room.dealerSeat);
  room.actionSeat   = firstBettor;
  scheduleActionTimer(room);
  broadcast(room);
}

// ─── Showdown ─────────────────────────────────────────────────────────────────

function doShowdown(room) {
  room.street = 'showdown';
  const alive = notFolded(room);

  if (alive.length === 1) {
    const winner = alive[0];
    winner.chips += room.pot;
    updateStats(room, [{ seat: winner.seat, name: winner.name, amount: room.pot, handName: '' }]);
    room.showdownData = {
      winners: [{ seat: winner.seat, name: winner.name, amount: room.pot, handName: '' }],
      hands: [],
    };
    room.pot = 0;
    broadcast(room);
    scheduleNextHand(room, NEXT_HAND_DELAY_FOLD);
    return;
  }

  const evals = alive.map(p => {
    const hand = Hand.solve([...p.holeCards, ...room.communityCards]);
    hand._seat = p.seat;
    return { seat: p.seat, name: p.name, hand, holeCards: p.holeCards };
  });

  const pots     = calcSidePots(room.players);
  const winnings = {};
  room.players.forEach(p => { winnings[p.seat] = 0; });

  for (const pot of pots) {
    const eligibleEvals = evals.filter(e => pot.eligible.includes(e.seat));
    if (!eligibleEvals.length) continue;
    const winnerHands = Hand.winners(eligibleEvals.map(e => e.hand));
    const winnerSeats = eligibleEvals.filter(e => winnerHands.includes(e.hand)).map(e => e.seat);
    const share = Math.floor(pot.amount / winnerSeats.length);
    const rem   = pot.amount % winnerSeats.length;
    winnerSeats.forEach((s, i) => { winnings[s] += share + (i === 0 ? rem : 0); });
  }

  const winnerInfo = [];
  room.players.forEach(p => {
    if (winnings[p.seat] > 0) {
      p.chips += winnings[p.seat];
      const ev = evals.find(e => e.seat === p.seat);
      addLog(room, `${p.name} +${winnings[p.seat]} (${ev ? ev.hand.name : ''})`);
      winnerInfo.push({ seat: p.seat, name: p.name, amount: winnings[p.seat], handName: ev ? ev.hand.name : '' });
    }
  });

  updateStats(room, winnerInfo);

  room.showdownData = {
    winners: winnerInfo,
    hands: evals.map(e => ({
      seat: e.seat, name: e.name, holeCards: e.holeCards,
      handName: e.hand.name, handDescr: e.hand.descr || '',
    })),
  };
  room.pot = 0;
  broadcast(room);
  scheduleNextHand(room, NEXT_HAND_DELAY_SHOWDOWN);
}

function scheduleNextHand(room, delay = NEXT_HAND_DELAY_FOLD) {
  setTimeout(() => {
    if (!rooms[room.code]) return;
    room.showdownData = null;
    room.street       = 'waiting';
    broadcast(room);
    const eligible = room.players.filter(p => p.chips > 0 && p.connected);
    if (eligible.length >= 2) startHand(room);
  }, delay);
}

// ─── Bot Logic ────────────────────────────────────────────────────────────────

function preflopStrength(c1, c2) {
  const r1 = c1.slice(0,-1), s1 = c1.slice(-1);
  const r2 = c2.slice(0,-1), s2 = c2.slice(-1);
  const v1 = RANK_VAL[r1], v2 = RANK_VAL[r2];
  const hi = Math.max(v1,v2), lo = Math.min(v1,v2);
  const pair   = (v1 === v2);
  const suited = (s1 === s2);
  const gap    = hi - lo;

  if (pair) {
    if (hi >= 14) return 100; if (hi >= 13) return 95; if (hi >= 12) return 90;
    if (hi >= 11) return 85;  if (hi >= 10) return 78; if (hi >= 9)  return 70;
    if (hi >= 8)  return 62;  if (hi >= 7)  return 55; return 45;
  }
  if (hi === 14) {
    if (lo >= 13) return suited ? 84 : 78; if (lo >= 12) return suited ? 76 : 70;
    if (lo >= 11) return suited ? 70 : 63; if (lo >= 10) return suited ? 65 : 58;
    if (lo >= 9)  return suited ? 60 : 50; return suited ? 52 : 40;
  }
  if (hi === 13) {
    if (lo >= 12) return suited ? 70 : 63; if (lo >= 11) return suited ? 63 : 56;
    if (lo >= 10) return suited ? 57 : 50; return suited ? 47 : 37;
  }
  if (hi === 12) {
    if (lo >= 11) return suited ? 60 : 53; if (lo >= 10) return suited ? 54 : 48;
    return suited ? 43 : 33;
  }
  if (gap === 1 && suited) return 50; if (gap === 1) return 40;
  if (suited) return 30;
  return 18;
}

function handStrength(room, player) {
  if (!player.holeCards || player.holeCards.length < 2) return 30;
  if (room.communityCards.length === 0) {
    return preflopStrength(player.holeCards[0], player.holeCards[1]);
  }
  try {
    const hand = Hand.solve([...player.holeCards, ...room.communityCards]);
    return HAND_SCORE[hand.name] || 20;
  } catch(e) { return 30; }
}

function botDecide(room, seat) {
  const p = getP(room, seat);
  if (!p || !p.isBot) return;

  const strength = handStrength(room, p) + (Math.random() * 10 - 5);
  const toCall   = room.currentBet - p.bet;
  const livePot  = room.pot + room.players.reduce((s,q) => s+q.bet, 0);
  const potOdds  = toCall > 0 ? toCall / (livePot + toCall) : 0;
  const minRaise = room.currentBet + room.lastRaiseSize;
  const maxBet   = p.chips + p.bet;
  const canRaise = maxBet >= minRaise;
  const bluff    = strength < 42 && Math.random() < 0.12;

  let action, amount;

  if (bluff && canRaise) {
    action = 'raise'; amount = Math.min(minRaise, maxBet);
  } else if (strength >= 72 && canRaise) {
    const target = Math.min(maxBet, Math.max(minRaise, Math.floor(livePot * 0.75)));
    action = 'raise'; amount = target;
  } else if (strength >= 55) {
    if (toCall <= 0)                 action = 'check';
    else if (strength/100 > potOdds) action = 'call';
    else                             action = 'fold';
  } else {
    if (toCall <= 0) action = 'check';
    else if (potOdds < 0.18 && toCall <= room.cfgBB * 2) action = 'call';
    else action = 'fold';
  }

  handleAction(room, seat, action, amount);
}

function scheduleBotAct(room) {
  const seat = room.actionSeat;
  const p = getP(room, seat);
  if (!p || !p.isBot) return;

  const hasHuman = room.players.some(q => !q.isBot && q.connected);
  if (!hasHuman) return;

  const delay = 900 + Math.random() * 1100;
  setTimeout(() => {
    if (!rooms[room.code] || room.actionSeat !== seat) return;
    if (!['preflop','flop','turn','river'].includes(room.street)) return;
    const stillHuman = room.players.some(q => !q.isBot && q.connected);
    if (!stillHuman) return;
    botDecide(room, seat);
  }, delay);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('join-room', ({ roomCode, playerName }) => {
    if (!roomCode || !playerName) return;
    roomCode   = roomCode.toUpperCase().trim().slice(0, 8);
    playerName = playerName.trim().slice(0, 20);
    if (!playerName) return;

    if (!rooms[roomCode]) rooms[roomCode] = makeRoom(roomCode);
    const room = rooms[roomCode];

    const existing = getByName(room, playerName);
    if (existing && !existing.connected) {
      const oldId = existing.socketId;
      existing.socketId  = socket.id;
      existing.connected = true;
      socketMap[socket.id] = { code: roomCode, seat: existing.seat };
      delete socketMap[oldId];
      socket.join(roomCode);
      addLog(room, `${playerName} 재접속`);
      broadcast(room);
      return;
    }

    if (room.players.length >= MAX_SEATS) {
      socket.emit('err', '방이 꽉 찼습니다.');
      return;
    }

    const used = new Set(room.players.map(p => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;

    const player = makePlayer(socket.id, playerName, seat, room.cfgStartChips);
    if (room.players.length === 0) room.hostSeat = seat;
    room.players.push(player);
    ensureStats(room, seat);
    socketMap[socket.id] = { code: roomCode, seat };
    socket.join(roomCode);
    addLog(room, `${playerName} 입장`);
    broadcast(room);
  });

  socket.on('configure-room', ({ sb, bb, startChips, rebuy, timer }) => {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = rooms[info.code];
    if (!room || room.street !== 'waiting') return;
    if (info.seat !== room.hostSeat) return;

    const newSB    = parseInt(sb);
    const newBB    = parseInt(bb);
    const newStart = parseInt(startChips);
    const newRebuy = parseInt(rebuy);
    const newTimer = parseInt(timer);

    if (!isNaN(newSB)    && newSB > 0)     room.cfgSB         = newSB;
    if (!isNaN(newBB)    && newBB > 0)     room.cfgBB         = Math.max(newSB || room.cfgSB, newBB);
    if (!isNaN(newStart) && newStart > 0)  room.cfgStartChips = newStart;
    if (!isNaN(newRebuy) && newRebuy > 0)  room.cfgRebuy      = newRebuy;
    if (!isNaN(newTimer))                  room.cfgTimer      = Math.min(120, Math.max(0, newTimer));

    addLog(room, `설정: SB${room.cfgSB}/BB${room.cfgBB} 시작${room.cfgStartChips} 타이머${room.cfgTimer}초`);
    broadcast(room);
  });

  socket.on('start-game', () => {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = rooms[info.code];
    if (!room || room.street !== 'waiting') return;
    if (room.players.filter(p => p.chips > 0).length < 2) {
      socket.emit('err', '최소 2명 이상 필요합니다.');
      return;
    }
    room.started = true;
    startHand(room);
  });

  socket.on('action', ({ action, amount }) => {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = rooms[info.code];
    if (!room) return;
    handleAction(room, info.seat, action, amount);
  });

  socket.on('rebuy', () => {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = rooms[info.code];
    if (!room) return;
    const p = getP(room, info.seat);
    if (!p) return;
    if (p.chips > 0 && room.street !== 'waiting' && room.street !== 'showdown') {
      socket.emit('err', '핸드 사이 또는 칩이 없을 때만 리바이 가능합니다.');
      return;
    }
    p.chips += room.cfgRebuy;
    addLog(room, `${p.name} 리바이 (+${room.cfgRebuy})`);
    broadcast(room);
  });

  socket.on('add-bot', () => {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = rooms[info.code];
    if (!room) return;
    if (room.players.length >= MAX_SEATS) {
      socket.emit('err', '방이 꽉 찼습니다.');
      return;
    }
    const usedNames = new Set(room.players.map(p => p.name));
    const botName   = BOT_NAMES.find(n => !usedNames.has(n)) || `Bot${room.players.length}`;
    const used      = new Set(room.players.map(p => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    const bot = makePlayer(`bot-${seat}-${Date.now()}`, botName, seat, room.cfgStartChips);
    bot.isBot = true;
    ensureStats(room, seat);
    room.players.push(bot);
    addLog(room, `${botName} (봇) 입장`);
    broadcast(room);
  });

  socket.on('remove-bot', () => {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = rooms[info.code];
    if (!room) return;
    const bots = room.players.filter(p => p.isBot).sort((a,b) => b.seat - a.seat);
    if (!bots.length) return;
    const bot = bots[0];
    room.players = room.players.filter(p => p.seat !== bot.seat);
    addLog(room, `${bot.name} (봇) 퇴장`);
    broadcast(room);
  });

  socket.on('delete-room', () => {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = rooms[info.code];
    if (!room) return;
    if (info.seat !== room.hostSeat) return;

    // Notify all players in the room then clean up
    io.to(info.code).emit('room-deleted');
    for (const p of room.players) {
      delete socketMap[p.socketId];
    }
    delete rooms[info.code];
  });

  socket.on('disconnect', () => {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = rooms[info.code];
    if (room) {
      const p = getP(room, info.seat);
      if (p) {
        p.connected = false;
        addLog(room, `${p.name} 연결 끊김`);
        if (info.seat === room.hostSeat) {
          const newHost = room.players.find(q => !q.isBot && q.connected && q.seat !== info.seat);
          if (newHost) room.hostSeat = newHost.seat;
        }
        if (room.actionSeat === p.seat &&
            ['preflop','flop','turn','river'].includes(room.street)) {
          handleAction(room, p.seat, 'fold');
        } else {
          broadcast(room);
        }
      }
    }
    delete socketMap[socket.id];
  });
});

server.listen(PORT, () => console.log(`Poker server running on port ${PORT}`));
