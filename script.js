// Jungle-Jumble — adaptive memory game.
// Difficulty is driven by the DDA engine, which retunes the board between rounds based
// on accuracy, reaction latency and pointer jitter.

import { ready, getState, setState, gainXP } from './js/core/store.js';
import { sfx, setEnabled } from './js/core/audio.js';
import { DDAMonitor, TIERS, MINDFUL_PROMPTS } from './js/core/dda.js';
import { currentReading } from './js/core/biometrics.js';

const confettiArt = ['🎉', '🎊', '✨', '🟡', '🟠', '🌿', '🍃', '🪺', '🦜', '🌸'];

let board, movesDisplay, timerDisplay, popup, finalMoves, finalTime;
let moves, timer, timerInterval, matches, firstCard, secondCard, boardLocked;
let cards, gamePaused = false, adaptive = true, pendingNotice = null;
let bestScores = {};

const dda = new DDAMonitor({
  getExternalStress: () => {
    const r = currentReading();
    return r.source === 'none' ? null : r.stress;
  },
  onAdjust: (config, info) => {
    pendingNotice = info.direction === 'up'
      ? `⬆️ Feeling sharp — next round steps up to ${config.label} (${config.rows}×${config.cols}).`
      : `🌿 Let's ease into it — next round is ${config.label} (${config.rows}×${config.cols}).`;
    showNotice(pendingNotice);
  },
  onMindfulMoment: () => openMindfulBreak(),
});

// Verification handle, same purpose as window.__sanctuary.
window.__dda = dda;

document.addEventListener('DOMContentLoaded', async () => {
  await ready;
  board = document.getElementById('game-board');
  movesDisplay = document.getElementById('moves');
  timerDisplay = document.getElementById('timer');
  popup = document.getElementById('popup');
  finalMoves = document.getElementById('final-moves');
  finalTime = document.getElementById('final-time');

  document.getElementById('restart').onclick = restartGame;
  document.getElementById('play-again').onclick = restartGame;
  document.getElementById('difficulty').onchange = (e) => {
    const v = e.target.value;
    adaptive = v === 'adaptive';
    if (!adaptive) {
      dda.tier = TIERS.findIndex(t => t.label === v);
      pendingNotice = null;
    }
    restartGame();
  };
  document.getElementById('pause-btn').onclick = togglePause;
  document.getElementById('sound-toggle').onclick = toggleSound;
  document.getElementById('hint-btn').onclick = showHint;
  document.getElementById('darkToggle').onchange = (e) => document.body.classList.toggle('dark', e.target.checked);

  popup.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') restartGame(); });

  board.addEventListener('pointermove', (e) => dda.notePointer(e.clientX, e.clientY));

  setEnabled(getState().settings.sound);
  bestScores = JSON.parse(localStorage.getItem('jj-highscores') || '{}');
  buildDifficultyOptions();
  restartGame();
});

function buildDifficultyOptions() {
  const sel = document.getElementById('difficulty');
  sel.innerHTML = '<option value="adaptive">🧠 Adaptive (recommended)</option>' +
    TIERS.map(t => `<option value="${t.label}">${emojiForTier(t.tier)} ${t.label} (${t.rows}×${t.cols})</option>`).join('');
  sel.value = adaptive ? 'adaptive' : TIERS[dda.tier].label;
}

function emojiForTier(tier) { return ['🌱', '🍃', '🌴', '🦜', '🐆', '🦁'][tier] ?? '🍃'; }

function activeConfig() { return dda.config; }

