const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CATEGORIES, QUESTION_BANK, BOOST_DEFS } = require('./data');

const PORT = process.env.PORT || 8787;
const QUESTIONS_PER_QUIZ = 10;
const QUESTION_TIME_MS = 5000;
const BREAK_TIME_MS = 10000;
const SHORT_PAUSE_MS = 2600;
const RESULTS_PAUSE_MS = 4000;
const AWARD_PAUSE_MS = 4000;
const VOTE_TIME_MS = 15000;
const DIFFICULTY_TIME_MS = 15000;

const leagues = new Map();

function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function pick(arr,n){ return shuffle(arr).slice(0,Math.min(n,arr.length)); }
function genCode(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
function genId(){ return crypto.randomBytes(6).toString('hex'); }
function freshBoosts(){ return {freeze:1, swap:1, halve:1, hide:1, x2:1}; }

function newPlayer(name, isHost){
  return {
    id: genId(), name, isHost: !!isHost, connected: true,
    leaguePoints: 0, quizScore: 0, quizScoresHistory: [],
    correctCount: 0, boostsUsedCount: 0,
    boosts: freshBoosts(), hideCounter: 0, x2Counter: 0,
    frozenThisQuestion: false, frozenNextQuestion: false,
    answered: false, answerIndex: null, answerTime: null,
    lastPoints: 0, lastCorrect: false,
  };
}

function findPlayer(league, id){ return league.players.find(p=>p.id===id); }
function opponents(league, id){ return league.players.filter(p=>p.id!==id); }

function setLeagueTimer(league, ms, fn){
  if(league.timer) clearTimeout(league.timer);
  league.timer = setTimeout(fn, ms);
}
function clearLeagueTimer(league){
  if(league.timer){ clearTimeout(league.timer); league.timer = null; }
}

/* ---------- Broadcasting (per-player payloads, so hidden info stays hidden) ---------- */
function buildPayloadFor(league, viewerId){
  const revealed = league.revealed;
  let currentQuestion = null;
  if(league.currentQuestion){
    const viewer = findPlayer(league, viewerId);
    const masked = viewer && viewer.hideCounter > 0 && !revealed;
    currentQuestion = {
      text: league.currentQuestion.text,
      options: league.currentQuestion.options.map(o => masked ? '???' : o.text),
      correctIndex: revealed ? league.currentQuestion.correctIndex : null,
    };
  }
  return {
    code: league.code,
    screen: league.screen,
    leagueLength: league.leagueLength,
    quizIndex: league.quizIndex,
    hostId: league.hostId,
    you: viewerId,
    players: league.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, connected: p.connected,
      leaguePoints: p.leaguePoints, quizScore: p.quizScore,
      correctCount: p.correctCount, boostsUsedCount: p.boostsUsedCount,
      boosts: p.id === viewerId ? p.boosts : undefined,
      frozenThisQuestion: p.frozenThisQuestion,
      answered: p.answered, lastPoints: revealed ? p.lastPoints : undefined,
      lastCorrect: revealed ? p.lastCorrect : undefined,
    })),
    voteOptions: league.voteOptions || null,
    voteTally: league.screen === 'voteResult' ? league.voteTally : null,
    chosenCategory: league.chosenCategory || null,
    chosenDifficulty: league.chosenDifficulty || null,
    questionIndex: league.questionIndex,
    questionsPerQuiz: QUESTIONS_PER_QUIZ,
    currentQuestion,
    revealed: league.revealed,
    questionDeadline: league.questionDeadline || null,
    breakDeadline: league.breakDeadline || null,
    feed: league.feed || [],
    rankedThisQuiz: league.rankedThisQuiz || null,
    awardsList: league.screen === 'awards' || league.screen === 'final' ? league.awardsList : null,
    awardsStep: league.awardsStep,
    boostDefs: BOOST_DEFS,
  };
}

