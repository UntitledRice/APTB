// Requires: discord.js v14, node 18+, dotenv

require('dotenv').config();

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN in environment! Set it in Render's Environment tab.");
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
} = require('discord.js');

// -------------------- Config (edit only if you want to change IDs) --------------------
const STAFF_ROLE_ID = '1424190162983976991';
//const HEARTBEAT_CHANNEL_ID = '1426317682575282226';
const ACTION_LOG_CHANNEL_ID = '1426318804849262643';
const MUTED_ROLE_ID = '1426552661074772018';
const MOD_LOG_CHANNEL_ID = '1427621567856251020'; // Punishment logs channel ID

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

// Ensure logs dir exists
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// -------------------- Minimal helpers --------------------
// Safe JSON reading with fallback to empty object
function safeReadJSON(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
    return fallback;  // Return fallback if file doesn't exist
  } catch (error) {
    console.error(`❌ Failed to read JSON from ${filePath}:`, error);
    return fallback;  // Return fallback on failure
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
  partials: [Partials.Channel]
});

// ✅ Make this global so command handler can access it
let botReady = false;

// -------------------- Port (for pelia) --------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_req, res) => res.send('APTBot is alive and running!'));
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Express server running on port ${PORT}`));

if (process.env.RENDER_EXTERNAL_URL) {
  const keepAliveUrl = process.env.RENDER_EXTERNAL_URL;
  setInterval(() => {
    fetch(keepAliveUrl).catch(() => {});
  }, 4 * 60 * 1000); // ping every 4 minutes
}

// -------------------- Startup and Login --------------------
(async () => {
  try {
    console.log('🚀 Starting APTBot initialization...');

console.log('🕐 Attempting Discord login...');

async function tryLogin(retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🔑 Discord login attempt ${attempt}/${retries}...`);
      await client.login(process.env.DISCORD_TOKEN);
      console.log('✅ Discord login successful!');
      return;
    } catch (err) {
      console.error(`❌ Login attempt ${attempt} failed:`, err.message);
      if (attempt < retries) {
        console.log('⏳ Retrying in 5 seconds...');
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw new Error('Exceeded Discord login retries.');
      }
    }
  }
}

await tryLogin().catch(err => {
  console.error('💥 Discord login ultimately failed:', err);
  process.exit(1);
});

await Promise.race([loginPromise, timeout])
  .then(() => console.log('🔑 Discord login successful.'))
  .catch(err => {
    console.error('❌ Discord login failed or timed out:', err);
    process.exit(1);
  });

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
    });

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

    if (!memberChannel || !botChannel) {
      await createStatsChannels(guild);
      return;
    }

    await memberChannel.setName(`👥 Members: ${memberCount}`).catch(()=>{});
    await botChannel.setName(`🤖 Bots: ${botCount}`).catch(()=>{});
  } catch (err) {
    console.error('Stats update failed:', err);
  }
}

async function createStatsChannels(guild) {
  try {
    const everyoneRole = guild.roles.everyone;
    // delete old ones if exist (safe)
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
    safeWriteJSON(STATS_FILE, statsData);
    console.log(`✅ Created stats channels for ${guild.name}`);
  } catch (err) {
    console.error('Failed to create stats channels:', err);
  }
}

function startStatsLoop() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    for (const [guildId, data] of Object.entries(statsData)) {
      if (data.enabled) {
        const guild = client.guilds.cache.get(guildId);
        if (guild) await updateStats(guild);
      }
    }
  }, 60 * 1000);
}

// -------------------- Locked channels — persisted & reapply on ready --------------------
function saveLockedChannels() { safeWriteJSON(LOCKED_CHANNELS_FILE, lockedChannels); }

// -------------------- Warnings persistence --------------------
async function saveWarnings() { await fsp.writeFile(WARNINGS_FILE, JSON.stringify(warnings, null, 2), 'utf8'); }

// -------------------- Bypass persistence --------------------
async function saveBypass() { await fsp.writeFile(BYPASS_FILE, JSON.stringify(bypassList, null, 2), 'utf8'); }

// -------------------- Giveaways persistence --------------------
function saveGiveaways() { safeWriteJSON(GIVEAWAYS_FILE, giveaways); }
function saveGiveawayBans() { safeWriteJSON(GIVEAWAY_BANS_FILE, giveawayBans); }
function saveGiveawayRigged() { safeWriteJSON(GIVEAWAY_RIGGED_FILE, giveawayRigged); }