function buildCardSet() {
  const n = activeConfig().pairs;
  const pool = [];
  for (let i = 1; i <= 18; i++) pool.push(i);
  shuffle(pool);
  const chosen = pool.slice(0, n);

  const deck = [];
  chosen.forEach((img) => {
    deck.push({ id: `a${img}`, img: `images/${img}.jpg` });
    deck.push({ id: `b${img}`, img: `images/${img}.jpg` });
  });
  shuffle(deck);
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createBoard() {
  const { rows, cols } = activeConfig();
  board.innerHTML = '';
  board.style.gridTemplateColumns = `repeat(${cols}, var(--card-size))`;
  board.style.gridTemplateRows = `repeat(${rows}, var(--card-size))`;

  cards = buildCardSet();
  const frag = document.createDocumentFragment();
  cards.forEach((cardData) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;
    card.dataset.id = cardData.id;
    card.dataset.img = cardData.img;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', 'Face-down card');
    card.innerHTML = `
      <div class="card-inner">
        <div class="card-front"></div>
        <div class="card-back" style="background-image:url('${cardData.img}')"></div>
      </div>`;
    card.addEventListener('click', flipCard);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flipCard.call(card); }
    });
    frag.appendChild(card);
  });
  board.appendChild(frag);

  const hud = document.getElementById('tier-badge');
  if (hud) hud.textContent = `${activeConfig().label} · ${rows}×${cols} · ${activeConfig().pairs} pairs`;
}

function restartGame() {
  clearInterval(timerInterval);
  moves = timer = matches = 0;
  boardLocked = gamePaused = false;
  movesDisplay.textContent = timerDisplay.textContent = 0;
  popup.style.display = 'none';
  popup.blur();
  firstCard = secondCard = null;
  document.getElementById('pause-btn').textContent = '⏸️';
  dda.reset();
  if (adaptive && pendingNotice) { showNotice(pendingNotice); }
  pendingNotice = null;
  createBoard();
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!gamePaused) {
      timer++;
      timerDisplay.textContent = timer;
    }
  }, 1000);
}

function flipCard() {
  if (boardLocked || this.classList.contains('flipped') || gamePaused) return;
  this.classList.add('flipped');
  this.setAttribute('aria-label', 'Face-up card');
  sfx.flip();

  if (!firstCard) {
    firstCard = this;
    dda.noteFirstFlip();
    if (moves === 0 && timer === 0) startTimer();
    return;
  }
  if (this === firstCard) return;
  secondCard = this;
  moves++;
  movesDisplay.textContent = moves;
  boardLocked = true;
  checkForMatch();
}

function checkForMatch() {
  const matched = firstCard.dataset.img === secondCard.dataset.img;
  if (matched) {
    sfx.match();
    setTimeout(disableCards, 380);
  } else {
    sfx.mismatch();
    setTimeout(unflipCards, dda.revealMs);
  }
  dda.noteAttempt(matched);
  updateStressMeter();
}

function disableCards() {
  firstCard.removeEventListener('click', flipCard);
  secondCard.removeEventListener('click', flipCard);
  firstCard.classList.add('matched');
  secondCard.classList.add('matched');
  matches++;
  resetFlippedCards();
  if (matches === activeConfig().pairs) setTimeout(endGame, 320);
  else boardLocked = false;
}

function unflipCards() {
  firstCard.classList.remove('flipped');
  secondCard.classList.remove('flipped');
  firstCard.setAttribute('aria-label', 'Face-down card');
  secondCard.setAttribute('aria-label', 'Face-down card');
  resetFlippedCards();
  boardLocked = false;
}

function resetFlippedCards() { firstCard = secondCard = null; }

function updateStressMeter() {
  const meter = document.getElementById('stress-fill');
  const label = document.getElementById('stress-label');
  if (!meter) return;
  const pct = Math.round(dda.stress * 100);
  meter.style.width = pct + '%';
  meter.className = pct > 70 ? 'hot' : pct > 45 ? 'warm' : 'calm';
  if (label) label.textContent = `Flow pressure ${pct}% · accuracy ${Math.round(dda.accuracy * 100)}%`;
}

function endGame() {
  clearInterval(timerInterval);
  finalMoves.textContent = moves;
  finalTime.textContent = timer;
  launchConfetti();
  sfx.levelUp();

  const key = TIERS[dda.tier].label;
  const best = bestScores[key] || { moves: Infinity, time: Infinity };
  const highP = popup.querySelector('.highscore-line');
  if (moves < best.moves || (moves === best.moves && timer < best.time)) {
    bestScores[key] = { moves, time: timer };
    localStorage.setItem('jj-highscores', JSON.stringify(bestScores));
    highP.textContent = '🌟 New high score!';
  } else if (best.moves < Infinity) {
    highP.textContent = `Best on ${key}: ${best.moves} moves, ${best.time}s`;
  } else {
    highP.textContent = '';
  }

  // Reward scales with how hard the board actually was.
  const earned = 8 + dda.tier * 4 + Math.max(0, 12 - Math.floor(timer / 15));
  gainXP(earned);
  setState(s => { s.economy.coins += earned; }, 'reward');
  sfx.coin();
  document.getElementById('xp-reward').textContent = `+${earned} XP · +${earned} coins for Lumi`;

  dda.finishSession(true);
  popup.style.display = 'block';
  popup.focus();
}

