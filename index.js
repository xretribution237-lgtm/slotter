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

  CREATE TABLE IF NOT EXISTS slot_rules_messages (
    guild_id   TEXT PRIMARY KEY,
    message_id TEXT NOT NULL
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

const dbSaveSlotRulesMessage = (guildId, messageId) =>
  db.prepare("INSERT OR REPLACE INTO slot_rules_messages (guild_id, message_id) VALUES (?, ?)").run(guildId, messageId);
const dbGetSlotRulesMessage = (guildId) =>
  db.prepare("SELECT message_id FROM slot_rules_messages WHERE guild_id = ?").get(guildId);

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
const SLOT_RULES_CHANNEL_ID = '1474848695412457623';

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
// ─── Slot Rules Panel ─────────────────────────────────────────────────────────

async function sendSlotRules(guild) {
  const channel = guild.channels.cache.get(SLOT_RULES_CHANNEL_ID);
  if (!channel) return console.warn('Slot rules channel not found:', SLOT_RULES_CHANNEL_ID);

  const existing = dbGetSlotRulesMessage(guild.id);
  if (existing) {
    const old = await channel.messages.fetch(existing.message_id).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }

  const NL = '\n';

  const embed = new EmbedBuilder()
    .setColor(0xf5c518)
    .setTitle('📋  Drop Vault — Slot Rules')
    .setDescription(
      'Welcome to **Drop Vault**. Slots are your personal space to advertise and sell products to the community.' + NL + NL +
      'Read the following rules carefully. Failure to comply will result in your slot being removed **without warning or refund**.'
    )
    .addFields(
      {
        name: '✅  Eligibility Requirements',
        value: '> **15 vouches minimum** — At least 15 verified positive vouches required before opening a slot.' + NL +
               '> **Zero bad reviews** — Any 1–3 star reviews or documented complaints disqualify you immediately.' + NL +
               '> **Proof of transactions** — You must provide verifiable transaction history (see Payment Proof below).',
      },
      {
        name: '💳  Accepted Payment Proof',
        value: '> **Crypto** — On-chain transaction IDs/hashes (BTC, ETH, LTC, USDT, etc.)' + NL +
               '> **PayPal** — Screenshots of completed transactions with timestamps' + NL +
               '> **CashApp** — Screenshots of completed payments with timestamps' + NL +
               '> All proof must be **unedited** and include the **date, amount, and both parties**.',
      },
      {
        name: '📦  Slot Conduct',
        value: '> You may only advertise and sell **your own products or services**.' + NL +
               '> **No scamming, misleading listings, or false advertising** of any kind.' + NL +
               '> All transactions are **between buyer and seller** — Drop Vault is not liable for disputes.' + NL +
               '> You are allotted **1x @here** and **1x @everyone** per slot — do not abuse them.' + NL +
               '> Owner and admin slots are exempt from ping limits.',
      },
      {
        name: '🔔  Mention Rules',
        value: '> **Free / Paid slots** — 1x `@here` and 1x `@everyone` for the lifetime of the slot.' + NL +
               '> Abusing mentions results in your message being **silently deleted** and a **DM warning**.' + NL +
               '> Repeated abuse will result in **immediate slot removal**.',
      },
      {
        name: '⚠️  Enforcement',
        value: '> Admins reserve the right to remove any slot at any time for rule violations.' + NL +
               '> Slot removals due to rule violations are **non-refundable**.' + NL +
               '> Scammers will be **permanently banned** from Drop Vault.' + NL +
               '> To dispute a removal, open a ticket or contact a staff member directly.',
      },
      {
        name: '🎉  Weekend Slots',
        value: '> Every **Saturday 12:00 AM – Sunday 11:59 PM EST**, all members get a free temporary slot.' + NL +
               '> Weekend slots follow the same rules — 1x `@here` and 1x `@everyone`.' + NL +
               '> Members who already have an active slot do not receive a weekend slot.',
      }
    )
    .setFooter({ text: 'Drop Vault • Slot Rules  |  Last updated by staff' })
    .setTimestamp();

  const msg = await channel.send({ embeds: [embed] });
  await msg.pin().catch(() => {});
  dbSaveSlotRulesMessage(guild.id, msg.id);
  console.log('Slot rules posted in #' + channel.name);
}

// ─── Weekend Logic ────────────────────────────────────────────────────────────

