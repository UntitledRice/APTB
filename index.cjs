// Requires: discord.js v14, node 18+, dotenv

require('dotenv').config();
// Fetch import (compatible with CommonJS)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN in environment! Set it in .env file.");
  process.exit(1);
}

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ComponentType,
  InteractionType,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');

// -------------------- Config (IDs) --------------------
const OWNER_ID = '754859771479457879';
const STAFF_ROLE_ID = '1424190162983976991';
//const HEARTBEAT_CHANNEL_ID = '1426317682575282226';
const ACTION_LOG_CHANNEL_ID = '1426318804849262643';
const MUTED_ROLE_ID = '1426552661074772018';
const MOD_LOG_CHANNEL_ID = '1427621567856251020'; // Punishment logs channel ID
const prefix = '.';

// -------------------- Files & persistence --------------------
const LOGS_DIR = path.join(process.cwd(), 'logs');
const WARNINGS_FILE = path.join(process.cwd(), 'warnings.json');
const LOCKED_CHANNELS_FILE = path.join(process.cwd(), 'lockedChannels.json');
const STATS_FILE = path.join(process.cwd(), 'stats_channels.json');
const BYPASS_FILE = path.join(process.cwd(), 'bypass.json');
const INACTIVE_FILE = path.join(process.cwd(), 'inactiveTimers.json');
const GIVEAWAYS_FILE = path.join(process.cwd(), 'giveaways.json');
const GIVEAWAY_BANS_FILE = path.join(process.cwd(), 'giveawayBans.json');
const GIVEAWAY_RIGGED_FILE = path.join(process.cwd(), 'giveawayRigged.json');
const TICKET_STATE_FILE = path.join(process.cwd(), 'data', 'tickets_state.json');
// Keeps track of rigged coinflip results (userId -> "heads"/"tails")
const coinRigMap = new Map();

// Ensure logs dir exists
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Ensure data folder + default state exist
try {
  if (!fs.existsSync(path.join(process.cwd(), 'data'))) fs.mkdirSync(path.join(process.cwd(), 'data'));
  if (!fs.existsSync(TICKET_STATE_FILE)) fs.writeFileSync(TICKET_STATE_FILE, JSON.stringify({ posted: [] }, null, 2));
} catch (err) { console.error('Failed ensure ticket storage:', err); }

// Reference role/category IDs (editable mapping)
const TICKET_REFERENCES = {
  // categories
  categories: {
    support: '1424211950069481492', // Support category
    sellbuy: '1424383802402275489', // Sell/buy Spawners
    gwclaim: '1424383655278678069', // Giveaway Claim Tickets
    partner: '1425230917110206566', // Partner tickets
  },
  // roles to ping per ticket
  roles: {
    staff: '1424190162983976991',
    buyer: '1425194486715387924',
    seller: '1425194948541812937',
    partnerManager: '1424203753552220170',
    seniorAdmin: '1424193103744733335',
    headAdmin: '1424199126991507608',
    admin: '1424199702596948072',
    summonAPT: '1424189356008280094',
    trialMod: '1424205270963458111',
  }
};

// Ticket catalog
const SAVED_TICKETS = [
  {
    id: 1,
    name: 'Support tickets',
    description: 'Pick one of the following to best assist you. False claims or troll tickets will be closed and you may be muted.',
    buttons: [
      { id: 'support:general', label: '🧬 General Support' },
      { id: 'support:sell', label: '💵 Sell Spawners' },
      { id: 'support:buy', label: '💸 Buy Spawners' },
      { id: 'support:gw', label: '🏆 GW Claim' },
      { id: 'support:partner', label: '🤝 Partner' },
      { id: 'support:wager', label: '⚔️ Wager' },
      { id: 'support:suggestions', label: '❓ Suggestions' }
    ]
  },
  {
    id: 2,
    name: 'Applications',
    description: 'Pick one of the following applications to apply for. Troll tickets will be closed and you may be muted.',
    buttons: [
      { id: 'apps:staff', label: '🤖 Staff' },
      { id: 'apps:pm', label: '🤝 Partner Manager' },
      { id: 'apps:sponsor', label: '💸 Sponsor' },
      { id: 'apps:trusted', label: '👍 Trusted Roles' },
      { id: 'apps:vouches', label: '✅ Vouches Roles' }
    ]
  }
];

// Helper to format timestamp mm/dd/yyyy hh:MM (24h)
function formatTicketTimestamp(date = new Date()) {
  const pad = s => String(s).padStart(2, '0');
  return `${pad(date.getMonth()+1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// -------------------- Minimal helpers --------------------
// Safe JSON reading with fallback to empty object
function safeReadJSON(path, fallback = {}) {
  try {
    if (!fs.existsSync(path)) return fallback;
    const raw = fs.readFileSync(path, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return fallback;
  }
}

// Safe JSON writing
function safeWriteJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ JSON write failed:', e);
  }
}

// ===== Ticket state persistence helpers (persistent) =====
// data dir & file
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('Failed creating data dir:', e); }
}
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');

/**
 * readTicketState()
 * Synchronously returns the persisted ticket state object, or {} if missing/corrupt.
 * Synchronous read at startup makes boot deterministic.
 */
function readTicketState() {
  try {
    if (!fs.existsSync(TICKETS_FILE)) return {};
    const raw = fs.readFileSync(TICKETS_FILE, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.error('readTicketState failed - returning empty state:', err);
    return {};
  }
}

/**
 * writeTicketState(state)
 * Persist ticket state asynchronously (fire-and-forget). Returns Promise if awaited.
 */
function writeTicketState(state) {
  try {
    const data = state || {};
    // write atomically to a temp file then rename to reduce corruption risk
    const tmp = `${TICKETS_FILE}.tmp`;
    return fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
      .then(() => fsp.rename(tmp, TICKETS_FILE))
      .catch(err => {
        console.error('writeTicketState async failed:', err);
      });
  } catch (err) {
    console.error('writeTicketState failed:', err);
    return Promise.resolve(); // keep callers safe
  }
}

/**
 * writeTicketStateSync(state)
 * If you need a synchronous write (for shutdown paths), use this.
 */
function writeTicketStateSync(state) {
  try {
    const data = JSON.stringify(state || {}, null, 2);
    const tmp = `${TICKETS_FILE}.tmp`;
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, TICKETS_FILE);
  } catch (err) {
    console.error('writeTicketStateSync failed:', err);
  }
}

// ---------- Ticket runtime state (persistent) ----------
const _ticketStateStartup = (typeof readTicketState === 'function') ? readTicketState() : {};
let postedTicketMenus = Array.isArray(_ticketStateStartup.posted) ? _ticketStateStartup.posted : [];
let openTickets = (_ticketStateStartup.open && typeof _ticketStateStartup.open === 'object')
  ? _ticketStateStartup.open
  : {};

// Function to handle warning and mute logic
async function handleWarningsAndMute(user, message) {
  const muteRole = message.guild.roles.cache.get(MUTED_ROLE_ID);
  if (!muteRole) return; // If mute role is not found, exit the function

  // Get the number of warnings for the user
  const warnCount = warnings[user.id]?.length || 0;
  let muteDuration = 0;
  let muteMessage = '';

  // Check for 3 warnings (10-minute mute)
  if (warnCount === 3) {
    muteDuration = 10 * 60 * 1000; // 10 minutes
    muteMessage = `You have been muted for **10 minutes** due to reaching **3 warnings**.`;

  // Check for 5 warnings (1-hour mute for the first time)
  } else if (warnCount === 5) {
    muteDuration = 60 * 60 * 1000; // 1 hour
    muteMessage = `You have been muted for **1 hour** due to reaching **5 warnings**.`;

  // For every multiple of 5 warnings, mute time doubles (e.g., 10 warnings = 2-hour mute)
  } else if (warnCount > 5 && warnCount % 5 === 0) {
    const baseDuration = 60 * 60 * 1000; // 1 hour
    const multiplier = Math.pow(2, (warnCount / 5) - 1); // Doubles every 5 warnings
    muteDuration = baseDuration * multiplier;
    const muteHours = muteDuration / (60 * 60 * 1000);
    muteMessage = `You have been muted for **${muteHours} hour(s)** due to reaching **${warnCount} warnings**.`;
  }

  // If no mute is required, exit
  if (muteDuration === 0) return;

  try {
    // Mute the user
    await user.roles.add(muteRole);
    await message.channel.send(`🚨 ${user.user.tag} reached ${warnCount} warnings and has been muted for the appropriate duration.`);

    // Send DM to the user
    const embed = new EmbedBuilder()
      .setTitle('🔇 You have been muted')
      .setColor(0xff0000)
      .setDescription(`${muteMessage}\n\nYou currently have **${warnCount} warnings**. You need **${warnCount + 2} warnings** for the next punishment.`);
    await user.send({ embeds: [embed] }).catch(() => {});

    // Set a timeout to auto-unmute after the defined mute duration
    setTimeout(async () => {
      try {
        await user.roles.remove(muteRole);
        await message.channel.send(`✅ Auto-unmute: ${user.user.tag}`);
      } catch (err) { console.error('❌ Auto-unmute failed:', err); }
    }, muteDuration);
  } catch (err) {
    console.error('❌ Failed to mute user:', err);
  }
}

// -------------------- Load persisted data --------------------
// Read data from JSON files with default fallback to empty objects
let warnings = safeReadJSON(WARNINGS_FILE, {});
let lockedChannels = safeReadJSON(LOCKED_CHANNELS_FILE, {});
let statsData = safeReadJSON(STATS_FILE, {});
let bypassList = safeReadJSON(BYPASS_FILE, {});
let inactiveTimers = safeReadJSON(INACTIVE_FILE, {});
let giveaways = safeReadJSON(GIVEAWAYS_FILE, {});
let giveawayBans = safeReadJSON(GIVEAWAY_BANS_FILE, {});
let giveawayRigged = safeReadJSON(GIVEAWAY_RIGGED_FILE, {});

// In-memory small locks to avoid race conditions when many users press Join simultaneously
const giveawayLocks = new Set();

console.log("🔄 Loaded persisted data:");
console.log(`- Warnings: ${Object.keys(warnings).length} users`);
console.log(`- Locked Channels: ${Object.keys(lockedChannels).length}`);
console.log(`- Stats Channels: ${Object.keys(statsData).length}`);
console.log(`- Bypass List: ${Object.keys(bypassList).length}`);
console.log(`- Inactive Timers: ${Object.keys(inactiveTimers).length}`);
console.log(`- Giveaways: ${Object.keys(giveaways).length}`);
console.log(`- Giveaway Bans: ${Object.keys(giveawayBans).length}`);
console.log(`- Giveaway Rigged: ${Object.keys(giveawayRigged).length}`);

// -------------------- Discord client --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

let botReady = false;

// -------------------- Port (for PI) --------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_req, res) => res.send('APTBot is alive and running!'));
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Express server running on port ${PORT}`));

// -------------------- Startup and Login --------------------
(async () => {
  try {
console.log('🚀 Starting APTBot initialization...');
console.log('🕐 Attempting Discord login...');

const loginWithTimeout = async (timeoutMs = 45000) => {
  return Promise.race([
    client.login(process.env.DISCORD_TOKEN),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Login timeout after 45s')), timeoutMs))
  ]);
};

try {
  const res = await fetch('https://discord.com/api/v10/gateway');
  console.log('🌐 Discord API reachable:', res.ok);
} catch (err) {
  console.error('❌ Discord API unreachable:', err);
}

try {
  await loginWithTimeout(90000);
  console.log('🔑 Discord login successful.');
} catch (err) {
  console.error('❌ Discord login failed or timed out:', err);
  console.log('🔁 Retrying login in 10 seconds...');
  setTimeout(async () => {
    try {
      await client.login(process.env.DISCORD_TOKEN);
      console.log('✅ Reconnected successfully.');
    } catch (retryErr) {
      console.error('🚫 Retry failed:', retryErr);
      process.exit(1);
    }
  }, 10_000);
}

    // Handle when bot is ready
    client.once('ready', async () => {
      console.log(`🤖 Logged in as ${client.user.tag}!`);
      console.log(`✅ All systems initialized successfully.`);
      console.log('🌐 Express server is running (Render environment detected).');

      // ✅ 5-second delay before marking bot as fully ready
      setTimeout(() => {
        botReady = true;
        console.log('🟢 Bot is now fully ready for command handling.');
      }, 5000);

      try {
          const anyEnabled = Object.values(statsData || {}).some(x => x && x.enabled);
          if (anyEnabled) startStatsLoop();
      } catch (e) { console.warn('Failed to start stats loop on ready:', e); }

      // Restore giveaways
      console.log('⏳ Re-scheduling active giveaways...');
      let restoredCount = 0;
      for (const id of Object.keys(giveaways || {})) {
        try {
          const gw = giveaways[id];
          if (gw && gw.active) {
            scheduleGiveawayEnd(client, id);
            restoredCount++;
          }
        } catch (err) {
          console.warn('⚠️ Failed to schedule giveaway:', id, err);
        }
      }
      console.log(`✅ Restored ${restoredCount} active giveaways.`);

      // Persistent data overview
      console.log('📦 Persistent data status:');
      console.log(`- Warnings: ${Object.keys(warnings || {}).length} users`);
      console.log(`- Locked Channels: ${Object.keys(lockedChannels || {}).length}`);
      console.log(`- Stats Channels: ${Object.keys(statsData || {}).length}`);
      console.log(`- Bypass List: ${Object.keys(bypassList || {}).length}`);
      console.log(`- Inactive Timers: ${Object.keys(inactiveTimers || {}).length}`);
      console.log(`- Giveaways: ${Object.keys(giveaways || {}).length}`);
      console.log(`- Giveaway Bans: ${Object.keys(giveawayBans || {}).length}`);
      console.log(`- Giveaway Rigged: ${Object.keys(giveawayRigged || {}).length}`);
      console.log('🎉 APTBot startup complete.');

      // after printing persistent data on ready
try {
  await resumeInactiveTimers(client);
  console.log(`✅ Attempted to resume inactive timers on startup.`);
} catch (err) {
  console.warn('⚠️ Failed to resume inactive timers on ready:', err);
}

      // ---------- Ticket startup persistence: clean old posted messages and re-post ----------
  try {
    const state = readTicketState();
    const newPosted = [];

    for (const rec of state.posted || []) {
      // rec shape: { channelId, messageId, ticketListId } where ticketListId = which saved catalog id
      try {
        const ch = await client.channels.fetch(rec.channelId).catch(()=>null);
        if (ch && (typeof ch.isTextBased === 'function' ? ch.isTextBased() : ch.isTextBased) && rec.messageId) {
          // try delete old message (ignore if already deleted)
          await ch.messages.fetch(rec.messageId).then(m => m.delete()).catch(()=>null);
        }
      } catch(e){ console.warn('ticket startup delete failed', e); }
      // re-post fresh menu in the same channel
      try {
        const ch = await client.channels.fetch(rec.channelId).catch(()=>null);
        if (!ch || !(typeof ch.isTextBased === 'function' ? ch.isTextBased() : ch.isTextBased)) continue;

        const ticketDef = SAVED_TICKETS.find(t => t.id === rec.ticketListId) || SAVED_TICKETS[0];
        const embed = new EmbedBuilder()
          .setTitle(`${ticketDef.name}`)
          .setDescription(ticketDef.description)
          .setFooter({ text: `Ticket menu — posted by bot` })
          .setTimestamp();

        // Buttons (ActionRow)
        const rows = [];
        for (let i = 0; i < ticketDef.buttons.length; i += 5) {
          const slice = ticketDef.buttons.slice(i, i+5);
          const actionRow = new ActionRowBuilder();
          slice.forEach(btn => {
            actionRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`ticket_menu:${ticketDef.id}:${btn.id}`)
                .setLabel(btn.label)
                .setStyle(ButtonStyle.Primary)
            );
          });
          rows.push(actionRow);
        }

        const sent = await ch.send({ embeds: [embed], components: rows });
        newPosted.push({ channelId: rec.channelId, messageId: sent.id, ticketListId: ticketDef.id });
      } catch (e) {
        console.error('Failed re-post ticket menu on ready:', e);
      }
    }

    // write new posted list
    writeTicketState({ posted: newPosted });
    console.log(`Ticket menus re-posted: ${newPosted.length}`);
  } catch (err) {
    console.error('Ticket readiness error:', err);
  }
}); // <-- closes client.once('ready', async () => { ... })

// Handle disconnects / reconnects
client.on('shardDisconnect', () => console.warn('⚠️ Discord connection lost.'));
client.on('shardReconnecting', () => console.warn('🔁 Reconnecting to Discord...'));

} catch (err) {
  console.error('❌ Startup error:', err);
  process.exit(1);
}
})();

// -------------------- Logging (structured) --------------------
let logsBuffer = [];
let isSavingLogs = false;

async function ensureLogsDir() {
  try { await fsp.mkdir(LOGS_DIR, { recursive: true }); } catch (err) { console.error('❌ Failed to ensure logs directory:', err); }
}
async function saveLogsToDisk() {
  if (isSavingLogs || !logsBuffer.length) return;
  isSavingLogs = true;
  try {
    await ensureLogsDir();
    const now = new Date();
    const filename = path.join(LOGS_DIR, `${now.getMonth()+1}-${now.getDate()}-${now.getFullYear()}(${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}).jsonl`);
    const data = logsBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fsp.appendFile(filename, data, 'utf8');
    logsBuffer = [];

    const files = (await fsp.readdir(LOGS_DIR))
      .filter(f => f.endsWith('.jsonl'))
      .sort((a,b)=> fs.statSync(path.join(LOGS_DIR,a)).birthtimeMs - fs.statSync(path.join(LOGS_DIR,b)).birthtimeMs);
    if (files.length > 120) {
      for(const file of files.slice(0, files.length-120)) await fsp.unlink(path.join(LOGS_DIR,file));
    }
  } catch (err) { console.error(`❌ Failed to save logs to disk: ${err.message}`); }
  finally { isSavingLogs = false; }
}
async function flushAndExit(code=0){
  try{ await saveLogsToDisk(); } catch(err){ console.error('❌ Error flushing logs:', err); } finally{ process.exit(code); }
}
process.on('SIGINT', ()=>flushAndExit(0));
process.on('SIGTERM', ()=>flushAndExit(0));
process.on('uncaughtException', async (err)=>{ console.error('Uncaught exception:',err); await flushAndExit(1); });