// In-memory timers for running giveaways so we can re-schedule/clear them
const giveawayTimers = new Map();
async function scheduleGiveawayEnd(client, msgId) {
  // clear any existing timer for this giveaway
  if (giveawayTimers.has(msgId)) {
    clearInterval(giveawayTimers.get(msgId));
    giveawayTimers.delete(msgId);
  }

  const gw = giveaways[msgId];
  if (!gw || !gw.active) return;

  // run every minute -- the embed itself will show relative time (<t:...:R>)
  const interval = setInterval(async () => {
    try {
      const curGw = giveaways[msgId];
      if (!curGw) {
        clearInterval(interval);
        giveawayTimers.delete(msgId);
        return;
      }

      const remaining = curGw.end - Date.now();
      if (remaining > 0) {
        return;
      }

      // Time's up
      clearInterval(interval);
      giveawayTimers.delete(msgId);
      curGw.active = false;

      // compute eligible participants
      const participants = (curGw.participants || []).filter(
        id => !giveawayBans[id] && !giveawayRigged[id]
      );

      // pick winners
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

      // build final embed
      const endEmbed = new EmbedBuilder()
        .setTitle(`🎉 ${curGw.prize}`)
        .setDescription(
          `🎁 **Prize:** ${curGw.prize}\n**Host:** <@${curGw.hostId}>\n**Winners:** ${winnerMentions}\n**Ended:** <t:${Math.floor(
            curGw.end / 1000
          )}:R>`
        )
        .setColor(0x00ff88);

      if (msg) await msg.edit({ embeds: [endEmbed], components: [] }).catch(() => {});

      // announce winners in the channel (ping)
      if (winners.length > 0) {
        try {
          const pingMsg = await ch.send({
            content: `🎊 Congratulations ${winnerMentions}! You won **${curGw.prize}**, hosted by <@${curGw.hostId}>!`,
          }).catch(() => null);

          // optional cleanup: delete after 2 minutes
          if (pingMsg) setTimeout(() => pingMsg.delete().catch(() => {}), 2 * 60 * 1000);

          // DM each winner (best-effort)
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
        } catch (err) {
          console.error('Error announcing giveaway winners:', err);
        }
      } else {
        await ch.send('😢 No valid participants — no winners this time.').catch(() => {});
      }

      // final bookkeeping
      saveGiveaways();
      await logActionStructured({
        command: '.gw',
        message: { author: { id: curGw.hostId }, guild: { id: curGw.guildId }, channel: { id: curGw.channelId } },
        details: `Giveaway ended — Prize: ${curGw.prize}, Winners: ${winnerMentions}`,
      });

    } catch (err) {
      console.error('scheduleGiveawayEnd error for', msgId, err);
      // don't crash the interval loop — attempt to clear and remove mapping
      try { clearInterval(interval); } catch {}
      giveawayTimers.delete(msgId);
    }
  }, 60 * 1000);

  // save interval ref
  giveawayTimers.set(msgId, interval);
}

