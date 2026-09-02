# Quiz with Friends — multiplayer server

A working, tested real-time backend for the quiz league game: rooms, live scoring,
boosts, and the full booster-break/awards flow, all driven server-side so nobody
can see hidden answers or fake a score.

## What's here
- `server.js` — the authoritative game server (Node core modules only, zero npm
  dependencies). Runs the whole game loop: category vote, difficulty, 10 questions
  with 5s timers, a booster break every 2 questions, league scoring, and an awards
  ceremony — all with real timers on the server, not the browser.
- `data.js` — categories, question bank, boost definitions (shared).
- `public/index.html` — the client. Connects over Server-Sent Events (SSE) and
  renders whatever the server sends; all it does is display state and submit
  taps (vote / answer / boost).
- `test.js` — an automated script that plays through a full round with two
  simulated players and prints each state transition, useful for checking
  nothing broke after an edit.

## Run it locally
Requires Node.js 18+ (no `npm install` needed — there are no dependencies).

```
node server.js
```

Then open `http://localhost:8787` in a browser tab for each player. On the same
wifi network, other phones can reach it at `http://YOUR-COMPUTER-IP:8787`.

## Make it public — deploy to Render (already set up for you)

This repo now has `package.json`, `render.yaml`, and a git commit ready to go.
Render will auto-detect everything — you just need to get the code onto GitHub
and click connect. This takes about 2 minutes:

**1. Push to GitHub** (needs a free GitHub account — sign up at github.com if
you don't have one):
```
# Create a new empty repo at github.com/new first, then:
cd quiz-server
git remote add origin https://github.com/YOUR-USERNAME/quiz-with-friends.git
git push -u origin main
```

**2. Deploy on Render** (free, no credit card):
- Go to render.com → sign up/sign in with your GitHub account.
- Click **New +** → **Blueprint**.
- Select your `quiz-with-friends` repo. Render reads `render.yaml` automatically
  and fills in the service config — you shouldn't need to change anything.
- Click **Apply** / **Deploy**.
- Wait ~1-2 minutes for the first build. You'll get a URL like
  `https://quiz-with-friends.onrender.com` — that's your public link.

**One thing to know about Render's free tier**: the server "sleeps" after 15
minutes with no traffic, and takes ~30-50 seconds to wake back up on the next
request. Fine for a quiz night with friends (someone opens the link, everyone
waits a moment on the first load, then it's fast). If that wait bugs you later,
Render's cheapest paid tier ($7/mo) removes it.

## Known limitations (next things to tackle)
- **State is in memory** — if the server restarts, all active leagues are lost.
  Fine for a quiz night, not fine long-term. Next step: persist league state to
  a small database (SQLite or Postgres) so it survives restarts.
- **No reconnect-into-a-specific-question** — if someone's phone drops mid-question
  and reopens the page, they rejoin the live stream but missed whatever they
  missed. Good enough for now; a "catch-up" screen would need explicit design.
- **No auth** — anyone with the league code can join as anyone. Fine for
  friends, not for a public product.
- **Dropped SSE messages aren't replayed** — if a phone's connection blips for
  a second, it reconnects and gets the current state, but any boost/feed
  messages that happened during the gap are gone rather than replayed. Not a
  big deal since the current state is always accurate, just less dramatic.