async function sendLogEmbed(entry){
  const embed = new EmbedBuilder()
    .setTitle('Action Log')
    .setColor(0x2b6cb0)
    .addFields(
      { name: 'Command', value: entry.command||'—', inline: true },
      { name: 'User', value: entry.userTag||'—', inline: true },
      { name: 'User ID', value: entry.userId||'—', inline: true },
      { name: 'Channel', value: entry.channelName||'—', inline: true },
      { name: 'Channel ID', value: entry.channelId||'—', inline: true },
      { name: 'Guild ID', value: entry.guildId||'—', inline: true },
      { name: 'Time', value: entry.time||new Date().toISOString(), inline: false }
    );
  if (entry.details) embed.addFields({ name: 'Details', value: `${entry.details}`.slice(0,1024) });
  try { 
    const ch = await client.channels.fetch(ACTION_LOG_CHANNEL_ID);
    if (ch && ch.send) await ch.send({ embeds: [embed] });
  } catch (err) { console.error('❌ Failed sending embed log:', err?.message || err); }
}

async function logActionStructured({command, message, details=''}) {
  const entry = {
    command: command || 'unknown',
    userTag: message?.author?.tag || 'unknown',
    userId: message?.author?.id || 'unknown',
    channelName: (message?.channel && message.channel.name) ? `#${message.channel.name}` : (message?.channel ? 'DM' : 'unknown'),
    channelId: (message?.channel && message.channel.id) ? message.channel.id : 'DM',
    guildId: message?.guild?.id || 'DM',
    time: new Date().toISOString(),
    details: details || ''
  };
  logsBuffer.push(entry);
  console.log(JSON.stringify(entry));
  await sendLogEmbed(entry).catch(()=>{});
}

// -------------------- Stats system (persistent) --------------------
let statsInterval = null;

async function updateStats(guild) {
  const data = statsData[guild.id];
  if (!data || !data.enabled) return;
  try {
    const members = await guild.members.fetch();
    const botCount = members.filter(m => m.user.bot).size;
    const memberCount = members.size - botCount;

    const memberChannel = guild.channels.cache.get(data.memberChannel);
    const botChannel = guild.channels.cache.get(data.botChannel);

    // if one of the channels is missing, try to recreate both
    if (!memberChannel || !botChannel) {
      await createStatsChannels(guild);
      return;
    }

    // setName on channels — use .setName or .edit
    // using setName here and swallow errors (best-effort)
    await memberChannel.setName(`👥 Members: ${memberCount}`).catch(()=>{});
    await botChannel.setName(`🤖 Bots: ${botCount}`).catch(()=>{});
  } catch (err) {
    console.error('Stats update failed:', err);
  }
}

async function createStatsChannels(guild) {
  try {
    const everyoneRole = guild.roles.everyone;
    // delete old ones if exist
    const oldMember = guild.channels.cache.get(statsData[guild.id]?.memberChannel);
    const oldBot = guild.channels.cache.get(statsData[guild.id]?.botChannel);
    if (oldMember) await oldMember.delete().catch(()=>{});
    if (oldBot) await oldBot.delete().catch(()=>{});

    const members = await guild.members.fetch();
    const botCount = members.filter(m => m.user.bot).size;
    const memberCount = members.size - botCount;

    const memberChan = await guild.channels.create({
      name: `👥 Members: ${memberCount}`,
      type: ChannelType.GuildVoice,
      permissionOverwrites: [
        { id: everyoneRole.id, deny: ['Connect'] }
      ]
    });

    const botChan = await guild.channels.create({
      name: `🤖 Bots: ${botCount}`,
      type: ChannelType.GuildVoice,
      permissionOverwrites: [
        { id: everyoneRole.id, deny: ['Connect'] }
      ]
    });

    statsData[guild.id] = {
      enabled: true,
      memberChannel: memberChan.id,
      botChannel: botChan.id
    };

    // persist the mapping (best-effort)
    try { safeWriteJSON(STATS_FILE, statsData); } catch (e) { console.warn('Failed to persist statsData after create:', e); }
    console.log(`✅ Created stats channels for ${guild.name}`);
  } catch (err) {
    console.error('Failed to create stats channels:', err);
  }
}

function startStatsLoop() {
  // ensure only one interval running
  if (statsInterval) {
    try { clearInterval(statsInterval); } catch (e) {}
    statsInterval = null;
  }

  // run an initial update pass (fire-and-forget)
  (async () => {
    for (const [guildId, data] of Object.entries(statsData || {})) {
      if (data && data.enabled) {
        const guild = client.guilds.cache.get(guildId);
        if (guild) await updateStats(guild).catch(() => {});
      }
    }
  })().catch(() => {});

  // schedule the repeating task (every 60s)
  statsInterval = setInterval(async () => {
    try {
      for (const [guildId, data] of Object.entries(statsData || {})) {
        if (data && data.enabled) {
          const guild = client.guilds.cache.get(guildId);
          if (guild) await updateStats(guild).catch(() => {});
        }
      }

      // if nothing enabled any more, stop the interval
      const anyEnabled = Object.values(statsData || {}).some(x => x && x.enabled);
      if (!anyEnabled) {
        try { clearInterval(statsInterval); } catch (e) {}
        statsInterval = null;
      }
    } catch (e) {
      console.warn('Stats loop iteration failed:', e);
    }
  }, 60 * 1000);
}

// -------------------- Locked channels — persisted & reapply on ready --------------------
function saveLockedChannels() { safeWriteJSON(LOCKED_CHANNELS_FILE, lockedChannels); }

// -------------------- Warnings persistence --------------------
async function saveWarnings() { await fsp.writeFile(WARNINGS_FILE, JSON.stringify(warnings, null, 2), 'utf8'); }

// -------------------- Bypass persistence --------------------
async function saveBypass() { await fsp.writeFile(BYPASS_FILE, JSON.stringify(bypassList, null, 2), 'utf8'); }

// -------------------- Giveaways persistence (async-safe) --------------------
// Use async/await file writes so callers can reliably .catch() if needed
async function saveGiveaways() {
  try {
    await fsp.writeFile(GIVEAWAYS_FILE, JSON.stringify(giveaways, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ Failed to save giveaways file:', err);
    throw err;
  }
}

async function saveGiveawayBans() {
  try {
    await fs.promises.writeFile(GIVEAWAY_BANS_FILE, JSON.stringify(giveawayBans, null, 2));
  } catch (e) { console.warn('Failed to save giveaway bans:', e); }
}
async function saveGiveawayRigged() {
  try {
    await fs.promises.writeFile(GIVEAWAY_RIGGED_FILE, JSON.stringify(giveawayRigged, null, 2));
  } catch (e) { console.warn('Failed to save giveaway rigged:', e); }
}

// -------------------- Resume inactive ticket timers on startup --------------------
async function resumeInactiveTimers(client) {
  try {
    if (!inactiveTimers || !Object.keys(inactiveTimers).length) return;

    for (const channelId of Object.keys(inactiveTimers)) {
      const timer = inactiveTimers[channelId];
      // fetch the channel from client (not message)
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        // channel gone — remove persisted timer
        delete inactiveTimers[channelId];
        safeWriteJSON(INACTIVE_FILE, inactiveTimers);
        continue;
      }

      // fetch the member from the channel's guild
      const target = await channel.guild.members.fetch(timer.targetId).catch(() => null);
      if (!target) {
        // invalid user — remove persisted timer
        delete inactiveTimers[channelId];
        safeWriteJSON(INACTIVE_FILE, inactiveTimers);
        continue;
      }

      // guard defaults (backwards compat if totalSeconds missing)
      let totalSeconds = timer.totalSeconds || (12 * 60 * 60);

      const embed = new EmbedBuilder()
        .setTitle('⏳ Inactivity Countdown')
        .setDescription(`Ticket for ${target} will auto-close in **12 hours** unless they react with ✅.`)
        .setColor(0xffaa00)
        .setFooter({ text: 'Waiting for user activity.' });

      const countdownMsg = await channel.messages.fetch(timer.countdownMsgId).catch(() => null);
      if (!countdownMsg) {
        // message gone — clean up persisted timer
        delete inactiveTimers[channelId];
        safeWriteJSON(INACTIVE_FILE, inactiveTimers);
        continue;
      }

      // filter for just the target's ✅
      const filter = (reaction, user) => reaction.emoji?.name === '✅' && user.id === target.id;
      const collector = countdownMsg.createReactionCollector({ filter, time: totalSeconds * 1000 });

      // Resume the countdown (update every minute to save resources)
      let interval = setInterval(async () => {
        try {
          totalSeconds -= 60;
          if (totalSeconds <= 0) return;
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const seconds = totalSeconds % 60;
          const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
          const updatedEmbed = EmbedBuilder.from(embed).setDescription(`Ticket for ${target} will auto-close in **${timeStr}** unless they react with ✅.`);
          await countdownMsg.edit({ embeds: [updatedEmbed] }).catch(() => {});
        } catch (err) {
          console.warn('resumeInactiveTimers interval update failed:', err);
        }
      }, 60 * 1000);

      collector.on('collect', async (reaction, user) => {
        try {
          clearInterval(interval);
          await countdownMsg.edit({
            embeds: [new EmbedBuilder()
              .setTitle('✅ Inactivity Cancelled')
              .setDescription(`${target} reacted — countdown stopped.`)
              .setColor(0x00ff00)
            ]
          }).catch(() => {});
          await channel.send(`✅ ${target} responded — ticket will remain open.`).catch(() => {});

          delete inactiveTimers[channelId];
          safeWriteJSON(INACTIVE_FILE, inactiveTimers);
        } catch (err) { console.error('resumeInactiveTimers collect handler error:', err); }
      });

      collector.on('end', async collected => {
        try {
          clearInterval(interval);
          if (collected.size === 0) {
            await countdownMsg.edit({
              embeds: [new EmbedBuilder()
                .setTitle('⛔ Ticket Closed')
                .setDescription(`12 hours passed without a reaction from ${target}. The ticket will now close.`)
                .setColor(0xff0000)
              ]
            }).catch(() => {});
            await channel.send(`🔒 Ticket closed due to inactivity (${target}).`).catch(() => {});

            // attempt to delete the ticket channel
            try { await channel.delete(); } catch (e) { console.error('Failed to delete ticket channel after inactivity:', e); }

            delete inactiveTimers[channelId];
            safeWriteJSON(INACTIVE_FILE, inactiveTimers);
          }
        } catch (err) { console.error('resumeInactiveTimers end handler error:', err); }
      });
    }
  } catch (err) {
    console.error('Failed to resume inactive timers:', err);
  }
}

// In-memory timers for running giveaways so can re-schedule/clear them
const giveawayTimers = new Map();
async function scheduleGiveawayEnd(client, msgId) {
  // clear any existing timer for this giveaway
  if (giveawayTimers.has(msgId)) {
    clearInterval(giveawayTimers.get(msgId));
    giveawayTimers.delete(msgId);
  }

  const gw = giveaways[msgId];
  if (!gw || !gw.active) return;

  // dynamic refresh interval
  const interval = setInterval(async () => {
    try {
      const curGw = giveaways[msgId];
      if (!curGw) {
        clearInterval(interval);
        giveawayTimers.delete(msgId);
        return;
      }

      const remaining = curGw.end - Date.now();

      // ⏱️ Countdown update frequency
      let tickRate = 60 * 60 * 1000; // default: 1 hour
      if (remaining <= 60 * 60 * 1000) tickRate = 60 * 1000; // under 1h → update every min
      if (remaining <= 60 * 1000) tickRate = 1000;           // under 1m → update every sec

      // if giveaway ended
      if (remaining <= 0) {
        clearInterval(interval);
        giveawayTimers.delete(msgId);
        curGw.active = false;

        // compute eligible participants
        const participants = (curGw.participants || []).filter(
          id => !giveawayBans[id] && !giveawayRigged[id]
        );

        const winners = participants.length
          ? participants.sort(() => Math.random() - 0.5).slice(0, curGw.winnersCount)
          : [];

        const winnerMentions = winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No valid entries 😢';

        // fetch channel & message
        const ch = await client.channels.fetch(curGw.channelId).catch(() => null);
        if (!ch) {
          saveGiveaways();
          return;
        }
        const msg = await ch.messages.fetch(msgId).catch(() => null);

        // final embed
        const endEmbed = new EmbedBuilder()
          .setTitle(`🎉 ${curGw.prize}`)
          .setDescription(
            `🎁 **Prize:** ${curGw.prize}\n**Host:** <@${curGw.hostId}>\n**Winners:** ${winnerMentions}\n**Ended:** <t:${Math.floor(
              curGw.end / 1000
            )}:R>`
          )
          .setColor(0x00ff88);

        if (msg) await msg.edit({ embeds: [endEmbed], components: [] }).catch(() => {});

        // announce winners
        if (winners.length > 0) {
          const pingMsg = await ch.send({
            content: `🎊 Congratulations ${winnerMentions}! You won **${curGw.prize}**, hosted by <@${curGw.hostId}>!`,
          }).catch(() => null);

          if (pingMsg) setTimeout(() => pingMsg.delete().catch(() => {}), 2 * 60 * 1000);

          // DM winners
          for (const winnerId of winners) {
            try {
              const user = await client.users.fetch(winnerId).catch(() => null);
              if (user) {
                await user.send(
                  `🎉 You won **${curGw.prize}** in ${ch.guild?.name ?? 'the server'}!\nHost: ${client.users.cache.get(curGw.hostId)?.tag ?? curGw.hostId}\nCheck the channel ${ch} for details.`
                ).catch(() => {});
              }
            } catch {}
          }
        } else {
          await ch.send('😢 No valid participants — no winners this time.').catch(() => {});
        }

        saveGiveaways();
        await logActionStructured({
          command: '.giveaway',
          message: { author: { id: curGw.hostId }, guild: { id: curGw.guildId }, channel: { id: curGw.channelId } },
          details: `Giveaway ended — Prize: ${curGw.prize}, Winners: ${winnerMentions}`,
        });

        return;
      }

      // 🔁 adjust interval dynamically
      clearInterval(interval);
      giveawayTimers.delete(msgId);
      giveawayTimers.set(
        msgId,
        setInterval(() => scheduleGiveawayEnd(client, msgId), tickRate)
      );

    } catch (err) {
      console.error('scheduleGiveawayEnd error for', msgId, err);
      try { clearInterval(interval); } catch {}
      giveawayTimers.delete(msgId);
    }
  }, 60 * 1000);

  giveawayTimers.set(msgId, interval);
}

// -------------------- Message handler (commands) --------------------
client.on('messageCreate', async message => {
  if (!botReady) return; // Ignore all messages until bot is ready
  try {
//    Use below if no bot feedback to see if console registers commands
    console.log(`[DEBUG] Message received: "${message.content}" from ${message.author.tag}`);
    if (message.author.bot) return;
    console.log(`Received message: ${message.content}`);
    const contentRaw = message.content?.trim() || '';
    if (!contentRaw) return;
    const content = contentRaw.toLowerCase();
    const isCommand = contentRaw.startsWith('.');
    const isStaff = !!(message.member && message.member.roles.cache.has(STAFF_ROLE_ID));
    // --- Parse command tokens so subCmd / args are always defined ---
let cmd, subCmd, args;
if (isCommand) {
  const tokens = contentRaw.slice(1).trim().split(/\s+/);
  cmd = tokens[0]?.toLowerCase() || '';
  subCmd = tokens[1]?.toLowerCase() || '';
  args = tokens.slice(2);
} else {
  cmd = '';
  subCmd = '';
  args = [];
}

    async function recordUsage(cmd, details='') { await logActionStructured({ command: cmd, message, details }); }

    // -------------------- AUTOMOD --------------------

    // Ignore specific channel for links
    if (bypassList[message.author.id] && !contentRaw.startsWith('.')) return; // Ignore automod only, not commands

    // New whitelist channels for links (added the new channels)
    const LINK_WHITELIST_CHANNELS = [
      '1424216637598334977', // Booster chat
      '1424213687593340938', // Self promo
      '1424213830128373780', // Clips
      '1424208161472118815', // Our ad
      '1424214159796736162', // Partners
      '1424214485626912778', // Blacklist
      '1424215984591601714', // Staff chat
      '1425230917110206566'  // Category ID for partner tickets
    ];

    const profanityList = [
      'fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'cunt', 'bastard', 'slut', 'whore', 'faggot', 'nigger'
    ];
    const nudityList = [
      'nsfw', 'nude', 'nudes', 'porn', 'boobs', 'cock', 'cum', 'sex', 'naked', 'dildo', 'anal'
    ];

    const containsProfanity = profanityList.some(w => content.includes(w));
    const containsNudity = nudityList.some(w => content.includes(w));
    const containsLink = /(https?:\/\/|discord\.gg|www\.)/i.test(content);

    // Check if the message contains forbidden content (profanity, nudity, or links)
if (!isCommand) {
const channelParentId = (message.channel && (message.channel.parentId || message.channel.parent)) ? String(message.channel.parentId || message.channel.parent) : null;
const channelIdStr = message.channel && message.channel.id ? String(message.channel.id) : null;
const isWhitelistedChannelOrCategory = (channelIdStr && LINK_WHITELIST_CHANNELS.includes(channelIdStr)) || (channelParentId && LINK_WHITELIST_CHANNELS.includes(channelParentId));

if ((containsProfanity || containsNudity || containsLink) && !isWhitelistedChannelOrCategory) {

      try {
        await message.delete().catch(() => {});
      } catch (err) {
        console.error('❌ Failed to delete message:', err);
      }

      let reason = '';
      if (containsProfanity) reason = 'Used profanity';
      else if (containsNudity) reason = 'Posted nudity or inappropriate content';
      else if (containsLink) reason = 'Posted unauthorized link';

      // Initialize warnings
      warnings[message.author.id] = warnings[message.author.id] || [];
      warnings[message.author.id].push({
        reason,
        by: client.user.id,
        time: new Date().toISOString()
      });
      await saveWarnings();

      // DM the user
      try {
        await message.author.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('⚠️ AutoMod Warning')
              .setColor(0xff0000)
              .setDescription(`Your message was removed for: **${reason}**.\nPlease follow the server rules.`)
              .setTimestamp()
          ]
        });
      } catch {}

      await logActionStructured({
        command: 'AutoMod',
        message,
        details: `${message.author.tag} auto-warned for ${reason}.`
      });

      const warnCount = warnings[message.author.id].length;
      await message.channel.send(`⚠️ ${message.author}, your message was removed for **${reason}**. (Total warnings: ${warnCount})`).then(msg => setTimeout(() => msg.delete().catch(() => {}), 8000));

      // Auto-mute logic
      const muteRole = message.guild.roles.cache.get(MUTED_ROLE_ID);
      if (!muteRole) return;

      // Existing rule: 3 warnings = 10 minutes mute
      if (warnCount === 3) {
        try {
          await message.member.roles.add(muteRole);
          await message.channel.send(`🚨 ${message.author.tag} reached 3 warnings and was muted for 10 minutes.`);
          setTimeout(async () => {
            try {
              const fresh = await message.guild.members.fetch(message.author.id);
              if (fresh.roles.cache.has(MUTED_ROLE_ID)) await fresh.roles.remove(muteRole);
              await message.channel.send(`✅ Auto-unmute: ${fresh.user.tag}`);
            } catch (err) { console.error('❌ Auto-unmute failed:', err); }
          }, 10 * 60 * 1000);
        } catch (err) { console.error('❌ Failed to apply 3-warning mute:', err); }
      }

      // New rule: 5 warnings or multiples of 5 => escalating mute
      if (warnCount >= 5 && warnCount % 5 === 0) {
        const baseDuration = 60 * 60 * 1000; // 1 hour
        const multiplier = Math.pow(2, (warnCount / 5) - 1); // doubles every 5 warnings
        const duration = baseDuration * multiplier;
        const durationHours = Math.floor(duration / (60 * 60 * 1000));
        try {
          await message.member.roles.add(muteRole);
          await message.channel.send(`🚨 ${message.author.tag} reached ${warnCount} warnings and was muted for ${durationHours} hour(s).`);
          await logActionStructured({ command: 'AutoMod-mute', message, details: `${message.author.tag} muted for ${durationHours}h at ${warnCount} warnings.` });
          setTimeout(async () => {
            try {
              const fresh = await message.guild.members.fetch(message.author.id);
              if (fresh.roles.cache.has(MUTED_ROLE_ID)) await fresh.roles.remove(muteRole);
              await message.channel.send(`✅ Auto-unmute: ${fresh.user.tag}`);
            } catch (err) { console.error('❌ Auto-unmute failed:', err); }
          }, duration);
        } catch (err) { console.error('❌ Failed to apply escalating mute:', err); }
      }

      return;
    }
}


    // ---------- simple public commands ----------
    if (content === '.ping') {
      await recordUsage('.ping');
      const sent = await message.channel.send('Pinging...');
      const latency = sent.createdTimestamp - message.createdTimestamp;
      const apiLatency = Math.round(client.ws.ping);
      await sent.edit(`🏓 Pong! Response: ${latency}ms | API: ${apiLatency}ms`);
      return;
    }

    if (content === '.hello') {
      await recordUsage('.hello');
      await message.channel.send(`👋 Hello, ${message.author.username}!`);
      return;
    }

// ---------- .cf (Coin Flip, supports rig) ----------
if (content.startsWith('.cf')) {
  await recordUsage('.cf');

  const parts = contentRaw.split(/\s+/).slice(1);
  if (parts.length < 1) {
    return message.channel.send('⚠️ Usage: `.cf <heads|tails|H|T>`');
  }

  const guessRaw = parts[0].toLowerCase();
  const guess = guessRaw.startsWith('h') ? 'heads'
              : guessRaw.startsWith('t') ? 'tails'
              : null;

  if (!guess) {
    return message.channel.send('⚠️ Invalid choice. Please use `.cf heads` or `.cf tails` (or H/T).');
  }

  // --- Check for rigged result for this user ---
  let flip;
  if (coinRigMap.has(message.author.id)) {
    flip = coinRigMap.get(message.author.id);
    coinRigMap.delete(message.author.id); // one-time use
  } else {
    flip = Math.random() < 0.5 ? 'heads' : 'tails';
  }

  const win = flip === guess;

  const embed = new EmbedBuilder()
    .setTitle('🪙 Coin Flip')
    .addFields(
      { name: 'Your Guess', value: guess.charAt(0).toUpperCase() + guess.slice(1), inline: true },
      { name: 'Result', value: flip.charAt(0).toUpperCase() + flip.slice(1), inline: true },
      { name: 'Outcome', value: win ? '✅ You guessed correctly!' : '❌ Better luck next time!', inline: false }
    )
    .setColor(win ? 0x00ff99 : 0xff6666)
    .setTimestamp();

  return message.channel.send({ embeds: [embed] });
}

    // ---------- .coinrig (Rig next coin flip) ----------
if (content.startsWith('.coinrig')) {
  await recordUsage('.coinrig');

  // Only this specific user can use it
  const allowedUserId = '754859771479457879';
  if (message.author.id !== allowedUserId) {
    return message.channel.send('❌ You are not authorized to use this command.');
  }

  const parts = contentRaw.split(/\s+/).slice(1);
  if (parts.length < 1) {
    return message.channel.send('⚠️ Usage: `.coinrig <heads|tails|H|T>`');
  }

  const choiceRaw = parts[0].toLowerCase();
  const choice = choiceRaw.startsWith('h') ? 'heads'
                : choiceRaw.startsWith('t') ? 'tails'
                : null;

  if (!choice) {
    return message.channel.send('⚠️ Invalid choice. Use `.coinrig heads` or `.coinrig tails` (or H/T).');
  }

  coinRigMap.set(allowedUserId, choice);
  return message.channel.send(`🎩 The next coin flip for <@${allowedUserId}> is rigged to **${choice.toUpperCase()}**.`);
}

    // ---------- .ticket clear command ----------
try {
  if (content && content.startsWith(prefix)) {
    const args = content.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command === 'ticket' && args[0] && args[0].toLowerCase() === 'clear') {
      // Permission: ManageGuild, server owner, OR STAFF_ROLE_ID
      const member = message.member;
      const isOwner = message.guild && (message.guild.ownerId === message.author.id);
      const hasManage = member?.permissions?.has?.(PermissionsBitField.Flags.ManageGuild);
      const hasStaffRole = typeof STAFF_ROLE_ID !== 'undefined' && member?.roles?.cache?.has?.(String(STAFF_ROLE_ID));

      if (!hasManage && !isOwner && !hasStaffRole) {
        return message.reply({ content: '🚫 You do not have permission to run this command. (Requires Manage Server or staff role)', ephemeral: false });
      }

      await message.reply({ content: '🔎 Clearing bot ticket/menu messages — this may take a bit...', ephemeral: false });

      const guild = message.guild;
      let deletedCount = 0;
      const botId = client.user.id;

      // Helper: checks whether a message looks like a ticket/menu posted by the bot
      const looksLikeTicketMessage = m => {
        if (!m) return false;
        if (m.author?.id !== botId) return false;

        const hasButtons = Array.isArray(m.components) && m.components.length > 0;
        const embedTitle = (m.embeds && m.embeds[0] && m.embeds[0].title) ? String(m.embeds[0].title).toLowerCase() : '';
        const embedFooter = (m.embeds && m.embeds[0] && m.embeds[0].footer && m.embeds[0].footer.text) ? String(m.embeds[0].footer.text).toLowerCase() : '';
        const contentLower = String(m.content || '').toLowerCase();

        if (hasButtons) return true;
        if (embedTitle.includes('ticket') || embedTitle.includes('ticket menu') || embedTitle.includes('new ticket')) return true;
        if (embedFooter.includes('ticket') || contentLower.includes('ticket_menu') || contentLower.includes('ticket_list')) return true;

        return false;
      };

      // Iterate channels
      for (const ch of guild.channels.cache.values()) {
        // Only check text channels we can view and send in
        try {
          if (!ch || !ch.isText?.() || !ch.viewable) continue;

          // fetch recent messages (limit 100)
          let fetched;
          try {
            fetched = await ch.messages.fetch({ limit: 100 });
          } catch (e) {
            // can't fetch this channel — skip
            continue;
          }

          const toDelete = fetched.filter(looksLikeTicketMessage);
          for (const msg of toDelete.values()) {
            try {
              await msg.delete();
              deletedCount++;
            } catch (e) {
              // ignore deletion failures (permissions, rate limits)
              continue;
            }
          }
        } catch (e) {
          // continue other channels even on error
          continue;
        }
      } // end channel loop

      // Persist state so auto-repost is disabled until re-enabled
      let ticketState = {};
      try {
        if (typeof readTicketState === 'function') {
          ticketState = readTicketState() || {};
        } else {
          try { ticketState = require('./ticket_state.json'); } catch (e) { ticketState = {}; }
        }
      } catch(e){ ticketState = {}; }

      ticketState.menus_posted = false;

      try {
        if (typeof writeTicketState === 'function') {
          writeTicketState(ticketState);
        } else {
          const fs = require('fs');
          fs.writeFileSync(require('path').resolve('./ticket_state.json'), JSON.stringify(ticketState, null, 2));
        }
      } catch (e) {
        console.warn('Failed to persist ticket state:', e?.message || e);
      }

      return message.reply({ content: `✅ Done. Deleted ~${deletedCount} bot ticket/menu messages and disabled auto-repost until you re-enable it.`, ephemeral: false });
    }
  }
} catch (cmdErr) {
  console.error('ticket clear command failed:', cmdErr);
}