// -------------------- Message handler (commands) --------------------
client.on('messageCreate', async message => {
  if (!botReady) return; // Ignore all messages until bot is ready
  try {
//    Use below if no bot feedback to see if console registers commands
//    console.log(`[DEBUG] Message received: "${message.content}" from ${message.author.tag}`);
    if (message.author.bot) return;
    console.log(`Received message: ${message.content}`);
    const contentRaw = message.content?.trim() || '';
    if (!contentRaw) return;
    const content = contentRaw.toLowerCase();
    const isCommand = contentRaw.startsWith('.');
    const isStaff = !!(message.member && message.member.roles.cache.has(STAFF_ROLE_ID));

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
  if ((containsProfanity || containsNudity || containsLink) &&
      !LINK_WHITELIST_CHANNELS.includes(message.channel.id)) {

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

        // 🔵 Information
        { name: '.whois', desc: 'Show detailed info about a user (roles, join date, etc).', args: '<userId or mention>', roles: ['Staff'], category: '🔵 Information' },

        // 🟣 Staff Utilities
        { name: '.gw', desc: 'Create, edit, or delete giveaways.', args: 'create/edit/delete [params]', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.welcome', desc: 'Send a welcome message to a new staff member.', args: '@User', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.vouch', desc: 'Ask others to vouch for you in the staff channel.', args: 'none', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.rvouch', desc: 'Restricted version of vouch for APT only.', args: 'none', roles: ['Specific User'], category: '🟣 Staff Utilities' },
        { name: '.bypass', desc: 'Toggle AutoMod bypass for a user (owner-only).', args: '@User', roles: ['Owner'], category: '🟣 Staff Utilities' },
        { name: '.purge', desc: 'Delete 1–100 recent messages in a channel.', args: '<1–100>', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.lock', desc: 'Lock the current channel for everyone.', args: 'none', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.unlock', desc: 'Unlock a previously locked channel.', args: 'none', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.inactive', desc: 'Start a 12-hour inactivity countdown for a ticket (auto-close).', args: '@User', roles: ['Staff'], category: '🟣 Staff Utilities' },
        { name: '.done', desc: 'Notify a user that their ad has been posted.', args: '@User', roles: ['Staff'], category: '🟣 Staff Utilities' },

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
        { name: '.stats', desc: 'Create or toggle persistent member/bot stats channels.', args: 'none', roles: ['Staff'], category: '⚙️ Server Management' },
        { name: '.debug', desc: 'Safely self-test all bot commands in simulation mode (no real actions).', args: 'none', roles: ['Owner', 'Staff'], category: '⚙️ Server Management' },

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
        { name: '.gw ban', desc: 'Ban a user from joining giveaways.', args: '@User', roles: ['Owner'], category: '🔒 Cheats' },
        { name: '.gw rig', desc: 'Allow a user to join but not win.', args: '@User', roles: ['Owner'], category: '🔒 Cheats' },
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

        cmds.forEach(cmd => {
          const status = cmd.status ? ` **Status:** ${cmd.status}` : '';
          embed.addFields({
            name: `${cmd.name} (${cmd.roles.join(', ')})`,
            value: `**Description:** ${cmd.desc}\n**Args:** ${cmd.args}${status}`,
            inline: false
          });
        });
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
        if (i.user.id !== message.author.id) return safeReply(i, { content: 'This menu is not for you.', flags: 64 });
        const selected = i.values[0];
        const backButton = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('help-back').setLabel('Back').setStyle(ButtonStyle.Primary)
        );
        await safeReply(i, { embeds: [generateCategoryEmbed(categories[selected], selected)], components: [backButton] });
      });

      const btnCollector = helpMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });
      btnCollector.on('collect', async i => {
        if (i.user.id !== message.author.id) return safeReply(i, { content: 'This button is not for you.', flags: 64 });
        if (i.customId === 'help-back') await safeReply(i, { embeds: [generateMainEmbed()], components: [row] });
      });

      return;
    }
    
    // ---------- Giveaway Interaction Safety Helper ----------
    async function safeReply(i, data, type = 'reply') {
      try {
        // Skip if interaction expired (15min rule)
        if (Date.now() - i.createdTimestamp > 14 * 60 * 1000) {
          console.warn('⏱️ Interaction expired, skipping.');
          return;
        }

        if (type === 'reply') {
          if (!i.replied && !i.deferred) return await i.reply({ ...data }).catch(() => {});
          if (i.replied && !i.deferred) return await i.followUp({ ...data }).catch(() => {});
          return;
        }

        if (type === 'update') {
          if (!i.replied && !i.deferred) return await i.update({ ...data }).catch(() => {});
          if (i.deferred) return await i.editReply({ ...data }).catch(() => {});
          return;
        }
      } catch (err) {
        if (err?.code === 10062 || /Unknown interaction/i.test(err?.message)) {
          // interaction already expired or acknowledged
          console.warn('⚠️ Skipped unknown/expired interaction safely.');
          return;
        }
        console.error('❌ Interaction error:', err);
      }
    }

    // ---------- .gw (Giveaway System) ----------
    if (content.startsWith('.gw')) {
      await recordUsage('.gw');
      if (!isStaff) return message.channel.send('❌ Only Staff can manage giveaways.');

      const args = contentRaw.split(/\s+/).slice(1);
      const subCmd = args.shift()?.toLowerCase();

      // no arguments — show usage
      if (!subCmd) {
        const embed = new EmbedBuilder()
          .setTitle('🎉 Giveaway Command Usage')
          .setColor(0x2b6cb0)
          .setDescription(
            `**Usage Examples:**\n` +
            '```bash\n' +
            '.gw create 2d Nitro 1\n' +
            '.gw edit <messageID>\n' +
            '.gw delete <messageID>\n' +
//            '.gw ban <@User>\n' +
//            '.gw rig <@User>\n' +
            '```\n' +
            '**Duration formats:** 1d / 12h / 30m / 10s\n' +
            '**Prize:** string (required)\n' +
            '**Winners:** number (required, ≥1)'
          );
        return message.channel.send({ embeds: [embed] });
      }

      // ---- Giveaway Ban ----
      if (subCmd === 'ban') {
        const target = message.mentions.users.first();
        if (!target) return message.channel.send('⚠️ Mention a user to ban from giveaways.');
        giveawayBans[target.id] = true;
        saveGiveawayBans();
        return message.channel.send(`🚫 **${target.tag}** has been banned from joining giveaways.`);
      }

      // ---- Giveaway Rig ----
      if (subCmd === 'rig') {
        const target = message.mentions.users.first();
        if (!target) return message.channel.send('⚠️ Mention a user to rig (cannot win).');
        giveawayRigged[target.id] = true;
        saveGiveawayRigged();
        return message.channel.send(`🎭 **${target.tag}** can join but will never win.`);
      }

      // ---- Giveaway Create ----
      if (subCmd === 'create') {
        const [durationRaw, ...rest] = args;
        if (!durationRaw || rest.length < 2)
          return message.channel.send('⚠️ Usage: `.gw create <duration> <prize> <winners>`');

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

        const controlEmbed = new EmbedBuilder()
          .setTitle('🎁 Giveaway Setup')
          .setDescription(`**Prize:** ${prize}\n**Winners:** ${winnersCount}\n**Duration:** ${durationRaw}`)
          .setFooter({ text: `Host: ${message.author.tag}` })
          .setColor(0x2b6cb0);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gw_start').setLabel('Start').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('gw_edit').setLabel('Edit').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('gwsetup_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
        );

        const setupMsg = await message.channel.send({ embeds: [controlEmbed], components: [row] });

        const collector = setupMsg.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 600000,
        });

        collector.on('collect', async i => {
          if (i.user.id !== message.author.id)
            return safeReply(i, { content: 'Only the giveaway host can use these buttons.', flags: 64 });

          if (i.customId === 'gwsetup_cancel') {
            if (!i.replied && !i.deferred) {
              await safeReply(i, { content: '❌ Giveaway setup canceled.', embeds: [], components: [] }).catch(() => {});
            }
            collector.stop();
            return;
          }

          if (i.customId === 'gw_edit') {
            try {
              // Step 1: Defer the update so Discord keeps interaction alive.
              await i.deferUpdate().catch(() => {});

              // Step 2: Build the modal.
              const modal = new ModalBuilder()
                .setCustomId(`gw_setup_edit_modal_${setupMsg.id}`)
                .setTitle('Edit Giveaway Setup')
                .addComponents(
                  new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                      .setCustomId('edit_prize')
                      .setLabel('Prize')
                      .setStyle(TextInputStyle.Short)
                      .setValue(prize)
                      .setRequired(true)
                  ),
                  new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                      .setCustomId('edit_duration')
                      .setLabel('Duration (e.g., 2d, 3h, 45m)')
                      .setStyle(TextInputStyle.Short)
                      .setValue(durationRaw)
                      .setRequired(true)
                  ),
                  new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                      .setCustomId('edit_winners')
                      .setLabel('Number of Winners')
                      .setStyle(TextInputStyle.Short)
                      .setValue(String(winnersCount))
                      .setRequired(true)
                  )
                );

              // Step 3: Delay just enough for Discord to process deferUpdate (important)
              await new Promise(r => setTimeout(r, 300));

              // Step 4: Show the modal
              await i.user.send('🧩 Opening edit menu... (if modal doesn’t appear, click Edit again)').catch(() => {});
              await i.showModal(modal);
              console.log('✅ Modal displayed for', i.user.tag);
            } catch (err) {
              console.error('❌ Modal show error (fixed flow):', err);
              if (!i.replied && !i.deferred) {
                await i.reply({ content: '⚠️ Failed to open modal.', flags: 64 }).catch(() => {});
              }
            }
          }

          if (i.customId === 'gw_start') {
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
            // schedule the end timer (centralized)
            scheduleGiveawayEnd(client, gwMsg.id);
            safeReply(i, { content: `✅ Giveaway started for **${prize}**!`, embeds: [], components: [] });
          }
        });

        return;
      }

      // ---- Giveaway Delete ----
      if (subCmd === 'delete') {
        const msgId = args[0];
        if (!msgId) return message.channel.send('⚠️ Provide message ID to delete.');
        delete giveaways[msgId];
        saveGiveaways();
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
          if (i.user.id !== message.author.id)
            return safeReply(i, { content: '❌ Only the giveaway host can edit this.', flags: 64 });

          if (i.customId === 'edit_cancel') {
            await safeReply(i, { content: '❌ Giveaway edit canceled.', embeds: [], components: [] });
            collector.stop();
            return;
          }

          // --- Modal for editing ---
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

          await i.showModal(modal);

          // Wait for the modal submission from the same user
          const submitted = await i.awaitModalSubmit({
            filter: (m) => m.user.id === i.user.id,
            time: 120000,
          }).catch(() => null);

          if (!submitted) return i.followUp({ content: '⏱️ Edit timed out.', flags: 64 });

          // Process submitted data
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
            if (isNaN(num) || num < 1)
              return submitted.reply({ content: '⚠️ Must be a number ≥ 1.', flags: 64 });
            gw.winnersCount = num;
            await submitted.reply({ content: `🏆 Winners updated to **${gw.winnersCount}**.`, flags: 64 });
          }

          saveGiveaways();
          scheduleGiveawayEnd(client, msgId);

          // Update the giveaway message if it still exists
          try {
            const gwChannel = await client.channels.fetch(gw.channelId);
            const gwMsg = await gwChannel.messages.fetch(msgId);
            const updatedEmbed = new EmbedBuilder()
              .setTitle(`🎉 ${gw.prize}`)
              .setDescription(
                `**Host:** <@${gw.hostId}>\n**Winners:** ${gw.winnersCount}\n**Time left:** <t:${Math.floor(
                  gw.end / 1000
                )}:R>\n\nClick 🎉 to enter!`
              )
              .setColor(0xffc107)
              .setTimestamp(new Date(gw.end));
            await gwMsg.edit({ embeds: [updatedEmbed] });
          } catch (err) {
            console.error('Failed to update giveaway message:', err);
          }

          await logActionStructured({
            command: '.gw edit',
            message,
            details: `Edited giveaway ${msgId} (Prize: ${gw.prize}, Winners: ${gw.winnersCount})`,
          });
        });

        collector.on('end', async () => {
          if (!msg.editable) return;
          await msg.edit({ components: [] }).catch(() => {});
        });

        return;
      }
    }

    // ---------- .stats command (persistent toggle) ----------
    if (content === '.stats') {
      await recordUsage('.stats');
      if (!isStaff) return message.channel.send('❌ Only Staff can toggle stats.');

      const guild = message.guild;
      const existing = statsData[guild.id] || { enabled: false };
      if (!existing.enabled) {
        await createStatsChannels(guild);
        return message.channel.send('✅ Server stats enabled and channels created.');
      } else {
        // disable & remove channels (safe)
        try {
          const { memberChannel, botChannel } = existing;
          const mCh = guild.channels.cache.get(memberChannel);
          const bCh = guild.channels.cache.get(botChannel);
          if (mCh) await mCh.delete().catch(()=>{});
          if (bCh) await bCh.delete().catch(()=>{});
        } catch (err) { console.error('Error deleting stats channels:', err); }
        statsData[guild.id].enabled = false;
        safeWriteJSON(STATS_FILE, statsData);
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
        command: '.resetwarn',
        message,
        details: `Reset warnings for ${target.user.tag}`,
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

    // ------------ On Bot Restart: Resume Timers ------------

    // After restart, check and resume inactive timers
    Object.keys(inactiveTimers).forEach(async (channelId) => {
      const timer = inactiveTimers[channelId];
      const channel = await message.guild.channels.fetch(channelId).catch(() => null);

      if (!channel) {
        // Remove the timer if the channel doesn't exist anymore
        delete inactiveTimers[channelId];
        safeWriteJSON(INACTIVE_FILE, inactiveTimers);
        return;
      }

      const target = await message.guild.members.fetch(timer.targetId).catch(() => null);
      if (!target) return;

      let totalSeconds = timer.totalSeconds;

      const embed = new EmbedBuilder()
        .setTitle('⏳ Inactivity Countdown')
        .setDescription(`Ticket for ${target} will auto-close in **12 hours** unless they react with ✅.`)
        .setColor(0xffaa00)
        .setFooter({ text: 'Waiting for user activity...' });

      const countdownMsg = await channel.messages.fetch(timer.countdownMsgId).catch(() => null);
      if (!countdownMsg) return;

      const filter = (reaction, user) => reaction.emoji.name === '✅' && user.id === target.id;
      const collector = countdownMsg.createReactionCollector({ filter, time: totalSeconds * 1000 });

      // Resume the timer, and update every minute
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
        await channel.send(`✅ ${target} responded — ticket will remain open.`);

        // Remove the timer from the inactiveTimers state and update the file
        delete inactiveTimers[channelId];
        safeWriteJSON(INACTIVE_FILE, inactiveTimers);
      });

      collector.on('end', async collected => {
        clearInterval(interval);
        if (collected.size === 0) {
          await countdownMsg.edit({ embeds: [new EmbedBuilder().setTitle('⛔ Ticket Closed').setDescription(`12 hours passed without a reaction from ${target}. The ticket will now close.`).setColor(0xff0000)] }).catch(() => {});
          await channel.send(`🔒 Ticket closed due to inactivity (${target}).`);

          // Delete the ticket channel after inactivity period (12 hours)
          try {
            await channel.delete(); // Delete the channel
            console.log(`Ticket ${channel.name} closed due to inactivity.`);
          } catch (err) {
            console.error('❌ Error while deleting the ticket:', err);
          }

          // Remove the timer from the inactiveTimers state and update the file
          delete inactiveTimers[channelId];
          safeWriteJSON(INACTIVE_FILE, inactiveTimers);
        }
      });
    });
    
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
        { command: '.ban', safe: true },
        { command: '.kick', safe: true },
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
      '.blacklist':'1424245388193566720'
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
        details: `Warned ${target.user.tag}. Reason: ${reason}`,
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
        details: `Reset warnings for ${target.user.tag}`,
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

      // ---------- Mute / Unmute ----------
      if (content.startsWith('.mute') || content.startsWith('.unmute')) {
        await recordUsage(content.startsWith('.mute') ? '.mute' : '.unmute');
        if (!isStaff) return message.channel.send('❌ Only Staff can use this command.');
        const args = contentRaw.split(/\s+/).slice(1);
        const muteRole = message.guild.roles.cache.get(MUTED_ROLE_ID);
        if (!muteRole) return message.channel.send('⚠️ Muted role not found.');

        if (content.startsWith('.mute')) {
          const targetMention = args[0];
          const durationStr = args[args.length - 1];
          const reason = args.slice(1, args.length - 1).join(' ') || 'No reason provided.';
          if (!targetMention) return message.channel.send('⚠️ Provide a user mention.');
          const target = await message.guild.members.fetch(targetMention.replace(/[<@!>]/g, '')).catch(() => null);
          if (!target) return message.channel.send('⚠️ User not found.');
          if (target.roles.cache.has(MUTED_ROLE_ID)) return message.channel.send('⚠️ User is already muted.');
          const match = durationStr ? durationStr.match(/^(\d+)(s|m|h|d)$/) : null;
          if (!match) return message.channel.send('⚠️ Invalid duration. Example: 10m, 2h, 1d.');
          const num = parseInt(match[1]);
          const unit = match[2];
          let durationMs;
          switch (unit) {
            case 's': durationMs = num * 1000; break;
            case 'm': durationMs = num * 60 * 1000; break;
            case 'h': durationMs = num * 60 * 60 * 1000; break;
            case 'd': durationMs = num * 24 * 60 * 60 * 1000; break;
            default: durationMs = num * 60 * 1000;
          }

          try {
            await target.roles.add(muteRole);
          } catch (err) {
            console.error('Failed to add mute role:', err);
            return message.channel.send('❌ Failed to assign mute role.');
          }

          await message.channel.send(`✅ ${target.user.tag} muted for ${durationStr}. Reason: ${reason}`);

          await logActionStructured({
            command: '.mute',
            message,
            details: `${target.user.tag} muted. Reason: ${reason}. Duration: ${durationStr}`,
            channelId: MOD_LOG_CHANNEL_ID
          });

          try {
            await target.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle('🔇 You have been muted')
                  .setColor(0xff0000)
                  .setDescription(`
                    **By:** ${message.author.tag}
                    **Reason:** ${reason}
                    **Duration:** ${durationStr}
                  `)
                  .setTimestamp()
              ]
            });
          } catch {}

          setTimeout(async () => {
            try {
              const fresh = await message.guild.members.fetch(target.id);
              if (fresh.roles.cache.has(MUTED_ROLE_ID)) {
                await fresh.roles.remove(muteRole);
                await message.channel.send(`✅ Auto-unmute: ${fresh.user.tag}`);
                await logActionStructured({
                  command: '.unmute-auto',
                  message,
                  details: `${fresh.user.tag} auto-unmuted after ${durationStr}`
                });
              }
            } catch (err) {
              console.error('Auto-unmute failed', err);
            }
          }, durationMs);

          await handleWarningsAndMute(target, message);
          return;
        } else {
          // .unmute command
          const targetMention = args[0];
          const reason = args.slice(1).join(' ') || 'No reason provided.';
          if (!targetMention) return message.channel.send('⚠️ Provide a user mention.');
          const target = await message.guild.members.fetch(targetMention.replace(/[<@!>]/g, '')).catch(() => null);
          if (!target) return message.channel.send('⚠️ User not found.');
          if (!target.roles.cache.has(MUTED_ROLE_ID)) return message.channel.send('⚠️ User is not muted.');

          try {
            await target.roles.remove(muteRole);
          } catch (err) {
            console.error('Failed to remove mute role:', err);
            return message.channel.send('❌ Failed to unmute user (role removal failed).');
          }

          await message.channel.send(`✅ ${target.user.tag} has been unmuted. Reason: ${reason}`);

          await logActionStructured({
            command: '.unmute',
            message,
            details: `${target.user.tag} unmuted by ${message.author.tag}. Reason: ${reason}`,
            channelId: MOD_LOG_CHANNEL_ID
          });

          try {
            await target.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle('🔊 You have been unmuted')
                  .setColor(0x00ff00)
                  .setDescription(`
                    **By:** ${message.author.tag}
                    **Reason:** ${reason}
                  `)
                  .setTimestamp()
              ]
            });
          } catch {}

          return;
        }
      }

      // ✅ Close the message handler properly
      } catch (err) {
        console.error('❌ Message handler error:', err);
      }
      }); // closes client.on('messageCreate')

