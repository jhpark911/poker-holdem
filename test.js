'use strict';
// Integration test: 2-player full hand simulation
// Covers: join, start, preflop (SB call + BB check), flop/turn/river (check-check), showdown
// Run: node test.js

const http   = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver');

// Inline server setup (no static files needed for tests)
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// Import the game logic by requiring server-like setup inline
// Since server.js uses io directly, we re-run its logic here with our io instance.
// Alternatively: spawn the real server and connect to it.
// Simpler: just use the real server.js with a dynamic port.

const io_client = require('socket.io-client');
server.close();

// ─── Start real server on random port ────────────────────────────────────────

const realApp    = express();
const realServer = http.createServer(realApp);
const realIo     = new Server(realServer, { cors: { origin: '*' } });
realApp.use(express.static('public'));

// Paste game logic inline (to avoid module issues with the plain server.js)
// Instead: just spawn node server.js on a test port and connect to it

const { spawn } = require('child_process');
const PORT = 13579;

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) { console.log('  ✓', msg); pass++; }
  else       { console.error('  ✗', msg); fail++; }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectClient(url, name, room) {
  return new Promise((resolve) => {
    const s = io_client(url, { transports: ['websocket'] });
    const states = [];
    s.on('state', st => { states.push(st); });
    s.on('connect', () => {
      s.emit('join-room', { roomCode: room, playerName: name });
      setTimeout(() => resolve({ socket: s, states }), 300);
    });
  });
}

