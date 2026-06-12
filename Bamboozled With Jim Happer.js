/*
  Bamboozled With Jim Happer
  Paste your deployed Google Apps Script Web App URL below.
*/

const Bamboozled = {
  API_URL: 'https://script.google.com/macros/s/AKfycbz-MuQ783Re1CzClsSMPTexkKf2tu5X29brwbCeLKW2QJvzLPfQiBlH22sL2loFlB6d/exec',
  pollMs: 1500,
  gameCode: '',
  playerName: '',
  playerColumn: '',
  isMvp: false,
  hostIntroStarted: false,
  hostBoardLoaded: false,
  lastPhase: '',
  lastQuestionKey: '',
  calgoatyNames: [],
  currentHiddenOptions: []
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setHidden(id, hidden) {
  const el = $(id);
  if (el) el.classList.toggle('hidden', hidden);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text ?? '';
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function api(action, data = {}) {
  if (!Bamboozled.API_URL || Bamboozled.API_URL.includes('PASTE_YOUR_GOOGLE')) {
    throw new Error('Paste your Google Apps Script Web App URL into Bamboozled With Jim Happer.js first.');
  }
  const response = await fetch(Bamboozled.API_URL, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...data })
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || 'Google Sheet request failed.');
  return json;
}

function renderPlayers(targetId, players = []) {
  const box = $(targetId);
  if (!box) return;
  box.innerHTML = '';
  const filled = players.filter((p) => p && p.name);
  if (!filled.length) {
    box.innerHTML = '<span class="player-chip">Waiting for players...</span>';
    return;
  }
  filled.forEach((player, index) => {
    const chip = document.createElement('span');
    chip.className = 'player-chip';
    chip.textContent = `${index + 1}. ${player.name}`;
    box.appendChild(chip);
  });
}

function renderScores(targetId, players = []) {
  const box = $(targetId);
  if (!box) return;
  box.innerHTML = '';
  players.filter((p) => p && p.name).forEach((player) => {
    const chip = document.createElement('span');
    chip.className = 'score-chip';
    chip.textContent = `${player.name}: ${player.score || 0}`;
    box.appendChild(chip);
  });
}

function currentRemainingSeconds(state) {
  if (!state || !state.timerEnds) return '';
  return Math.max(0, Math.ceil((Number(state.timerEnds) - Date.now()) / 1000));
}

async function startHost() {
  setText('hostStatus', 'Making a four letter and number code...');
  try {
    const result = await api('createGame');
    Bamboozled.gameCode = result.code;
    setText('hostCode', result.code);
    setText('hostStatus', 'Game sheet created. Waiting for players.');
    window.addEventListener('beforeunload', () => {
      if (!Bamboozled.gameCode) return;
      navigator.sendBeacon?.(Bamboozled.API_URL, JSON.stringify({ action: 'deleteGame', code: Bamboozled.gameCode }));
    });
    hostLoop();
  } catch (error) {
    setText('hostStatus', error.message);
  }
}

async function hostLoop() {
  while (Bamboozled.gameCode) {
    try {
      const state = await api('hostStatus', { code: Bamboozled.gameCode });
      renderPlayers('hostPlayers', state.players);
      renderPlayers('topPlayers', state.players);
      renderPlayers('boardPlayers', state.players);
      renderScores('scoreBoard', state.players);

      if (state.playersWithText >= 2 && state.phase === 'lobby') {
        setText('hostStatus', 'At least two players are in. Approved row 2 on the game sheet. Waiting for MVP to lock Calgoatys.');
      }

      if (state.startGame && !Bamboozled.hostIntroStarted) {
        Bamboozled.hostIntroStarted = true;
        await runHostIntro();
      }

      if ((state.phase === 'board' || state.boardReady) && !Bamboozled.hostBoardLoaded) {
        Bamboozled.hostBoardLoaded = true;
        await loadHostBoard();
      }

      if (state.phase === 'board' && Bamboozled.hostBoardLoaded) {
        setHidden('questionDisplay', true);
        setHidden('gameBoardSection', false);
        await refreshHostBoard();
        setText('hostBoardStatus', state.currentPlayerName ? `${state.currentPlayerName} chooses the next question.` : 'Choose the next question.');
      }

      if (state.phase === 'question' || state.phase === 'steal') {
        Bamboozled.hostBoardLoaded = true;
        showHostQuestionFromState(state);
      }

      if (state.phase === 'end') {
        showEndGame(state);
        break;
      }
    } catch (error) {
      setText('hostStatus', error.message);
      setText('hostBoardStatus', error.message);
    }
    await sleep(Bamboozled.pollMs);
  }
}

