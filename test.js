const { spawn } = require('child_process');
const BASE = 'http://localhost:8787';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function post(path, body){
  const r = await fetch(BASE + path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  return r.json();
}

function openStream(code, playerId, onEvent){
  fetch(`${BASE}/api/league/${code}/stream?playerId=${playerId}`).then(async (r) => {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while(true){
      const { done, value } = await reader.read();
      if(done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while((idx = buf.indexOf('\n\n')) >= 0){
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if(chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)));
      }
    }
  }).catch(e => console.log('stream error', e.message));
}

async function main(){
  const server = spawn('node', ['server.js'], { cwd: __dirname });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stdout.write('[server-err] ' + d));
  await sleep(600);

  let aliceState = null, bobState = null;
  const { code, playerId: aliceId } = await post('/api/league', { name: 'Alice', leagueLength: 3 });
  console.log('Created league', code, 'host', aliceId);
  const { playerId: bobId } = await post(`/api/league/${code}/join`, { name: 'Bob' });
  console.log('Bob joined', bobId);

  openStream(code, aliceId, s => { aliceState = s; console.log('[Alice sees]', s.screen); });
  openStream(code, bobId, s => { bobState = s; console.log('[Bob sees]', s.screen); });
  await sleep(400);

  console.log('--- Starting league ---');
  console.log(await post(`/api/league/${code}/start`, { playerId: aliceId }));
  await sleep(400);

  const catId = aliceState.voteOptions[0].id;
  console.log('--- Both vote for', catId, '---');
  await post(`/api/league/${code}/vote`, { playerId: aliceId, categoryId: catId });
  await post(`/api/league/${code}/vote`, { playerId: bobId, categoryId: catId });
  await sleep(500);
  console.log('Chosen category:', aliceState.chosenCategory);

  await sleep(3200); // wait for voteResult -> difficulty transition
  console.log('--- Host picks easy difficulty ---');
  console.log(await post(`/api/league/${code}/difficulty`, { playerId: aliceId, difficulty: 'easy' }));
  await sleep(400);
  console.log('Question 1:', aliceState.currentQuestion);

  console.log('--- Alice answers correct option, Bob answers wrong ---');
  const correctIdx = 0; // we don't know true correctIndex (hidden), just answer something for both
  await post(`/api/league/${code}/answer`, { playerId: aliceId, optionIndex: 0 });
  await post(`/api/league/${code}/answer`, { playerId: bobId, optionIndex: 1 });
  await sleep(400);
  console.log('Revealed?', aliceState.revealed, 'players:', aliceState.players.map(p => ({n:p.name, correct:p.lastCorrect, pts:p.lastPoints})));

  await sleep(3000); // reveal pause + next question load
  console.log('Now on:', aliceState.screen, 'question index', aliceState.questionIndex);

  // Answer question 2 for both to trigger early reveal, then should hit booster break
  if(aliceState.screen === 'quiz'){
    await post(`/api/league/${code}/answer`, { playerId: aliceId, optionIndex: 0 });
    await post(`/api/league/${code}/answer`, { playerId: bobId, optionIndex: 0 });
    await sleep(300);
    console.log('Early reveal check -> revealed:', aliceState.revealed);
    await sleep(3000);
  }
  console.log('Screen after Q2:', aliceState.screen);

  if(aliceState.screen === 'boosterBreak'){
    console.log('--- Bob freezes Alice for next question ---');
    console.log(await post(`/api/league/${code}/boost`, { playerId: bobId, type: 'freeze', targetId: aliceId }));
    await sleep(300);
    console.log('Feed:', aliceState.feed, 'Alice frozenNextQuestion applied via boosts count:', bobState.players.find(p=>p.id===bobId).boostsUsedCount);
  }

  await sleep(200);
  server.kill();
  console.log('--- Test complete, server stopped ---');
  process.exit(0);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
