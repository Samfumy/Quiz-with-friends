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

  console.log('--- Adding 2 bots ---');
  console.log(await post(`/api/league/${code}/addBot`, { playerId: aliceId }));
  console.log(await post(`/api/league/${code}/addBot`, { playerId: aliceId }));
  await sleep(300);
  console.log('Lobby now has', aliceState.players.length, 'players:', aliceState.players.map(p=>p.name+(p.isBot?' (bot)':'')));

  console.log('--- Starting league ---');
  console.log(await post(`/api/league/${code}/start`, { playerId: aliceId }));
  await sleep(400);

  console.log('--- Alice votes, waiting for bots to auto-vote ---');
  const catId = aliceState.voteOptions[0].id;
  await post(`/api/league/${code}/vote`, { playerId: aliceId, categoryId: catId });
  await post(`/api/league/${code}/vote`, { playerId: bobId, categoryId: catId });
  await sleep(3000); // give bots time to auto-vote and trigger tally
  console.log('Chosen category:', aliceState.chosenCategory, 'screen:', aliceState.screen);

  await sleep(3200); // wait for voteResult -> difficulty transition
  console.log('--- Host picks easy difficulty ---');
  console.log(await post(`/api/league/${code}/difficulty`, { playerId: aliceId, difficulty: 'easy' }));
  await sleep(1000);
  console.log('Question 1 up. Waiting for bots to auto-answer...');
  await sleep(5200); // let the full 5s question + bot answers play out
  console.log('Revealed:', aliceState.revealed);
  console.log('Players after Q1:', aliceState.players.map(p => ({n:p.name, bot:p.isBot, answered:p.answered, correct:p.lastCorrect, pts:p.lastPoints})));

  await sleep(3200); // reveal pause -> loads Q2
  console.log('--- Waiting for Q2 to auto-resolve (bots answer on their own) ---');
  await sleep(5200);
  console.log('Screen after Q2 resolves + advance:', aliceState.screen);
  await sleep(1000);
  console.log('Screen now (should be boosterBreak):', aliceState.screen);

  if(aliceState.screen === 'boosterBreak'){
    await sleep(3000);
    console.log('Feed after bots had a chance to use boosts:', aliceState.feed);
    console.log('Bot boost charges remaining:', aliceState.players.filter(p=>p.isBot).map(p=>({n:p.name, boosts:p.boosts})));
  }

  await sleep(200);
  server.kill();
  console.log('--- Test complete, server stopped ---');
  process.exit(0);
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