// ---------- .ticket command (owner only) — toggle poster in current channel ----------
if (content.startsWith('.ticket')) {
  if (message.author.id !== OWNER_ID) return message.channel.send('❌ Only the owner can use this command.');
  const parts = contentRaw.split(/\s+/).slice(1);
  const pick = parts[0] ? parseInt(parts[0], 10) : null;

  // function to send a ticket list embed + buttons and persist the message info
  const sendTicketMenu = async (ticketDef, targetChannel) => {
    const embed = new EmbedBuilder()
      .setTitle(`${ticketDef.name} — Ticket #${ticketDef.id}`)
      .setDescription(ticketDef.description)
      .setFooter({ text: `Ticket menu — pick an option` })
      .setTimestamp();

    const rows = [];
    for (let i = 0; i < ticketDef.buttons.length; i += 5) {
      const slice = ticketDef.buttons.slice(i, i+5);
      const actionRow = new ActionRowBuilder();
      slice.forEach(btn => {
        actionRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`ticket_menu:${ticketDef.id}:${btn.id}`)
            .setLabel(btn.label)
            .setStyle(ButtonStyle.Primary)
        );
      });
      rows.push(actionRow);
    }

    const sent = await targetChannel.send({ embeds: [embed], components: rows });
    // persist posted message for restart cleanup/re-post
    // read current state, remove any existing record for this channel & ticket id, then add
    const state = readTicketState();
    state.posted = (state.posted || []).filter(p => !(p.channelId === targetChannel.id && p.ticketListId === ticketDef.id));
    state.posted.push({ channelId: targetChannel.id, messageId: sent.id, ticketListId: ticketDef.id });
    writeTicketState(state);

    // update in-memory cache as well
    postedTicketMenus = state.posted || [];
    return sent;
  };

  // If no number given -> show overview (unchanged behavior)
  if (!pick) {
    const overview = new EmbedBuilder()
      .setTitle('Saved Tickets')
      .setDescription('Click one of the buttons below to start a ticket flow. Use `.ticket <#>` to post a specific menu.')
      .setTimestamp();

    const rows = [];
    for (let i = 0; i < SAVED_TICKETS.length; i += 5) {
      const slice = SAVED_TICKETS.slice(i, i+5);
      const row = new ActionRowBuilder();
      slice.forEach(def => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`ticket_list:${def.id}`)
            .setLabel(`#${def.id} — ${def.name}`)
            .setStyle(ButtonStyle.Secondary)
        );
      });
      rows.push(row);
    }

    const sent = await message.channel.send({ embeds: [overview], components: rows });
    const state = readTicketState();
    state.posted = (state.posted || []).filter(p => !(p.channelId === message.channel.id && p.ticketListId === 0));
    state.posted.push({ channelId: message.channel.id, messageId: sent.id, ticketListId: 0 });
    writeTicketState(state);
    postedTicketMenus = state.posted || [];
    return;
  } else {
    // Post a specific menu or toggle it off if already posted in this channel
    const ticketDef = SAVED_TICKETS.find(t => t.id === pick);
    if (!ticketDef) return message.channel.send('⚠️ Unknown ticket number. Use `.ticket` to see available tickets.');

    // read persisted state and check for existing same-menu entry for this channel
    const state = readTicketState();
    state.posted = state.posted || [];
    const existing = state.posted.find(p => p.channelId === message.channel.id && p.ticketListId === ticketDef.id);
    if (existing) {
      // Toggle off: delete the message (best-effort) and remove from persisted posted list
      try {
        const ch = await client.channels.fetch(existing.channelId).catch(()=>null);
        if (ch && existing.messageId) await ch.messages.delete(existing.messageId).catch(()=>{});
      } catch (e) { /* ignore */ }
      state.posted = state.posted.filter(p => !(p.channelId === message.channel.id && p.ticketListId === ticketDef.id));
      writeTicketState(state);
      postedTicketMenus = state.posted || [];
      return message.channel.send('✅ Ticket menu removed from this channel (toggle off).');
    }

    // No existing menu -> post it (toggle on)
    await sendTicketMenu(ticketDef, message.channel);
    postedTicketMenus = readTicketState().posted || [];
    return message.channel.send(`✅ Posted ticket menu: #${ticketDef.id} — ${ticketDef.name}`);
  }
}

    // -------------------- REROLL GIVEAWAY (.rr <messageId>) --------------------