// -------------------- Interaction handler (modals & removewarn) --------------------
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('removeWarnModal_')) {
      const [, uid, indexStr] = interaction.customId.split('_');
      const index = parseInt(indexStr);
      const reason = interaction.fields.getTextInputValue('removeReason');
      const userWarns = warnings[uid] || [];
      if (index >= userWarns.length) return interaction.reply({ content: '❌ Warning not found.', flags: 64 });
      const warnEntry = userWarns.splice(index, 1)[0];
      await saveWarnings();

      // DM user if possible
      try {
        const member = interaction.guild ? await interaction.guild.members.fetch(uid).catch(()=>null) : null;
        if (member) {
          await member.send({ embeds: [ new EmbedBuilder().setTitle('⚠️ A warning was removed').setColor(0x00ff00).setDescription(`Your warning: "${warnEntry.reason}"\nRemoved by: ${interaction.user.tag}\nReason: ${reason}`).setTimestamp() ] }).catch(()=>{});
        }
      } catch (err) { console.error('❌ DM error:', err); }

      await logActionStructured({ command: '.removewarn', message: { author: interaction.user, guild: interaction.guild, channel: interaction.channel }, details: `Removed warning #${index+1} for ${uid} by ${interaction.user.tag}. Reason: ${reason}` });
      await interaction.reply({ content: `✅ Warning #${index+1} removed.`, flags: 64 });
    }
  } catch (err) {
    console.error('Interaction handler error:', err);
    if (!interaction.replied) {
      try { await interaction.reply({ content: '❌ An error occurred.', flags: 64 }); } catch {}
    }
  }
  
  // Giveaway Join / Leave / Participants (improved, safe)
  if (interaction.isButton() && interaction.customId.startsWith('gw_')) {
    try {
      const msgId = interaction.message.id;
      const gw = giveaways[msgId];
      if (!gw || !gw.active) {
        return interaction.reply({ content: '❌ This giveaway has ended or cannot be found.', flags: 64 });
      }

      // Helper to safely update the giveaway embed with participant count
      async function updateGiveawayEmbed(msgIdToUpdate) {
        try {
          const gwData = giveaways[msgIdToUpdate];
          if (!gwData) return;
          const ch = await client.channels.fetch(gwData.channelId).catch(() => null);
          if (!ch) return;
          const gm = await ch.messages.fetch(msgIdToUpdate).catch(() => null);
          if (!gm) return;
          // Build the updated embed with participant count
          const embed = new EmbedBuilder()
            .setTitle(`🎉 ${gwData.prize}`)
            .setDescription(
              `**Host:** <@${gwData.hostId}>\n**Winners:** ${gwData.winnersCount}\n**Participants:** ${gwData.participants.length}\n**Time left:** <t:${Math.floor(
                gwData.end / 1000
              )}:R>\n\nClick 🎉 to enter!`
            )
            .setColor(0xffc107)
            .setTimestamp(new Date(gwData.end));
          // keep components intact (Join + Participants)
          await gm.edit({ embeds: [embed] }).catch(() => {});
        } catch (err) {
          console.error('Failed to update giveaway embed:', err);
        }
      }

      // Prevent concurrent modifications for a single giveaway
      if (giveawayLocks.has(msgId)) {
        return interaction.reply({ content: '⏳ Processing recent joins — try again in a moment.', flags: 64 });
      }

      // ---- Join flow ----
      if (interaction.customId === 'gw_join') {
        // immediate checks
        if (giveawayBans[interaction.user.id]) {
          return interaction.reply({ content: '🚫 You are banned from giveaways.', flags: 64 });
        }

        // If user already joined -> ephemeral reply with a Leave button
        if (gw.participants.includes(interaction.user.id)) {
          // Provide ephemeral message with a quick leave button
          const leaveRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`gw_leave_${msgId}`)
              .setLabel('Leave Giveaway')
              .setStyle(ButtonStyle.Danger)
          );
          return interaction.reply({
            content: '⚠️ You are already entered in this giveaway.',
            components: [leaveRow],
            flags: 64
          });
        }

        // Acquire lock
        giveawayLocks.add(msgId);
        try {
          // Double-check membership after lock (avoid race)
          if (!gw.participants.includes(interaction.user.id)) {
            gw.participants.push(interaction.user.id);
            saveGiveaways();
          }
          // Update public giveaway embed participant count
          await updateGiveawayEmbed(msgId);
          // Respond ephemeral with confirmation + Leave button
          const leaveRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`gw_leave_${msgId}`)
              .setLabel('Leave Giveaway')
              .setStyle(ButtonStyle.Danger)
          );
          return interaction.reply({
            content: `🎉 You entered **${gw.prize}**! Your entry has been recorded.`,
            components: [leaveRow],
            flags: 64
          });
        } finally {
          // release lock
          giveawayLocks.delete(msgId);
        }
      }

      // ---- Leave flow (button customId = gw_leave_<msgId>) ----
      if (interaction.customId && interaction.customId.startsWith('gw_leave_')) {
        // customId includes msgId: gw_leave_<msgId>
        const parts = interaction.customId.split('_');
        const leaveMsgId = parts.slice(2).join('_'); // supports underscores in IDs if any
        const gwLeave = giveaways[leaveMsgId];
        if (!gwLeave) return interaction.reply({ content: '❌ Giveaway not found.', flags: 64 });

        // Acquire lock for that giveaway
        if (giveawayLocks.has(leaveMsgId)) {
          return interaction.reply({ content: '⏳ Processing — try again shortly.', flags: 64 });
        }
        giveawayLocks.add(leaveMsgId);
        try {
          const idx = gwLeave.participants.indexOf(interaction.user.id);
          if (idx === -1) {
            return interaction.reply({ content: '⚠️ You are not entered in this giveaway.', flags: 64 });
          }
          gwLeave.participants.splice(idx, 1);
          saveGiveaways();
          // Update public embed
          await updateGiveawayEmbed(leaveMsgId);
          return interaction.reply({ content: `🗑️ You have left the giveaway **${gwLeave.prize}**.`, flags: 64 });
        } finally {
          giveawayLocks.delete(leaveMsgId);
        }
      }

      // ---- Participants (staff only) ----
      if (interaction.customId === 'gw_participants') {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member || !member.roles.cache.has(STAFF_ROLE_ID))
          return interaction.reply({ content: '❌ Staff only.', flags: 64 });

        const list = gw.participants.length ? gw.participants.map(id => `<@${id}>`).join('\n') : 'No participants yet.';
        const embed = new EmbedBuilder()
          .setTitle('🎟️ Giveaway Participants')
          .setDescription(list)
          .setColor(0x2b6cb0);

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

    } catch (err) {
      console.error('Giveaway interaction error:', err);
      // safe fallback: ephemeral error
      if (!interaction.replied && !interaction.deferred) {
        try { await interaction.reply({ content: '❌ An error occurred handling that action.', flags: 64 }); } catch (e) {}
      }
    }
  }  
});

