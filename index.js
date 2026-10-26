/**
 * AsciiEQ Discord Caption Bot
 *
 * Joins a Discord voice channel and streams per-user PCM audio
 * over a local WebSocket so AsciiEQ can transcribe each speaker
 * independently with accurate attribution.
 *
 * Protocol (WebSocket on ws://127.0.0.1:9849):
 *   Bot → AsciiEQ:
 *     { type: "user_speaking", userId: "123", username: "Alice", pcm: "<base64 16-bit LE mono 48kHz>" }
 *     { type: "user_joined",  userId: "123", username: "Alice" }
 *     { type: "user_left",    userId: "123", username: "Alice" }
 *     { type: "connected",    channelId: "456", guildId: "789" }
 *     { type: "disconnected" }
 *   AsciiEQ → Bot:
 *     { type: "join",  guildId: "789", channelId: "456" }
 *     { type: "leave" }
 *
 * Usage:
 *   1. Copy .env.example to .env and paste your bot token
 *   2. node index.js (or npm start)
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  EndBehaviorType,
  getVoiceConnection,
  generateDependencyReport,
} = require("@discordjs/voice");
const { WebSocketServer } = require("ws");
const { OpusEncoder } = require("@discordjs/opus");
const { Transform } = require("stream");

// ── Logging ─────────────────────────────────────────────────────
const LOG_PATH = path.join(__dirname, "discord-bot.log");
// Truncate on startup
fs.writeFileSync(LOG_PATH, `=== AsciiEQ Discord Bot Log — ${new Date().toISOString()} ===\n`);

function log(tag, msg, data) {
  const ts = new Date().toISOString();
  const line = data !== undefined
    ? `[${ts}] [${tag}] ${msg} ${JSON.stringify(data)}`
    : `[${ts}] [${tag}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// Verbose-only logging for per-speaker audio detail (VAD, flushes, 30s stats).
// Off by default to keep the window readable; enable with VERBOSE=1 in .env.
const VERBOSE = process.env.VERBOSE === "1" || process.env.VERBOSE === "true";
function vlog(tag, msg, data) {
  if (VERBOSE) log(tag, msg, data);
}

// Per-user stats — accumulated and dumped periodically
const userStats = new Map(); // userId → { username, frames, speechFrames, silentFrames, flushes, totalBytes, rmsSum, rmsCount, peakRms }
function getUserStats(userId, username) {
  if (!userStats.has(userId)) {
    userStats.set(userId, {
      username,
      frames: 0,
      speechFrames: 0,
      silentFrames: 0,
      flushes: 0,
      totalBytesFlushed: 0,
      rmsSum: 0,
      rmsCount: 0,
      peakRms: 0,
      lastFlushTime: null,
    });
  }
  return userStats.get(userId);
}

// Dump stats every 30 seconds
setInterval(() => {
  if (!VERBOSE || userStats.size === 0) return;
  log("STATS", "─── 30s User Stats Dump ───");
  for (const [userId, s] of userStats) {
    const avgRms = s.rmsCount > 0 ? (s.rmsSum / s.rmsCount).toFixed(1) : "0";
    const speechPct = s.frames > 0 ? ((s.speechFrames / s.frames) * 100).toFixed(1) : "0";
    log("STATS", `  ${s.username}`, {
      totalFrames: s.frames,
      speechFrames: s.speechFrames,
      speechPct: `${speechPct}%`,
      avgRms,
      peakRms: s.peakRms.toFixed(1),
      flushes: s.flushes,
      totalKBFlushed: (s.totalBytesFlushed / 1024).toFixed(1),
    });
  }
  log("STATS", "───────────────────────────");
}, 30000);

// ── Config ──────────────────────────────────────────────────────
const WS_PORT = 9849;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
// API used to validate that the caller holds a paid AsciiEQ license.
const API_URL = (process.env.ASCIIEQ_API_URL || "https://api.asciieq.com").replace(/\/+$/, "");

console.log(generateDependencyReport());
const SAMPLE_RATE = 48000; // Discord native
const OUT_SAMPLE_RATE = 16000; // Vosk target — downsample on bot side
const CHANNELS = 1; // mono (discord voice is already mono per-user)
const FRAME_DURATION_MS = 20; // opus frame
const SILENCE_THRESHOLD_MS = 400; // gap before flushing buffered audio (lower = faster captions)
const FLUSH_BYTES = 16000; // ~500ms of 16kHz 16-bit mono (small chunks = lower latency)
const VAD_RMS_THRESHOLD = 300; // Minimum RMS energy to consider a frame as speech (16-bit PCM range)
const VAD_TRAILING_FRAMES = 15; // Keep buffering this many frames after speech stops (~300ms at 20ms/frame)

if (!BOT_TOKEN || BOT_TOKEN === "your_token_here") {
  console.error("Error: Bot token not configured.");
  console.error("  1. Open tools/discord-bot/.env");
  console.error("  2. Replace 'your_token_here' with your bot token from https://discord.com/developers/applications");
  console.error("  3. Run again: npm start");
  process.exit(1);
}

// ── WebSocket Server (local only) ──────────────────────────────
const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
let wsClient = null;

wss.on("connection", (ws) => {
  console.log("[WS] AsciiEQ connected");
  wsClient = ws;

  // Auto-send channel list if bot is already logged in
  if (botReady) {
    listChannels();
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleCommand(msg);
    } catch (e) {
      console.error("[WS] Bad message:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("[WS] AsciiEQ disconnected");
    wsClient = null;
  });
});

function send(obj) {
  if (wsClient && wsClient.readyState === 1) {
    wsClient.send(JSON.stringify(obj));
  }
}

console.log(`[WS] Listening on ws://127.0.0.1:${WS_PORT}`);

// ── Discord Client ─────────────────────────────────────────────
// Only the intents we actually need for voice capture
// GuildMembers is privileged — enable it in Developer Portal > Bot > Privileged Intents
// Required to verify user presence in voice channels before joining
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

let currentConnection = null;
const activeStreams = new Map(); // userId → { username, buffer, timer }
let botReady = false;

client.once("ready", () => {
  botReady = true;
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  console.log(`[Bot] Bot is in ${client.guilds.cache.size} server(s)`);
  console.log(`[Bot] Invite link: https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=1049600&scope=bot`);
  console.log("[Bot] Waiting for AsciiEQ to send join command...");

  // List available guilds and voice channels for easy copy-paste
  for (const guild of client.guilds.cache.values()) {
    console.log(`\n  Server: ${guild.name} (ID: ${guild.id})`);
    const voiceChannels = guild.channels.cache.filter((c) => c.type === 2);
    for (const vc of voiceChannels.values()) {
      console.log(`    Voice: #${vc.name} (ID: ${vc.id})`);
    }
  }
  console.log("");

  // If app is already connected, send the channel list now
  if (wsClient) {
    console.log("[Bot] App already connected, sending channel list");
    listChannels();
  }
});

// ── Commands from AsciiEQ ──────────────────────────────────────
function handleCommand(msg) {
  console.log("[WS] Received command:", msg.type);
  switch (msg.type) {
    case "join":
      joinChannel(msg.guildId, msg.channelId, msg.linkedUserId, msg.licenseToken);
      break;
    case "leave":
      leaveChannel();
      break;
    case "list_channels":
      listChannels();
      break;
    default:
      console.log("[WS] Unknown command:", msg.type);
  }
}

function listChannels() {
  const servers = [];
  for (const guild of client.guilds.cache.values()) {
    const voiceChannels = guild.channels.cache
      .filter((c) => c.type === 2) // GuildVoice
      .map((vc) => {
        const perms = vc.permissionsFor(guild.members.me);
        const canConnect = perms ? perms.has("Connect") : false;
        const canSpeak = perms ? perms.has("Speak") : false;
        // Check if bot is currently in this channel
        const botInChannel =
          currentConnection &&
          currentConnection.joinConfig.guildId === guild.id &&
          currentConnection.joinConfig.channelId === vc.id;
        // Count members currently in the channel (exclude bots)
        const memberCount = vc.members ? vc.members.filter((m) => !m.user.bot).size : 0;
        return {
          id: vc.id,
          name: vc.name,
          canConnect,
          canSpeak,
          botInChannel: !!botInChannel,
          memberCount,
        };
      });
    servers.push({
      guildId: guild.id,
      guildName: guild.name,
      guildIcon: guild.iconURL({ size: 64 }) || null,
      channels: voiceChannels,
    });
  }
  console.log(`[WS] Sending channel_list: ${servers.length} server(s)`);
  send({ type: "channel_list", servers });
}

// ── License validation ─────────────────────────────────────────
// The bot independently verifies the caller's license with the server so captions
// can't be used by simply running this sidecar with a free/trial app.
async function validateLicense(token) {
  if (!token) {
    return { ok: false, reason: "Discord captions require a paid AsciiEQ license. Activate a key in AsciiEQ first." };
  }
  try {
    const res = await fetch(`${API_URL}/v1/license/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      return { ok: false, reason: "License token invalid or expired. Re-activate AsciiEQ." };
    }
    if (!res.ok) {
      return { ok: false, reason: `License check failed (${res.status}).` };
    }
    const data = await res.json();
    if (!data.valid) {
      return { ok: false, reason: "Your license is not valid (revoked or expired)." };
    }
    if (data.tier === "Trial") {
      return { ok: false, reason: "Discord captions require a paid AsciiEQ license." };
    }
    log("LICENSE", `Validated ${data.tier} license — captions allowed`);
    return { ok: true };
  } catch (e) {
    log("LICENSE", `Validation request failed: ${e.message}`);
    return { ok: false, reason: "Could not reach the AsciiEQ license server. Check your connection." };
  }
}

// ── Telling the channel ────────────────────────────────────────
// Everyone in the call must know their speech is being transcribed: Discord's developer policy
// and all-party-consent recording laws both expect it. Posted in the voice channel's own text
// chat each time captions start. Without "Send Messages" there, the bot logs it and carries on;
// the person running captions is then responsible for telling the others (see the guide).
async function announceCaptions(channel, linkedUserId) {
  try {
    if (typeof channel.isTextBased !== "function" || !channel.isTextBased()) return;
    await channel.send(
      `🔴 **Live captions are on** in this channel for <@${linkedUserId}>. ` +
      "Speech here is turned into text on their PC by AsciiEQ; no audio is recorded or uploaded. " +
      "If you'd rather not be captioned, ask them to turn it off."
    );
  } catch (err) {
    log("JOIN", `Could not post the captions notice in #${channel.name}: ${err.message}`);
  }
}

// ── Voice Connection ───────────────────────────────────────────
async function joinChannel(guildId, channelId, linkedUserId, licenseToken) {
  log("JOIN", `Attempting to join guild=${guildId} channel=${channelId} linkedUser=${linkedUserId || "NONE"}`);

  // ── License gate (server-validated) ──
  const lic = await validateLicense(licenseToken);
  if (!lic.ok) {
    log("JOIN", `REFUSED: license check failed — ${lic.reason}`);
    send({ type: "join_refused", reason: lic.reason });
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    log("JOIN", `ERROR: Guild ${guildId} not found in cache`);
    send({ type: "join_refused", reason: "Server not found" });
    return;
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    log("JOIN", `ERROR: Channel ${channelId} not found in guild ${guild.name}`);
    send({ type: "join_refused", reason: "Voice channel not found" });
    return;
  }

  log("JOIN", `Found: ${guild.name} → #${channel.name}`);

  // ── User presence verification ──
  // The linked Discord user ID must be present in the voice channel.
  // This prevents abuse — the bot will only join calls the app user is in.
  if (!linkedUserId) {
    log("JOIN", `REFUSED: No linked user ID provided`);
    send({
      type: "join_refused",
      reason: "No Discord account linked. Link your account in AsciiEQ first.",
    });
    return;
  }

  const members = channel.members;
  const userInChannel = members && members.has(linkedUserId);
  if (!userInChannel) {
    log("JOIN", `REFUSED: User ${linkedUserId} is NOT in #${channel.name}`);
    // List who IS in the channel for debugging
    const inChannel = members
      ? [...members.values()].map((m) => `${m.user.tag} (${m.id})`).join(", ")
      : "unknown";
    log("JOIN", `  Members in channel: ${inChannel || "none"}`);
    send({
      type: "join_refused",
      reason:
        "You must be in the voice channel for the bot to join. " +
        "Join the Discord voice channel first, then try again.",
    });
    return;
  }

  log("JOIN", `VERIFIED: User ${linkedUserId} is in #${channel.name} — proceeding`);

  // Check bot permissions in this channel
  const perms = channel.permissionsFor(guild.members.me);
  if (perms) {
    const canConnect = perms.has("Connect");
    const canSpeak = perms.has("Speak");
    log("JOIN", `Permissions: Connect=${canConnect} Speak=${canSpeak}`);
    if (!canConnect) {
      log("JOIN", `WARNING: Bot may lack Connect permission in #${channel.name} — attempting anyway`);
    }
  }

  // Leave existing connection if any
  leaveChannel();

  currentConnection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // must not be deafened to receive audio
    selfMute: true, // bot doesn't need to speak
  });

  currentConnection.on("stateChange", (oldState, newState) => {
    console.log(`[Bot] Voice state: ${oldState.status} → ${newState.status}`);
  });

  currentConnection.on("error", (err) => {
    console.error(`[Bot] Voice connection error:`, err.message);
  });

  currentConnection.on(VoiceConnectionStatus.Ready, () => {
    console.log(`[Bot] Connected to voice channel ${channelId}`);
    send({ type: "connected", channelId, guildId });
    startReceiving();
    announceCaptions(channel, linkedUserId);
  });

  currentConnection.on(VoiceConnectionStatus.Disconnected, () => {
    console.log("[Bot] Disconnected from voice");
    cleanupStreams();
    send({ type: "disconnected" });
  });

  currentConnection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log("[Bot] Connection destroyed");
    cleanupStreams();
    currentConnection = null;
  });
}

function leaveChannel() {
  if (currentConnection) {
    cleanupStreams();
    currentConnection.destroy();
    currentConnection = null;
    send({ type: "disconnected" });
  }
}

// ── Per-User Audio Receive ─────────────────────────────────────
// Cache of userId → username so we don't fetch every time
const usernameCache = new Map();

async function resolveUsername(userId) {
  if (usernameCache.has(userId)) return usernameCache.get(userId);
  try {
    const user = await client.users.fetch(userId);
    const raw = user.displayName || user.username || `User_${userId}`;
    // Strip Unicode combining characters (U+0300–U+036F, U+0489, etc.) that break monospace rendering
    const name = raw.replace(/[\u0300-\u036f\u0489\u034e\u0350-\u035f]/g, "");
    usernameCache.set(userId, name);
    return name;
  } catch {
    return `User_${userId}`;
  }
}

function startReceiving() {
  if (!currentConnection) return;
  const receiver = currentConnection.receiver;

  receiver.speaking.on("start", async (userId) => {
    if (activeStreams.has(userId)) return; // already subscribed

    const username = await resolveUsername(userId);

    console.log(`[Audio] ${username} started speaking (subscribing)`);
    send({ type: "user_joined", userId, username });

    // Use Manual end behavior — we manage the lifecycle ourselves
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const decoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    const pcmChunks = [];
    let flushTimer = null;
    let totalBuffered = 0;

    const decodeStream = new Transform({
      transform(chunk, encoding, callback) {
        try {
          const decoded = decoder.decode(chunk);
          this.push(decoded);
        } catch {
          // skip bad frames
        }
        callback();
      },
    });

    opusStream.pipe(decodeStream);

    // VAD state: count of silent frames since last speech
    let silentFrames = VAD_TRAILING_FRAMES + 1; // start as "silent"

    decodeStream.on("data", (pcmBuffer) => {
      const rms = computeRms(pcmBuffer);
      const stats = getUserStats(userId, username);
      stats.frames++;
      stats.rmsSum += rms;
      stats.rmsCount++;
      if (rms > stats.peakRms) stats.peakRms = rms;

      if (rms >= VAD_RMS_THRESHOLD) {
        // Speech detected
        if (silentFrames > VAD_TRAILING_FRAMES) {
          vlog("VAD", `${username} speech START`, { rms: rms.toFixed(1), threshold: VAD_RMS_THRESHOLD });
        }
        silentFrames = 0;
        stats.speechFrames++;
      } else {
        silentFrames++;
        stats.silentFrames++;
        if (silentFrames === VAD_TRAILING_FRAMES + 1) {
          vlog("VAD", `${username} speech END (trailing window expired)`, { lastRms: rms.toFixed(1) });
        }
      }

      // Only buffer if speech or within trailing window after speech
      if (silentFrames > VAD_TRAILING_FRAMES) return;

      pcmChunks.push(pcmBuffer);
      totalBuffered += pcmBuffer.length;

      // Reset silence flush timer
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        flushPcm(userId, username, pcmChunks);
        totalBuffered = 0;
      }, SILENCE_THRESHOLD_MS);

      // Flush every ~500ms of audio at 16kHz output rate
      if (totalBuffered >= FLUSH_BYTES * 3) {
        // FLUSH_BYTES*3 = 48000 bytes ≈ 500ms at 48kHz source → ~500ms at 16kHz after downsample
        flushPcm(userId, username, pcmChunks);
        totalBuffered = 0;
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
      }
    });

    decodeStream.on("end", () => {
      if (pcmChunks.length > 0) {
        flushPcm(userId, username, pcmChunks);
      }
      if (flushTimer) clearTimeout(flushTimer);
      console.log(`[Audio] ${username} stream ended`);
      send({ type: "user_left", userId, username });
      activeStreams.delete(userId);
    });

    activeStreams.set(userId, {
      username,
      opusStream,
      decodeStream,
      pcmChunks,
      flushTimer,
    });
  });
}

function flushPcm(userId, username, pcmChunks) {
  if (pcmChunks.length === 0) return;
  const combined = Buffer.concat(pcmChunks.splice(0));
  // Downsample 48kHz → 16kHz with linear interpolation for better quality
  const downsampled = downsample(combined, SAMPLE_RATE, OUT_SAMPLE_RATE);

  const stats = getUserStats(userId, username);
  stats.flushes++;
  stats.totalBytesFlushed += downsampled.length;
  const now = Date.now();
  const sinceLast = stats.lastFlushTime ? `${now - stats.lastFlushTime}ms` : "first";
  stats.lastFlushTime = now;

  vlog("FLUSH", `${username}`, {
    chunks: combined.length / (SAMPLE_RATE * 2 * FRAME_DURATION_MS / 1000),
    srcBytes: combined.length,
    outBytes: downsampled.length,
    outDurationMs: Math.round((downsampled.length / 2 / OUT_SAMPLE_RATE) * 1000),
    sinceLast,
  });

  send({
    type: "user_speaking",
    userId,
    username,
    sampleRate: OUT_SAMPLE_RATE,
    channels: CHANNELS,
    pcm: downsampled.toString("base64"),
  });
}

/**
 * Compute RMS energy of a 16-bit LE PCM buffer.
 * Used for voice activity detection — silence/noise has low RMS.
 */
function computeRms(buf) {
  const samples = buf.length / 2;
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

/**
 * Downsample 16-bit LE PCM using linear interpolation.
 * Much better than nearest-neighbor (no aliasing artifacts).
 */
function downsample(buf, fromRate, toRate) {
  if (fromRate === toRate) return buf;
  const srcSamples = buf.length / 2;
  const ratio = fromRate / toRate;
  const outSamples = Math.floor(srcSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = buf.readInt16LE(Math.min(idx, srcSamples - 1) * 2);
    const s1 = buf.readInt16LE(Math.min(idx + 1, srcSamples - 1) * 2);
    const val = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
  }
  return out;
}

function cleanupStreams() {
  for (const [userId, state] of activeStreams) {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    try {
      state.opusStream.destroy();
    } catch {}
    try {
      state.decodeStream.destroy();
    } catch {}
  }
  activeStreams.clear();
}

// ── Graceful Shutdown ──────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n[Bot] Shutting down...");
  leaveChannel();
  client.destroy();
  wss.close();
  process.exit(0);
});

// ── Start ──────────────────────────────────────────────────────
client.login(BOT_TOKEN);