async function runHostIntro() {
  setHidden('hostLobby', true);
  setHidden('hostClientImage', true);
  setHidden('introStage', false);

  const lines = [
    '5 Calgoatys',
    '25 Questions',
    '9500 Points Up for Grabs',
    'Most Points Wins, More Points Means Harder Questions',
    'Who Wants to Play Bamboozled?'
  ];

  for (const line of lines) {
    const intro = $('introText');
    intro.style.animation = 'none';
    intro.offsetHeight;
    intro.style.animation = '';
    intro.textContent = line;
    await sleep(3000);
  }

  setText('introText', '');
  await api('prepareBoard', { code: Bamboozled.gameCode });
  await sleep(2000);
}

async function loadHostBoard() {
  setHidden('introStage', true);
  setHidden('gameBoardSection', false);
  await refreshHostBoard();
}

async function refreshHostBoard() {
  const result = await api('getBoard', { code: Bamboozled.gameCode });
  renderBoard(result.board || []);
}

function renderBoard(board) {
  const boardEl = $('gameBoard');
  if (!boardEl) return;
  boardEl.innerHTML = '';

  board.forEach((column, colIndex) => {
    const category = document.createElement('div');
    category.className = 'board-cell category-cell';
    category.textContent = column.category || `Calgoaty ${colIndex + 1}`;
    boardEl.appendChild(category);
  });

  for (let rowIndex = 0; rowIndex < 5; rowIndex++) {
    board.forEach((column) => {
      const point = column.points[rowIndex] || {};
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'board-cell point-cell';
      if (point.used) btn.classList.add('used');
      btn.textContent = point.points || '';
      btn.disabled = !point.points || point.used;
      btn.addEventListener('click', async () => {
        try {
          const state = await api('chooseQuestion', {
            code: Bamboozled.gameCode,
            columnLetter: column.columnLetter,
            calgoaty: column.category,
            pointsRow: point.row,
            playerColumn: ''
          });
          showHostQuestionFromState(state);
        } catch (error) {
          setText('hostBoardStatus', error.message);
        }
      });
      boardEl.appendChild(btn);
    });
  }
}

function showHostQuestionFromState(state) {
  setHidden('gameBoardSection', true);
  setHidden('questionDisplay', false);
  setText('hostTimer', currentRemainingSeconds(state));
  setText('questionTitle', state.category || 'Question');
  setText('questionPoints', state.points ? `${state.points} Points` : '');
  setText('questionText', state.question || 'Waiting for the question...');
  setHidden('hostStealNotice', state.phase !== 'steal');
}

function showEndGame(state) {
  setHidden('hostLobby', true);
  setHidden('introStage', true);
  setHidden('gameBoardSection', true);
  setHidden('questionDisplay', true);
  setHidden('endGameScreen', false);
  const scores = $('finalScores');
  scores.innerHTML = '';
  const max = Math.max(...(state.players || []).map((p) => Number(p.score || 0)), 0);
  (state.players || []).filter((p) => p.name).forEach((player) => {
    const line = document.createElement('div');
    line.className = 'final-score-line' + (Number(player.score || 0) === max ? ' winner' : '');
    line.textContent = `${player.name}: ${player.score || 0}`;
    scores.appendChild(line);
  });
  const winners = (state.players || []).filter((p) => p.name && Number(p.score || 0) === max).map((p) => p.name).join(', ');
  setText('winnerText', winners ? `Winner: ${winners}` : 'No winner found');
}

function bindClient() {
  $('enterCodeButton').addEventListener('click', clientEnterCode);
  $('gameCodeInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') clientEnterCode();
  });
  $('saveNameButton').addEventListener('click', clientSaveName);
  $('lockCalgoatysButton').addEventListener('click', clientLockCalgoatys);
  $('clientCalgoatySelect').addEventListener('change', loadClientPointButtons);
  $('lifelineButton').addEventListener('click', useFiftyFifty);
}

async function clientEnterCode() {
  Bamboozled.gameCode = normalizeCode($('gameCodeInput').value);
  setText('joinMessage', 'Checking code...');
  try {
    const result = await api('checkCode', { code: Bamboozled.gameCode });
    if (!result.found) {
      setText('joinMessage', 'Wrong code');
      return;
    }
    setHidden('joinPanel', true);
    setHidden('namePanel', false);
    setText('nameMessage', 'Code found. Enter your name.');
  } catch (error) {
    setText('joinMessage', error.message);
  }
}