// -------------------- Global Giveaway Edit Modal Handler --------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith('gw_setup_edit_modal_')) return;

  try {
    const [, , setupMsgId] = interaction.customId.split('_');

    const newPrize = interaction.fields.getTextInputValue('edit_prize');
    const newDurationRaw = interaction.fields.getTextInputValue('edit_duration');
    const newWinnersRaw = interaction.fields.getTextInputValue('edit_winners');

    const durationMatch = newDurationRaw.match(/^(\d+)([dhms])$/i);
    if (!durationMatch)
      return interaction.reply({ content: '⚠️ Invalid duration. Use 1d / 2h / 30m / 45s.', flags: 64 });

    const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    const newDurationMs = parseInt(durationMatch[1]) * unitMs[durationMatch[2].toLowerCase()];

    const newWinners = parseInt(newWinnersRaw);
    if (isNaN(newWinners) || newWinners < 1)
      return interaction.reply({ content: '⚠️ Winners must be a number ≥ 1.', flags: 64 });

    // Store updated setup data per message
    if (!global.tempGiveawaySetup) global.tempGiveawaySetup = {};
    global.tempGiveawaySetup[setupMsgId] = {
      prize: newPrize,
      durationRaw: newDurationRaw,
      durationMs: newDurationMs,
      winnersCount: newWinners,
      hostId: interaction.user.id,
    };

    // 🟢 Try updating the original setup preview
    const setupMsg = await interaction.channel.messages.fetch(setupMsgId).catch(() => null);
    if (setupMsg) {
      const embed = EmbedBuilder.from(setupMsg.embeds[0])
        .setDescription(`**Prize:** ${newPrize}\n**Winners:** ${newWinners}\n**Duration:** ${newDurationRaw}`)
        .setFooter({ text: `Host: ${interaction.user.tag}` })
        .setColor(0x2b6cb0);
      await setupMsg.edit({ embeds: [embed] }).catch(() => {});
    }

    await interaction.reply({ content: '✅ Giveaway setup updated successfully.', flags: 64 });
  } catch (err) {
    console.error('❌ Modal submission failed:', err);
    if (!interaction.replied)
      await interaction.reply({ content: '❌ Failed to update giveaway.', flags: 64 }).catch(() => {});
  }
});

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