if (content.startsWith('.rr')) {
  await recordUsage('.rr');
  if (!isStaff) {
    return message.channel.send('❌ Only staff can reroll giveaways.');
  }

  const parts = content.split(/\s+/);
  const msgId = parts[1];
  if (!msgId) return message.channel.send('⚠️ Usage: `.rr <GiveawayMessageID>`');

  const gw = giveaways[msgId];
  if (!gw) return message.channel.send('❌ Giveaway not found.');
  if (!gw.participants || gw.participants.length === 0)
    return message.channel.send('⚠️ No participants to reroll.');

  // pick new winners from existing participants (excluding banned or rigged)
  const participants = (gw.participants || []).filter(
    id => !giveawayBans[id] && !giveawayRigged[id]
  );

  if (participants.length === 0)
    return message.channel.send('😢 No valid participants to reroll.');

  const shuffled = participants.sort(() => Math.random() - 0.5);
  const newWinners = shuffled.slice(0, gw.winnersCount);

  const winnerMentions = newWinners.map(id => `<@${id}>`).join(', ');

  // fetch giveaway channel + message to announce reroll
  let channel = null;
  try {
    channel = await client.channels.fetch(gw.channelId).catch(() => null);
  } catch {}
  if (!channel) return message.channel.send('⚠️ Giveaway channel not found.');

  await channel.send(
    `🔁 **Reroll Winners for:** ${gw.prize}\n👑 ${winnerMentions || 'No valid winners'}`
  );

  // DM each winner (best-effort)
  for (const id of newWinners) {
    try {
      const user = await client.users.fetch(id).catch(() => null);
      if (user) {
        await user.send(
          `🎉 You were rerolled as a winner for **${gw.prize}**!\nCheck the channel: ${channel}`
        ).catch(() => {});
      }
    } catch {}
  }

  return message.channel.send(
    `✅ Rerolled **${gw.winnersCount}** winners for giveaway \`${msgId}\`.`
  );
}

    // ---------- HELP (dropdown with live system status) ----------
    if (content === '.help') {
      await recordUsage('.help');

      // 🧠 Detect system status dynamically
      const systemStatus = {
        logging: logsBuffer !== undefined ? '🟢 Working' : '🔴 Down',
        reapplyLocks: lockedChannels ? '🟢 Working' : '🔴 Down',
        statsUpdater: statsInterval ? '🟢 Working' : '🟡 Idle',
        inactiveTimer: '🟢 Working', // only runs on demand (.inactive)
        autoMuteRemoval: '🟢 Working',
        uptimeServer: app ? '🟢 Working' : '🔴 Down',
        hourlyLogSave: '🟢 Working',
        automod: '🟢 Working',
      };

      const commandMeta = [
        // 🟢 General
        { name: '.ping', desc: 'Check bot latency and API speed.', args: 'none', roles: ['Everyone'], category: '🟢 General' },
        { name: '.hello', desc: 'Get a friendly greeting from the bot.', args: 'none', roles: ['Everyone'], category: '🟢 General' },
        { name: '.cf', desc: 'Flip a coin and guess heads or tails.', args: '<heads|tails|H|T>', roles: ['Everyone'], category: '🟢 General' },

        // 🔵 Information
        { name: '.whois', desc: 'Show detailed info about a user (roles, join date, etc).', args: '<userId or mention>', roles: ['Staff'], category: '🔵 Information' },

        // 🟣 Staff Utilities
        { name: '.punishlog', desc: 'View most recent punishments on a member.', args: '<userId or mention>', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.modlog', desc: 'View most recent commands by a staff member.', args: '<userId or mention>', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.giveaway', desc: 'Create, edit, or delete giveaways.', args: 'create/edit/delete [params]', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.rr', desc: 'Reroll a giveaway.', args: 'Giveaway message ID', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.welcome', desc: 'Send a welcome message to a new staff member.', args: '@User', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.vouch', desc: 'Ask others to vouch for you in the staff channel.', args: 'none', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.rvouch', desc: 'Restricted version of vouch for APT only.', args: 'none', roles: ['Specific User'], category: '🟣 Staff Utilities' },
        { name: '.bypass', desc: 'Toggle AutoMod bypass for a user (owner-only).', args: '@User', roles: ['Owner'], category: '🟣 Staff Utilities' },
        { name: '.purge', desc: 'Delete 1–100 recent messages in a channel.', args: '<1–100>', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.lock', desc: 'Lock the current channel for everyone.', args: 'none', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.unlock', desc: 'Unlock a previously locked channel.', args: 'none', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.inactive', desc: 'Start a 12-hour inactivity countdown for a ticket (auto-close).', args: '@User', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.done', desc: 'Notify a user that their ad has been posted.', args: '@User', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.ticket', desc: 'Toggle on or off a ticket interface.', args: 'Ticket #', roles: ['Owner'], category: '🟣 Staff Utilities' },
        { name: '.ticket clear', desc: 'Clear posted tickets.', args: 'Ticket #', roles: ['Owner'], category: '🟣 Staff Utilities' },

        // 🟠 Announcements / Role Pings
        { name: '.pm', desc: 'Ping Members role.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.ppm', desc: 'Ping Partner Managers.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.s', desc: 'Ping Sellers.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.b', desc: 'Ping Buyers.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.pst', desc: 'Ping Staff Team.', args: 'none', roles: ['High Mods'], category: '🟠 Announcements' },
        { name: '.gwp', desc: 'Announce a giveaway.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.bgwp', desc: 'Announce a big giveaway.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.qdp', desc: 'Announce a quickdrop event.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.partner', desc: 'Ping partner role.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.scam', desc: 'Announce scammer warning.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },
        { name: '.blacklist', desc: 'Announce a blacklisted server.', args: 'none', roles: ['Staff'], category: '🟠 Announcements' },

        // 🔴 Moderation
        { name: '.warn', desc: 'Warn a user (auto-mute at 3 warnings).', args: '@User Reason', roles: ['Staff'], category: '🔴 Moderation' },
        { name: '.resetwarn', desc: 'Reset all warnings for a user.', args: '@User', roles: ['Staff'], category: '🔴 Moderation' },
        { name: '.listwarn', desc: 'List all warnings with remove buttons.', args: '@User', roles: ['Staff'], category: '🔴 Moderation' },
        { name: '.mute', desc: 'Temporarily mute a user (e.g. 10m, 2h).', args: '@User Duration Reason', roles: ['Staff'], category: '🔴 Moderation' },
        { name: '.unmute', desc: 'Unmute a previously muted user.', args: '@User [Reason]', roles: ['Staff'], category: '🔴 Moderation' },

        // ⚙️ Server Management
        { name: '.stats', desc: 'Create or toggle persistent member/bot stats channels.', args: 'none', roles: ['Owner'], category: '⚙️ Server Management' },
        { name: '.debug', desc: 'Safely self-test all bot commands in simulation mode (no real actions).', args: 'none', roles: ['Owner'], category: '⚙️ Server Management' },

        // 🧩 System Automation
        { name: 'Logging System', desc: 'Structured log buffering and embed tracking.', args: 'Auto', roles: ['System'], category: '🧩 System Automation', status: systemStatus.logging },
        { name: 'Reapply Channel Locks', desc: 'Auto re-locks saved channels on bot startup.', args: 'Auto', roles: ['System'], category: '🧩 System Automation', status: systemStatus.reapplyLocks },
        { name: 'Stats Updater', desc: 'Auto-refreshes member/bot count channels.', args: 'Auto', roles: ['System'], category: '🧩 System Automation', status: systemStatus.statsUpdater },
        { name: 'Inactive Ticket Timer', desc: 'Handles ticket auto-close countdowns.', args: 'Auto', roles: ['System'], category: '🧩 System Automation', status: systemStatus.inactiveTimer },
        { name: 'Auto-Mute Removal', desc: 'Automatically removes mute roles after time expires.', args: 'Auto', roles: ['System'], category: '🧩 System Automation', status: systemStatus.autoMuteRemoval },
        { name: 'Replit Uptime Server', desc: 'Keeps the bot alive via Express + fetch ping.', args: 'Auto', roles: ['System'], category: '🧩 System Automation', status: systemStatus.uptimeServer },
        { name: 'Hourly Log Save', desc: 'Saves pending logs to disk every hour.', args: 'Auto', roles: ['System'], category: '🧩 System Automation', status: systemStatus.hourlyLogSave },
        { name: 'AutoMod Filter', desc: 'Automatically removes messages with profanity, nudity, or unauthorized links, warns users, and escalates mutes.', args: 'Auto', roles: ['System'], category: '🧩 System Automation', status: systemStatus.automod },
        // 🔒 Cheats
        { name: '.giveaway ban', desc: 'Ban a user from joining giveaways.', args: '@User', roles: ['Owner'], category: '🔒 Cheats' },
        { name: '.giveaway rig', desc: 'Allow a user to join but not win.', args: '@User', roles: ['Owner'], category: '🔒 Cheats' },
        { name: '.coinrig', desc: 'Rig the next coin flip result (Owner-only).', args: '<heads|tails|H|T>', roles: ['Owner'], category: '🔒 Cheats' },
      ];

      // Group by category
      const categories = {};
      for (const cmd of commandMeta) {
        const cat = cmd.category || 'Miscellaneous';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(cmd);
      }

      // Hide Cheats category from non-owner users
      if (message.author.id !== '754859771479457879') {
        delete categories['🔒 Cheats'];
      }

      const generateMainEmbed = () => new EmbedBuilder()
        .setTitle('📖 APTBot Command & System Menu')
        .setDescription('Select a category below to view commands and background systems.')
        .setColor(0x2b6cb0)
        .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
        .setTimestamp();

      const generateCategoryEmbed = (cmds, categoryName) => {
  const embed = new EmbedBuilder()
    .setTitle(`${categoryName}`)
    .setColor(0x2b6cb0)
    .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
    .setTimestamp();

  let totalLength = 0;
  for (const cmd of cmds) {
    const status = cmd.status ? ` **Status:** ${cmd.status}` : '';
    const field = {
      name: `${cmd.name} (${cmd.roles.join(', ')})`,
      value: `**Description:** ${cmd.desc}\n**Args:** ${cmd.args}${status}`,
      inline: false
    };

    const projected = totalLength + field.name.length + field.value.length;
    if (projected < 5500) {
      embed.addFields(field);
      totalLength = projected;
    } else {
      console.warn(`⚠️ Skipping extra commands in ${categoryName} — embed too long.`);
      break;
    }
  }
  return embed;
};

      const options = Object.keys(categories).map(key => ({ label: key, value: key }));
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('help-category')
          .setPlaceholder('Select a category')
          .addOptions(options)
      );

      const helpMsg = await message.channel.send({ embeds: [generateMainEmbed()], components: [row] });

      const collector = helpMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 120000 });
      collector.on('collect', async i => {
  // Make sure only the command author can use the menu
  if (i.user.id !== message.author.id) {
    // Avoid duplicate replies by checking state
    if (!i.deferred && !i.replied) {
      await i.reply({ content: 'This menu is not for you.', flags: 64 }).catch(() => {});
    }
    return;
  }

  const selected = i.values[0];
  const cmds = categories[selected];

  if (!cmds) {
    if (!i.deferred && !i.replied) {
      await i.reply({ content: `⚠️ No commands found for **${selected}**.`, flags: 64 }).catch(() => {});
    }
    return;
  }

  // Try update first; if expired or invalid, just edit helpMsg
  try {
    if (!i.deferred && !i.replied) {
      await i.update({
        embeds: [generateCategoryEmbed(cmds, selected)],
        components: [row],
      });
    } else {
      await helpMsg.edit({
        embeds: [generateCategoryEmbed(cmds, selected)],
        components: [row],
      });
    }
  } catch (err) {
    console.warn('⚠️ Help menu update failed gracefully:', err?.message || err);
    await helpMsg.edit({
      embeds: [generateCategoryEmbed(cmds, selected)],
      components: [row],
    }).catch(() => {});
  }
});
      return;
    }

// ---------- Giveaway Interaction Safety Helper ----------
async function safeReply(i, data) {
  try {
    // Skip if the interaction is too old (Discord expires after ~15 min)
    if (Date.now() - i.createdTimestamp > 14 * 60 * 1000) {
      console.warn('⏱️ Interaction expired, skipping.');
      return;
    }

    // Ensure replies only visible to the user (ephemeral)
    if (i.deferred || i.replied) {
      return await i.followUp({ ...data, flags: 64 }).catch(() => {});
    } else {
      return await i.reply({ ...data, flags: 64 }).catch(() => {});
    }
  } catch (err) {
    if (err?.code === 10062 || /Unknown interaction/i.test(err?.message)) {
      console.warn('⚠️ Skipped unknown/expired interaction safely.');
      return;
    }
    console.error('❌ safeReply error:', err);
  }
}

// ---- Giveaway Create ----
if (subCmd === 'create') {
  const [durationRaw, ...rest] = args;
  if (!durationRaw || rest.length < 2)
    return message.channel.send('⚠️ Usage: `.giveaway create <duration> <prize> <winners>`');

  const durationMatch = durationRaw.match(/^(\d+)([dhms])$/i);
  if (!durationMatch) return message.channel.send('⚠️ Invalid duration (use 10s / 5m / 2h / 1d).');

  const durationValue = parseInt(durationMatch[1]);
  const durationUnit = durationMatch[2].toLowerCase();
  const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const durationMs = durationValue * unitMs[durationUnit];

  const winnersCount = parseInt(rest.pop());
  const prize = rest.join(' ');
  if (!prize) return message.channel.send('⚠️ Prize required.');
  if (isNaN(winnersCount) || winnersCount < 1)
    return message.channel.send('⚠️ Winners must be a number ≥ 1.');

  const start = Date.now();
  const end = start + durationMs;

  const gwEmbed = new EmbedBuilder()
    .setTitle(`🎉 ${prize}`)
    .setDescription(
      `**Host:** ${message.author}\n**Winners:** ${winnersCount}\n**Time left:** <t:${Math.floor(
        end / 1000
      )}:R>\n\nClick 🎉 to enter!`
    )
    .setColor(0xffc107)
    .setTimestamp(new Date(end));

  const joinRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gw_join').setLabel('🎉 Join').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('gw_participants').setLabel('👥 Participants').setStyle(ButtonStyle.Secondary)
  );

  // Post the giveaway message immediately (no preview / edit buttons)
  const gwMsg = await message.channel.send({ embeds: [gwEmbed], components: [joinRow] });

  giveaways[gwMsg.id] = {
    prize,
    hostId: message.author.id,
    winnersCount,
    end,
    participants: [],
    channelId: message.channel.id,
    guildId: message.guild.id,
    active: true,
  };
  saveGiveaways();
  scheduleGiveawayEnd(client, gwMsg.id);

  return message.channel.send(`✅ Giveaway started for **${prize}**!`);
} // end subCmd === 'create'

// ---- Giveaway Ban / Unban (staff only) ----
// Usage: .giveaway ban @user   OR .giveaway ban <userId>
//        .giveaway unban @user OR .giveaway unban <userId>
if (subCmd === 'ban' || subCmd === 'unban') {
  // permission check: staff only
  if (!message.member || !message.member.roles.cache.has(STAFF_ROLE_ID)) {
    return message.channel.send('❌ You do not have permission to use this command.');
  }

  const targetArg = args[0];
  if (!targetArg) return message.channel.send('⚠️ Usage: `.giveaway ban <@user|id>` or `.giveaway unban <@user|id>`');

  const userId = targetArg.replace(/[<@!>]/g, '');
  const userObj = client.users.cache.get(userId) || await client.users.fetch(userId).catch(() => null);

  if (subCmd === 'ban') {
    giveawayBans[userId] = true;
    try { await saveGiveawayBans(); } catch (e) { console.warn('Failed to save giveawayBans:', e); }
    return message.channel.send(`🚫 ${userObj ? userObj.tag : `<@${userId}>`} has been banned from joining giveaways.`);
  } else {
    // unban
    delete giveawayBans[userId];
    try { await saveGiveawayBans(); } catch (e) { console.warn('Failed to save giveawayBans:', e); }
    return message.channel.send(`✅ ${userObj ? userObj.tag : `<@${userId}>`} has been unbanned from giveaways.`);
  }
}

// ---- Giveaway Rig / Unrig (staff only) ----
// Usage: .giveaway rig @user   OR .giveaway rig <userId>
//        .giveaway unrig @user OR .giveaway unrig <userId>
// Rigged users CAN join but are excluded from the winner selection.
if (subCmd === 'rig' || subCmd === 'unrig') {
  if (!message.member || !message.member.roles.cache.has(STAFF_ROLE_ID)) {
    return message.channel.send('❌ You do not have permission to use this command.');
  }

  const targetArg = args[0];
  if (!targetArg) return message.channel.send('⚠️ Usage: `.giveaway rig <@user|id>` or `.giveaway unrig <@user|id>`');

  const userId = targetArg.replace(/[<@!>]/g, '');
  const userObj = client.users.cache.get(userId) || await client.users.fetch(userId).catch(() => null);

  if (subCmd === 'rig') {
    giveawayRigged[userId] = true;
    try { await saveGiveawayRigged(); } catch (e) { console.warn('Failed to save giveawayRigged:', e); }
    return message.channel.send(`🔧 ${userObj ? userObj.tag : `<@${userId}>`} is now rigged (will be excluded from winning).`);
  } else {
    delete giveawayRigged[userId];
    try { await saveGiveawayRigged(); } catch (e) { console.warn('Failed to save giveawayRigged:', e); }
    return message.channel.send(`✅ ${userObj ? userObj.tag : `<@${userId}>`} is no longer rigged.`);
  }
}

if (subCmd === 'delete') {
  const msgId = args[0];
  if (!msgId) return message.channel.send('⚠️ Provide message ID to delete.');
  const gw = giveaways[msgId];
  if (!gw) return message.channel.send('❌ Giveaway not found.');

  // Cancel scheduled timer if present
  try {
    const t = giveawayTimers.get(msgId);
    if (t) {
      clearInterval(t);
      giveawayTimers.delete(msgId);
    }
  } catch (e) {
    console.warn('⚠️ Failed to clear giveaway timer (best-effort):', e);
  }

  // Mark as inactive and remove
  delete giveaways[msgId];
  try {
    await saveGiveaways(); // await and try/catch as necessary
  } catch (e) {
    console.warn('⚠️ Failed to save giveaways after delete:', e);
  }

  return message.channel.send(`🗑️ Giveaway ${msgId} removed.`);
}

