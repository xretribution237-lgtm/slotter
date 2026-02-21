const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS slots (
    channel_id    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    guild_id      TEXT NOT NULL,
    type          TEXT NOT NULL,
    emoji         TEXT NOT NULL,
    expires_at    INTEGER,
    here_used     INTEGER DEFAULT 0,
    everyone_used INTEGER DEFAULT 0,
    inf_mentions  INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS slot_talk (
    channel_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS used_free_slots (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS verify_messages (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS weekend_slots (
    channel_id TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    here_used  INTEGER DEFAULT 0,
    everyone_used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS weekend_state (
    guild_id   TEXT PRIMARY KEY,
    active     INTEGER DEFAULT 0
  );
`);

// ─── DB Helpers ───────────────────────────────────────────────────────────────

const dbSaveSlot = (channelId, userId, guildId, type, emoji, expiresAt, infMentions = 0) =>
  db.prepare(`INSERT OR REPLACE INTO slots
    (channel_id, user_id, guild_id, type, emoji, expires_at, here_used, everyone_used, inf_mentions)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`)
    .run(channelId, userId, guildId, type, emoji, expiresAt ?? null, infMentions ? 1 : 0);

const dbDeleteSlot = (channelId) => {
  db.prepare('DELETE FROM slot_talk WHERE channel_id = ?').run(channelId);
  db.prepare('DELETE FROM slots WHERE channel_id = ?').run(channelId);
};

const dbGetSlot = (channelId) => {
  const row = db.prepare('SELECT * FROM slots WHERE channel_id = ?').get(channelId);
  if (!row) return null;
  const talk = db.prepare('SELECT user_id FROM slot_talk WHERE channel_id = ?').all(channelId);
  return {
    userId: row.user_id, guildId: row.guild_id, type: row.type,
    emoji: row.emoji, expiresAt: row.expires_at,
    hereUsed: !!row.here_used, everyoneUsed: !!row.everyone_used,
    infMentions: !!row.inf_mentions,
    talkAllowed: new Set(talk.map((r) => r.user_id)),
  };
};

const dbAllSlots = () => db.prepare('SELECT channel_id FROM slots').all().map((r) => r.channel_id);
const dbMarkHereUsed = (id) => db.prepare('UPDATE slots SET here_used = 1 WHERE channel_id = ?').run(id);
const dbMarkEveryoneUsed = (id) => db.prepare('UPDATE slots SET everyone_used = 1 WHERE channel_id = ?').run(id);
const dbAddTalkUser = (channelId, userId) =>
  db.prepare('INSERT OR IGNORE INTO slot_talk (channel_id, user_id) VALUES (?, ?)').run(channelId, userId);

const dbHasUsedFreeSlot = (guildId, userId) =>
  !!db.prepare('SELECT 1 FROM used_free_slots WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
const dbMarkFreeSlotUsed = (guildId, userId) =>
  db.prepare('INSERT OR IGNORE INTO used_free_slots (guild_id, user_id) VALUES (?, ?)').run(guildId, userId);

const dbSaveVerifyMessage = (guildId, channelId, messageId) =>
  db.prepare('INSERT OR REPLACE INTO verify_messages (guild_id, channel_id, message_id) VALUES (?, ?, ?)')
    .run(guildId, channelId, messageId);
const dbGetVerifyMessage = (guildId) =>
  db.prepare('SELECT * FROM verify_messages WHERE guild_id = ?').get(guildId);

// Weekend DB
const dbSaveWeekendSlot = (channelId, userId, guildId) =>
  db.prepare('INSERT OR REPLACE INTO weekend_slots (channel_id, user_id, guild_id, here_used, everyone_used) VALUES (?, ?, ?, 0, 0)')
    .run(channelId, userId, guildId);
const dbGetWeekendSlot = (channelId) =>
  db.prepare('SELECT * FROM weekend_slots WHERE channel_id = ?').get(channelId);
const dbDeleteWeekendSlot = (channelId) =>
  db.prepare('DELETE FROM weekend_slots WHERE channel_id = ?').run(channelId);
const dbAllWeekendSlots = (guildId) =>
  db.prepare('SELECT channel_id FROM weekend_slots WHERE guild_id = ?').all(guildId).map((r) => r.channel_id);
const dbMarkWeekendHere = (id) => db.prepare('UPDATE weekend_slots SET here_used = 1 WHERE channel_id = ?').run(id);
const dbMarkWeekendEveryone = (id) => db.prepare('UPDATE weekend_slots SET everyone_used = 1 WHERE channel_id = ?').run(id);
const dbGetWeekendState = (guildId) =>
  db.prepare('SELECT active FROM weekend_state WHERE guild_id = ?').get(guildId)?.active ?? 0;
const dbSetWeekendState = (guildId, active) =>
  db.prepare('INSERT OR REPLACE INTO weekend_state (guild_id, active) VALUES (?, ?)').run(guildId, active ? 1 : 0);

// Check if user already has any kind of slot open
const dbUserHasSlot = (guildId, userId) =>
  !!db.prepare('SELECT 1 FROM slots WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
const dbUserHasWeekendSlot = (guildId, userId) =>
  !!db.prepare('SELECT 1 FROM weekend_slots WHERE guild_id = ? AND user_id = ?').get(guildId, userId);

// ─── Config ───────────────────────────────────────────────────────────────────

const NEWBIE_ROLE_ID      = '1474836752756768880';
const MEMBER_ROLE_ID      = '1474837032001081486';
const VERIFY_CHANNEL_ID   = '1474836719143616545';
const VERIFY_BUTTON_ID    = 'verify_button';

const SLOT_CATEGORY_NAME    = '🎰 SLOTS';
const WEEKEND_CATEGORY_NAME = '🎉 WEEKEND SLOTS';

const OWNER_EMOJI = '𓆩👑𓆪';
const ADMIN_EMOJI = '🛠️';

const SLOT_TYPES = {
  free:    { emoji: '🎲', duration: 7 * 24 * 60 * 60 * 1000 },
  week:    { emoji: '🎰', duration: null },
  month:   { emoji: '💎', duration: null },
  perm:    { emoji: '⚜️', duration: null },
  owner:   { emoji: OWNER_EMOJI, duration: null },
  admin:   { emoji: ADMIN_EMOJI, duration: null },
};

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isAdminOrOwner = (member, guild) =>
  member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);

const isAdmin = (member) => member.permissions.has(PermissionFlagsBits.Administrator);

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  const ms = expiresAt - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function channelName(emoji, username, expiresAt, isWeekend = false) {
  const safe = username.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (isWeekend) return `🎉-${safe}s-weekend-slot`;
  if (!expiresAt) return `${emoji}-${safe}s-slot`;
  return `${emoji}-${safe}s-slot-${daysRemaining(expiresAt)}d`;
}

async function getOrCreateCategory(guild, name) {
  let cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  );
  if (!cat) cat = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  return cat;
}

async function createSlotChannel(guild, user, emoji, expiresAt, categoryName = SLOT_CATEGORY_NAME, isWeekend = false) {
  const category = await getOrCreateCategory(guild, categoryName);
  return guild.channels.create({
    name: channelName(emoji, user.username, expiresAt, isWeekend),
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
  });
}

// ─── Auto-create Owner & Admin slots on boot ──────────────────────────────────

async function ensureStaffSlots(guild) {
  // Owner slot
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner && !dbUserHasSlot(guild.id, owner.id)) {
    const ch = await createSlotChannel(guild, owner.user, OWNER_EMOJI, null);
    dbSaveSlot(ch.id, owner.id, guild.id, 'owner', OWNER_EMOJI, null, true);
    await ch.send(
      `${OWNER_EMOJI} Welcome to your permanent owner slot, ${owner}!\n\n` +
      `♾️ Infinite \`@here\` and \`@everyone\` — no limits.\n` +
      `👥 Use \`?talk @user1 @user2 ...\` to invite people.`
    );
  }

  // Admin slots — all members with Administrator permission
  const members = await guild.members.fetch();
  for (const [, member] of members) {
    if (member.user.bot) continue;
    if (member.id === guild.ownerId) continue;
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) continue;
    if (dbUserHasSlot(guild.id, member.id)) continue;

    const ch = await createSlotChannel(guild, member.user, ADMIN_EMOJI, null);
    dbSaveSlot(ch.id, member.id, guild.id, 'admin', ADMIN_EMOJI, null, true);
    await ch.send(
      `🛠️ Welcome to your permanent admin slot, ${member}!\n\n` +
      `♾️ Infinite \`@here\` and \`@everyone\` — no limits.\n` +
      `👥 Use \`?talk @user1 @user2 ...\` to invite people.`
    );
  }
}

// ─── Verify Panel ─────────────────────────────────────────────────────────────

async function sendVerifyPanel(guild) {
  const channel = guild.channels.cache.get(VERIFY_CHANNEL_ID);
  if (!channel) return console.warn('⚠️  Verify channel not found:', VERIFY_CHANNEL_ID);

  const existing = dbGetVerifyMessage(guild.id);
  if (existing) {
    const old = await channel.messages.fetch(existing.message_id).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('👋  Welcome — Get Access')
    .setDescription(
      `Ready to join the community?\n\n` +
      `Click the **✅ Verify** button below to receive the <@&${MEMBER_ROLE_ID}> role and unlock the server.\n\n` +
      `> By verifying, you confirm you have read and agree to the server rules.`
    )
    .setFooter({ text: 'One click is all it takes.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(VERIFY_BUTTON_ID)
      .setLabel('Verify')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  dbSaveVerifyMessage(guild.id, channel.id, msg.id);
  console.log(`✅ Verify panel sent in #${channel.name}`);
}

// ─── Weekend Logic ────────────────────────────────────────────────────────────

async function openWeekend(guild) {
  if (dbGetWeekendState(guild.id)) return; // already active
  dbSetWeekendState(guild.id, true);

  // Give a weekend slot to every member who doesn't already have a slot
  const members = await guild.members.fetch();
  for (const [, member] of members) {
    if (member.user.bot) continue;
    if (dbUserHasSlot(guild.id, member.id)) continue;
    if (dbUserHasWeekendSlot(guild.id, member.id)) continue;

    try {
      const ch = await createSlotChannel(guild, member.user, '🎉', null, WEEKEND_CATEGORY_NAME, true);
      dbSaveWeekendSlot(ch.id, member.id, guild.id);
      await ch.send(
        `🎉 Hey ${member}, enjoy your **Weekend Slot**!\n\n` +
        `⏳ This slot is available through **Sunday 11:59 PM EST**.\n` +
        `📢 You have **1x \`@here\`** and **1x \`@everyone\`** to use.\n` +
        `👥 Use \`?talk @user1 @user2 ...\` to invite people to chat here.`
      );
    } catch (err) {
      console.error(`Failed to create weekend slot for ${member.user.tag}:`, err);
    }
  }
  console.log(`🎉 Weekend slots opened for ${guild.name}`);
}

async function closeWeekend(guild) {
  if (!dbGetWeekendState(guild.id)) return;
  const channelIds = dbAllWeekendSlots(guild.id);
  for (const channelId of channelIds) {
    const ch = guild.channels.cache.get(channelId);
    if (ch) await ch.delete().catch(() => {});
    dbDeleteWeekendSlot(channelId);
  }

  // Delete the weekend category if empty
  const cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === WEEKEND_CATEGORY_NAME
  );
  if (cat) await cat.delete().catch(() => {});
  dbSetWeekendState(guild.id, false);
  console.log(`🛑 Weekend slots closed for ${guild.name}`);
}

// Also give a weekend slot to new members who join during the weekend
client.on(Events.GuildMemberAdd, async (member) => {
  const { guild } = member;

  // Auto Newbie role
  try {
    const role = guild.roles.cache.get(NEWBIE_ROLE_ID);
    if (role) await member.roles.add(role);
  } catch (err) {
    console.error('Failed to assign Newbie role:', err);
  }

  // Weekend slot for new joiners if weekend is active
  if (dbGetWeekendState(guild.id) && !dbUserHasSlot(guild.id, member.id)) {
    try {
      const ch = await createSlotChannel(guild, member.user, '🎉', null, WEEKEND_CATEGORY_NAME, true);
      dbSaveWeekendSlot(ch.id, member.id, guild.id);
      await ch.send(
        `🎉 Hey ${member}, enjoy your **Weekend Slot**!\n\n` +
        `⏳ Available through **Sunday 11:59 PM EST**.\n` +
        `📢 You have **1x \`@here\`** and **1x \`@everyone\`** to use.\n` +
        `👥 Use \`?talk @user1 @user2 ...\` to invite people to chat here.`
      );
    } catch {}
  }
});

// ─── Scheduler (EST = UTC-5) ──────────────────────────────────────────────────

function scheduleWeekend() {
  setInterval(async () => {
    // Current time in EST
    const now = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const day  = now.getUTCDay();   // 0=Sun, 6=Sat
    const hour = now.getUTCHours();
    const min  = now.getUTCMinutes();

    const isSaturdayMidnight = day === 6 && hour === 0 && min === 0;
    const isSundayEnd        = day === 0 && hour === 23 && min === 59;

    for (const [, guild] of client.guilds.cache) {
      if (isSaturdayMidnight) await openWeekend(guild).catch(console.error);
      if (isSundayEnd)        await closeWeekend(guild).catch(console.error);
    }
  }, 60 * 1000); // check every minute
}

// ─── Expiry Loop ──────────────────────────────────────────────────────────────

async function checkExpiredSlots() {
  for (const channelId of dbAllSlots()) {
    const data = dbGetSlot(channelId);
    if (!data || !data.expiresAt) continue;

    if (Date.now() < data.expiresAt) {
      try {
        const guild = client.guilds.cache.get(data.guildId);
        if (!guild) continue;
        const channel = guild.channels.cache.get(channelId);
        if (!channel) continue;
        const m = await guild.members.fetch(data.userId).catch(() => null);
        if (!m) continue;
        const newName = channelName(data.emoji, m.user.username, data.expiresAt);
        if (channel.name !== newName) await channel.setName(newName).catch(() => {});
      } catch {}
      continue;
    }

    try {
      const guild = client.guilds.cache.get(data.guildId);
      if (guild) {
        const ch = guild.channels.cache.get(channelId);
        if (ch) await ch.delete().catch(() => {});
      }
    } catch {}
    dbDeleteSlot(channelId);
  }
}

// ─── Verify Button ────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== VERIFY_BUTTON_ID) return;
  const { member, guild } = interaction;
  try {
    if (member.roles.cache.has(MEMBER_ROLE_ID))
      return interaction.reply({ content: '✅ You\'re already verified!', ephemeral: true });

    const memberRole = guild.roles.cache.get(MEMBER_ROLE_ID);
    const newbieRole = guild.roles.cache.get(NEWBIE_ROLE_ID);
    if (memberRole) await member.roles.add(memberRole);
    if (newbieRole) await member.roles.remove(newbieRole).catch(() => {});

    await interaction.reply({
      content: `✅ You've been verified! Welcome — you now have the <@&${MEMBER_ROLE_ID}> role.`,
      ephemeral: true,
    });
  } catch (err) {
    console.error('Verify error:', err);
    await interaction.reply({ content: '❌ Something went wrong. Contact an admin.', ephemeral: true });
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const { content, member, guild, channel } = message;
  const args = content.trim().split(/\s+/);
  const cmd  = args[0]?.toLowerCase();

  // ── ?sendverify ────────────────────────────────────────────────────────────
  if (cmd === '?sendverify') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can do that.');
    await sendVerifyPanel(guild);
    return message.reply('✅ Verify panel sent!');
  }

  // ── ?removeslot @user ──────────────────────────────────────────────────────
  if (cmd === '?removeslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can remove slots.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Please mention a user.');

    // Find their slot
    const slotRow = db.prepare('SELECT channel_id FROM slots WHERE guild_id = ? AND user_id = ?').get(guild.id, target.id);
    if (!slotRow) return message.reply(`❌ **${target.user.username}** doesn't have an active slot.`);

    const ch = guild.channels.cache.get(slotRow.channel_id);
    if (ch) await ch.delete().catch(() => {});
    dbDeleteSlot(slotRow.channel_id);

    return message.reply(`✅ Slot removed for **${target.user.username}**.`);
  }

  // ── ?freeslot @user ────────────────────────────────────────────────────────
  if (cmd === '?freeslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can open slots.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Please mention a user.');
    if (dbHasUsedFreeSlot(guild.id, target.id))
      return message.reply(`❌ **${target.user.username}** has already used their free slot.`);

    const expiresAt = Date.now() + SLOT_TYPES.free.duration;
    dbMarkFreeSlotUsed(guild.id, target.id);
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.free.emoji, expiresAt);
    dbSaveSlot(ch.id, target.id, guild.id, 'free', SLOT_TYPES.free.emoji, expiresAt);

    await ch.send(
      `🎲 Welcome to your slot, ${target}!\n\n` +
      `⏳ This slot lasts **7 days**.\n` +
      `📢 You have **1x \`@here\`** and **1x \`@everyone\`** to use.\n` +
      `👥 Use \`?talk @user1 @user2 ...\` to invite people to chat here.`
    );
    return message.reply(`✅ Free slot opened for ${target} in ${ch}!`);
  }

  // ── ?weekslot <weeks> @user ────────────────────────────────────────────────
  if (cmd === '?weekslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can open slots.');
    const weeks = parseInt(args[1]);
    const target = message.mentions.members.first();
    if (!target || isNaN(weeks) || weeks < 1) return message.reply('❌ Usage: `?weekslot <weeks> @user`');

    const expiresAt = Date.now() + weeks * 7 * 24 * 60 * 60 * 1000;
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.week.emoji, expiresAt);
    dbSaveSlot(ch.id, target.id, guild.id, 'week', SLOT_TYPES.week.emoji, expiresAt);

    await ch.send(
      `🎰 Welcome to your slot, ${target}!\n\n` +
      `⏳ This slot lasts **${weeks} week${weeks > 1 ? 's' : ''}**.\n` +
      `📢 You have **1x \`@here\`** and **1x \`@everyone\`** to use.\n` +
      `👥 Use \`?talk @user1 @user2 ...\` to invite people to chat here.`
    );
    return message.reply(`✅ Weekly slot (${weeks}w) opened for ${target} in ${ch}!`);
  }

  // ── ?monthslot <months> @user ──────────────────────────────────────────────
  if (cmd === '?monthslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can open slots.');
    const months = parseInt(args[1]);
    const target = message.mentions.members.first();
    if (!target || isNaN(months) || months < 1) return message.reply('❌ Usage: `?monthslot <months> @user`');

    const expiresAt = Date.now() + months * 30 * 24 * 60 * 60 * 1000;
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.month.emoji, expiresAt);
    dbSaveSlot(ch.id, target.id, guild.id, 'month', SLOT_TYPES.month.emoji, expiresAt);

    await ch.send(
      `💎 Welcome to your slot, ${target}!\n\n` +
      `⏳ This slot lasts **${months} month${months > 1 ? 's' : ''}**.\n` +
      `📢 You have **1x \`@here\`** and **1x \`@everyone\`** to use.\n` +
      `👥 Use \`?talk @user1 @user2 ...\` to invite people to chat here.`
    );
    return message.reply(`✅ Monthly slot (${months}mo) opened for ${target} in ${ch}!`);
  }

  // ── ?permslot @user ────────────────────────────────────────────────────────
  if (cmd === '?permslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can open slots.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Please mention a user.');

    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.perm.emoji, null);
    dbSaveSlot(ch.id, target.id, guild.id, 'perm', SLOT_TYPES.perm.emoji, null);

    await ch.send(
      `⚜️ Welcome to your permanent slot, ${target}!\n\n` +
      `♾️ This slot never expires.\n` +
      `📢 You have **1x \`@here\`** and **1x \`@everyone\`** to use.\n` +
      `👥 Use \`?talk @user1 @user2 ...\` to invite people to chat here.`
    );
    return message.reply(`✅ Permanent slot opened for ${target} in ${ch}!`);
  }

  // ── ?weekend (manually open weekend) ──────────────────────────────────────
  if (cmd === '?weekend') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can trigger the weekend.');
    if (dbGetWeekendState(guild.id)) return message.reply('⚠️ Weekend slots are already open!');
    await openWeekend(guild);
    return message.reply('🎉 Weekend slots are now open for everyone!');
  }

  // ── ?stopw (force close weekend) ──────────────────────────────────────────
  if (cmd === '?stopw') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can stop the weekend.');
    if (!dbGetWeekendState(guild.id)) return message.reply('⚠️ No weekend is currently active.');
    await closeWeekend(guild);
    return message.reply('🛑 Weekend slots have been closed.');
  }

  // ── ?talk @user1 @user2 ... ────────────────────────────────────────────────
  if (cmd === '?talk') {
    // Works in both regular slots and weekend slots
    const slotData    = dbGetSlot(channel.id);
    const weekendData = dbGetWeekendSlot(channel.id);
    const ownerUserId = slotData?.userId ?? weekendData?.user_id ?? null;

    if (!ownerUserId) return;
    if (message.author.id !== ownerUserId)
      return message.reply('❌ Only the slot owner can use `?talk`.');

    const targets = message.mentions.members;
    if (!targets || targets.size === 0) return message.reply('❌ Mention at least one user to invite.');

    const added = [];
    for (const [, t] of targets) {
      if (t.id === ownerUserId) continue;
      await channel.permissionOverwrites.edit(t.id, {
        [PermissionFlagsBits.SendMessages]: true,
        [PermissionFlagsBits.ViewChannel]: true,
        [PermissionFlagsBits.ReadMessageHistory]: true,
      }).catch(() => {});
      if (slotData) dbAddTalkUser(channel.id, t.id);
      added.push(t.toString());
    }
    if (added.length) return message.reply(`✅ Invited ${added.join(', ')} to chat in this slot.`);
    return;
  }

  // ── @here / @everyone abuse detection ─────────────────────────────────────

  // Regular slots
  const slotData = dbGetSlot(channel.id);
  if (slotData && message.author.id === slotData.userId) {
    if (slotData.infMentions) return; // owner/admin — unlimited, do nothing

    const usedHere     = content.includes('@here');
    const usedEveryone = content.includes('@everyone');
    let abused = false;

    if (usedHere) {
      if (slotData.hereUsed) abused = true;
      else dbMarkHereUsed(channel.id);
    }
    if (usedEveryone) {
      if (slotData.everyoneUsed) abused = true;
      else dbMarkEveryoneUsed(channel.id);
    }

    if (abused) {
      await message.delete().catch(() => {});
      message.author.send(
        `⚠️ **Warning** — You've exceeded your @here/@everyone limit in your slot on **${guild.name}**.\n` +
        `Each slot allows exactly **1x \`@here\`** and **1x \`@everyone\`**.`
      ).catch(() => {});
    }
    return;
  }

  // Weekend slots
  const weekendData = dbGetWeekendSlot(channel.id);
  if (weekendData && message.author.id === weekendData.user_id) {
    const usedHere     = content.includes('@here');
    const usedEveryone = content.includes('@everyone');
    let abused = false;

    if (usedHere) {
      if (weekendData.here_used) abused = true;
      else dbMarkWeekendHere(channel.id);
    }
    if (usedEveryone) {
      if (weekendData.everyone_used) abused = true;
      else dbMarkWeekendEveryone(channel.id);
    }

    if (abused) {
      await message.delete().catch(() => {});
      message.author.send(
        `⚠️ **Warning** — You've exceeded your @here/@everyone limit in your weekend slot on **${guild.name}**.\n` +
        `Weekend slots allow exactly **1x \`@here\`** and **1x \`@everyone\`**.`
      ).catch(() => {});
    }
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  for (const [, guild] of client.guilds.cache) {
    // Verify panel
    if (!dbGetVerifyMessage(guild.id)) {
      await sendVerifyPanel(guild).catch(console.error);
    }
    // Owner & admin auto-slots
    await ensureStaffSlots(guild).catch(console.error);
  }

  setInterval(checkExpiredSlots, 10 * 60 * 1000);
  scheduleWeekend();
});

client.login(process.env.DISCORD_TOKEN);
