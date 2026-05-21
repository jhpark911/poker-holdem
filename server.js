'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { Hand }   = require('pokersolver');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static('public'));

const PORT           = process.env.PORT || 3000;
const STARTING_CHIPS = 20000;
const SB_AMOUNT      = 100;
const BB_AMOUNT      = 200;
const REBUY_AMOUNT   = 20000;
const MAX_SEATS      = 9;
const NEXT_HAND_DELAY = 5000;

const rooms     = {};  // code -> room
const socketMap = {};  // socketId -> { code, seat }

// ─── Deck ────────────────────────────────────────────────────────────────────

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
    lastRaiseSize: BB_AMOUNT,
    dealerSeat: -1,
    sbSeat: -1,
    bbSeat: -1,
    actionSeat: -1,
    street: 'waiting',
    handNumber: 0,
    log: [],
    started: false,
    showdownData: null,
  };
}

function makePlayer(socketId, name, seat) {
  return {
    socketId,
    name,
    seat,
    chips: STARTING_CHIPS,
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

const getP       = (room, seat) => room.players.find(p => p.seat === seat);
const getBySocket = (room, sid) => room.players.find(p => p.socketId === sid);
const getByName   = (room, name) => room.players.find(p => p.name === name);
const notFolded   = (room) => room.players.filter(p => !p.folded);
const canBet      = (room) => room.players.filter(p => !p.folded && !p.allIn);

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

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcast(room) {
  const livePot = room.pot + room.players.reduce((s, p) => s + p.bet, 0);

  for (const player of room.players) {
    const sock = io.sockets.sockets.get(player.socketId);
    if (!sock) continue;

    const isShowdown = !!room.showdownData;

    sock.emit('state', {
      roomCode: room.code,
      street: room.street,
      pot: livePot,
      communityCards: room.communityCards,
      currentBet: room.currentBet,
      minRaise: room.currentBet + room.lastRaiseSize,
      actionSeat: room.actionSeat,
      dealerSeat: room.dealerSeat,
      sbSeat: room.sbSeat,
      bbSeat: room.bbSeat,
      handNumber: room.handNumber,
      log: room.log.slice(0, 20),
      showdownData: room.showdownData,
      started: room.started,
      players: room.players.map(p => ({
        seat: p.seat,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        connected: p.connected,
        isMe: p.seat === player.seat,
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
}

// ─── Collect bets into pot ────────────────────────────────────────────────────

function collectBets(room) {
  room.players.forEach(p => {
    room.pot += p.bet;
    p.bet = 0;
  });
}

// ─── Start Hand ───────────────────────────────────────────────────────────────

function startHand(room) {
  const eligible = room.players.filter(p => p.chips > 0 && p.connected);
  if (eligible.length < 2) {
    room.street = 'waiting';
    broadcast(room);
    return;
  }

  room.players.forEach(p => {
    p.holeCards        = [];
    p.bet              = 0;
    p.totalBet         = 0;
    p.folded           = p.chips <= 0 || !p.connected;
    p.allIn            = false;
    p.actedThisStreet  = false;
    p.lastAction       = '';
  });

  room.communityCards  = [];
  room.pot             = 0;
  room.currentBet      = 0;
  room.lastRaiseSize   = BB_AMOUNT;
  room.showdownData    = null;
  room.handNumber++;
  room.street          = 'preflop';

  // Rotate dealer
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

  postBlind(room, room.sbSeat, SB_AMOUNT);
  postBlind(room, room.bbSeat, BB_AMOUNT);
  room.currentBet    = BB_AMOUNT;
  room.lastRaiseSize = BB_AMOUNT;

  // Deal cards to non-folded players
  room.deck = newDeck();
  room.players.filter(p => !p.folded).forEach(p => {
    p.holeCards = [room.deck.pop(), room.deck.pop()];
  });

  // Preflop action: UTG (after BB) for 3+, dealer/SB for HU
  room.actionSeat = eligible.length === 2
    ? room.sbSeat
    : nextActiveSeat(room, room.bbSeat);

  addLog(room, `── Hand #${room.handNumber} ──`);
  addLog(room, `딜러: ${getP(room, room.dealerSeat).name}`);
  addLog(room, `${getP(room, room.sbSeat).name} SB ${SB_AMOUNT}`);
  addLog(room, `${getP(room, room.bbSeat).name} BB ${BB_AMOUNT}`);

  broadcast(room);
}

function postBlind(room, seat, amount) {
  const p = getP(room, seat);
  if (!p) return;
  const actual    = Math.min(amount, p.chips);
  p.chips        -= actual;
  p.bet          += actual;
  p.totalBet     += actual;
  if (p.chips === 0) p.allIn = true;
}

// ─── Action Handler ───────────────────────────────────────────────────────────

function handleAction(room, seat, action, amount) {
  const p = getP(room, seat);
  if (!p || p.folded || p.allIn || room.actionSeat !== seat) return;
  if (!['fold','check','call','raise','allin'].includes(action)) return;

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
      // Must meet min raise, OR be going all-in
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

      // Reopen action for others
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

  // Single survivor?
  const alive = notFolded(room);
  if (alive.length === 1) {
    collectBets(room);
    const winner = alive[0];
    winner.chips += room.pot;
    addLog(room, `${winner.name} 승리 (무경쟁) +${room.pot}`);
    room.showdownData = {
      winners: [{ seat: winner.seat, name: winner.name, amount: room.pot, handName: '' }],
      hands: [],
    };
    room.pot    = 0;
    room.street = 'showdown';
    broadcast(room);
    scheduleNextHand(room);
    return;
  }

  if (isActionClosed(room)) {
    collectBets(room);
    advanceStreet(room);
  } else {
    const next = nextBettorSeat(room, seat);
    if (next === -1) {
      collectBets(room);
      advanceStreet(room);
    } else {
      room.actionSeat = next;
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
  room.lastRaiseSize = BB_AMOUNT;

  const streets = ['preflop','flop','turn','river'];
  const idx     = streets.indexOf(room.street);

  if (room.street === 'river' || idx === -1) {
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

  // If ≤1 player can still bet, run out cards and showdown
  if (canBet(room).length <= 1) {
    while (room.communityCards.length < 5) room.communityCards.push(room.deck.pop());
    broadcast(room);
    setTimeout(() => doShowdown(room), 1500);
    return;
  }

  // Postflop: first active player left of dealer
  const firstBettor = nextBettorSeat(room, room.dealerSeat);
  room.actionSeat   = firstBettor;
  broadcast(room);
}

// ─── Showdown ─────────────────────────────────────────────────────────────────

function doShowdown(room) {
  room.street = 'showdown';
  const alive = notFolded(room);

  if (alive.length === 1) {
    // Shouldn't normally reach here, but handle gracefully
    const winner = alive[0];
    winner.chips += room.pot;
    room.showdownData = {
      winners: [{ seat: winner.seat, name: winner.name, amount: room.pot, handName: '' }],
      hands: [],
    };
    room.pot = 0;
    broadcast(room);
    scheduleNextHand(room);
    return;
  }

  // Evaluate hands
  const evals = alive.map(p => {
    const hand = Hand.solve([...p.holeCards, ...room.communityCards]);
    hand._seat = p.seat;
    return { seat: p.seat, name: p.name, hand, holeCards: p.holeCards };
  });

  const pots    = calcSidePots(room.players);
  const winnings = {};
  room.players.forEach(p => { winnings[p.seat] = 0; });

  for (const pot of pots) {
    const eligibleEvals = evals.filter(e => pot.eligible.includes(e.seat));
    if (!eligibleEvals.length) continue;

    const winnerHands  = Hand.winners(eligibleEvals.map(e => e.hand));
    const winnerSeats  = eligibleEvals
      .filter(e => winnerHands.includes(e.hand))
      .map(e => e.seat);

    const share = Math.floor(pot.amount / winnerSeats.length);
    const rem   = pot.amount % winnerSeats.length;
    winnerSeats.forEach((s, i) => {
      winnings[s] += share + (i === 0 ? rem : 0);
    });
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

  room.showdownData = {
    winners: winnerInfo,
    hands: evals.map(e => ({
      seat: e.seat,
      name: e.name,
      holeCards: e.holeCards,
      handName: e.hand.name,
    })),
  };
  room.pot = 0;
  broadcast(room);
  scheduleNextHand(room);
}

function scheduleNextHand(room) {
  setTimeout(() => {
    if (!rooms[room.code]) return;
    room.showdownData = null;
    room.street       = 'waiting';
    broadcast(room);
    const eligible = room.players.filter(p => p.chips > 0 && p.connected);
    if (eligible.length >= 2) startHand(room);
  }, NEXT_HAND_DELAY);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('join-room', ({ roomCode, playerName }) => {
    if (!roomCode || !playerName) return;
    roomCode    = roomCode.toUpperCase().trim().slice(0, 8);
    playerName  = playerName.trim().slice(0, 20);
    if (!playerName) return;

    if (!rooms[roomCode]) rooms[roomCode] = makeRoom(roomCode);
    const room = rooms[roomCode];

    // Reconnect by name
    const existing = getByName(room, playerName);
    if (existing && !existing.connected) {
      const oldId = existing.socketId;
      existing.socketId   = socket.id;
      existing.connected  = true;
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

    // Find next available seat
    const used = new Set(room.players.map(p => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;

    const player = makePlayer(socket.id, playerName, seat);
    room.players.push(player);
    socketMap[socket.id] = { code: roomCode, seat };
    socket.join(roomCode);
    addLog(room, `${playerName} 입장`);
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
    // Allow rebuy anytime between hands, or when bust
    if (p.chips > 0 && room.street !== 'waiting' && room.street !== 'showdown') {
      socket.emit('err', '핸드 사이 또는 칩이 없을 때만 리바이 가능합니다.');
      return;
    }
    p.chips += REBUY_AMOUNT;
    addLog(room, `${p.name} 리바이 (+${REBUY_AMOUNT})`);
    broadcast(room);
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
        // Auto-fold if it's their turn mid-hand
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