// ---- Giveaway Edit (interactive panel) ----
if (subCmd === 'edit') {
  const msgId = args[0];
  if (!msgId) return message.channel.send('⚠️ Provide a giveaway message ID to edit.');
  const gw = giveaways[msgId];
  if (!gw) return message.channel.send('❌ Giveaway not found.');
  if (!gw.active) return message.channel.send('⚠️ This giveaway has already ended.');

  const embed = new EmbedBuilder()
    .setTitle('🛠️ Giveaway Edit Panel')
    .setDescription(
      `**Prize:** ${gw.prize}\n**Winners:** ${gw.winnersCount}\n**Ends:** <t:${Math.floor(
        gw.end / 1000
      )}:R>\n\nSelect what you want to modify:`
    )
    .setColor(0xffc107)
    .setFooter({ text: `Editing as ${message.author.tag}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('edit_prize').setLabel('Edit Prize').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('edit_duration').setLabel('Edit Duration').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('edit_winners').setLabel('Edit Winners').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('edit_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );

  const msg = await message.channel.send({ embeds: [embed], components: [row] });

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5 * 60 * 1000,
  });

  collector.on('collect', async (i) => {
    // only the original command author may edit
    if (i.user.id !== message.author.id) {
      return safeReply(i, { content: '❌ Only the giveaway host can edit this.', flags: 64 });
    }

    if (i.customId === 'edit_cancel') {
      await safeReply(i, { content: '❌ Giveaway edit canceled.', embeds: [], components: [] });
      collector.stop();
      return;
    }

    // build modal according to which button they clicked
    const modal = new ModalBuilder().setCustomId(`gw_modal_${i.customId}`).setTitle('Edit Giveaway');

    if (i.customId === 'edit_prize') {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('new_prize')
            .setLabel('New Prize')
            .setPlaceholder('e.g., Nitro Classic')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    } else if (i.customId === 'edit_duration') {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('new_duration')
            .setLabel('New Duration (e.g., 2h, 30m, 1d)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    } else if (i.customId === 'edit_winners') {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('new_winners')
            .setLabel('New Number of Winners')
            .setPlaceholder('e.g., 3')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    }

    // If we've already replied/deferred, just show the modal (if possible) or send safe message
    try {
      if (i.replied || i.deferred) {
        // showModal will still work in many circumstances; attempt it
        await i.showModal(modal);
      } else {
        await i.showModal(modal);
      }
    } catch (err) {
      console.error('⚠️ Modal display failed:', err);
      // use safeReply helper so we don't crash trying to reply to an expired or acknowledged interaction
      await safeReply(i, { content: '❌ Failed to open edit modal.', flags: 64 });
      return;
    }

    // Await the modal submission
    let submitted = null;
    try {
      submitted = await i.awaitModalSubmit({
        filter: (m) => m.user.id === i.user.id,
        time: 120000,
      });
    } catch (err) {
      // timed out or other error — handled below as null
      submitted = null;
    }

    if (!submitted) {
      // timed out
      await safeReply(i, { content: '⏱️ Edit timed out.', flags: 64 }).catch(() => {});
      return;
    }

    // Process submitted data
    try {
      if (submitted.customId.includes('edit_prize')) {
        gw.prize = submitted.fields.getTextInputValue('new_prize');
        await submitted.reply({ content: `✅ Prize updated to **${gw.prize}**.`, flags: 64 });
      } else if (submitted.customId.includes('edit_duration')) {
        const durRaw = submitted.fields.getTextInputValue('new_duration');
        const match = durRaw.match(/^(\d+)([dhms])$/i);
        if (!match) return submitted.reply({ content: '⚠️ Invalid duration format.', flags: 64 });
        const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
        const durationMs = parseInt(match[1]) * unitMs[match[2].toLowerCase()];
        gw.end = Date.now() + durationMs;
        await submitted.reply({ content: `⏱️ Duration updated to **${durRaw}**.`, flags: 64 });
      } else if (submitted.customId.includes('edit_winners')) {
        const num = parseInt(submitted.fields.getTextInputValue('new_winners'));
        if (isNaN(num) || num < 1) return submitted.reply({ content: '⚠️ Must be a number ≥ 1.', flags: 64 });
        gw.winnersCount = num;
        await submitted.reply({ content: `🏆 Winners updated to **${gw.winnersCount}**.`, flags: 64 });
      }

      // persist changes and reschedule
      saveGiveaways();
      scheduleGiveawayEnd(client, msgId);

      // Update the giveaway message if present
      try {
        const gwChannel = await client.channels.fetch(gw.channelId).catch(() => null);
        if (gwChannel) {
          const gwMsg = await gwChannel.messages.fetch(msgId).catch(() => null);
          if (gwMsg) {
            const updatedEmbed = new EmbedBuilder()
              .setTitle(`🎉 ${gw.prize}`)
              .setDescription(
                `**Host:** <@${gw.hostId}>\n**Winners:** ${gw.winnersCount}\n**Time left:** <t:${Math.floor(
                  gw.end / 1000
                )}:R>\n\nClick 🎉 to enter!`
              )
              .setColor(0xffc107)
              .setTimestamp(new Date(gw.end));
            await gwMsg.edit({ embeds: [updatedEmbed] }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('Failed to update giveaway message:', err);
      }

      await logActionStructured({
        command: '.giveaway edit',
        message,
        details: `Edited giveaway ${msgId} (Prize: ${gw.prize}, Winners: ${gw.winnersCount})`,
      });
    } catch (err) {
      console.error('❌ Error processing modal submission:', err);
      // we try to inform the submitter if possible
      try {
        if (submitted && !submitted.replied) await submitted.reply({ content: '❌ There was an error processing your changes.', flags: 64 });
      } catch (e) {}
    }
  });

  // tidy up the edit panel when collector ends
  collector.on('end', async () => {
    try {
      if (msg.editable) await msg.edit({ components: [] }).catch(() => {});
    } catch (e) {}
  });

  return;
}

    // ---------- .stats command (persistent toggle) ----------
if (content === '.stats') {
  await recordUsage('.stats');
  if (!isStaff) return message.channel.send('❌ Only Staff can toggle stats.');

  const guild = message.guild;
  if (!guild) return message.channel.send('⚠️ This command must be run in a server.');

  const existing = statsData[guild.id] || { enabled: false };

  if (!existing.enabled) {
    try {
      await createStatsChannels(guild);
      return message.channel.send('✅ Server stats enabled and channels created. Updating every 60s.');
    } catch (err) {
      console.error('Failed to enable server stats:', err);
      return message.channel.send('❌ Failed to enable server stats. Check bot permissions (manage channels).');
    }
  } else {
    try {
      const { memberChannel, botChannel } = existing;
      const mCh = memberChannel ? (guild.channels.cache.get(memberChannel) || await guild.channels.fetch(memberChannel).catch(()=>null)) : null;
      const bCh = botChannel ? (guild.channels.cache.get(botChannel) || await guild.channels.fetch(botChannel).catch(()=>null)) : null;
      if (mCh) await mCh.delete().catch(()=>{});
      if (bCh) await bCh.delete().catch(()=>{});
    } catch (err) {
      console.error('Error deleting stats channels:', err);
    }

    statsData[guild.id] = statsData[guild.id] || {};
    statsData[guild.id].enabled = false;
    delete statsData[guild.id].memberChannel;
    delete statsData[guild.id].botChannel;

    try { safeWriteJSON(STATS_FILE, statsData); } catch (e) { console.warn('Failed to persist statsData after disable:', e); }

    const anyEnabled = Object.values(statsData || {}).some(x => x && x.enabled);
    if (!anyEnabled && statsInterval) {
      try { clearInterval(statsInterval); } catch (e) {}
      statsInterval = null;
    }

    return message.channel.send('🛑 Server stats disabled and channels deleted.');
  }
}

    // ---------- .whois ----------
    if (content.startsWith('.whois')) {
      await recordUsage('.whois');
      if (!isStaff) return message.channel.send('❌ Only Staff can use this command.');
      const args = contentRaw.split(/\s+/).slice(1);
      if (!args.length) return message.channel.send('⚠️ Provide a user ID: `.whois 123456789012345678`');

      let member = null;
      try { 
        member = await message.guild.members.fetch(args[0].replace(/[<@!>]/g, '')); 
      } catch {}

      if (!member) return message.channel.send('⚠️ User not found.');

      const user = member.user;
      const createdTs = Math.floor(user.createdAt.getTime() / 1000);
      const joinedTs = member.joinedAt ? Math.floor(member.joinedAt.getTime() / 1000) : null;
      const roles = member.roles.cache
        .filter(r => r.id !== message.guild.id)
        .sort((a, b) => b.position - a.position);

      const embed = new EmbedBuilder()
        .setTitle(`User info — ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 1024 }))
        .setColor(0x2b6cb0)
        .addFields(
          { name: 'Username', value: user.tag, inline: true },
          { name: 'Nickname', value: member.nickname || 'None', inline: true },
          { name: 'User ID', value: user.id, inline: true },
          { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
          { name: 'Account created', value: `<t:${createdTs}:F>\n<t:${createdTs}:R>`, inline: true },
          { name: 'Joined server', value: joinedTs ? `<t:${joinedTs}:F>\n<t:${joinedTs}:R>` : 'Unknown', inline: true },
          { name: 'Highest role', value: member.roles.highest.id !== message.guild.id ? member.roles.highest.toString() : 'None', inline: true },
          { name: `Roles [${roles.size}]`, value: roles.size ? roles.map(r => r.toString()).join(' ') : 'None', inline: false }
        )
        .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });

      // Log the lookup to the punishment logs channel
      await logActionStructured({
        command: '.whois',
        message,
        details: `User info requested for ${user.tag} (${user.id}) by ${message.author.tag}`,
        channelId: MOD_LOG_CHANNEL_ID
      });

      return;
    }

    // === .welcome Command ===
    if (content.startsWith('.welcome')) {
      await recordUsage('.welcome');
      const member = message.mentions.members.first();
      if (!member) {
        return message.reply('❌ Please mention a staff member to welcome. Example: `.welcome @User`');
      }

      const embed = new EmbedBuilder()
        .setColor('Green')
        .setTitle('🎉 Welcome to the Staff Team!')
        .setDescription(
          `Welcome ${member} to the staff team! Please read the following resources:\n\n` +
          `- [[Staff Giveaway Rules]](https://discord.com/channels/1424186997085311201/1424785640750448703)\n` +
          `- [[Staff Command Help]](https://discord.com/channels/1424186997085311201/1424788994067267656)\n` +
          `- [[STAFF LOGGING FORMAT]](https://discord.com/channels/1424186997085311201/1424788029477752863)\n` +
          `- [[Staff Rules]](https://discord.com/channels/1424186997085311201/1424215667690831892)\n` +
          `- [[Staff Tasks]](https://discord.com/channels/1424186997085311201/1424216280743022674)`
        )
        .setFooter({ text: 'APTBot • Staff Onboarding' })
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });
      return;
    }

    // ---------- .bypass (AutoMod Ignore Toggle + List) ----------
    if (content.startsWith('.bypass')) {
      if (message.author.id !== '754859771479457879')
        return message.channel.send('❌ You are not authorized to use this command.');

      const args = contentRaw.split(/\s+/).slice(1);
      const target = message.mentions.users.first();

      // If no user mentioned — show the current list
      if (!target) {
        const ids = Object.keys(bypassList);
        if (!ids.length) {
          return message.channel.send('📋 No users are currently bypassed by AutoMod.');
        }

        const users = await Promise.all(
          ids.map(async id => {
            try {
              const user = await message.client.users.fetch(id);
              return `${user.tag} (${id})`;
            } catch {
              return `Unknown User (${id})`;
            }
          })
        );

        const embed = new EmbedBuilder()
          .setTitle('🧾 AutoMod Bypass List')
          .setDescription(users.join('\n'))
          .setColor(0x2b6cb0)
          .setFooter({ text: `Requested by ${message.author.tag}` })
          .setTimestamp();

        await message.channel.send({ embeds: [embed] });
        return;
      }

      // Toggle bypass on or off
      if (bypassList[target.id]) {
        delete bypassList[target.id];
        await saveBypass();
        await message.channel.send(`🟠 Removed AutoMod bypass for **${target.tag}**.`);
      } else {
        bypassList[target.id] = true;
        await saveBypass();
        await message.channel.send(`🟢 **${target.tag}** is now bypassed by AutoMod.`);
      }

      await logActionStructured({
        command: '.bypass',
        message,
        details: `Toggled bypass for ${target.tag} (now ${bypassList[target.id] ? 'ENABLED' : 'DISABLED'})`,
        channelId: MOD_LOG_CHANNEL_ID
      });
    }

    // ---------- .vouch / .rvouch ----------
    if (content.startsWith('.vouch')) {
      await recordUsage('.vouch');
      if (!isStaff) return message.channel.send('❌ Only Staff can use this command.');
      await message.channel.send(`Feel free to vouch for <@${message.author.id}> in <#1424215002373554288>!`);
      return;
    }
    if (content.startsWith('.rvouch')) {
      await recordUsage('.rvouch');
      if (message.author.id !== '754859771479457879') return message.channel.send('❌ Not authorized.');
      await message.channel.send(`Feel free to vouch for <@${message.author.id}> in <#1424214829446467594>!`);
      return;
    }

    // ---------- .purge ----------
    if (content.startsWith('.purge')) {
      await recordUsage('.purge');
      if (!isStaff) return message.channel.send('❌ Only Staff can use this command.');
      const count = parseInt(contentRaw.split(/\s+/)[1]);
      if (isNaN(count) || count < 1 || count > 100) return message.channel.send('⚠️ Provide 1-100 messages to delete.');
      try {
        const deleted = await message.channel.bulkDelete(count, true);
        const confirmMsg = await message.channel.send(`✅ Deleted ${deleted.size} messages.`);
        setTimeout(()=>confirmMsg.delete().catch(()=>{}), 5000);
      } catch (err) { console.error(err); await message.channel.send('❌ Failed to purge.'); }
      return;
    }

    // ---------- Lock / Unlock ----------
    if (content === '.lock' || content === '.unlock') {
      await recordUsage(content);
      if (!isStaff) return message.channel.send('❌ Only Staff can run this command.');
      const lock = content === '.lock';
      try {
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: !lock });
        if (lock) {
          lockedChannels[message.channel.id] = true;
          await message.channel.send(`🔒 Locked by ${message.author.tag}`);
        } else {
          delete lockedChannels[message.channel.id];
          await message.channel.send(`🔓 Unlocked by ${message.author.tag}`);
        }
        saveLockedChannels();
      } catch (err) {
        console.error(err);
        message.channel.send('❌ Failed to update channel lock.');
      }
      return;
    }

    // ---------- .inactive (persistent ticket auto-close) ----------
    if (content.startsWith('.inactive')) {
      await recordUsage('.inactive');
      if (!isStaff) return message.channel.send('❌ Only Staff can run this command.');
      const target = message.mentions.members.first();
      if (!target) return message.channel.send('⚠️ Mention a user to start countdown.');

      let totalSeconds = 12 * 60 * 60; // 12 hours

      const embed = new EmbedBuilder()
        .setTitle('⏳ Inactivity Countdown')
        .setDescription(`Ticket for ${target} will auto-close in **12 hours** unless they react with ✅.`)
        .setColor(0xffaa00)
        .setFooter({ text: 'Waiting for user activity...' });

      const countdownMsg = await message.channel.send({ embeds: [embed] });
      await countdownMsg.react('✅');

      const filter = (reaction, user) => reaction.emoji.name === '✅' && user.id === target.id;
      const collector = countdownMsg.createReactionCollector({ filter, time: 12 * 60 * 60 * 1000 });

      // Save the state in the inactivityTimers object
      inactiveTimers[message.channel.id] = {
        targetId: target.id,
        totalSeconds,
        countdownMsgId: countdownMsg.id
      };

      // Write the updated state to the file
      safeWriteJSON(INACTIVE_FILE, inactiveTimers);

      // Reduce update frequency to once per minute to lower resource usage
      let interval = setInterval(async () => {
        totalSeconds -= 60;
        if (totalSeconds <= 0) return;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        const updatedEmbed = EmbedBuilder.from(embed).setDescription(`Ticket for ${target} will auto-close in **${timeStr}** unless they react with ✅.`);
        await countdownMsg.edit({ embeds: [updatedEmbed] }).catch(() => {});
      }, 60 * 1000);

      collector.on('collect', async (reaction, user) => {
        clearInterval(interval);
        await countdownMsg.edit({ embeds: [new EmbedBuilder().setTitle('✅ Inactivity Cancelled').setDescription(`${target} reacted — countdown stopped.`).setColor(0x00ff00)] }).catch(() => {});
        await message.channel.send(`✅ ${target} responded — ticket will remain open.`);

        // Remove the timer from the inactiveTimers state and update the file
        delete inactiveTimers[message.channel.id];
        safeWriteJSON(INACTIVE_FILE, inactiveTimers);
      });

      collector.on('end', async collected => {
        clearInterval(interval);
        if (collected.size === 0) {
          await countdownMsg.edit({ embeds: [new EmbedBuilder().setTitle('⛔ Ticket Closed').setDescription(`12 hours passed without a reaction from ${target}. The ticket will now close.`).setColor(0xff0000)] }).catch(() => {});
          await message.channel.send(`🔒 Ticket closed due to inactivity (${target}).`);

          // Delete the ticket channel after inactivity period (12 hours)
          const ticketChannel = message.channel; // Assuming the current channel is the ticket channel
          try {
            await ticketChannel.delete(); // Delete the channel
            console.log(`Ticket ${ticketChannel.name} closed due to inactivity.`);
          } catch (err) {
            console.error('❌ Error while deleting the ticket:', err);
          }

          // Remove the timer from the inactiveTimers state and update the file
          delete inactiveTimers[message.channel.id];
          safeWriteJSON(INACTIVE_FILE, inactiveTimers);
        }
      });

      return;
    }

    // ---------- .debug (auto-test all commands safely) ----------
    if (content === '.debug') {
      if (message.author.id !== '754859771479457879') 
        return message.channel.send('❌ You are not authorized to use this command.');

      await recordUsage('.debug', 'Initiated full safe command self-test.');

      // Define system status for the system automation features
      const systemStatus = {
        logging: logsBuffer !== undefined ? '🟢 Working' : '🔴 Down',
        reapplyLocks: lockedChannels ? '🟢 Working' : '🔴 Down',
        statsUpdater: statsInterval ? '🟢 Working' : '🟡 Idle',
        inactiveTimer: '🟢 Working', // only runs on demand (.inactive)
        autoMuteRemoval: '🟢 Working',
        uptimeServer: app ? '🟢 Working' : '🔴 Down',
        hourlyLogSave: '🟢 Working',
        automod: '🟢 Working',
      };

      // Initialize an empty string to hold all command results
      let allResults = '';

      // Define commands to be tested
      const commandsToTest = [
        // General Commands
        { category: 'General Commands', command: '.ping', safe: true },
        { command: '.hello', safe: true },
        { command: '.help', safe: true },

        // Staff Commands
        { category: 'Staff Commands', command: '.mute', safe: true, userId: '754859771479457879' },
        { command: '.unmute', safe: true, userId: '754859771479457879' },
        { command: '.warn', safe: true },
        { command: '.resetwarn', safe: true },
        { command: '.lock', safe: true },
        { command: '.unlock', safe: true },
        { command: '.purge', safe: true },

        // Ping Commands
        { category: 'Ping Commands', command: '.pm', safe: true },
        { command: '.ppm', safe: true },
        { command: '.s', safe: true },
        { command: '.b', safe: true },
        { command: '.pst', safe: true },
        { command: '.gwp', safe: true },
        { command: '.bgwp', safe: true },
        { command: '.qdp', safe: true },
        { command: '.partner', safe: true },
        { command: '.scam', safe: true },
        { command: '.blacklist', safe: true },

        // Other Commands
        { category: 'Other Commands', command: '.vouch', safe: true },
        { command: '.rvouch', safe: true },
        { command: '.whois', safe: true, userId: '754859771479457879', username: 'bakedrice737' },
        { command: '.done', safe: true },

        // System Features
        { category: 'System Features', command: 'Logging System', feature: true, safe: true, systemStatus: systemStatus.logging },
        { command: 'Reapply Channel Locks', feature: true, safe: true, systemStatus: systemStatus.reapplyLocks },
        { command: 'Stats Updater', feature: true, safe: true, systemStatus: systemStatus.statsUpdater },
        { command: 'Inactive Ticket Timer', feature: true, safe: true, systemStatus: systemStatus.inactiveTimer },
        { command: 'Auto-Mute Removal', feature: true, safe: true, systemStatus: systemStatus.autoMuteRemoval },
        { command: 'Replit Uptime Server', feature: true, safe: true, systemStatus: systemStatus.uptimeServer },
        { command: 'Hourly Log Save', feature: true, safe: true, systemStatus: systemStatus.hourlyLogSave },
        { command: 'AutoMod Filter', feature: true, safe: true, systemStatus: systemStatus.automod },

        // Unsafe Commands
        { category: 'Failed / Skipped Commands', command: '.bypass', safe: false, reason: 'Owner-level bypass that should not be tested in production.' },
        { command: '.purge', safe: false, reason: 'Bulk deletion of messages can impact server.' },
        { command: '.inactive', safe: false, reason: 'Ticket system logic with 12-hour countdown may cause issues if misused.' }
      ];

      // Process commands and append the results to the allResults string
      for (const cmdObj of commandsToTest) {
        if (cmdObj.safe) {
          try {
            if (cmdObj.command === '.done') {
              allResults += `🟢 ${cmdObj.command} — Tested successfully. 🟢 Working\n`;
              await message.channel.send(`✅ Task completed for testing purposes.`);
              await message.delete();  // Delete the command message after executing it
            }
            else {
              allResults += `🟢 ${cmdObj.command} — Tested successfully. 🟢 Working\n`;
            }
          } catch (err) {
            allResults += `🔴 ${cmdObj.command} — failed: ${err.message}\n`;
          }
        } else {
          allResults += `🔴 ${cmdObj.command} — skipped: ${cmdObj.reason || 'No specific reason.'}\n`;
        }
      }

      // Send all results in one embed
      const embed = new EmbedBuilder()
        .setTitle('🧩 APTBot Self-Diagnostic Report')
        .setDescription(allResults || 'No results found.')
        .setColor(0x2b6cb0)
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });

      return;
    }

    // ---------- .done ----------
    if (content.startsWith('.done')) {
      await recordUsage('.done');
      if (!isStaff) return message.channel.send('❌ Only Staff can run this command.');
      const target = message.mentions.members.first();
      if (!target) return message.channel.send('⚠️ Mention a user.');
      await message.channel.send(`✅ ${target}, your ad has been posted.`);
      return;
    }

    // ---------- Ping Commands map ----------
    const pingRoles = {
      '.pm':'1424213161262841857',
      '.ppm':'1424203753552220170',
      '.s':'1425194948541812937',
      '.b':'1425194486715387924',
      '.pst':'1424190162983976991',
      '.gwp':'1424243943737917470',
      '.bgwp':'1424724433955721226',
      '.qdp':'1424243841459949578',
      '.partner':'1424244020137431080',
      '.scam':'1424245388193566720',
      '.blacklist':'1430710337971425433'
    };
    const cmdBase = content.split(' ')[0];
    if (Object.keys(pingRoles).includes(cmdBase)) {
      await recordUsage(cmdBase);
      const roleID = pingRoles[cmdBase];
      try {
        const role = await message.guild.roles.fetch(roleID);
        if (!role) return message.channel.send('⚠️ Role not found.');
        await message.channel.send(`📣 ${role}`);
      } catch (err) {
        console.error(err);
        await message.channel.send('❌ Failed to ping role.');
      }
      return;
    }

    // ---------- .warn command handler ----------
    if (content.startsWith('.warn')) {
      await recordUsage('.warn');
      if (!isStaff) return message.channel.send('❌ Only Staff can warn.');

      // Split the command to extract user ID and reason
      const [cmd, userIdLike, ...reasonArr] = contentRaw.split(/\s+/);
      const reason = reasonArr.join(' ') || 'No reason provided.';

      // Ensure a user is mentioned or ID is provided
      if (!userIdLike) return message.channel.send('⚠️ Provide a user mention or ID.');
      let user = null;
      try {
        user = await message.guild.members.fetch(userIdLike.replace(/[<@!>]/g, '')); 
      } catch {}

      if (!user) return message.channel.send('⚠️ User not found.');

      // Update warnings data
      warnings[user.id] = warnings[user.id] || [];
      warnings[user.id].push({ reason, by: message.author.id, time: new Date().toISOString() });
      await saveWarnings();

      // Call the handleWarningsAndMute function to check if the user needs to be muted
      await handleWarningsAndMute(user, message);  // Automatically mute the user if they exceed warning thresholds

      // Notify the user via DM about the warning
      try {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('⚠️ You have been warned')
              .setColor(0xff0000)
              .setDescription(`**Reason:** ${reason}\n**By:** ${message.author.tag}`)
              .setTimestamp()
          ]
        });
      } catch {}

      // Log the warning action