function broadcast(league){
  for(const [pid, res] of league.sseClients.entries()){
    const payload = buildPayloadFor(league, pid);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

/* ---------- Game flow ---------- */
function beginQuizSetup(league){
  league.voteOptions = pick(CATEGORIES, 4);
  league.voteTally = {};
  league.voteOptions.forEach(c => league.voteTally[c.id] = 0);
  league.votesCast = new Set();
  league.screen = 'categoryVote';
  broadcast(league);
  setLeagueTimer(league, VOTE_TIME_MS, () => tallyVotes(league));
}

function tallyVotes(league){
  clearLeagueTimer(league);
  let best = -1, tied = [];
  Object.entries(league.voteTally).forEach(([id, count]) => { if(count > best) best = count; });
  Object.entries(league.voteTally).forEach(([id, count]) => { if(count === best) tied.push(id); });
  if(tied.length === 0) tied = league.voteOptions.map(c => c.id);
  const winnerId = tied[Math.floor(Math.random() * tied.length)];
  league.chosenCategory = CATEGORIES.find(c => c.id === winnerId);
  league.screen = 'voteResult';
  broadcast(league);
  setLeagueTimer(league, 3000, () => goToDifficulty(league));
}

function goToDifficulty(league){
  league.screen = 'difficulty';
  league.chosenDifficulty = null;
  broadcast(league);
  setLeagueTimer(league, DIFFICULTY_TIME_MS, () => {
    league.chosenDifficulty = league.chosenDifficulty || 'medium';
    startQuiz(league);
  });
}

function startQuiz(league){
  clearLeagueTimer(league);
  const pool = QUESTION_BANK[league.chosenCategory.id];
  const sameDiff = pool.filter(q => q.d === league.chosenDifficulty);
  const rest = pool.filter(q => q.d !== league.chosenDifficulty);
  let selected = pick(sameDiff, Math.min(sameDiff.length, QUESTIONS_PER_QUIZ));
  if(selected.length < QUESTIONS_PER_QUIZ){
    selected = selected.concat(pick(rest, QUESTIONS_PER_QUIZ - selected.length));
  }
  league.quizQuestions = shuffle(selected);
  league.questionIndex = 0;
  league.players.forEach(p => { p.quizScore = 0; p.boosts = freshBoosts(); p.hideCounter = 0; p.x2Counter = 0; });
  league.screen = 'quiz';
  loadQuestion(league);
}

function loadQuestion(league){
  clearLeagueTimer(league);
  league.screen = 'quiz';
  const raw = league.quizQuestions[league.questionIndex];
  const opts = raw.o.map((text, i) => ({ text, correct: i === raw.c }));
  const shuffled = shuffle(opts);
  league.currentQuestion = {
    text: raw.q,
    options: shuffled,
    correctIndex: shuffled.findIndex(o => o.correct),
  };
  league.revealed = false;
  league.feed = [];
  league.questionDeadline = Date.now() + QUESTION_TIME_MS;
  league.players.forEach(p => {
    p.frozenThisQuestion = !!p.frozenNextQuestion;
    p.frozenNextQuestion = false;
    p.answered = false;
    p.answerIndex = null;
    p.answerTime = null;
  });
  broadcast(league);
  setLeagueTimer(league, QUESTION_TIME_MS, () => revealAnswer(league));
}

function checkEarlyReveal(league){
  const eligible = league.players.filter(p => p.connected && !p.frozenThisQuestion);
  if(eligible.length > 0 && eligible.every(p => p.answered)){
    revealAnswer(league);
  }
}

function revealAnswer(league){
  if(league.revealed) return;
  clearLeagueTimer(league);
  league.revealed = true;
  const correctIndex = league.currentQuestion.correctIndex;
  league.players.forEach(p => {
    let correct = false, timeLeftMs = 0;
    if(p.answered && !p.frozenThisQuestion){
      correct = p.answerIndex === correctIndex;
      timeLeftMs = Math.max(0, QUESTION_TIME_MS - (p.answerTime - (league.questionDeadline - QUESTION_TIME_MS)));
    }
    let points = 0;
    if(correct){
      points = 500 + Math.round((timeLeftMs / QUESTION_TIME_MS) * 500);
      if(p.x2Counter > 0) points *= 2;
      p.correctCount += 1;
    }
    p.lastPoints = points;
    p.lastCorrect = correct;
    p.quizScore += points;
    if(p.hideCounter > 0) p.hideCounter -= 1;
    if(p.x2Counter > 0) p.x2Counter -= 1;
  });
  broadcast(league);
  setLeagueTimer(league, SHORT_PAUSE_MS, () => advanceQuestion(league));
}

function advanceQuestion(league){
  const nextIndex = league.questionIndex + 1;
  if(nextIndex < QUESTIONS_PER_QUIZ){
    league.questionIndex = nextIndex;
    if(nextIndex % 2 === 0){
      enterBoosterBreak(league);
    } else {
      loadQuestion(league);
    }
  } else {
    finishQuiz(league);
  }
}

function enterBoosterBreak(league){
  clearLeagueTimer(league);
  league.screen = 'boosterBreak';
  league.feed = [];
  league.breakDeadline = Date.now() + BREAK_TIME_MS;
  broadcast(league);
  setLeagueTimer(league, BREAK_TIME_MS, () => loadQuestion(league));
}

function finishQuiz(league){
  clearLeagueTimer(league);
  league.players.forEach(p => p.quizScoresHistory.push(p.quizScore));
  const ranked = league.players.slice().sort((a, b) => b.quizScore - a.quizScore);
  const n = league.players.length;
  ranked.forEach((p, idx) => {
    const leaguePts = Math.max(n - idx, 0);
    p.lastLeaguePoints = leaguePts;
    p.leaguePoints += leaguePts;
  });
  league.rankedThisQuiz = ranked.map(p => ({ id: p.id, name: p.name, quizScore: p.quizScore, lastLeaguePoints: p.lastLeaguePoints }));
  league.screen = 'quizResults';
  broadcast(league);
  setLeagueTimer(league, RESULTS_PAUSE_MS, () => {
    league.screen = 'leaderboard';
    broadcast(league);
    setLeagueTimer(league, RESULTS_PAUSE_MS, () => {
      if(league.quizIndex + 1 < league.leagueLength){
        league.quizIndex += 1;
        beginQuizSetup(league);
      } else {
        buildAwards(league);
        league.screen = 'awards';
        league.awardsStep = 0;
        broadcast(league);
        stepAwards(league);
      }
    });
  });
}

function buildAwards(league){
  const players = league.players;
  const champ = players.slice().sort((a, b) => b.leaguePoints - a.leaguePoints)[0];
  const podium = players.slice().sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, 3).map(p => ({ name: p.name }));
  const mostBoosts = players.slice().sort((a, b) => b.boostsUsedCount - a.boostsUsedCount)[0];
  const leastBoosts = players.slice().sort((a, b) => a.boostsUsedCount - b.boostsUsedCount)[0];
  const mostCorrect = players.slice().sort((a, b) => b.correctCount - a.correctCount)[0];
  const leastCorrect = players.slice().sort((a, b) => a.correctCount - b.correctCount)[0];
  let bestSingle = { name: '-', score: -1, quiz: 0 };
  let worstSingle = { name: '-', score: Infinity, quiz: 0 };
  players.forEach(p => {
    p.quizScoresHistory.forEach((s, idx) => {
      if(s > bestSingle.score) bestSingle = { name: p.name, score: s, quiz: idx + 1 };
      if(s < worstSingle.score) worstSingle = { name: p.name, score: s, quiz: idx + 1 };
    });
  });
  league.awardsList = [
    { title: 'League champion', emoji: '🏆', body: `${champ.name} takes the league with ${champ.leaguePoints} points!`, podium },
    { title: 'Boost baron', emoji: '⚡', body: `${mostBoosts.name} fired off the most boosts — ${mostBoosts.boostsUsedCount} used.` },
    { title: 'Boost shy', emoji: '🧊', body: `${leastBoosts.name} kept it clean, using just ${leastBoosts.boostsUsedCount}.` },
    { title: 'Brainbox', emoji: '🧠', body: `${mostCorrect.name} nailed the most correct answers — ${mostCorrect.correctCount} in total.` },
    { title: 'Wildcard guesser', emoji: '🎯', body: `${leastCorrect.name} had the fewest correct answers, with ${leastCorrect.correctCount}.` },
    { title: 'High scorer', emoji: '📈', body: `${bestSingle.name} posted the league's top single-quiz score: ${bestSingle.score} in quiz ${bestSingle.quiz}.` },
    { title: 'Rocky round', emoji: '📉', body: `${worstSingle.name} had the toughest round: ${worstSingle.score} points in quiz ${worstSingle.quiz}.` },
  ];
}

function stepAwards(league){
  setLeagueTimer(league, AWARD_PAUSE_MS, () => {
    league.awardsStep += 1;
    if(league.awardsStep >= league.awardsList.length){
      league.screen = 'final';
      broadcast(league);
    } else {
      broadcast(league);
      stepAwards(league);
    }
  });
}

/* ---------- Boosts ---------- */
function applyBoost(league, user, type, target){
  const def = BOOST_DEFS[type];
  if(!def || user.boosts[type] <= 0) return { error: 'No charges left' };
  if(league.screen !== 'boosterBreak') return { error: 'Boosts can only be used during a booster break' };
  user.boosts[type] -= 1;
  user.boostsUsedCount += 1;
  const tName = target.id === user.id ? 'themself' : target.name;
  switch(type){
    case 'freeze':
      target.frozenNextQuestion = true;
      league.feed.push(`🧊 ${user.name} froze ${tName} for the next question!`);
      break;
    case 'swap': {
      const tmp = user.quizScore; user.quizScore = target.quizScore; target.quizScore = tmp;
      league.feed.push(`🔄 ${user.name} swapped scores with ${tName}!`);
      break;
    }
    case 'halve':
      target.quizScore = Math.floor(target.quizScore / 2);
      league.feed.push(`✂️ ${user.name} halved ${tName}'s score!`);
      break;
    case 'hide':
      target.hideCounter = 3;
      league.feed.push(`🙈 ${user.name} blindfolded ${tName} for 3 questions!`);
      break;
    case 'x2':
      user.x2Counter = 3;
      league.feed.push(`⚡ ${user.name} activated double points!`);
      break;
  }
  broadcast(league);
  return { ok: true };
}

/* ---------- HTTP layer ---------- */
function send(res, status, body){
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function readBody(req){
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch(e){ resolve({}); } });
  });
}

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const parts = u.pathname.split('/').filter(Boolean);

  if(req.method === 'OPTIONS'){
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  // Static file serving for the client
  if(req.method === 'GET' && parts[0] !== 'api'){
    let filePath = u.pathname === '/' ? '/index.html' : u.pathname;
    filePath = path.join(__dirname, filePath);
    fs.readFile(filePath, (err, data) => {
      if(err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(data);
    });
    return;
  }

  if(parts[0] === 'api' && parts[1] === 'categories' && req.method === 'GET'){
    return send(res, 200, CATEGORIES);
  }

  if(parts[0] === 'api' && parts[1] === 'league' && !parts[2] && req.method === 'POST'){
    const body = await readBody(req);
    const name = (body.name || 'Host').slice(0, 20);
    const leagueLength = [3,4,5].includes(body.leagueLength) ? body.leagueLength : 4;
    const code = genCode();
    const host = newPlayer(name, true);
    const league = {
      code, hostId: host.id, leagueLength, players: [host],
      quizIndex: 0, screen: 'lobby', sseClients: new Map(), feed: [],
      timer: null,
    };
    leagues.set(code, league);
    return send(res, 200, { code, playerId: host.id });
  }

  if(parts[0] === 'api' && parts[1] === 'league' && parts[3] === 'join' && req.method === 'POST'){
    const league = leagues.get(parts[2]);
    if(!league) return send(res, 404, { error: 'League not found' });
    if(league.screen !== 'lobby') return send(res, 400, { error: 'League already started' });
    const body = await readBody(req);
    const name = (body.name || 'Player').slice(0, 20);
    const player = newPlayer(name, false);
    league.players.push(player);
    broadcast(league);
    return send(res, 200, { playerId: player.id });
  }

  if(parts[0] === 'api' && parts[1] === 'league' && parts[3] === 'start' && req.method === 'POST'){
    const league = leagues.get(parts[2]);
    if(!league) return send(res, 404, { error: 'League not found' });
    const body = await readBody(req);
    const player = findPlayer(league, body.playerId);
    if(!player || !player.isHost) return send(res, 403, { error: 'Only the host can start' });
    if(league.players.length < 2) return send(res, 400, { error: 'Need at least 2 players' });
    beginQuizSetup(league);
    return send(res, 200, { ok: true });
  }

  if(parts[0] === 'api' && parts[1] === 'league' && parts[3] === 'vote' && req.method === 'POST'){
    const league = leagues.get(parts[2]);
    if(!league || league.screen !== 'categoryVote') return send(res, 400, { error: 'Not voting right now' });
    const body = await readBody(req);
    const player = findPlayer(league, body.playerId);
    if(!player) return send(res, 404, { error: 'Unknown player' });
    if(!league.votesCast.has(player.id) && league.voteTally[body.categoryId] !== undefined){
      league.voteTally[body.categoryId] += 1;
      league.votesCast.add(player.id);
      broadcast(league);
      const connectedCount = league.players.filter(p => p.connected).length;
      if(league.votesCast.size >= connectedCount) tallyVotes(league);
    }
    return send(res, 200, { ok: true });
  }

  if(parts[0] === 'api' && parts[1] === 'league' && parts[3] === 'difficulty' && req.method === 'POST'){
    const league = leagues.get(parts[2]);
    if(!league || league.screen !== 'difficulty') return send(res, 400, { error: 'Not choosing difficulty right now' });
    const body = await readBody(req);
    const player = findPlayer(league, body.playerId);
    if(!player || !player.isHost) return send(res, 403, { error: 'Only the host can pick difficulty' });
    if(!['easy','medium','hard'].includes(body.difficulty)) return send(res, 400, { error: 'Bad difficulty' });
    league.chosenDifficulty = body.difficulty;
    startQuiz(league);
    return send(res, 200, { ok: true });
  }

  if(parts[0] === 'api' && parts[1] === 'league' && parts[3] === 'answer' && req.method === 'POST'){
    const league = leagues.get(parts[2]);
    if(!league || league.screen !== 'quiz' || league.revealed) return send(res, 400, { error: 'Not answering right now' });
    const body = await readBody(req);
    const player = findPlayer(league, body.playerId);
    if(!player || player.frozenThisQuestion || player.answered) return send(res, 400, { error: 'Cannot answer' });
    player.answered = true;
    player.answerIndex = body.optionIndex;
    player.answerTime = Date.now();
    broadcast(league);
    checkEarlyReveal(league);
    return send(res, 200, { ok: true });
  }

  if(parts[0] === 'api' && parts[1] === 'league' && parts[3] === 'boost' && req.method === 'POST'){
    const league = leagues.get(parts[2]);
    if(!league) return send(res, 404, { error: 'League not found' });
    const body = await readBody(req);
    const user = findPlayer(league, body.playerId);
    const target = findPlayer(league, body.targetId) || user;
    if(!user) return send(res, 404, { error: 'Unknown player' });
    const result = applyBoost(league, user, body.type, target);
    if(result.error) return send(res, 400, result);
    return send(res, 200, result);
  }

  if(parts[0] === 'api' && parts[1] === 'league' && parts[3] === 'stream' && req.method === 'GET'){
    const league = leagues.get(parts[2]);
    if(!league) { res.writeHead(404); return res.end(); }
    const playerId = u.searchParams.get('playerId');
    const player = findPlayer(league, playerId);
    if(!player) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    player.connected = true;
    league.sseClients.set(playerId, res);
    res.write(`data: ${JSON.stringify(buildPayloadFor(league, playerId))}\n\n`);
    broadcast(league);
    req.on('close', () => {
      league.sseClients.delete(playerId);
      player.connected = false;
      broadcast(league);
    });
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Quiz server running on http://localhost:${PORT}`));