async function run() {
  console.log('\n=== Texas Hold\'em Integration Test ===\n');

  // Spawn server
  const srv = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    cwd: __dirname,
  });
  srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));

  await delay(1000); // wait for server to boot

  const url  = `http://localhost:${PORT}`;
  const room = 'TEST01';

  // ── Test 1: Both players join ──────────────────────────────────────────────
  console.log('Test 1: Both players join');
  const p1 = await connectClient(url, 'Alice', room);
  const p2 = await connectClient(url, 'Bob',   room);
  await delay(300);

  const s1 = p1.states.at(-1);
  const s2 = p2.states.at(-1);
  assert(s1 && s1.players.length === 2, 'Alice sees 2 players');
  assert(s2 && s2.players.length === 2, 'Bob sees 2 players');
  assert(s1.street === 'waiting', 'Street is waiting before start');

  // ── Test 2: Start game ─────────────────────────────────────────────────────
  console.log('\nTest 2: Start game → blinds posted');
  p1.socket.emit('start-game');
  await delay(500);

  const after2 = p1.states.at(-1);
  assert(after2.street === 'preflop', 'Street advances to preflop');
  assert(after2.pot >= 300, `Pot ≥ 300 (SB+BB) — got ${after2.pot}`);
  assert(after2.handNumber === 1, 'Hand #1');

  const meP1 = after2.players.find(p => p.isMe);
  assert(meP1.holeCards.length === 2, 'Alice has 2 hole cards');
  assert(after2.communityCards.length === 0, 'No community cards yet');

  // ── Test 3: Min-raise enforcement ─────────────────────────────────────────
  console.log('\nTest 3: Min-raise enforcement');
  // We need to know who acts first. In HU: dealer/SB acts first preflop.
  const stateP1 = after2;
  const actionSeat = stateP1.actionSeat;
  const alicesSeat = stateP1.players.find(p => p.isMe).seat;

  // Identify who goes first; if Alice, she tries a bad raise then a good one
  const firstActor = actionSeat === alicesSeat ? p1 : p2;
  const firstState = actionSeat === alicesSeat ? after2 : p2.states.at(-1);

  // Min raise from currentBet=200 is 200+200=400
  const minRaise = firstState.minRaise; // should be 400
  assert(minRaise === 400, `minRaise is 400 — got ${minRaise}`);

  // Send a bad raise (below minRaise, not all-in) — server should ignore it
  const snapshotBefore = firstActor.states.length;
  firstActor.socket.emit('action', { action: 'raise', amount: 350 }); // invalid
  await delay(400);
  // If server rejected it, no new state broadcast (or state unchanged)
  const afterBadRaise = firstActor.states.at(-1);
  assert(afterBadRaise.actionSeat === actionSeat, 'Bad raise rejected — action seat unchanged');

  // ── Test 4: Preflop → SB calls, BB checks → flop ─────────────────────────
  console.log('\nTest 4: Preflop action → flop');
  // SB calls BB (200 total), BB checks → advance to flop
  firstActor.socket.emit('action', { action: 'call' });
  await delay(400);

  // Now BB's turn — figure out which client is BB
  const stateAfterCall = p1.states.at(-1);
  const newActionSeat  = stateAfterCall.actionSeat;
  const secondActor    = newActionSeat === alicesSeat ? p1 : p2;
  secondActor.socket.emit('action', { action: 'check' });
  await delay(1100);

  const flopState = p1.states.at(-1);
  assert(flopState.street === 'flop', `Advanced to flop — got ${flopState.street}`);
  assert(flopState.communityCards.length === 3, '3 community cards on flop');
  assert(flopState.pot >= 400, `Pot ≥ 400 after blinds — got ${flopState.pot}`);

  // ── Test 5: Flop → check/check → turn ────────────────────────────────────
  console.log('\nTest 5: Flop check/check → turn');
  const flopAction1 = flopState.actionSeat === alicesSeat ? p1 : p2;
  const flopAction2 = flopState.actionSeat === alicesSeat ? p2 : p1;
  flopAction1.socket.emit('action', { action: 'check' });
  await delay(400);
  flopAction2.socket.emit('action', { action: 'check' });
  await delay(1100);

  const turnState = p1.states.at(-1);
  assert(turnState.street === 'turn', `Advanced to turn — got ${turnState.street}`);
  assert(turnState.communityCards.length === 4, '4 community cards on turn');

  // ── Test 6: Turn → check/check → river ───────────────────────────────────
  console.log('\nTest 6: Turn check/check → river');
  const turnA1 = turnState.actionSeat === alicesSeat ? p1 : p2;
  const turnA2 = turnState.actionSeat === alicesSeat ? p2 : p1;
  turnA1.socket.emit('action', { action: 'check' });
  await delay(400);
  turnA2.socket.emit('action', { action: 'check' });
  await delay(1100);

  const riverState = p1.states.at(-1);
  assert(riverState.street === 'river', `Advanced to river — got ${riverState.street}`);
  assert(riverState.communityCards.length === 5, '5 community cards on river');

  // ── Test 7: River → check/check → showdown ────────────────────────────────
  console.log('\nTest 7: River check/check → showdown');
  const riverA1 = riverState.actionSeat === alicesSeat ? p1 : p2;
  const riverA2 = riverState.actionSeat === alicesSeat ? p2 : p1;
  riverA1.socket.emit('action', { action: 'check' });
  await delay(400);
  riverA2.socket.emit('action', { action: 'check' });
  await delay(1100);

  const sdState = p1.states.at(-1);
  assert(sdState.street === 'showdown', `Showdown reached — got ${sdState.street}`);
  assert(!!sdState.showdownData, 'showdownData present');
  assert(sdState.showdownData.winners.length >= 1, 'At least one winner');
  assert(sdState.showdownData.hands.length === 2, '2 hands revealed at showdown');

  const totalChips = sdState.players.reduce((s, p) => s + p.chips, 0);
  // 2 players × 20000 = 40000 (winner gets +pot, loser chip count decremented)
  // At showdown, pot is distributed. chips should sum to 40000.
  // But state shows chips after distribution only after the hand.
  // sdState is the showdown state — pot=0, chips redistributed
  assert(sdState.pot === 0, 'Pot is 0 after distribution');

  // ── Test 8: Opponent hole cards revealed at showdown ──────────────────────
  console.log('\nTest 8: Opponent cards visible at showdown');
  const stateP1sd = p1.states.at(-1);
  const opponent = stateP1sd.players.find(p => !p.isMe);
  assert(opponent.holeCards.length === 2 && opponent.holeCards[0] !== '??',
    'Opponent hole cards visible at showdown');

  // ── Test 9: Auto-next-hand after 20s showdown delay ──────────────────────
  console.log('\nTest 9: Auto next hand starts after 20s showdown delay');
  await delay(21000);
  const nextHand = p1.states.at(-1);
  assert(nextHand.handNumber === 2, `Hand #2 started — got ${nextHand.handNumber}`);
  assert(nextHand.street === 'preflop', 'Back to preflop');

  // ── Test 10: Fold → single winner ─────────────────────────────────────────
  console.log('\nTest 10: Fold → uncontested pot awarded');
  const h2State = nextHand;
  const h2ActionSeat = h2State.actionSeat;
  const folder = h2ActionSeat === alicesSeat ? p1 : p2;
  folder.socket.emit('action', { action: 'fold' });
  await delay(1000);

  const foldResult = p1.states.at(-1);
  assert(foldResult.street === 'showdown', 'Showdown after fold');
  assert(foldResult.showdownData.winners.length === 1, 'Exactly 1 winner on fold');
  assert(foldResult.showdownData.hands.length === 0, 'No hands shown when only 1 survives');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail === 0) console.log('All tests passed ✓');
  else            console.error('Some tests FAILED ✗');

  p1.socket.disconnect();
  p2.socket.disconnect();
  srv.kill();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