async function clientSaveName() {
  const name = String($('playerNameInput').value || '').trim();
  if (!name) {
    setText('nameMessage', 'Type your name first.');
    return;
  }
  setText('nameMessage', 'Joining...');
  try {
    const result = await api('joinGame', { code: Bamboozled.gameCode, name });
    Bamboozled.playerName = result.name;
    Bamboozled.playerColumn = result.column;
    Bamboozled.isMvp = !!result.mvp;
    setHidden('namePanel', true);
    if (Bamboozled.isMvp) {
      await setupMvpPanel();
    } else {
      setHidden('waitingPanel', false);
      clientLoop();
    }
  } catch (error) {
    setText('nameMessage', error.message);
  }
}

async function setupMvpPanel() {
  try {
    const result = await api('getCalgoatyList');
    Bamboozled.calgoatyNames = result.calgoatys || [];
    const stack = $('calgoatyDropdowns');
    stack.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const select = document.createElement('select');
      select.className = 'western-input mvp-calgoaty-select';
      select.innerHTML = '<option value="">Pick a Calgoaty</option>' +
        Bamboozled.calgoatyNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
      stack.appendChild(select);
    }
    setHidden('mvpPanel', false);
  } catch (error) {
    setText('mvpMessage', error.message);
  }
}

async function clientLockCalgoatys() {
  const selects = Array.from(document.querySelectorAll('.mvp-calgoaty-select'));
  const picks = selects.map((select) => select.value).filter(Boolean);
  if (picks.length !== 5) {
    setText('mvpMessage', 'Pick all 5 Calgoatys first.');
    return;
  }
  setText('mvpMessage', 'Locking in...');
  try {
    await api('lockCalgoatys', { code: Bamboozled.gameCode, picks });
    setHidden('mvpPanel', true);
    setHidden('waitingPanel', false);
    clientLoop();
  } catch (error) {
    setText('mvpMessage', error.message);
  }
}

async function clientLoop() {
  while (Bamboozled.gameCode && Bamboozled.playerColumn) {
    try {
      const state = await api('clientStatus', {
        code: Bamboozled.gameCode,
        column: Bamboozled.playerColumn,
        name: Bamboozled.playerName
      });
      renderClientState(state);
    } catch (error) {
      setText('waitingMessage', error.message);
      setText('clientPlayMessage', error.message);
      setText('clientQuestionMessage', error.message);
    }
    await sleep(Bamboozled.pollMs);
  }
}

async function renderClientState(state) {
  setText('clientOwnScore', `Your Score: ${state.myScore || 0}`);
  setText('clientScoreWaiting', `Your Score: ${state.myScore || 0}`);

  if (state.phase === 'end') {
    setHidden('waitingPanel', true);
    setHidden('clientPlayPanel', true);
    setHidden('clientQuestionBox', true);
    setHidden('clientEndScreen', false);
    const box = $('clientFinalScores');
    box.innerHTML = '';
    (state.players || []).filter((p) => p.name).forEach((player) => {
      const line = document.createElement('div');
      line.textContent = `${player.name}: ${player.score || 0}`;
      box.appendChild(line);
    });
    return;
  }

  if (state.phase === 'lobby' || state.phase === 'intro') {
    setHidden('waitingPanel', false);
    setHidden('clientPlayPanel', true);
    setHidden('clientQuestionBox', true);
    setText('waitingMessage', state.approved ? 'Approved. Waiting for game to start.' : 'Waiting for approval.');
    return;
  }

  if (state.phase === 'board') {
    setHidden('clientQuestionBox', true);
    if (state.ready) {
      setHidden('waitingPanel', true);
      setHidden('clientPlayPanel', false);
      await setupClientPlay(state);
    } else {
      setHidden('clientPlayPanel', true);
      setHidden('waitingPanel', false);
      setText('waitingMessage', state.currentPlayerName ? `Waiting for ${state.currentPlayerName} to choose.` : 'Waiting for your turn.');
    }
    return;
  }

  if (state.phase === 'question' || state.phase === 'steal') {
    setHidden('clientPlayPanel', true);
    setHidden('waitingPanel', !(state.canAnswer || state.canSteal));
    if (state.canAnswer || state.canSteal) {
      showClientQuestion(state);
    } else {
      setHidden('clientQuestionBox', true);
      setText('waitingMessage', state.phase === 'steal' ? 'Steal Available for other players.' : `${state.currentPlayerName || 'Another player'} is answering.`);
    }
  }
}

