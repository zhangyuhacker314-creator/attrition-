# ATTRITION — game + shared leaderboard

Your game, plus a small server so every player sees the same **Ace Board**.

---

## What is in this folder

| File | What it is |
|---|---|
| `public/index.html` | Your game, with the leaderboard added |
| `server.js` | The server — saves scores and sends back the rankings |
| `package.json` | The shopping list that tells Node what to download |
| `render.yaml` | Optional. Lets Render set itself up automatically |
| `.gitignore` | Tells Git to skip `node_modules` and `scores.json` |

A file called `scores.json` appears on its own the first time somebody
scores. You do not need to create it.

---

## Try it on your own computer first

You need [Node.js](https://nodejs.org) installed (any version 18 or newer).

Open a terminal in this folder and run:

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

Register a pilot, fly a sortie, and click **Ace Board**. To see a real
leaderboard, open a second browser window (or an incognito window),
register a *different* callsign, and fly. Both pilots will show up.

Press `Ctrl + C` in the terminal to stop the server.

---

## Putting it on Render

### Step 1 — Put the code on GitHub

Render reads your code from GitHub, so it needs to live there first.

1. Make a free account at [github.com](https://github.com).
2. Click **New repository**, name it `attrition`, keep it **Public**, click **Create**.
3. In a terminal, inside this folder:

```bash
git init
git add .
git commit -m "ATTRITION with leaderboard"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/attrition.git
git push -u origin main
```

Swap `YOUR-USERNAME` for your real GitHub username.

### Step 2 — Create the Web Service

1. Make a free account at [render.com](https://render.com).
2. Click **New +** → **Web Service**.
3. Connect your GitHub and pick your `attrition` repository.
4. Fill the form in exactly like this:

| Field | What to put |
|---|---|
| **Name** | `attrition` (this becomes your web address) |
| **Language** / Runtime | `Node` |
| **Branch** | `main` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | `Free` |

5. Click **Create Web Service** and wait a couple of minutes.

Render gives you an address like `https://attrition.onrender.com`.
Open it and your game is live, leaderboard and all. Send that link to
friends and you will all share one board.

> **Do not set a PORT yourself.** Render picks the port and the server
> already reads it from `process.env.PORT`.

---

## Two things to know about the free plan

**1. It falls asleep.** After about 15 minutes with nobody playing, Render
shuts the service down. The next person to open it waits 30–50 seconds
while it wakes up. The game handles this: the board shows
*"Server is waking up…"* instead of looking broken.

**2. Scores reset when you redeploy.** The free plan has no permanent
disk, so `scores.json` disappears every time you push new code (and
sometimes when the service restarts). Scores are safe while it is running
normally — you just lose them on a deploy.

If you want scores to last forever, you need a paid plan with a Disk:
attach one at mount path `/var/data`, then add an environment variable
`DATA_DIR` = `/var/data`. The `render.yaml` file has this ready to
uncomment.

---

## How the leaderboard works

### Your password never leaves your computer

Accounts still live in your browser's own storage (IndexedDB), exactly
as before. The server only ever receives:

```json
{ "username": "maverick", "best": 14, "totalKills": 52, "sorties": 7, "wave": 8 }
```

No password, no hash. If the server is down or you are offline, the game
carries on perfectly — it just cannot show the board.

### Scores only ever go up

The server keeps the *highest* number it has seen for each pilot. An old
save or a bad run can never wipe out your real best score.

### What the columns mean

| Column | Meaning |
|---|---|
| **Best** | Most kills in a single sortie — this decides the ranking |
| **Sortie** | How far through the campaign you have reached |
| **Career** | Total kills across every flight |

Ties are broken by Sortie, then Career, then whoever got there first.

---

## If something goes wrong

**The board says "Could not reach the score server"**
Is the server running? On your own computer, check the terminal still
shows `ATTRITION server flying on port 3000`. On Render, open your
service and look at the **Logs** tab.

**Render build fails**
Check that Build Command is `npm install` and Start Command is `npm start`,
and that `package.json` is in the top level of the repo (not inside a
sub-folder).

**You opened `index.html` by double-clicking it instead of using the server**
Then the game does not know where the server is. Either use
`http://localhost:3000`, or open `public/index.html`, find this line near
the bottom of the `<script>` section, and put your Render address in:

```js
const SERVER_URL = '';   // -> 'https://attrition.onrender.com'
```

**Someone cheats**
They can, by editing their own save. Stopping that properly means moving
the whole game onto the server, which is a much bigger project. For
playing with friends it is not worth it.
