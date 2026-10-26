# AsciiEQ Discord Caption Bot — Self-Hosting Guide

Live captions for Discord voice calls, with each speaker labelled by name.

You run this small helper on **your own PC**, next to AsciiEQ. There is no shared
server to sign up for: you create your own Discord bot, paste its token here, and
start it. That is the only way it can work, and it is also what keeps your calls
private (see **How it works & privacy** at the bottom).

You need a **paid AsciiEQ license** — the bot checks it before it will join a call.

---

## What you need

- **Windows 10/11** with **AsciiEQ installed** and a **paid license activated**.
- **Node.js 18 or newer** — free, from <https://nodejs.org> (pick the "LTS" installer and click through the defaults).
- A **Discord account** and a server you can add a bot to (you need the *Manage Server* permission on it; your own server is easiest — you can make one in seconds).

To check Node is installed, open a terminal and run `node --version`. You should see something like `v20.x`.

---

## Step 1 — Create your Discord bot (one time, ~3 minutes)

1. Go to the **Discord Developer Portal**: <https://discord.com/developers/applications>
2. Click **New Application**, give it a name (e.g. "My AsciiEQ Captions"), accept, and **Create**.
3. In the left sidebar, open **Bot**.
4. Under **Privileged Gateway Intents**, turn **ON** → **Server Members Intent**. Click **Save Changes**.
   (The bot needs this to confirm you are in the voice channel before it joins.)
5. At the top of the **Bot** page, click **Reset Token**, confirm, then **Copy** the token.
   - Treat this token like a password. Anyone with it can control your bot. Never share it or post it.

## Step 2 — Invite the bot to your server

1. In the sidebar open **OAuth2 → URL Generator**.
2. Under **Scopes**, tick **bot**.
3. Under **Bot Permissions**, tick **View Channels**, **Connect** and **Send Messages**. The bot never
   speaks; it uses Send Messages once per call, to tell the channel that live captions are on.
4. Copy the generated URL at the bottom, open it in your browser, pick your server, and **Authorize**.

> **Captioning other people.** Everyone in the call should know their speech is being transcribed.
> The bot posts a notice in the voice channel's chat when captions start; if it can't (no Send
> Messages permission there), tell people yourself. In some places recording or transcribing a
> conversation needs everyone's consent; you are responsible for following the law where you and
> they are. Nothing is recorded or uploaded: speech is turned into text on your PC only.

The bot will show as offline until you start it in Step 4.

## Step 3 — Configure the token

1. Find the bot folder. If you installed AsciiEQ, it is at:
   `C:\Users\<you>\AppData\Local\Programs\AsciiEQ\discord-bot`
   (or wherever you unzipped it).
2. Double-click **`setup.cmd`**. It installs the bot's dependencies and creates a `.env` file for you.
3. Open the new **`.env`** file in Notepad and paste your token after `DISCORD_BOT_TOKEN=`.
   Save and close.

## Step 4 — Start the bot

1. Double-click **`start.cmd`**.
2. A terminal window opens. When you see **"Logged in as …"** and **"Waiting for AsciiEQ…"**, it is ready.
3. **Leave this window open** while you want captions. Closing it stops the bot.

## Step 5 — Link your Discord account in AsciiEQ

The bot only joins a call that *you* are in, so AsciiEQ needs your Discord User ID:

1. In Discord: **User Settings → Advanced → Developer Mode = ON**.
2. Right-click your own name and choose **Copy User ID**.
3. In AsciiEQ, open the **Visualizer / Captions** page, paste the ID into **Link Discord account**, and confirm.

## Step 6 — Get captions

1. Join a Discord **voice channel**.
2. In AsciiEQ, pick your server and that channel, then **Join**.
3. The bot hops into the call and captions appear, one line per speaker, as people talk.

That's it. Next time you only need Steps 4 and 6.

---

## Troubleshooting

**`node` is not recognized / nothing happens when I run setup.cmd**
Node.js isn't installed or the terminal was open before you installed it. Install from
<https://nodejs.org>, then close and reopen the terminal.

**`setup.cmd` fails while installing (errors mentioning `node-gyp`, `opus`, or a compiler)**
The bot normally installs ready-made binaries and needs no compiler. If your network blocked
that download, run `npm install` again on a normal connection. As a last resort, install the
build tools with `npm install --global windows-build-tools` (admin terminal) and retry.

**The bot says "Logged in" but AsciiEQ says "Connecting to Discord bot…" forever**
AsciiEQ talks to the bot on `ws://127.0.0.1:9849` (your PC only). Make sure the bot and AsciiEQ
are on the **same computer**, and that nothing else is using port 9849. A local firewall prompt
for Node should be allowed (it's a local connection; the bot needs internet only for Discord).

**"You must be in the voice channel for the bot to join"**
Join the Discord voice channel first, and make sure the User ID you linked is *your* account
(Step 5). The ID must match the account that's in the call.

**"Discord captions require a paid AsciiEQ license"**
Activate a paid key in AsciiEQ first. The bot re-checks your license with the AsciiEQ server on
every join, so a trial or expired license is refused.

**Bot joins but there are no captions**
The first time, AsciiEQ downloads its speech model (a few tens of MB) — give it a moment on the
first words. Also check people are actually transmitting (not server-muted) and that you picked
the right channel.

**The bot isn't listed in my server**
Re-do Step 2. You need *Manage Server* on the server you're adding it to.

---

## Keeping it running (optional)

For always-on captions you can keep the bot running in the background with
[PM2](https://pm2.keymetrics.io/):

```
npm install -g pm2
pm2 start index.js --name asciieq-bot
pm2 save
```

Stop it with `pm2 stop asciieq-bot`.

---

## How it works & privacy

- The bot joins the voice call and receives each person's audio from Discord. It converts that
  audio to a small 16 kHz stream and sends it **only to AsciiEQ on your own PC**, over a local
  connection (`127.0.0.1`). **Your voice audio is never uploaded to AsciiEQ's servers or anywhere
  else** — the speech-to-text runs entirely on your machine.
- The only thing that leaves your PC is a quick license check to AsciiEQ's server (to confirm you
  hold a paid license) and the bot's normal connection to Discord.
- Captioning other people means their speech is transcribed on your computer. Let the people you're
  in a call with know you're captioning, and follow your server's rules and local laws on recording.

## Configuration reference (`.env`)

| Setting | What it does |
|---|---|
| `DISCORD_BOT_TOKEN` | Your bot's token from the Developer Portal. Required. |
| `ASCIIEQ_API_URL` | License-check endpoint. Leave as the default unless told otherwise. |
| `VERBOSE` | Set to `1` for detailed per-speaker audio logs (troubleshooting only). |

The bot listens for AsciiEQ on `ws://127.0.0.1:9849` and needs outbound internet to Discord and
to the AsciiEQ license API. It never opens a port to the internet.