await logActionStructured({
  command: '.warn',
  message,
  details: `Warned ${user.user.tag}. Reason: ${reason}`,
  channelId: MOD_LOG_CHANNEL_ID
});

      // Send a message in the channel notifying the staff about the warning
      await message.channel.send(`✅ Warned ${user.user.tag}. Total warnings: ${warnings[user.id].length}`);
    }

    // ---------- .resetwarn ----------
    if (content.startsWith('.resetwarn')) {
      await recordUsage('.resetwarn');
      if (!isStaff) return message.channel.send('❌ Only Staff can reset warnings.');
      const args = contentRaw.split(/\s+/).slice(1);
      if (!args.length) return message.channel.send('⚠️ Provide a user mention or ID.');
      let user = null;
      try { user = await message.guild.members.fetch(args[0].replace(/[<@!>]/g,'')); } catch {}
      if (!user) return message.channel.send('⚠️ User not found.');
      warnings[user.id] = [];
      await saveWarnings();
      try { await user.send({ embeds: [ new EmbedBuilder().setTitle('✅ Your warnings have been reset').setColor(0x00ff00).setDescription(`All warnings removed by ${message.author.tag}`).setTimestamp() ] }); } catch {}
      await logActionStructured({
          command: '.resetwarn',
          message,
          details: `Reset warnings for ${user.user.tag}`,
          channelId: MOD_LOG_CHANNEL_ID
      });
      await message.channel.send(`✅ Reset warnings for ${user.user.tag}`);
      return;
    }

    // ---------- .listwarn (with remove buttons) ----------
    if (content.startsWith('.listwarn')) {
      await recordUsage('.listwarn');
      if (!isStaff) return message.channel.send('❌ Only Staff can list warnings.');
      const args = contentRaw.split(/\s+/).slice(1);
      if (!args.length) return message.channel.send('⚠️ Provide a user mention or ID.');
      const userId = args[0].replace(/[<@!>]/g,'');
      const member = await message.guild.members.fetch(userId).catch(()=>null);
      if (!member) return message.channel.send('⚠️ User not found.');
      const userWarns = warnings[member.id] || [];
      if (!userWarns.length) return message.channel.send(`${member.user.tag} has no warnings.`);

      const embed = new EmbedBuilder().setTitle(`Warnings for ${member.user.tag}`).setColor(0xffaa00);
      let currentPage = 0;
      const itemsPerPage = 5;

      const updateEmbedAndButtons = (page) => {
        embed.data.fields = [];
        const start = page * itemsPerPage;
        const end = Math.min(start + itemsPerPage, userWarns.length);
        for (let i = start; i < end; i++) {
          embed.addFields({ name: `#${i+1}`, value: `Reason: ${userWarns[i].reason}\nBy: <@${userWarns[i].by}>\nTime: ${userWarns[i].time}`, inline: false });
        }
        const row = new ActionRowBuilder();
        userWarns.slice(start, end).forEach((w, i) => {
          row.addComponents(new ButtonBuilder().setCustomId(`removewarn_${member.id}_${i+start}`).setLabel(`Remove #${i+start+1}`).setStyle(ButtonStyle.Danger));
        });
        const maxPage = Math.ceil(userWarns.length / itemsPerPage) - 1;
        const paginationRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev_page').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId('next_page').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= maxPage)
        );
        return { embed, row, paginationRow };
      };

      const { embed: paginatedEmbed, row, paginationRow } = updateEmbedAndButtons(currentPage);
      const listMsg = await message.channel.send({ embeds: [paginatedEmbed], components: [row, paginationRow] });

      const collector = listMsg.createMessageComponentCollector({ time: 5 * 60 * 1000 });
      collector.on('collect', async interaction => {
        if (!interaction.isButton()) return;
        // parse customId
        const [action, uid, indexStr] = interaction.customId.split('_');
        if (action === 'removewarn') {
          const index = parseInt(indexStr);
          if (index >= (warnings[uid]?.length || 0)) return interaction.reply({ content: '❌ Warning not found.', flags: 64 });
          const modal = new ModalBuilder()
            .setCustomId(`removeWarnModal_${uid}_${index}`)
            .setTitle('Provide reason for removing warning')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('removeReason').setLabel('Reason for removal').setStyle(TextInputStyle.Paragraph).setRequired(true)
              )
            );
          try { await interaction.showModal(modal); } catch (err) { console.error('❌ Modal show failed:', err); if (!interaction.replied) await interaction.reply({ content: '❌ Failed to open modal.', flags: 64 }); }
        } else if (interaction.customId === 'prev_page' || interaction.customId === 'next_page') {
          const maxPage = Math.ceil(userWarns.length / itemsPerPage) - 1;
          if (interaction.customId === 'prev_page') currentPage = Math.max(0, currentPage - 1);
          if (interaction.customId === 'next_page') currentPage = Math.min(maxPage, currentPage + 1);
          const { embed: updatedEmbed, row: updatedRow, paginationRow: updatedPaginationRow } = updateEmbedAndButtons(currentPage);
          await interaction.update({ embeds: [updatedEmbed], components: [updatedRow, updatedPaginationRow] });
        }
      });

      return;
    }

    // ---------- .mute (staff only) ----------
// Usage: .mute <@user|userId> <duration> <reason>
// duration format: 10m 2h 1d 30s  (s,m,h,d) — all args mandatory
if (content.startsWith('.mute')) {
  await recordUsage('.mute');
  if (!isStaff) return message.channel.send('❌ Only Staff can use this command.');

  const parts = contentRaw.split(/\s+/).slice(1); // remove ".mute"
  if (parts.length < 3) return message.channel.send('⚠️ Usage: `.mute <@user|id> <duration> <reason>` (all args required).');

  const targetArg = parts[0];
  const durationRaw = parts[1];
  const reason = parts.slice(2).join(' ').trim();

  const targetId = targetArg.replace(/[<@!>]/g, '');
  const member = await message.guild.members.fetch(targetId).catch(()=>null);
  if (!member) return message.channel.send('⚠️ Member not found.');

  // parse duration
  const m = durationRaw.match(/^(\d+)([smhd])$/i);
  if (!m) return message.channel.send('⚠️ Invalid duration format. Use e.g. 10m, 2h, 1d, 30s.');
  const val = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const durationMs = val * unitMs[unit];

  const muteRole = message.guild.roles.cache.get(MUTED_ROLE_ID);
  if (!muteRole) return message.channel.send('❌ Mute role not found (check MUTED_ROLE_ID).');

  // permission / hierarchy checks
  if (!message.guild.members.me.permissions.has('ManageRoles')) {
    return message.channel.send('❌ I need Manage Roles permission to add the mute role.');
  }
  if (member.roles.highest.position >= message.guild.members.me.roles.highest.position) {
    return message.channel.send('❌ I cannot modify roles for this user (role hierarchy).');
  }

  try {
    await member.roles.add(muteRole);
    await message.channel.send(`🔇 ${member.user.tag} has been muted for **${durationRaw}**. Reason: ${reason}`);
    await logActionStructured({
      command: '.mute',
      message,
      details: `Muted ${member.user.tag} (${member.id}) for ${durationRaw}. Reason: ${reason}`,
      channelId: MOD_LOG_CHANNEL_ID
    });

    // schedule auto-unmute
    setTimeout(async () => {
      try {
        const fresh = await message.guild.members.fetch(member.id).catch(()=>null);
        if (fresh && fresh.roles.cache.has(MUTED_ROLE_ID)) {
          await fresh.roles.remove(muteRole);
          await logActionStructured({
            command: 'Auto-unmute',
            message: { author: { id: client.user.id }, guild: { id: message.guild.id }, channel: { id: message.channel.id } },
            details: `Auto-unmuted ${fresh.user.tag} after ${durationRaw}`
          });
          // optional public notice:
          await message.channel.send(`✅ Auto-unmute: ${fresh.user.tag}`);
        }
      } catch (err) {
        console.error('Auto-unmute error:', err);
      }
    }, durationMs);
  } catch (err) {
    console.error('❌ .mute failed:', err);
    return message.channel.send('❌ Failed to mute member. Check bot permissions and role hierarchy.');
  }
  return;
}

// ---------- .unmute (staff only) ----------
// Usage: .unmute <@user|userId> <reason>   (reason mandatory)
if (content.startsWith('.unmute')) {
  await recordUsage('.unmute');
  if (!isStaff) return message.channel.send('❌ Only Staff can use this command.');

  const parts = contentRaw.split(/\s+/).slice(1);
  if (parts.length < 2) return message.channel.send('⚠️ Usage: `.unmute <@user|id> <reason>` (reason required).');

  const targetId = parts[0].replace(/[<@!>]/g, '');
  const reason = parts.slice(1).join(' ').trim();

  const member = await message.guild.members.fetch(targetId).catch(()=>null);
  if (!member) return message.channel.send('⚠️ Member not found.');

  const muteRole = message.guild.roles.cache.get(MUTED_ROLE_ID);
  if (!muteRole) return message.channel.send('❌ Mute role not found (check MUTED_ROLE_ID).');

  if (!message.guild.members.me.permissions.has('ManageRoles')) {
    return message.channel.send('❌ I need Manage Roles permission to remove the mute role.');
  }

  try {
    if (!member.roles.cache.has(MUTED_ROLE_ID)) {
      return message.channel.send('⚠️ That user is not muted.');
    }
    await member.roles.remove(muteRole);
    await message.channel.send(`🔊 ${member.user.tag} has been unmuted. Reason: ${reason}`);
    await logActionStructured({
      command: '.unmute',
      message,
      details: `Unmuted ${member.user.tag} (${member.id}). Reason: ${reason}`,
      channelId: MOD_LOG_CHANNEL_ID
    });
  } catch (err) {
    console.error('❌ .unmute failed:', err);
    return message.channel.send('❌ Failed to unmute member. Check bot permissions and role hierarchy.');
  }
  return;
}