async function setupClientPlay(state) {
  setText('clientPlayerTitle', `${Bamboozled.playerName}, choose a Calgoaty`);
  const select = $('clientCalgoatySelect');
  const calgoatys = state.calgoatys || [];
  const old = select.value;
  select.innerHTML = calgoatys.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if (calgoatys.includes(old)) select.value = old;
  await loadClientPointButtons();
}

async function loadClientPointButtons() {
  const calgoaty = $('clientCalgoatySelect').value;
  if (!calgoaty || !Bamboozled.gameCode) return;
  const result = await api('getClientButtons', { code: Bamboozled.gameCode, calgoaty });
  const box = $('clientPointButtons');
  box.innerHTML = '';
  const buttons = result.buttons || [];
  if (!buttons.length) {
    box.innerHTML = '<p>No open point buttons for this Calgoaty.</p>';
    return;
  }
  buttons.forEach((buttonInfo) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = buttonInfo.points;
    button.addEventListener('click', async () => {
      try {
        const state = await api('chooseQuestion', {
          code: Bamboozled.gameCode,
          calgoaty,
          pointsRow: buttonInfo.row,
          columnLetter: buttonInfo.columnLetter,
          playerColumn: Bamboozled.playerColumn
        });
        showClientQuestion({ ...state, canAnswer: true });
      } catch (error) {
        setText('clientPlayMessage', error.message);
      }
    });
    box.appendChild(button);
  });
}

function showClientQuestion(state) {
  setHidden('waitingPanel', true);
  setHidden('clientQuestionBox', false);
  setText('clientTimer', currentRemainingSeconds(state));
  setText('clientQuestionTitle', state.phase === 'steal' ? `Steal: ${state.category}` : state.category);
  setText('clientQuestionPoints', state.points ? `${state.points} Points` : '');
  setText('clientQuestionText', state.question || '');
  setText('clientQuestionMessage', state.phase === 'steal' ? 'Steal Available' : 'Choose your answer.');

  const key = `${state.phase}|${state.category}|${state.pointsRow}|${state.timerEnds}`;
  if (Bamboozled.lastQuestionKey !== key) {
    Bamboozled.lastQuestionKey = key;
    Bamboozled.currentHiddenOptions = state.hiddenOptions || [];
  } else if (state.hiddenOptions && state.hiddenOptions.length) {
    Bamboozled.currentHiddenOptions = state.hiddenOptions;
  }

  const answerBox = $('clientAnswerButtons');
  answerBox.innerHTML = '';
  (state.options || []).forEach((optionText, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = optionText || `Op ${index + 1}`;
    if (Bamboozled.currentHiddenOptions.includes(index)) button.classList.add('hidden-answer');
    button.addEventListener('click', async () => submitAnswer(index, optionText));
    answerBox.appendChild(button);
  });

  const lifelineButton = $('lifelineButton');
  const showLifeline = state.phase === 'question' && state.canAnswer;
  lifelineButton.classList.toggle('hidden', !showLifeline);
  lifelineButton.disabled = !!state.lifelineUsed || Bamboozled.currentHiddenOptions.length > 0;
  lifelineButton.textContent = state.lifelineUsed ? '50 and 50 Used' : '50 and 50';
}

async function submitAnswer(optionIndex, optionText) {
  try {
    setText('clientQuestionMessage', 'Checking answer...');
    const state = await api('submitAnswer', {
      code: Bamboozled.gameCode,
      column: Bamboozled.playerColumn,
      optionIndex,
      optionText
    });
    if (state.correct) setText('clientQuestionMessage', 'Correct!');
    else setText('clientQuestionMessage', state.phase === 'steal' ? 'Wrong. Locked out of this steal.' : 'Wrong. Steal Available.');
    renderClientState(state);
  } catch (error) {
    setText('clientQuestionMessage', error.message);
  }
}

async function useFiftyFifty() {
  try {
    const result = await api('useLifeline', {
      code: Bamboozled.gameCode,
      column: Bamboozled.playerColumn
    });
    Bamboozled.currentHiddenOptions = result.hiddenOptions || [];
    document.querySelectorAll('#clientAnswerButtons button').forEach((button, index) => {
      if (Bamboozled.currentHiddenOptions.includes(index)) button.classList.add('hidden-answer');
    });
    $('lifelineButton').disabled = true;
    $('lifelineButton').textContent = '50 and 50 Used';
    setText('clientQuestionMessage', '50 and 50 used. Two wrong answers are gone for the rest of this countdown.');
  } catch (error) {
    setText('clientQuestionMessage', error.message);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'host') startHost();
  if (page === 'client') bindClient();
});