function togglePause() {
  gamePaused = !gamePaused;
  document.getElementById('pause-btn').textContent = gamePaused ? '▶️' : '⏸️';
}

function toggleSound() {
  const next = !getState().settings.sound;
  setState(s => { s.settings.sound = next; }, 'settings');
  setEnabled(next);
  document.getElementById('sound-toggle').textContent = next ? '🔈' : '🔇';
}

let hintCooldownUntil = 0;
function showHint() {
  if (gamePaused || boardLocked) return;
  if (Date.now() < hintCooldownUntil) {
    showNotice(`💡 Hint recharging — ${Math.ceil((hintCooldownUntil - Date.now()) / 1000)}s`);
    return;
  }
  // A stressed player gets a longer look and a shorter wait.
  const lookMs = 900 + dda.stress * 900;
  hintCooldownUntil = Date.now() + (dda.stress > 0.5 ? 12_000 : 25_000);
  boardLocked = true;
  const hidden = Array.from(board.querySelectorAll('.card:not(.matched):not(.flipped)'));
  hidden.forEach(c => c.classList.add('flipped'));
  setTimeout(() => {
    hidden.forEach(c => c.classList.remove('flipped'));
    boardLocked = false;
  }, lookMs);
}

// ---- Micro-mindfulness break --------------------------------------------
function openMindfulBreak() {
  gamePaused = true;
  boardLocked = true;
  const prompt = MINDFUL_PROMPTS[Math.floor(Math.random() * MINDFUL_PROMPTS.length)];
  const overlay = document.getElementById('mindful');
  const text = document.getElementById('mindful-text');
  const orb = document.getElementById('mindful-orb');
  text.textContent = prompt.text;
  overlay.classList.add('show');
  sfx.breathIn();

  let left = prompt.seconds;
  const label = document.getElementById('mindful-count');
  label.textContent = `${left}s`;
  const tick = setInterval(() => {
    left--;
    label.textContent = left > 0 ? `${left}s` : '';
    if (left === Math.floor(prompt.seconds / 2)) sfx.breathOut();
    if (left <= 0) {
      clearInterval(tick);
      overlay.classList.remove('show');
      orb.style.animation = '';
      gamePaused = false;
      boardLocked = false;
      dda.consecutiveMisses = 0;
      dda.lastBreakAt = Date.now();
      showNotice('🌿 Nice. Back to the jungle when you are ready.');
    }
  }, 1000);
}

let noticeTimer = null;
function showNotice(msg) {
  const el = document.getElementById('notice');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

function launchConfetti() {
  for (let i = 0; i < 8; i++) {
    setTimeout(() => {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = (30 + Math.random() * 40) + 'vw';
      c.style.top = (28 + Math.random() * 12) + 'vh';
      c.textContent = confettiArt[Math.floor(Math.random() * confettiArt.length)];
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 1300);
    }, 65 * i);
  }
}

// ---- Easter egg ----------------------------------------------------------
const egg = document.getElementById('easterEgg');
const eggMsg = document.getElementById('eggMessage');
let eggBroken = false;

function showEggMessage() {
  eggMsg.textContent = "Brewed fresh in Anushka's imagination lab 💥";
  eggMsg.style.opacity = '1';
  egg.style.transform = 'scale(1.2) rotate(15deg)';
  setTimeout(() => { egg.style.transform = 'scale(0) rotate(45deg)'; }, 400);
  setTimeout(() => {
    eggMsg.style.opacity = '0';
    egg.style.transform = '';
    eggBroken = false;
  }, 3000);
}

egg.addEventListener('click', () => { if (!eggBroken) { eggBroken = true; showEggMessage(); } });
egg.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !eggBroken) {
    e.preventDefault();
    eggBroken = true;
    showEggMessage();
  }
});