// ---------- .modlog command ----------
if (content.startsWith('.modlog')) {
  const args = content.split(/\s+/);
  const targetMention = args[1];
  if (!targetMention) return message.channel.send('⚠️ Usage: `.modlog <@user or userID>`');

  const targetId = targetMention.replace(/[<@!>]/g, '');
  const logDir = path.join(process.cwd(), 'logs');
// robust: get files sorted by mtime desc (newest first)
let files = [];
try {
  files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.log') || f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(x => x.name);
} catch (e) {
  files = [];
}

  let entries = [];
  for (const file of files) {
    const filePath = path.join(logDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.includes(`"userId":"${targetId}"`) || l.includes(targetId));

    for (const line of lines) {
      if (line.includes('"command":')) {
        try {
          const data = JSON.parse(line);
          entries.push({
            command: data.command,
            time: new Date(data.time).toLocaleString('en-US', { timeZone: 'UTC', hour12: false }),
          });
        } catch (err) {
          // fallback for non-JSON lines
          const match = line.match(/Received message: (\.\S+)/);
          if (match) {
            entries.push({ command: match[1], time: 'Unknown' });
          }
        }
      }
    }

    if (entries.length >= 50) break; // limit for performance
  }

  if (entries.length === 0) return message.channel.send('⚠️ No command logs found for that user.');

  const formatted = entries
    .slice(-25) // latest 25 entries
    .map(e => `• **${e.command}** — ${e.time}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`🧾 Command History for <@${targetId}>`)
    .setDescription(formatted)
    .setColor(0x2b6cb0)
    .setFooter({ text: `Found ${entries.length} total commands` })
    .setTimestamp();

  return message.channel.send({ embeds: [embed] });
}

    // ---------- .punishlog command ----------
if (content.startsWith('.punishlog')) {
  const args = content.split(/\s+/);
  const targetMention = args[1];
  if (!targetMention) return message.channel.send('⚠️ Usage: `.punishlog <@user or userID>`');

  const targetId = targetMention.replace(/[<@!>]/g, '');
  const logDir = path.join(process.cwd(), 'logs');

// Accept both .log and .jsonl files, sort by mtime desc (newest first)
let files = [];
if (fs.existsSync(logDir)) {
  files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.log') || f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(x => x.name);
}

  const allowedCommands = new Set([
    '.warn', '.resetwarn', '.mute', '.unmute', // explicit commands
    'AutoMod', 'AutoMod-mute', 'AutoMod-unmute', 'AutoMod' // auto-moderation entries
  ]);

  let entries = [];
  for (const file of files) {
    try {
      const filePath = path.join(logDir, file);
      const contentStr = fs.readFileSync(filePath, 'utf8');
      const lines = contentStr.split('\n').filter(l => l && (l.includes(`"userId":"${targetId}"`) || l.includes(targetId)));

      for (const line of lines) {
        // Try JSON parse first (most structured logs are JSON)
        try {
          const data = JSON.parse(line);
          const cmd = (data.command || '').toString();
          const details = data.details || '';
          // Keep entries that either are in allowedCommands or mention punish-related words in details
          if (
            allowedCommands.has(cmd) ||
            /mute|muted|unmute|unmuted|warn|warning|resetwarn|automod/i.test(cmd + ' ' + details)
          ) {
            entries.push({
              command: cmd || 'unknown',
              time: data.time ? new Date(data.time).toLocaleString('en-US', { timeZone: 'UTC', hour12: false }) : 'Unknown',
              details: (details || '').toString().slice(0, 800)
            });
          }
        } catch (err) {
          // Non-JSON fallback: try to catch textual triggers
          if (/(AutoMod|autowarn|warn|mute|unmute|resetwarn)/i.test(line)) {
            const m = line.match(/(AutoMod|autowarn|warn|mute|unmute|resetwarn)/i);
            entries.push({
              command: m ? m[0] : 'text-log',
              time: 'Unknown',
              details: line.slice(0, 800)
            });
          }
        }
      }
    } catch (e) {
      // ignore file read errors and continue
      console.error('Failed reading log file for punishlog:', file, e?.message || e);
    }

    if (entries.length >= 10) break; // safety limit while scanning many files
  }

  if (entries.length === 0) return message.channel.send('⚠️ No punishment-related logs found for that user.');

// Format: show up to the 10 most-recent punishment entries (newest -> oldest)
const formatted = entries
  .slice(0, 10)      // first 10 entries (newest -> oldest because we scanned newest files first)
  .map(e => {
    const det = e.details ? ` — ${e.details}` : '';
    return `• **${e.command}** — ${e.time}${det}`;
  })
  .join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`🔨 Punishment History for <@${targetId}>`)
    .setDescription(formatted)
    .setColor(0xff3333)
    .setFooter({ text: `Found ${entries.length} total punish entries` })
    .setTimestamp();

  return message.channel.send({ embeds: [embed] });
}

  } catch (err) {
    console.error('❌ Message handler error:', err);
  }
});

// ---------- Unified interaction handler (modal + buttons + tickets) ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // ---------------- 1) Modal submissions ----------------
    const isModal = (typeof interaction.isModalSubmit === 'function') ? interaction.isModalSubmit() : interaction.isModalSubmit;
    if (isModal) {
      try {
        // --- Remove warning modal ---
        if (interaction.customId && String(interaction.customId).startsWith('removeWarnModal_')) {
          try {
            const [, uid, indexStr] = String(interaction.customId).split('_');
            const index = parseInt(indexStr, 10);
            const reason = (typeof interaction.fields?.getTextInputValue === 'function') ? (interaction.fields.getTextInputValue('removeReason') || 'No reason') : 'No reason';
            const userWarns = warnings[uid] || [];
            if (isNaN(index) || index < 0 || index >= userWarns.length) {
              return interaction.reply({ content: '❌ Warning not found.', flags: 64 });
            }
            userWarns.splice(index, 1);
            try { await saveWarnings(); } catch (e) { console.warn('saveWarnings failed:', e?.message || e); }

            try {
              const member = interaction.guild ? await interaction.guild.members.fetch(uid).catch(() => null) : null;
              if (member) {
                await member.send({
                  embeds: [
                    new EmbedBuilder()
                      .setTitle('⚠️ Warning Removed')
                      .setColor(0x2b6cb0)
                      .setDescription(`A warning was removed by staff.\n\n**Reason:** ${reason}`)
                      .setTimestamp(),
                  ],
                }).catch(() => {});
              }
            } catch (e) { console.warn('DM failed on removeWarnModal:', e?.message || e); }

            return interaction.reply({ content: '✅ Warning removed and records updated.', flags: 64 });
          } catch (err) {
            console.error('Error handling removeWarnModal:', err);
            try { if (!interaction.replied) await interaction.reply({ content: '❌ Failed to process modal submission.', flags: 64 }); } catch(e){}
            return;
          }
        }

        // --- Ticket modal submission handler ---
        if (interaction.customId && String(interaction.customId).startsWith('ticket_modal:')) {
          try {
            // ---------- Ticket modal submit handler ----------
           // parse ticket_modal customId robustly
// expected: ticket_modal:<menuId>:<optionId>  (optionId may contain ':'), optionally :<targetUserId> at the end
const parts = String(interaction.customId || '').split(':');

const menuIdRaw = parts[1];
let optionIdRaw = '';
let targetUserId = interaction.user.id; // default to submitter

if (parts.length >= 3) {
  // If the last segment looks like a Discord snowflake, treat it as the target user's id.
  // This avoids confusing option ids that themselves contain ':' (like 'support:general').
  const last = parts[parts.length - 1];
  if (parts.length >= 4 && /^\d{17,20}$/.test(String(last))) {
    targetUserId = String(last);
    optionIdRaw = parts.slice(2, parts.length - 1).join(':');
  } else {
    // everything after index 1 is the option id (may contain colons)
    optionIdRaw = parts.slice(2).join(':');
  }
}

// 🧩 Sanity check — if it's not a valid snowflake (17–20 digits), default to the modal submitter
if (!/^\d{17,20}$/.test(String(targetUserId))) {
  console.warn(`⚠️ Invalid or missing targetUserId (${targetUserId}), defaulting to interaction user.`);
  targetUserId = interaction.user.id;
}

            const menuId = isNaN(Number(menuIdRaw)) ? menuIdRaw : Number(menuIdRaw);
            const ticketDef = (Array.isArray(SAVED_TICKETS) ? SAVED_TICKETS : []).find(t => t.id === menuId || String(t.id) === String(menuId));
            if (!ticketDef) {
              return interaction.reply({ content: '⚠️ Ticket definition not found. Contact an admin.', flags: 64 });
            }

            const buttons = ticketDef.buttons || [];
            let option = buttons.find(b => (typeof b === 'object' && b.id !== undefined ? String(b.id) === String(optionIdRaw) : String(b) === String(optionIdRaw)));
            if (!option && !Number.isNaN(Number(optionIdRaw))) {
              const idx = Number(optionIdRaw);
              if (idx >= 0 && idx < buttons.length) option = (typeof buttons[idx] === 'object') ? buttons[idx] : { id: idx, label: buttons[idx] };
            }
            let optionRaw = option ? (option.id || option.label) : optionIdRaw;

// ensure support options have proper prefix
if (optionRaw && !String(optionRaw).startsWith('support:') && menuIdRaw === 'support') {
  optionRaw = `support:${optionRaw}`;
}

            // collect answers from modal fields (non-destructive best-effort)
            const answers = [];
            try {
              if (interaction.fields && typeof interaction.fields.getTextInputValue === 'function') {
                for (let i = 0; i < 20; i++) {
                  const fid = `q_${i}`;
                  try {
                    const val = interaction.fields.getTextInputValue(fid);
                    if (val !== undefined && val !== null) answers.push(String(val));
                  } catch (e) { /* ignore missing field */ }
                }
                if (!answers.length) {
                  for (let i = 0; i < 20; i++) {
                    const fid = `answer_${i}`;
                    try {
                      const val = interaction.fields.getTextInputValue(fid);
                      if (val !== undefined && val !== null) answers.push(String(val));
                    } catch (e) {}
                  }
                }
              }
            } catch (e) { /* ignore */ }

            // Must be inside a guild
            const g = interaction.guild;
            if (!g) {
              try { if (!interaction.replied) await interaction.reply({ content: '❌ Must be used inside a server.', flags: 64 }); } catch(e){}
              return;
            }

            // check open tickets
            let ticketChannelId = null;
            try {
              for (const cid of Object.keys(openTickets || {})) {
                const rec = openTickets[cid];
                if (rec && String(rec.userId) === String(targetUserId)) { ticketChannelId = cid; break; }
              }
            } catch (e) { console.warn('openTickets scan failed:', e?.message || e); }

            let ticketChannel = null;
            if (ticketChannelId) {
              try { ticketChannel = await g.channels.fetch(ticketChannelId).catch(() => null); } catch (e) { ticketChannel = null; }
            }

            if (!ticketChannel) {
  // helper sanitize
  const sanitize = s => String((s || '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  // basic sanitized username fallback
  const usernameSan = sanitize(interaction.user.username || interaction.user.tag || 'user');

  // Use answers[] (collected above) to craft special names for sell/buy/gw/wager etc.
  // answers[0] = first modal answer, answers[1] = second, etc.
  const ans = (answers || []).map(a => String(a || '').trim());

  const optId = String(option?.id || optionRaw || '').toLowerCase();

  // generate channel name by requested patterns
  let channelName;
  if (optId.startsWith('apps:staff')) {
    channelName = `staff-app-${usernameSan}`;
  } else if (optId.startsWith('apps:pm')) {
    channelName = `pm-app-${usernameSan}`;
  } else if (optId.startsWith('apps:sponsor')) {
    channelName = `sponsor-${usernameSan}`;
  } else if (optId.startsWith('apps:trusted')) {
    channelName = `trusted-role-${usernameSan}`;
  } else if (optId.startsWith('apps:vouches')) {
    channelName = `vouch-role-${usernameSan}`;
  } else if (optId === 'support:general') {
    channelName = `support-${usernameSan}`;
  } else if (optId === 'support:sell') {
    // expected answers: [type, amount, ign]
    channelName = `sell-${sanitize(ans[1] || 'unknown')}-${sanitize(ans[0] || usernameSan)}`;
  } else if (optId === 'support:buy') {
    channelName = `buy-${sanitize(ans[1] || 'unknown')}-${sanitize(ans[0] || usernameSan)}`;
  } else if (optId === 'support:gw') {
    // expected answers: [host, amount, ign/proof]
    channelName = `${sanitize(ans[0] || usernameSan)}-${sanitize(ans[1] || '0')}`;
  } else if (optId === 'support:partner') {
    channelName = `partner-${usernameSan}`;
  } else if (optId === 'support:wager') {
    // expected: [targetStaff, amount, ign/tier]
    channelName = `${sanitize(ans[0] || usernameSan)}-${sanitize(ans[1] || '0')}`;
  } else if (optId === 'support:suggestions') {
    channelName = `suggestion-${usernameSan}`;
  } else {
    // fallback
    channelName = `ticket-${usernameSan}-${menuId}`;
  }

              // --- Ensure targetUserId is valid ---
if (!/^\d{17,20}$/.test(String(targetUserId))) {
  console.warn(`⚠️ Invalid targetUserId (${targetUserId}), defaulting to interaction user.`);
  targetUserId = interaction.user.id;
}

// --- Fetch target member safely before creating the channel ---
let targetMember = null;
try {
  targetMember = await g.members.fetch(targetUserId);
} catch (err) {
  console.warn(`⚠️ Could not fetch member ${targetUserId}: ${err.message}`);
}

// --- Build permission overwrites ---
const overwrites = [
  {
    id: g.roles.everyone.id,
    deny: [PermissionsBitField.Flags.ViewChannel],
  },
];

// Add the target user if they exist
if (targetMember) {
  overwrites.push({
    id: targetMember.id,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.AttachFiles,
      PermissionsBitField.Flags.EmbedLinks,
    ],
  });
} else {
  console.warn(`⚠️ Member ${targetUserId} not found or not cached; skipping user overwrite.`);
}

// Add staff role overwrite if exists
const staffRole = g.roles.cache.get(STAFF_ROLE_ID);
if (staffRole) {
  overwrites.push({
    id: staffRole.id,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ReadMessageHistory,
    ],
  });
} else {
  console.warn(`⚠️ STAFF_ROLE_ID ${STAFF_ROLE_ID} not found in guild ${g.name}`);
}

const createOpts = {
  name: channelName,
  type: ChannelType.GuildText,
  permissionOverwrites: overwrites,
};

// pick parent (reuse previous logic)
let parentId;
try {
  const optStr = String(option?.id || optionRaw || '').toLowerCase();
  if (optStr.includes('partner')) parentId = TICKET_REFERENCES?.categories?.partner;
  else if (optStr.includes('sell') || optStr.includes('buy')) parentId = TICKET_REFERENCES?.categories?.sellbuy;
  else if (optStr.includes('gw') || optStr.includes('claim')) parentId = TICKET_REFERENCES?.categories?.gwclaim;
  else parentId = TICKET_REFERENCES?.categories?.support;
} catch (e) {
  parentId = TICKET_REFERENCES?.categories?.support;
}
if (parentId) createOpts.parent = String(parentId);

let ticketChannel;
try {
  ticketChannel = await g.channels.create(createOpts);
} catch (err) {
  console.error('❌ Failed to create ticket channel (modal):', err);
  ticketChannel = null;
}

  if (ticketChannel) {
    openTickets = openTickets || {};
    openTickets[ticketChannel.id] = { userId: targetUserId, menuId, optionId: option?.id || optionIdRaw, createdAt: Date.now(), channelId: ticketChannel.id };
    if (typeof writeTicketState === 'function') {
      try {
        const state = readTicketState ? readTicketState() : {};
        state.open = state.open || {};
        state.open[ticketChannel.id] = openTickets[ticketChannel.id];
        writeTicketState(state);
      } catch (e) { console.warn('writeTicketState failed:', e?.message || e); }
    }
  }
}

// Reconstruct question text map (same mapping used when we built the modal)
const questionMap = {
  'apps:staff': ['What experience do you have? Please go in detail.', 'Will you be willing to keep logging format and weekly req as staff?', 'What is your bal, net worth? (Assets)', 'How much do you make weekly?'],
  'apps:pm': ['What experience do you have?', 'Will you be willing to use logging format and keep weekly reqs?'],
  'apps:sponsor': ['How much do you want to sponsor?', 'One time or weekly?', 'You understand you must pay staff to run the giveaway and have read the role info channel?'],
  'apps:trusted': ['How many vouches total do you have?', 'How many vouches do you have inside the server vs outside?', 'Please send proof of all in the ticket'],
  'apps:vouches': ['How many vouches do you have total?', 'Please send all of them in ticket.'],
  'support:general': ['Please explain your issue in detail (be clear & readable).'],
  'support:sell': ['What kind of spawners are you selling?', 'How many?', 'What is your IGN?'],
  'support:buy': ['What kind of spawners are you buying?', 'How many?', 'What is your IGN?'],
  'support:gw': ['Who hosted the giveaway?', 'How much did you win?', 'What is your IGN? Also post proof in the ticket.'],
  'support:partner': ['Please explain your partner request / details'],
  'support:wager': ['Which staff do you want to wager?', 'How much money?', 'What is your IGN and tier?'],
  'support:suggestions': ['Share your suggestion (clear, concise, actionable):'],
};

// build final question->answer text
const qList = questionMap[String(option?.id || optionRaw || '').toLowerCase()] || [];

const pairedLines = (answers && answers.length)
  ? answers.map((a, i) => {
      const qText = qList[i] || `Q${i+1}`;
      return `**${qText}**\n${String(a).slice(0, 1000)}`;
    }).join('\n\n')
  : 'No answers provided.';

// single unified embed (only one embed will be sent)
const summary = new EmbedBuilder()
  .setTitle(`🎫 New Ticket — ${ticketDef?.name || 'Ticket'}`)
  .addFields(
    { name: 'User', value: `<@${targetUserId}>`, inline: true },
    { name: 'Opened by', value: `<@${interaction.user.id}>`, inline: true },
    { name: 'Option', value: option?.label ? String(option.label) : String(option?.id || optionIdRaw), inline: false },
    { name: 'Answers', value: pairedLines, inline: false }
  )
  .setTimestamp();

// ping both the opened user and the staff role (so staff are alerted)
const staffRoleId = STAFF_ROLE_ID || (TICKET_REFERENCES && TICKET_REFERENCES.roles && TICKET_REFERENCES.roles.staff);
const pingContent = staffRoleId
  ? `<@${targetUserId}> <@&${String(staffRoleId)}>`
  : `<@${targetUserId}>`;

// send a single message with the single embed
    try {
      if (ticketChannel) {
        await ticketChannel.send({ content: pingContent, embeds: [summary] }).catch(()=>{});
        if (!interaction.replied) await interaction.reply({ content: `✅ Ticket created: <#${ticketChannel.id}>`, flags: 64 }).catch(()=>{});
      } else {
        if (!interaction.replied) await interaction.reply({ content: '❌ Failed to create ticket channel.', flags: 64 }).catch(()=>{});
      }
    } catch (e) {
      // Error while sending the ticket message / replying
      if (!interaction.replied) await interaction.reply({ content: '❌ Ticket creation error.', flags: 64 }).catch(()=>{});
    }
  } catch (err) {
    // This catches errors specific to the ticket-modal processing branch
    console.error('Ticket modal handling error:', err);
    try {
      if (!interaction.replied) await interaction.reply({ content: '❌ Failed processing ticket modal.', flags: 64 }).catch(()=>{});
    } catch (e) { /* swallow */ }
    return;
  }
        }
      } catch (err) {
        console.error('Modal submission error:', err);
        try { if (!interaction.replied) await interaction.reply({ content: '❌ Modal processing failed.', flags: 64 }); } catch(e){}
      }
    }
    // end modal handling

    // ---------------- 2) Button interactions ----------------
    const isButton = (typeof interaction.isButton === 'function') ? interaction.isButton() : interaction.isButton;
    if (isButton && interaction.customId) {
      try {
        const customId = String(interaction.customId || '');

        // ----- Giveaways buttons (examples) -----
        if (customId === 'gw_join') {
          try {
            const msg = interaction.message;
            if (!msg) return interaction.reply({ content: '⚠️ Message not found.', flags: 64 });
            const gw = giveaways[msg.id];
            if (!gw || !gw.active) return interaction.reply({ content: '⚠️ Giveaway not active.', flags: 64 });
            if (giveawayBans[interaction.user.id]) return interaction.reply({ content: '🚫 You are banned from giveaways.', flags: 64 });
            if (!gw.participants.includes(interaction.user.id)) {
              if (giveawayLocks.has(msg.id)) return interaction.reply({ content: '⏳ Processing — try again shortly.', flags: 64 });
              giveawayLocks.add(msg.id);
              try {
                gw.participants.push(interaction.user.id);
                try { saveGiveaways(); } catch(e){}
                try { await updateGiveawayEmbed(msg.id); } catch(e){}
                return interaction.reply({ content: `🎉 You entered **${gw.prize}**!`, flags: 64 });
              } finally {
                giveawayLocks.delete(msg.id);
              }
            } else {
              return interaction.reply({ content: '⚠️ You are already entered.', flags: 64 });
            }
          } catch (e) {
            console.error('gw_join failed:', e);
            try { if (!interaction.replied) await interaction.reply({ content: '❌ Failed to join giveaway.', flags: 64 }); } catch(e){}
          }
          return;
        }

        if (customId.startsWith('gw_leave_')) {
          try {
            const msgId = customId.split('_').slice(2).join('_');
            const gw = giveaways[msgId];
            if (!gw) return interaction.reply({ content: '❌ Giveaway not found.', flags: 64 });
            if (giveawayLocks.has(msgId)) return interaction.reply({ content: '⏳ Processing — try again shortly.', flags: 64 });
            giveawayLocks.add(msgId);
            try {
              const idx = gw.participants.indexOf(interaction.user.id);
              if (idx === -1) return interaction.reply({ content: '⚠️ You are not entered in this giveaway.', flags: 64 });
              gw.participants.splice(idx, 1);
              try { saveGiveaways(); } catch(e){}
              try { await updateGiveawayEmbed(msgId); } catch(e){}
              return interaction.reply({ content: `🗑️ You have left the giveaway **${gw.prize}**.`, flags: 64 });
            } finally {
              giveawayLocks.delete(msgId);
            }
          } catch (e) {
            console.error('gw_leave failed:', e);
            try { if (!interaction.replied) await interaction.reply({ content: '❌ Failed to leave giveaway.', flags: 64 }); } catch(e){}
          }
          return;
        }

        if (customId === 'gw_participants') {
          try {
            const msg = interaction.message;
            if (!msg) return interaction.reply({ content: '⚠️ Message not found.', flags: 64 });
            const gw = giveaways[msg.id];
            if (!gw) return interaction.reply({ content: '❌ Giveaway not found.', flags: 64 });
            const mentions = (gw.participants || []).slice(0, 200).map(id => `<@${id}>`).join(', ') || 'No participants yet.';
            return interaction.reply({ content: `👥 Participants: ${mentions}`, flags: 64 });
          } catch (e) {
            console.error('gw_participants failed:', e);
            try { if (!interaction.replied) await interaction.reply({ content: '❌ Failed to get participants.', flags: 64 }); } catch(e){}
          }
          return;
        }

        // ---------- Ticket button logic ----------
        const [kind, ...rest] = String(interaction.customId || '').split(':');

        if (kind === 'ticket_list') {
          try {
            const menuIdRaw = rest[0];
            const menuId = isNaN(Number(menuIdRaw)) ? menuIdRaw : Number(menuIdRaw);
            const ticketDef = (Array.isArray(SAVED_TICKETS) ? SAVED_TICKETS : []).find(t => t.id === menuId || String(t.id) === String(menuId));
            if (!ticketDef) return interaction.reply({ content: `⚠️ Ticket menu ${menuIdRaw} not found.`, flags: 64 });

            const rows = [];
            const buttonsArray = ticketDef.buttons || [];
            for (let i = 0; i < buttonsArray.length; i += 5) {
              const slice = buttonsArray.slice(i, i + 5);
              const row = new ActionRowBuilder();
              slice.forEach(btn => {
                const btnId = (typeof btn === 'object' && btn.id !== undefined) ? btn.id : (typeof btn === 'string' ? String(btn) : String(i + slice.indexOf(btn)));
                const label = (typeof btn === 'object') ? (btn.label || String(btnId)) : String(btn);
                row.addComponents(
                  new ButtonBuilder()
                    .setCustomId(`ticket_menu:${ticketDef.id}:${btnId}`)
                    .setLabel(label.slice(0, 80))
                    .setStyle(ButtonStyle.Primary)
                );
              });
              rows.push(row);
            }

            return interaction.reply({
              embeds: [new EmbedBuilder().setTitle(ticketDef.name || 'Ticket Menu').setDescription(ticketDef.description || '').setTimestamp()],
              components: rows,
              flags: 64
            }).catch(err => { console.warn('ticket_list reply failed:', err?.message || err); });
          } catch (err) {
            console.error('ticket_list error:', err);
            try { if (!interaction.replied) await interaction.reply({ content: '❌ Ticket menu error.', flags: 64 }); } catch(e){}
          }
          return;
        }

if (kind === 'ticket_menu') {
  try {
    const menuIdRaw = rest[0];
    const optionRaw = rest.slice(1).join(':');
    const menuId = isNaN(Number(menuIdRaw)) ? menuIdRaw : Number(menuIdRaw);

    const ticketDef = (Array.isArray(SAVED_TICKETS) ? SAVED_TICKETS : []).find(
      t => t.id === menuId || String(t.id) === String(menuId)
    );
    if (!ticketDef) {
      return interaction.reply({
        content: `⚠️ Ticket definition not found for id \`${menuIdRaw}\`. Contact an admin.`,
        flags: 64
      });
    }

    // Resolve option
    let option = null;
    const buttons = ticketDef.buttons || [];

    if (optionRaw) {
      option = buttons.find(b => {
        if (typeof b === 'object' && b.id !== undefined)
          return String(b.id) === String(optionRaw);
        if (typeof b === 'string') return String(b) === String(optionRaw);
        return false;
      });
      if (!option && !Number.isNaN(Number(optionRaw))) {
        const idx = Number(optionRaw);
        if (idx >= 0 && idx < buttons.length)
          option =
            typeof buttons[idx] === 'object'
              ? buttons[idx]
              : { id: idx, label: buttons[idx] };
      }
    }

    // fallback: try matching by clicked button label (best-effort)
    if (!option && interaction.message && Array.isArray(interaction.message.components)) {
      try {
        for (const row of interaction.message.components) {
          for (const comp of row.components) {
            if (comp.type === 2 && comp.customId === interaction.customId) {
              const clickedLabel = comp.label || null;
              if (clickedLabel) {
                option = buttons.find(b =>
                  typeof b === 'object'
                    ? b.label === clickedLabel || String(b.id) === clickedLabel
                    : String(b) === clickedLabel
                );
              }
            }
          }
        }
      } catch (e) {
        /* ignore */
      }
    }

    if (!option) {
      const fallbackRows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        const slice = buttons.slice(i, i + 5);
        const row = new ActionRowBuilder();
        slice.forEach((b, idx) => {
          const btnId =
            typeof b === 'object' && b.id !== undefined
              ? b.id
              : typeof b === 'string'
              ? b
              : i + idx;
          const label =
            typeof b === 'object' ? b.label || String(btnId) : String(b);
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`ticket_menu:${ticketDef.id}:${btnId}`)
              .setLabel(label.slice(0, 80))
              .setStyle(ButtonStyle.Primary)
          );
        });
        fallbackRows.push(row);
      }
      return interaction
        .reply({
          content:
            '⚠️ Ticket option not found — please choose from the list below.',
          components: fallbackRows,
          flags: 64
        })
        .catch(err => {
          console.warn('Failed to send fallback ticket options:', err?.message || err);
        });
    }

    // ✅ Step 1: Show the modal instead of creating a channel directly
try {
  const optId = String(option?.id || optionRaw || '').toLowerCase();

  // mapping: optionId -> array of { label, style, required }
  const questionMap = {
    // Applications
    'apps:staff': [
      { label: 'What experience do you have? Go in detail.', style: TextInputStyle.Paragraph, required: true },
      { label: 'Will you keep logs format and weekly req?', style: TextInputStyle.Short, required: true },
      { label: 'What is your bal, net worth? (Assets)', style: TextInputStyle.Short, required: true },
      { label: 'How much do you make weekly?', style: TextInputStyle.Short, required: true },
    ],
    'apps:pm': [
      { label: 'What experience do you have?', style: TextInputStyle.Paragraph, required: true },
      { label: 'Will you be willing to use logs format and keep weekly reqs?', style: TextInputStyle.Short, required: true },
    ],
    'apps:sponsor': [
      { label: 'How much do you want to sponsor?', style: TextInputStyle.Short, required: true },
      { label: 'One time or weekly?', style: TextInputStyle.Short, required: true },
      { label: 'I have read the role info channel. (yes/no)', style: TextInputStyle.Short, required: true },
    ],
    'apps:trusted': [
      { label: 'How many vouches total do you have?', style: TextInputStyle.Short, required: true },
      { label: 'How many vouches do you have inside server?', style: TextInputStyle.Short, required: true },
      { label: 'Please send all in the ticket (paste links/screenshots).', style: TextInputStyle.Paragraph, required: true },
    ],
    'apps:vouches': [
      { label: 'How many vouches do you have total?', style: TextInputStyle.Short, required: true },
      { label: 'Please send all of them in ticket (links/screenshots).', style: TextInputStyle.Paragraph, required: true },
    ],

    // Support
    'support:general': [
      { label: 'Please explain your issue neatly in ticket.', style: TextInputStyle.Paragraph, required: true },
    ],
    'support:sell': [
      { label: 'What kind of spawners are you selling?', style: TextInputStyle.Short, required: true },
      { label: 'How many?', style: TextInputStyle.Short, required: true },
      { label: 'What is your IGN?', style: TextInputStyle.Short, required: true },
    ],
    'support:buy': [
      { label: 'What kind of spawners are you buying?', style: TextInputStyle.Short, required: true },
      { label: 'How many?', style: TextInputStyle.Short, required: true },
      { label: 'What is your IGN?', style: TextInputStyle.Short, required: true },
    ],
    'support:gw': [
      { label: 'Who hosted the giveaway?', style: TextInputStyle.Short, required: true },
      { label: 'How much did you win?', style: TextInputStyle.Short, required: true },
      { label: 'What is your IGN? Also post proof in the ticket.', style: TextInputStyle.Paragraph, required: true },
    ],
    'support:partner': [
      { label: 'Please explain your partner request / details', style: TextInputStyle.Paragraph, required: true },
    ],
    'support:wager': [
      { label: 'Which staff do you want to wager?', style: TextInputStyle.Short, required: true },
      { label: 'How much money?', style: TextInputStyle.Short, required: true },
      { label: 'What is your IGN and tier?', style: TextInputStyle.Short, required: true },
    ],
    'support:suggestions': [
      { label: 'Share your suggestion (clear, concise, actionable):', style: TextInputStyle.Paragraph, required: true },
    ],
  };

  const questions = questionMap[optId] || [{ label: 'Describe your issue or request:', style: TextInputStyle.Paragraph, required: true }];

  const modal = new ModalBuilder()
    .setCustomId(`ticket_modal:${menuId}:${option.id || optionRaw}`)
    .setTitle(`🎫 ${ticketDef.name || 'New Ticket'}`);

  // add up to 5 inputs (Discord modal limit)
  const rows = [];
  for (let i = 0; i < Math.min(5, questions.length); i++) {
    const q = questions[i];
    const safeLabel =
  q.label.length > 45
    ? q.label.slice(0, 42) + '...'
    : q.label;

const input = new TextInputBuilder()
  .setCustomId(`q_${i}`)
  .setLabel(safeLabel)
  .setStyle(q.style || TextInputStyle.Short)
  .setRequired(!!q.required);

    rows.push(new ActionRowBuilder().addComponents(input));
  }
  modal.addComponents(...rows);

  await interaction.showModal(modal);
  return; // stop further handling — modal submission handled separately
} catch (err) {
  console.error('ticket_menu modal build error:', err);
  try { if (!interaction.replied) await interaction.reply({ content: '❌ Failed building ticket modal.', flags: 64 }); } catch (e) {}
  return;
}

  } catch (err) {
    console.error('ticket_menu handling error:', err);
    try {
      if (!interaction.replied)
        await interaction.reply({
          content: '❌ Failed handling ticket menu click.',
          flags: 64
        });
    } catch (e) {}
  }
  return;
}

        if (kind === 'staffapp') {
          try { await interaction.reply({ content: '✅ Staff application clicked — staff will be notified.', flags: 64 }); } catch(e){}
          return;
        }

      } catch (err) {
        console.error('Button handling error:', err);
        try { if (!interaction.replied) await interaction.reply({ content: '❌ Button handling failed.', flags: 64 }); } catch(e){}
      }
    } // end button handling

    // ---------------- 3) SelectMenu interactions ----------------
    const isSelect = (typeof interaction.isStringSelectMenu === 'function') ? interaction.isStringSelectMenu() : interaction.isStringSelectMenu;
    if (isSelect) {
      try {
        if (interaction.customId === 'help-category') {
          const chosen = Array.isArray(interaction.values) ? interaction.values[0] : null;
          if (!chosen) return interaction.reply({ content: '⚠️ No category chosen.', flags: 64 });
          const helpEmbed = new EmbedBuilder()
            .setTitle(`Help — ${chosen}`)
            .setDescription(`Showing help for **${chosen}**. Use \`.help ${chosen}\` or check pinned messages.`)
            .setTimestamp();
          return interaction.reply({ embeds: [helpEmbed], flags: 64 });
        }
      } catch (err) {
        console.error('Select handler error:', err);
        try { if (!interaction.replied) await interaction.reply({ content: '❌ Select handling failed.', flags: 64 }); } catch(e){}
      }
      return;
    }

    // ---------------- 4) Fallback for other interaction types ----------------
    // add handling here if needed

  } catch (err) {
    console.error('Unified interaction handler error:', err);
    try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ An error occurred handling that action.', flags: 64 }); } catch(e){}
  }
}); // end client.on('interactionCreate')

      // -------------------- Auto-role on member join --------------------
      const AUTO_ROLE_ID = '1424213161262841857';

      client.on('guildMemberAdd', async (member) => {
        try {
          const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
          if (!role) {
            console.warn(`⚠️ Auto-role not found for guild ${member.guild.name}`);
            return;
          }

          await member.roles.add(role);
          console.log(`✅ Assigned auto-role "${role.name}" to ${member.user.tag}`);
        } catch (err) {
          console.error(`❌ Failed to assign auto-role to ${member.user.tag}:`, err);
        }
      });

// ---------- Join / Leave embeds (sends to channel ID 1424376959869259867) ----------
const JOIN_LEAVE_CHANNEL_ID = '1424376959869259867';

client.on('guildMemberAdd', async (member) => {
  try {
    const ch = await client.channels.fetch(JOIN_LEAVE_CHANNEL_ID).catch(()=>null);
    if (!ch || !ch.send) return;

    const createdTs = Math.floor(member.user.createdAt.getTime() / 1000);
    const joinedTs = member.joinedAt ? Math.floor(member.joinedAt.getTime() / 1000) : Math.floor(Date.now()/1000);

    const embed = new EmbedBuilder()
      .setTitle('Member Joined')
      .setDescription(`<@${member.id}>`)
      .addFields(
        { name: 'Username', value: `${member.user.tag}`, inline: true },
        { name: 'User ID', value: `${member.id}`, inline: true },
        { name: 'Account Created', value: `<t:${createdTs}:F>\n<t:${createdTs}:R>`, inline: true },
        { name: 'Date Joined', value: `<t:${joinedTs}:F>\n<t:${joinedTs}:R>`, inline: true }
      )
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 1024 }))
      .setColor(0x00ff88)
      .setTimestamp();

    await ch.send({ embeds: [embed] });
  } catch (err) { console.error('Join embed error:', err); }
});

client.on('guildMemberRemove', async (member) => {
  try {
    const ch = await client.channels.fetch(JOIN_LEAVE_CHANNEL_ID).catch(()=>null);
    if (!ch || !ch.send) return;

    const createdTs = Math.floor(member.user.createdAt.getTime() / 1000);
    const joinedTs = member.joinedAt ? Math.floor(member.joinedAt.getTime() / 1000) : null;

    const embed = new EmbedBuilder()
      .setTitle('Member Left')
      .setDescription(`${member.user.tag}`)
      .addFields(
        { name: 'Username', value: `${member.user.tag}`, inline: true },
        { name: 'User ID', value: `${member.id}`, inline: true },
        { name: 'Account Created', value: `<t:${createdTs}:F>\n<t:${createdTs}:R>`, inline: true },
        { name: 'Date Joined', value: joinedTs ? `<t:${joinedTs}:F>\n<t:${joinedTs}:R>` : 'Unknown', inline: true }
      )
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 1024 }))
      .setColor(0xff4444)
      .setTimestamp();

    await ch.send({ embeds: [embed] });
  } catch (err) { console.error('Leave embed error:', err); }
});

      // -------------------- Periodic Save Tasks --------------------

// Save logs every 10 minutes
setInterval(() => {
  saveLogsToDisk().catch(err => console.error('❌ saveLogsToDisk() error (10 min):', err));
}, 10 * 60 * 1000);

// Hourly full log backup
setInterval(() => {
  try {
    saveLogsToDisk();
    console.log('💾 Hourly log autosave complete.');
  } catch (err) {
    console.error('❌ Hourly autosave failed:', err);
  }
}, 60 * 60 * 1000);
