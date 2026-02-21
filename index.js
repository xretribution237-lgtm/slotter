const {
  Client, GatewayIntentBits, PermissionFlagsBits, ChannelType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events,
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS slots (
    channel_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, guild_id TEXT NOT NULL,
    type TEXT NOT NULL, emoji TEXT NOT NULL, expires_at INTEGER,
    here_used INTEGER DEFAULT 0, everyone_used INTEGER DEFAULT 0,
    inf_mentions INTEGER DEFAULT 0, muted INTEGER DEFAULT 0, locked INTEGER DEFAULT 0,
    talk_limit INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS slot_talk (
    channel_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (channel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS used_free_slots (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS verify_messages (
    guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS slot_rules_messages (
    guild_id TEXT PRIMARY KEY, message_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS weekend_slots (
    channel_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, guild_id TEXT NOT NULL,
    here_used INTEGER DEFAULT 0, everyone_used INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS weekend_state (
    guild_id TEXT PRIMARY KEY, active INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS slot_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL,
    emoji TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER,
    close_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS slot_config (
    guild_id TEXT PRIMARY KEY,
    slot_limit INTEGER DEFAULT 0,
    default_duration INTEGER DEFAULT 604800000,
    cooldown_ms INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS slot_cooldowns (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, available_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS slot_backups (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, backup_data TEXT NOT NULL,
    backed_up_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id)
  );
`);

// ─── DB Helpers ───────────────────────────────────────────────────────────────

const dbSaveSlot = (cid, uid, gid, type, emoji, exp, inf = 0) => {
  db.prepare(`INSERT OR REPLACE INTO slots
    (channel_id,user_id,guild_id,type,emoji,expires_at,here_used,everyone_used,inf_mentions,muted,locked,talk_limit)
    VALUES(?,?,?,?,?,?,0,0,?,0,0,0)`).run(cid, uid, gid, type, emoji, exp ?? null, inf ? 1 : 0);
  db.prepare(`INSERT OR IGNORE INTO slot_history (guild_id,user_id,type,emoji,opened_at) VALUES(?,?,?,?,?)`)
    .run(gid, uid, type, emoji, Date.now());
};

const dbDeleteSlot = (cid, reason = 'removed') => {
  const row = db.prepare('SELECT * FROM slots WHERE channel_id=?').get(cid);
  if (row) {
    db.prepare('UPDATE slot_history SET closed_at=?, close_reason=? WHERE guild_id=? AND user_id=? AND closed_at IS NULL')
      .run(Date.now(), reason, row.guild_id, row.user_id);
  }
  db.prepare('DELETE FROM slot_talk WHERE channel_id=?').run(cid);
  db.prepare('DELETE FROM slots WHERE channel_id=?').run(cid);
};

const dbGetSlot = (cid) => {
  const r = db.prepare('SELECT * FROM slots WHERE channel_id=?').get(cid);
  if (!r) return null;
  const talk = db.prepare('SELECT user_id FROM slot_talk WHERE channel_id=?').all(cid);
  return { userId: r.user_id, guildId: r.guild_id, type: r.type, emoji: r.emoji,
    expiresAt: r.expires_at, hereUsed: !!r.here_used, everyoneUsed: !!r.everyone_used,
    infMentions: !!r.inf_mentions, muted: !!r.muted, locked: !!r.locked,
    talkLimit: r.talk_limit, talkAllowed: new Set(talk.map(x => x.user_id)) };
};

const dbGetSlotByUser    = (gid, uid) => db.prepare('SELECT * FROM slots WHERE guild_id=? AND user_id=?').get(gid, uid);
const dbAllSlots         = ()         => db.prepare('SELECT channel_id FROM slots').all().map(r => r.channel_id);
const dbAllGuildSlots    = (gid)      => db.prepare('SELECT * FROM slots WHERE guild_id=?').all(gid);
const dbMarkHereUsed     = (cid)      => db.prepare('UPDATE slots SET here_used=1 WHERE channel_id=?').run(cid);
const dbMarkEveryoneUsed = (cid)      => db.prepare('UPDATE slots SET everyone_used=1 WHERE channel_id=?').run(cid);
const dbAddTalkUser      = (c, u)     => db.prepare('INSERT OR IGNORE INTO slot_talk(channel_id,user_id) VALUES(?,?)').run(c, u);
const dbRemoveTalkUser   = (c, u)     => db.prepare('DELETE FROM slot_talk WHERE channel_id=? AND user_id=?').run(c, u);
const dbClearTalkUsers   = (c)        => db.prepare('DELETE FROM slot_talk WHERE channel_id=?').run(c);
const dbGetTalkUsers     = (c)        => db.prepare('SELECT user_id FROM slot_talk WHERE channel_id=?').all(c).map(r => r.user_id);
const dbTalkCount        = (c)        => db.prepare('SELECT COUNT(*) as cnt FROM slot_talk WHERE channel_id=?').get(c).cnt;
const dbHasUsedFree      = (g, u)     => !!db.prepare('SELECT 1 FROM used_free_slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbMarkFreeUsed     = (g, u)     => db.prepare('INSERT OR IGNORE INTO used_free_slots(guild_id,user_id) VALUES(?,?)').run(g, u);
const dbUserHasSlot      = (g, u)     => !!db.prepare('SELECT 1 FROM slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbUserHasWeekend   = (g, u)     => !!db.prepare('SELECT 1 FROM weekend_slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbSetMuted         = (cid, v)   => db.prepare('UPDATE slots SET muted=? WHERE channel_id=?').run(v ? 1 : 0, cid);
const dbSetLocked        = (cid, v)   => db.prepare('UPDATE slots SET locked=? WHERE channel_id=?').run(v ? 1 : 0, cid);
const dbSetTalkLimit     = (cid, n)   => db.prepare('UPDATE slots SET talk_limit=? WHERE channel_id=?').run(n, cid);

const dbSaveVerify       = (g, c, m)  => db.prepare('INSERT OR REPLACE INTO verify_messages(guild_id,channel_id,message_id) VALUES(?,?,?)').run(g, c, m);
const dbGetVerify        = (g)        => db.prepare('SELECT * FROM verify_messages WHERE guild_id=?').get(g);
const dbSaveRules        = (g, m)     => db.prepare('INSERT OR REPLACE INTO slot_rules_messages(guild_id,message_id) VALUES(?,?)').run(g, m);
const dbGetRules         = (g)        => db.prepare('SELECT * FROM slot_rules_messages WHERE guild_id=?').get(g);

const dbSaveWeekend      = (c, u, g)  => db.prepare('INSERT OR REPLACE INTO weekend_slots(channel_id,user_id,guild_id,here_used,everyone_used) VALUES(?,?,?,0,0)').run(c, u, g);
const dbGetWeekend       = (cid)      => db.prepare('SELECT * FROM weekend_slots WHERE channel_id=?').get(cid);
const dbDeleteWeekend    = (cid)      => db.prepare('DELETE FROM weekend_slots WHERE channel_id=?').run(cid);
const dbAllWeekends      = (g)        => db.prepare('SELECT channel_id FROM weekend_slots WHERE guild_id=?').all(g).map(r => r.channel_id);
const dbMarkWHere        = (cid)      => db.prepare('UPDATE weekend_slots SET here_used=1 WHERE channel_id=?').run(cid);
const dbMarkWEveryone    = (cid)      => db.prepare('UPDATE weekend_slots SET everyone_used=1 WHERE channel_id=?').run(cid);
const dbGetWeekendState  = (g)        => db.prepare('SELECT active FROM weekend_state WHERE guild_id=?').get(g)?.active ?? 0;
const dbSetWeekendState  = (g, a)     => db.prepare('INSERT OR REPLACE INTO weekend_state(guild_id,active) VALUES(?,?)').run(g, a ? 1 : 0);

const dbGetConfig        = (g)        => db.prepare('SELECT * FROM slot_config WHERE guild_id=?').get(g) ?? { slot_limit: 0, default_duration: 604800000, cooldown_ms: 0 };
const dbSetConfig        = (g, k, v)  => { db.prepare('INSERT OR IGNORE INTO slot_config(guild_id) VALUES(?)').run(g); db.prepare(`UPDATE slot_config SET ${k}=? WHERE guild_id=?`).run(v, g); };
const dbGetCooldown      = (g, u)     => db.prepare('SELECT available_at FROM slot_cooldowns WHERE guild_id=? AND user_id=?').get(g, u);
const dbSetCooldown      = (g, u, t)  => db.prepare('INSERT OR REPLACE INTO slot_cooldowns(guild_id,user_id,available_at) VALUES(?,?,?)').run(g, u, t);
const dbGetHistory       = (g, u)     => db.prepare('SELECT * FROM slot_history WHERE guild_id=? AND user_id=? ORDER BY opened_at DESC LIMIT 10').all(g, u);
const dbSaveBackup       = (g, u, d)  => db.prepare('INSERT OR REPLACE INTO slot_backups(guild_id,user_id,backup_data,backed_up_at) VALUES(?,?,?,?)').run(g, u, JSON.stringify(d), Date.now());
const dbGetBackup        = (g, u)     => { const r = db.prepare('SELECT * FROM slot_backups WHERE guild_id=? AND user_id=?').get(g, u); return r ? { ...r, backup_data: JSON.parse(r.backup_data) } : null; };

// ─── Config ───────────────────────────────────────────────────────────────────

const NEWBIE_ROLE_ID        = '1474836752756768880';
const MEMBER_ROLE_ID        = '1474837032001081486';
const VERIFY_CHANNEL_ID     = '1474836719143616545';
const SLOT_RULES_CHANNEL_ID = '1474848695412457623';
const VERIFY_BUTTON_ID      = 'verify_button';
const SLOT_CATEGORY_NAME    = '🎰 SLOTS';
const WEEKEND_CATEGORY_NAME = '🎉 WEEKEND SLOTS';
const OWNER_EMOJI           = '𓆩👑𓆪';
const ADMIN_EMOJI           = '🛠️';

const SLOT_TYPES = {
  free:  { emoji: '🎲', duration: 7 * 24 * 60 * 60 * 1000 },
  week:  { emoji: '🎰', duration: null },
  month: { emoji: '💎', duration: null },
  perm:  { emoji: '⚜️', duration: null },
  owner: { emoji: OWNER_EMOJI, duration: null },
  admin: { emoji: ADMIN_EMOJI, duration: null },
};

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
  ],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isAdminOrOwner = (member, guild) =>
  member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);

function daysRemaining(exp) {
  if (!exp) return null;
  const ms = exp - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function formatExpiry(exp) {
  if (!exp) return '♾️ Never';
  const d = daysRemaining(exp);
  if (d === 0) return '⚠️ Expiring today';
  return `📅 ${new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (${d}d left)`;
}

function channelName(emoji, username, exp, isWeekend = false) {
  const safe = username.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (isWeekend) return `🎉-${safe}s-weekend-slot`;
  if (!exp) return `${emoji}-${safe}s-slot`;
  return `${emoji}-${safe}s-slot-${daysRemaining(exp)}d`;
}

async function getOrCreateCategory(guild, name) {
  let cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
  if (!cat) cat = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  return cat;
}

async function createSlotChannel(guild, user, emoji, exp, catName = SLOT_CATEGORY_NAME, isWeekend = false) {
  const cat = await getOrCreateCategory(guild, catName);
  return guild.channels.create({
    name: channelName(emoji, user.username, exp, isWeekend),
    type: ChannelType.GuildText,
    parent: cat.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.MentionEveryone] },
      { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ],
  });
}

function slotTypeLabel(type) {
  const map = { free: '🎲 Free (7-day)', week: '🎰 Weekly', month: '💎 Monthly', perm: '⚜️ Permanent', owner: `${OWNER_EMOJI} Owner`, admin: '🛠️ Admin', weekend: '🎉 Weekend' };
  return map[type] ?? type;
}

// ─── Staff Auto-Slots ─────────────────────────────────────────────────────────

async function ensureStaffSlots(guild) {
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) {
    const row = dbGetSlotByUser(guild.id, owner.id);
    if (row && !guild.channels.cache.get(row.channel_id)) dbDeleteSlot(row.channel_id, 'stale');
    if (!dbUserHasSlot(guild.id, owner.id)) {
      const ch = await createSlotChannel(guild, owner.user, OWNER_EMOJI, null);
      dbSaveSlot(ch.id, owner.id, guild.id, 'owner', OWNER_EMOJI, null, true);
      await ch.send(`${OWNER_EMOJI} Welcome to your permanent owner slot, ${owner}!\n\n♾️ Infinite \`@here\` and \`@everyone\` — no limits.\n👥 Use \`?talk @user ...\` to invite people.\n🚫 Use \`?removetalk @user\` to remove them.`);
    }
  }

  const members = await guild.members.fetch();
  for (const [, m] of members) {
    if (m.user.bot || m.id === guild.ownerId) continue;
    if (!m.permissions.has(PermissionFlagsBits.Administrator)) continue;
    const row = dbGetSlotByUser(guild.id, m.id);
    if (row) {
      if (!guild.channels.cache.get(row.channel_id)) dbDeleteSlot(row.channel_id, 'stale');
      else continue;
    }
    if (dbUserHasSlot(guild.id, m.id)) continue;
    const ch = await createSlotChannel(guild, m.user, ADMIN_EMOJI, null);
    dbSaveSlot(ch.id, m.id, guild.id, 'admin', ADMIN_EMOJI, null, true);
    await ch.send(`🛠️ Welcome to your permanent admin slot, ${m}!\n\n♾️ Infinite \`@here\` and \`@everyone\` — no limits.\n👥 Use \`?talk @user ...\` to invite people.\n🚫 Use \`?removetalk @user\` to remove them.`);
  }
}

// ─── Verify Panel ─────────────────────────────────────────────────────────────

async function sendVerifyPanel(guild) {
  const channel = guild.channels.cache.get(VERIFY_CHANNEL_ID);
  if (!channel) return console.warn('Verify channel not found:', VERIFY_CHANNEL_ID);
  const existing = dbGetVerify(guild.id);
  if (existing) { const old = await channel.messages.fetch(existing.message_id).catch(() => null); if (old) await old.delete().catch(() => {}); }
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('👋  Welcome — Get Access')
    .setDescription(`Ready to join the community?\n\nClick the **✅ Verify** button below to receive the <@&${MEMBER_ROLE_ID}> role and unlock the server.\n\n> By verifying, you confirm you have read and agree to the server rules.`)
    .setFooter({ text: 'One click is all it takes.' }).setTimestamp();
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success));
  const msg = await channel.send({ embeds: [embed], components: [row] });
  dbSaveVerify(guild.id, channel.id, msg.id);
  console.log('Verify panel sent in #' + channel.name);
}

// ─── Slot Rules Panel ─────────────────────────────────────────────────────────

async function sendSlotRules(guild) {
  const channel = guild.channels.cache.get(SLOT_RULES_CHANNEL_ID);
  if (!channel) return console.warn('Slot rules channel not found:', SLOT_RULES_CHANNEL_ID);
  const existing = dbGetRules(guild.id);
  if (existing) { const old = await channel.messages.fetch(existing.message_id).catch(() => null); if (old) await old.delete().catch(() => {}); }
  const N = '\n';
  const embed = new EmbedBuilder().setColor(0xf5c518).setTitle('📋  Drop Vault — Slot Rules')
    .setDescription('Welcome to **Drop Vault**. Slots are your personal space to advertise and sell products to the community.' + N + N + 'Read the following rules carefully. Failure to comply will result in your slot being removed **without warning or refund**.')
    .addFields(
      { name: '✅  Eligibility Requirements', value: '> **15 vouches minimum** — At least 15 verified positive vouches required.' + N + '> **Zero bad reviews** — Any 1–3 star reviews or complaints disqualify you immediately.' + N + '> **Proof of transactions** — Verifiable transaction history required (see Payment Proof).' },
      { name: '💳  Accepted Payment Proof', value: '> **Crypto** — On-chain transaction IDs/hashes (BTC, ETH, LTC, USDT, etc.)' + N + '> **PayPal** — Screenshots of completed transactions with timestamps' + N + '> **CashApp** — Screenshots of completed payments with timestamps' + N + '> All proof must be **unedited** and show the **date, amount, and both parties**.' },
      { name: '📦  Slot Conduct', value: '> Only advertise and sell **your own products or services**.' + N + '> **No scamming, misleading listings, or false advertising** of any kind.' + N + '> Transactions are **between buyer and seller** — Drop Vault is not liable for disputes.' + N + '> You get **1x @here** and **1x @everyone** per slot — do not abuse them.' + N + '> Owner and admin slots are exempt from ping limits.' },
      { name: '🔔  Mention Rules', value: '> **Free / Paid slots** — 1x `@here` and 1x `@everyone` for the lifetime of the slot.' + N + '> Abusing mentions = message **silently deleted** + **DM warning**.' + N + '> Repeated abuse = **immediate slot removal**.' },
      { name: '⚠️  Enforcement', value: '> Admins may remove any slot at any time for rule violations.' + N + '> Slot removals due to violations are **non-refundable**.' + N + '> Scammers will be **permanently banned** from Drop Vault.' + N + '> To dispute a removal, open a ticket or contact staff directly.' },
      { name: '🎉  Weekend Slots', value: '> Every **Saturday 12:00 AM – Sunday 11:59 PM EST**, all members get a free temp slot.' + N + '> Weekend slots follow the same rules — 1x `@here` and 1x `@everyone`.' + N + '> Members with an active slot do not receive a weekend slot.' }
    )
    .setFooter({ text: 'Drop Vault • Slot Rules  |  Last updated by staff' }).setTimestamp();
  const msg = await channel.send({ embeds: [embed] });
  await msg.pin().catch(() => {});
  dbSaveRules(guild.id, msg.id);
  console.log('Slot rules posted in #' + channel.name);
}

// ─── Weekend Logic ────────────────────────────────────────────────────────────

async function openWeekend(guild) {
  if (dbGetWeekendState(guild.id)) return;
  dbSetWeekendState(guild.id, true);
  const members = await guild.members.fetch();
  for (const [, m] of members) {
    if (m.user.bot || dbUserHasSlot(guild.id, m.id) || dbUserHasWeekend(guild.id, m.id)) continue;
    try {
      const ch = await createSlotChannel(guild, m.user, '🎉', null, WEEKEND_CATEGORY_NAME, true);
      dbSaveWeekend(ch.id, m.id, guild.id);
      await ch.send(`🎉 Hey ${m}, enjoy your **Weekend Slot**!\n\n⏳ Available through **Sunday 11:59 PM EST**.\n📢 1x \`@here\` and 1x \`@everyone\`.\n👥 Use \`?talk @user ...\` to invite people.`);
    } catch (e) { console.error('Weekend slot error:', e); }
  }
  console.log('Weekend slots opened for', guild.name);
}

async function closeWeekend(guild) {
  if (!dbGetWeekendState(guild.id)) return;
  for (const cid of dbAllWeekends(guild.id)) {
    const ch = guild.channels.cache.get(cid); if (ch) await ch.delete().catch(() => {});
    dbDeleteWeekend(cid);
  }
  const cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === WEEKEND_CATEGORY_NAME);
  if (cat) await cat.delete().catch(() => {});
  dbSetWeekendState(guild.id, false);
  console.log('Weekend slots closed for', guild.name);
}

function scheduleWeekend() {
  setInterval(async () => {
    const now = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const day = now.getUTCDay(), hour = now.getUTCHours(), min = now.getUTCMinutes();
    for (const [, guild] of client.guilds.cache) {
      if (day === 6 && hour === 0 && min === 0) await openWeekend(guild).catch(console.error);
      if (day === 0 && hour === 23 && min === 59) await closeWeekend(guild).catch(console.error);
    }
  }, 60 * 1000);
}

async function checkExpiredSlots() {
  for (const cid of dbAllSlots()) {
    const data = dbGetSlot(cid);
    if (!data || !data.expiresAt) continue;
    if (Date.now() < data.expiresAt) {
      try {
        const guild = client.guilds.cache.get(data.guildId); if (!guild) continue;
        const channel = guild.channels.cache.get(cid); if (!channel) continue;
        const m = await guild.members.fetch(data.userId).catch(() => null); if (!m) continue;
        const newName = channelName(data.emoji, m.user.username, data.expiresAt);
        if (channel.name !== newName) await channel.setName(newName).catch(() => {});
      } catch {}
      continue;
    }
    try {
      const guild = client.guilds.cache.get(data.guildId);
      if (guild) { const ch = guild.channels.cache.get(cid); if (ch) await ch.delete().catch(() => {}); }
    } catch {}
    dbDeleteSlot(cid, 'expired');
  }
}

// ─── Help Embed ───────────────────────────────────────────────────────────────

function buildHelpEmbed(isAdmin) {
  const N = '\n';
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📖  Drop Vault — Bot Commands')
    .setDescription('All available commands for the Drop Vault slot system.')
    .addFields(
      { name: '📊  Info & Viewing', value:
        '`?slotinfo @user` — Slot type, expiry, owner, invited users' + N +
        '`?slots` — List all active slots (admin only)' + N +
        '`?listtalkers` — Show who has access to this slot' + N +
        '`?myslot` — Your own slot info' + N +
        '`?slotstats` — Server slot statistics (admin only)' + N +
        '`?slothistory @user` — Past slot history' + N +
        '`?slotleaderboard` — Most active slot holders' },
      { name: '👥  Talk / Invite Controls', value:
        '`?talk @user ...` — Invite users to your slot' + N +
        '`?removetalk @user ...` — Remove invited users' + N +
        '`?revoketalk @user ...` — Alias for removetalk' + N +
        '`?revokealltalk` — Remove ALL invited users from your slot' + N +
        '`?listtalkers` — Show current invited users' + N +
        '`?talklimit <number>` — Set max invited users (0 = unlimited)' },
      { name: '⏳  Managing Time (Admin)', value:
        '`?extendslot <days> @user` — Add days to a slot' + N +
        '`?reduceslot <days> @user` — Remove days from a slot' + N +
        '`?setslotexpiry <YYYY-MM-DD> @user` — Set exact expiry date' + N +
        '`?renewslot @user` — Renew slot with same original duration' },
      { name: '🔇  Restrictions (Admin)', value:
        '`?muteslot @user` — Remove slot owner send perms temporarily' + N +
        '`?unmuteslot @user` — Restore slot owner send perms' + N +
        '`?lockslot @user` — Lock slot so nobody can send (except admins)' + N +
        '`?unlockslot @user` — Unlock the slot' },
      { name: '❌  Removals (Admin)', value:
        '`?removeslot @user` — Remove a slot' + N +
        '`?revokeslot @user` — Alias for removeslot' + N +
        '`?terminateslot @user` — Instant delete, no grace' + N +
        '`?forcetransfer @old @new` — Admin override transfer' },
      { name: '🔁  Transfers', value:
        '`?transferslot @old @new` — Transfer slot ownership' + N +
        '`?swapslots @user1 @user2` — Swap two users slots' },
      { name: '💾  Backup & Restore (Admin)', value:
        '`?backupslot @user` — Save slot permission snapshot' + N +
        '`?restoreslot @user` — Restore from backup' },
      { name: '⚙️  Configuration (Admin)', value:
        '`?setslotlimit <number>` — Max total slots (0 = unlimited)' + N +
        '`?setdefaultduration <days>` — Default slot duration' + N +
        '`?slotcooldown <hours>` — Cooldown after slot removal' },
      { name: '🎪  Slot Creation (Admin)', value:
        '`?freeslot @user` — 🎲 7-day free slot (once per user)' + N +
        '`?weekslot <weeks> @user` — 🎰 Weekly slot' + N +
        '`?monthslot <months> @user` — 💎 Monthly slot' + N +
        '`?permslot @user` — ⚜️ Permanent slot' + N +
        '`?weekend` — Open weekend slots for everyone' + N +
        '`?stopw` — Force close weekend slots' },
      { name: '📋  Panels (Admin)', value:
        '`?sendverify` — Re-post the verify panel' + N +
        '`?slotrules` — Re-post the slot rules embed' },
    )
    .setFooter({ text: 'Drop Vault • Use ?help anytime' });
  return embed;
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  try { const role = member.guild.roles.cache.get(NEWBIE_ROLE_ID); if (role) await member.roles.add(role); }
  catch (e) { console.error('Newbie role error:', e); }
  if (dbGetWeekendState(member.guild.id) && !dbUserHasSlot(member.guild.id, member.id)) {
    try {
      const ch = await createSlotChannel(member.guild, member.user, '🎉', null, WEEKEND_CATEGORY_NAME, true);
      dbSaveWeekend(ch.id, member.id, member.guild.id);
      await ch.send(`🎉 Hey ${member}, enjoy your **Weekend Slot**!\n\n⏳ Available through **Sunday 11:59 PM EST**.\n📢 1x \`@here\` and 1x \`@everyone\`.\n👥 Use \`?talk @user ...\` to invite people.`);
    } catch {}
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== VERIFY_BUTTON_ID) return;
  const { member, guild } = interaction;
  try {
    if (member.roles.cache.has(MEMBER_ROLE_ID)) return interaction.reply({ content: "✅ You're already verified!", ephemeral: true });
    const memberRole = guild.roles.cache.get(MEMBER_ROLE_ID);
    const newbieRole = guild.roles.cache.get(NEWBIE_ROLE_ID);
    if (memberRole) await member.roles.add(memberRole);
    if (newbieRole) await member.roles.remove(newbieRole).catch(() => {});
    await interaction.reply({ content: `✅ Verified! You now have the <@&${MEMBER_ROLE_ID}> role. Welcome!`, ephemeral: true });
  } catch (e) {
    console.error('Verify error:', e);
    await interaction.reply({ content: '❌ Something went wrong. Contact an admin.', ephemeral: true });
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const { content, member, guild, channel } = message;
  const args = content.trim().split(/\s+/);
  const cmd  = args[0]?.toLowerCase();

  // ── ?help ──────────────────────────────────────────────────────────────────
  if (cmd === '?help') {
    const embed = buildHelpEmbed(isAdminOrOwner(member, guild));
    return message.reply({ embeds: [embed] });
  }

  // ── ?sendverify ────────────────────────────────────────────────────────────
  if (cmd === '?sendverify') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    await sendVerifyPanel(guild);
    return message.reply('✅ Verify panel sent!');
  }

  // ── ?slotrules ─────────────────────────────────────────────────────────────
  if (cmd === '?slotrules') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    await sendSlotRules(guild);
    return message.reply('✅ Slot rules posted!');
  }

  // ── ?slots ─────────────────────────────────────────────────────────────────
  if (cmd === '?slots') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const rows = dbAllGuildSlots(guild.id);
    if (!rows.length) return message.reply('No active slots.');
    const lines = rows.map(r => {
      const exp = r.expires_at ? `${daysRemaining(r.expires_at)}d left` : '∞';
      const status = r.locked ? '🔒' : r.muted ? '🔇' : '✅';
      return `${status} ${r.emoji} <@${r.user_id}> — ${r.type} (${exp})`;
    });
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`🎰 Active Slots — ${rows.length} total`)
      .setDescription(lines.join('\n')).setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── ?slotstats ─────────────────────────────────────────────────────────────
  if (cmd === '?slotstats') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const all = dbAllGuildSlots(guild.id);
    const expiringSoon = all.filter(r => r.expires_at && daysRemaining(r.expires_at) <= 3).length;
    const perm = all.filter(r => !r.expires_at).length;
    const timed = all.filter(r => r.expires_at).length;
    const locked = all.filter(r => r.locked).length;
    const muted = all.filter(r => r.muted).length;
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📈 Slot Statistics')
      .addFields(
        { name: 'Total Active', value: `${all.length}`, inline: true },
        { name: 'Permanent', value: `${perm}`, inline: true },
        { name: 'Timed', value: `${timed}`, inline: true },
        { name: 'Expiring ≤3 days', value: `${expiringSoon}`, inline: true },
        { name: 'Locked', value: `${locked}`, inline: true },
        { name: 'Muted', value: `${muted}`, inline: true },
      ).setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── ?slotinfo @user ────────────────────────────────────────────────────────
  if (cmd === '?slotinfo') {
    const target = message.mentions.members.first() ?? member;
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    const talkers = dbGetTalkUsers(row.channel_id);
    const talkerList = talkers.length ? talkers.map(u => `<@${u}>`).join(', ') : 'None';
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`${row.emoji} ${target.user.username}'s Slot`)
      .addFields(
        { name: 'Type', value: slotTypeLabel(row.type), inline: true },
        { name: 'Channel', value: `<#${row.channel_id}>`, inline: true },
        { name: 'Expiry', value: formatExpiry(row.expires_at), inline: false },
        { name: 'Status', value: row.locked ? '🔒 Locked' : row.muted ? '🔇 Muted' : '✅ Active', inline: true },
        { name: '@here used', value: row.here_used ? '✅ Yes' : '❌ No', inline: true },
        { name: '@everyone used', value: row.everyone_used ? '✅ Yes' : '❌ No', inline: true },
        { name: `Invited Users (${talkers.length})`, value: talkerList },
      ).setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── ?myslot ────────────────────────────────────────────────────────────────
  if (cmd === '?myslot') {
    const row = dbGetSlotByUser(guild.id, member.id);
    if (!row) return message.reply("❌ You don't have an active slot.");
    const talkers = dbGetTalkUsers(row.channel_id);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`${row.emoji} Your Slot`)
      .addFields(
        { name: 'Type', value: slotTypeLabel(row.type), inline: true },
        { name: 'Channel', value: `<#${row.channel_id}>`, inline: true },
        { name: 'Expiry', value: formatExpiry(row.expires_at), inline: false },
        { name: 'Status', value: row.locked ? '🔒 Locked' : row.muted ? '🔇 Muted' : '✅ Active', inline: true },
        { name: 'Invited Users', value: talkers.length ? talkers.map(u => `<@${u}>`).join(', ') : 'None' },
      ).setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── ?listtalkers ───────────────────────────────────────────────────────────
  if (cmd === '?listtalkers') {
    const slotData = dbGetSlot(channel.id);
    if (!slotData) return message.reply('❌ This is not a slot channel.');
    const talkers = dbGetTalkUsers(channel.id);
    if (!talkers.length) return message.reply('No users have been invited to this slot.');
    const embed = new EmbedBuilder().setColor(0x5865f2)
      .setTitle('👥 Invited Users')
      .setDescription(talkers.map((u, i) => `${i + 1}. <@${u}>`).join('\n'))
      .setFooter({ text: `${talkers.length} user(s) invited` });
    return message.reply({ embeds: [embed] });
  }

  // ── ?slothistory @user ─────────────────────────────────────────────────────
  if (cmd === '?slothistory') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const history = dbGetHistory(guild.id, target.id);
    if (!history.length) return message.reply(`No slot history for **${target.user.username}**.`);
    const lines = history.map(r => {
      const opened = new Date(r.opened_at).toLocaleDateString('en-US');
      const closed = r.closed_at ? new Date(r.closed_at).toLocaleDateString('en-US') : 'Active';
      return `${r.emoji} **${r.type}** — Opened ${opened} | Closed: ${closed}${r.close_reason ? ` (${r.close_reason})` : ''}`;
    });
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`📜 Slot History — ${target.user.username}`)
      .setDescription(lines.join('\n')).setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── ?slotleaderboard ───────────────────────────────────────────────────────
  if (cmd === '?slotleaderboard') {
    const rows = db.prepare(`SELECT user_id, COUNT(*) as total FROM slot_history WHERE guild_id=? GROUP BY user_id ORDER BY total DESC LIMIT 10`).all(guild.id);
    if (!rows.length) return message.reply('No slot history yet.');
    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.total} slot${r.total > 1 ? 's' : ''}`);
    const embed = new EmbedBuilder().setColor(0xf5c518).setTitle('🏆 Slot Leaderboard')
      .setDescription(lines.join('\n')).setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── ?extendslot <days> @user ───────────────────────────────────────────────
  if (cmd === '?extendslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const days = parseInt(args[1]);
    const target = message.mentions.members.first();
    if (!target || isNaN(days) || days < 1) return message.reply('❌ Usage: `?extendslot <days> @user`');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    if (!row.expires_at) return message.reply('❌ That slot is permanent — no expiry to extend.');
    const newExp = row.expires_at + days * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) { const m2 = await guild.members.fetch(target.id).catch(() => null); if (m2) await ch.setName(channelName(row.emoji, m2.user.username, newExp)).catch(() => {}); }
    return message.reply(`✅ Extended **${target.user.username}**'s slot by ${days} day(s). New expiry: ${formatExpiry(newExp)}`);
  }

  // ── ?reduceslot <days> @user ───────────────────────────────────────────────
  if (cmd === '?reduceslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const days = parseInt(args[1]);
    const target = message.mentions.members.first();
    if (!target || isNaN(days) || days < 1) return message.reply('❌ Usage: `?reduceslot <days> @user`');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    if (!row.expires_at) return message.reply('❌ That slot is permanent.');
    const newExp = Math.max(row.expires_at - days * 24 * 60 * 60 * 1000, Date.now() + 60000);
    db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    return message.reply(`✅ Reduced **${target.user.username}**'s slot by ${days} day(s). New expiry: ${formatExpiry(newExp)}`);
  }

  // ── ?setslotexpiry <YYYY-MM-DD> @user ──────────────────────────────────────
  if (cmd === '?setslotexpiry') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const dateStr = args[1];
    const target = message.mentions.members.first();
    if (!target || !dateStr) return message.reply('❌ Usage: `?setslotexpiry <YYYY-MM-DD> @user`');
    const newExp = new Date(dateStr).getTime();
    if (isNaN(newExp)) return message.reply('❌ Invalid date. Use format `YYYY-MM-DD`.');
    if (newExp <= Date.now()) return message.reply('❌ Date must be in the future.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    return message.reply(`✅ Set **${target.user.username}**'s slot expiry to ${formatExpiry(newExp)}`);
  }

  // ── ?renewslot @user ───────────────────────────────────────────────────────
  if (cmd === '?renewslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    if (!row.expires_at) return message.reply('❌ That slot is permanent.');
    const cfg = dbGetConfig(guild.id);
    const dur = cfg.default_duration;
    const newExp = Date.now() + dur;
    db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    return message.reply(`✅ Renewed **${target.user.username}**'s slot. New expiry: ${formatExpiry(newExp)}`);
  }

  // ── ?muteslot @user ────────────────────────────────────────────────────────
  if (cmd === '?muteslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]: false }).catch(() => {});
    dbSetMuted(row.channel_id, true);
    return message.reply(`🔇 **${target.user.username}**'s slot has been muted.`);
  }

  // ── ?unmuteslot @user ──────────────────────────────────────────────────────
  if (cmd === '?unmuteslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]: true }).catch(() => {});
    dbSetMuted(row.channel_id, false);
    return message.reply(`✅ **${target.user.username}**'s slot has been unmuted.`);
  }

  // ── ?lockslot @user ────────────────────────────────────────────────────────
  if (cmd === '?lockslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) {
      await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]: false }).catch(() => {});
      const talkers = dbGetTalkUsers(row.channel_id);
      for (const uid of talkers) await ch.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]: false }).catch(() => {});
    }
    dbSetLocked(row.channel_id, true);
    return message.reply(`🔒 **${target.user.username}**'s slot has been locked.`);
  }

  // ── ?unlockslot @user ──────────────────────────────────────────────────────
  if (cmd === '?unlockslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) {
      await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]: true }).catch(() => {});
      const talkers = dbGetTalkUsers(row.channel_id);
      for (const uid of talkers) await ch.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]: true }).catch(() => {});
    }
    dbSetLocked(row.channel_id, false);
    return message.reply(`✅ **${target.user.username}**'s slot has been unlocked.`);
  }

  // ── ?removeslot / ?revokeslot / ?terminateslot ─────────────────────────────
  if (cmd === '?removeslot' || cmd === '?revokeslot' || cmd === '?terminateslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);

    // Apply cooldown if configured
    const cfg = dbGetConfig(guild.id);
    if (cfg.cooldown_ms > 0) dbSetCooldown(guild.id, target.id, Date.now() + cfg.cooldown_ms);

    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.delete().catch(() => {});
    dbDeleteSlot(row.channel_id, cmd === '?terminateslot' ? 'terminated' : 'removed');
    return message.reply(`✅ Slot removed for **${target.user.username}**.`);
  }

  // ── ?forcetransfer @old @new ───────────────────────────────────────────────
  if (cmd === '?forcetransfer' || cmd === '?transferslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const mentions = [...message.mentions.members.values()];
    if (mentions.length < 2) return message.reply('❌ Mention two users: `?transferslot @from @to`');
    const [from, to] = mentions;
    const row = dbGetSlotByUser(guild.id, from.id);
    if (!row) return message.reply(`❌ **${from.user.username}** has no active slot.`);
    if (dbUserHasSlot(guild.id, to.id)) return message.reply(`❌ **${to.user.username}** already has a slot.`);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) {
      await ch.permissionOverwrites.edit(from.id, { [PermissionFlagsBits.SendMessages]: false, [PermissionFlagsBits.ViewChannel]: false }).catch(() => {});
      await ch.permissionOverwrites.edit(to.id, { [PermissionFlagsBits.SendMessages]: true, [PermissionFlagsBits.ViewChannel]: true, [PermissionFlagsBits.ReadMessageHistory]: true, [PermissionFlagsBits.AttachFiles]: true, [PermissionFlagsBits.EmbedLinks]: true }).catch(() => {});
      await ch.setName(channelName(row.emoji, to.user.username, row.expires_at)).catch(() => {});
    }
    db.prepare('UPDATE slots SET user_id=? WHERE channel_id=?').run(to.id, row.channel_id);
    return message.reply(`✅ Slot transferred from **${from.user.username}** to **${to.user.username}**.`);
  }

  // ── ?swapslots @user1 @user2 ───────────────────────────────────────────────
  if (cmd === '?swapslots') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const mentions = [...message.mentions.members.values()];
    if (mentions.length < 2) return message.reply('❌ Mention two users: `?swapslots @user1 @user2`');
    const [u1, u2] = mentions;
    const r1 = dbGetSlotByUser(guild.id, u1.id);
    const r2 = dbGetSlotByUser(guild.id, u2.id);
    if (!r1) return message.reply(`❌ **${u1.user.username}** has no slot.`);
    if (!r2) return message.reply(`❌ **${u2.user.username}** has no slot.`);
    db.prepare('UPDATE slots SET user_id=? WHERE channel_id=?').run(u2.id, r1.channel_id);
    db.prepare('UPDATE slots SET user_id=? WHERE channel_id=?').run(u1.id, r2.channel_id);
    const ch1 = guild.channels.cache.get(r1.channel_id);
    const ch2 = guild.channels.cache.get(r2.channel_id);
    if (ch1) { await ch1.permissionOverwrites.edit(u1.id, { [PermissionFlagsBits.SendMessages]: false }).catch(() => {}); await ch1.permissionOverwrites.edit(u2.id, { [PermissionFlagsBits.SendMessages]: true, [PermissionFlagsBits.ViewChannel]: true }).catch(() => {}); await ch1.setName(channelName(r1.emoji, u2.user.username, r1.expires_at)).catch(() => {}); }
    if (ch2) { await ch2.permissionOverwrites.edit(u2.id, { [PermissionFlagsBits.SendMessages]: false }).catch(() => {}); await ch2.permissionOverwrites.edit(u1.id, { [PermissionFlagsBits.SendMessages]: true, [PermissionFlagsBits.ViewChannel]: true }).catch(() => {}); await ch2.setName(channelName(r2.emoji, u1.user.username, r2.expires_at)).catch(() => {}); }
    return message.reply(`✅ Swapped slots between **${u1.user.username}** and **${u2.user.username}**.`);
  }

  // ── ?backupslot @user ──────────────────────────────────────────────────────
  if (cmd === '?backupslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    const talkers = dbGetTalkUsers(row.channel_id);
    dbSaveBackup(guild.id, target.id, { ...row, talkers });
    return message.reply(`✅ Backed up **${target.user.username}**'s slot permissions.`);
  }

  // ── ?restoreslot @user ─────────────────────────────────────────────────────
  if (cmd === '?restoreslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const backup = dbGetBackup(guild.id, target.id);
    if (!backup) return message.reply(`❌ No backup found for **${target.user.username}**.`);
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot to restore into.`);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch && backup.backup_data.talkers?.length) {
      for (const uid of backup.backup_data.talkers) {
        await ch.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]: true, [PermissionFlagsBits.ViewChannel]: true, [PermissionFlagsBits.ReadMessageHistory]: true }).catch(() => {});
        dbAddTalkUser(row.channel_id, uid);
      }
    }
    return message.reply(`✅ Restored **${target.user.username}**'s slot from backup (${new Date(backup.backed_up_at).toLocaleDateString()}).`);
  }

  // ── ?setslotlimit <number> ─────────────────────────────────────────────────
  if (cmd === '?setslotlimit') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const n = parseInt(args[1]);
    if (isNaN(n) || n < 0) return message.reply('❌ Usage: `?setslotlimit <number>` (0 = unlimited)');
    dbSetConfig(guild.id, 'slot_limit', n);
    return message.reply(`✅ Slot limit set to **${n === 0 ? 'unlimited' : n}**.`);
  }

  // ── ?setdefaultduration <days> ─────────────────────────────────────────────
  if (cmd === '?setdefaultduration') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const days = parseInt(args[1]);
    if (isNaN(days) || days < 1) return message.reply('❌ Usage: `?setdefaultduration <days>`');
    dbSetConfig(guild.id, 'default_duration', days * 24 * 60 * 60 * 1000);
    return message.reply(`✅ Default slot duration set to **${days} days**.`);
  }

  // ── ?slotcooldown <hours> ──────────────────────────────────────────────────
  if (cmd === '?slotcooldown') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const hours = parseInt(args[1]);
    if (isNaN(hours) || hours < 0) return message.reply('❌ Usage: `?slotcooldown <hours>` (0 = disabled)');
    dbSetConfig(guild.id, 'cooldown_ms', hours * 60 * 60 * 1000);
    return message.reply(`✅ Slot cooldown set to **${hours === 0 ? 'disabled' : hours + ' hours'}**.`);
  }

  // ── ?talklimit <number> ────────────────────────────────────────────────────
  if (cmd === '?talklimit') {
    const slotData = dbGetSlot(channel.id);
    if (!slotData) return message.reply('❌ This is not a slot channel.');
    if (message.author.id !== slotData.userId && !isAdminOrOwner(member, guild))
      return message.reply('❌ Only the slot owner or admins can set this.');
    const n = parseInt(args[1]);
    if (isNaN(n) || n < 0) return message.reply('❌ Usage: `?talklimit <number>` (0 = unlimited)');
    dbSetTalkLimit(channel.id, n);
    return message.reply(`✅ Talk limit set to **${n === 0 ? 'unlimited' : n}** users.`);
  }

  // ── ?talk @user ... ────────────────────────────────────────────────────────
  if (cmd === '?talk') {
    const slotData    = dbGetSlot(channel.id);
    const weekendData = dbGetWeekend(channel.id);
    const ownerId     = slotData?.userId ?? weekendData?.user_id ?? null;
    if (!ownerId) return;
    if (message.author.id !== ownerId) return message.reply('❌ Only the slot owner can use `?talk`.');
    const targets = message.mentions.members;
    if (!targets || targets.size === 0) return message.reply('❌ Mention at least one user.');
    if (slotData?.talkLimit > 0) {
      const current = dbTalkCount(channel.id);
      if (current >= slotData.talkLimit) return message.reply(`❌ Talk limit reached (${slotData.talkLimit} users max).`);
    }
    const added = [];
    for (const [, t] of targets) {
      if (t.id === ownerId) continue;
      await channel.permissionOverwrites.edit(t.id, { [PermissionFlagsBits.SendMessages]: true, [PermissionFlagsBits.ViewChannel]: true, [PermissionFlagsBits.ReadMessageHistory]: true }).catch(() => {});
      if (slotData) dbAddTalkUser(channel.id, t.id);
      added.push(t.toString());
    }
    if (added.length) return message.reply(`✅ Invited ${added.join(', ')} to this slot.`);
    return;
  }

  // ── ?removetalk / ?revoketalk @user ... ───────────────────────────────────
  if (cmd === '?removetalk' || cmd === '?revoketalk' || cmd === '?untalk') {
    const slotData = dbGetSlot(channel.id);
    if (!slotData) return;
    if (message.author.id !== slotData.userId && !isAdminOrOwner(member, guild))
      return message.reply('❌ Only the slot owner or admins can remove talkers.');
    const targets = message.mentions.members;
    if (!targets || targets.size === 0) return message.reply('❌ Mention at least one user to remove.');
    const removed = [];
    for (const [, t] of targets) {
      if (t.id === slotData.userId) continue;
      await channel.permissionOverwrites.edit(t.id, { [PermissionFlagsBits.SendMessages]: false }).catch(() => {});
      dbRemoveTalkUser(channel.id, t.id);
      removed.push(t.toString());
    }
    if (removed.length) return message.reply(`✅ Removed ${removed.join(', ')} from this slot.`);
    return;
  }

  // ── ?revokealltalk ─────────────────────────────────────────────────────────
  if (cmd === '?revokealltalk') {
    const slotData = dbGetSlot(channel.id);
    if (!slotData) return;
    if (message.author.id !== slotData.userId && !isAdminOrOwner(member, guild))
      return message.reply('❌ Only the slot owner or admins can do this.');
    const talkers = dbGetTalkUsers(channel.id);
    if (!talkers.length) return message.reply('No invited users to remove.');
    for (const uid of talkers) {
      await channel.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]: false }).catch(() => {});
    }
    dbClearTalkUsers(channel.id);
    return message.reply(`✅ Removed all ${talkers.length} invited user(s) from this slot.`);
  }

  // ── Slot creation commands ─────────────────────────────────────────────────
  if (cmd === '?freeslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    if (dbHasUsedFree(guild.id, target.id)) return message.reply(`❌ **${target.user.username}** already used their free slot.`);
    const cfg = dbGetConfig(guild.id);
    if (cfg.cooldown_ms > 0) { const cd = dbGetCooldown(guild.id, target.id); if (cd && cd.available_at > Date.now()) { const hrs = Math.ceil((cd.available_at - Date.now()) / 3600000); return message.reply(`❌ **${target.user.username}** is on cooldown for ${hrs} more hour(s).`); } }
    const exp = Date.now() + SLOT_TYPES.free.duration;
    dbMarkFreeUsed(guild.id, target.id);
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.free.emoji, exp);
    dbSaveSlot(ch.id, target.id, guild.id, 'free', SLOT_TYPES.free.emoji, exp);
    await ch.send(`🎲 Welcome to your slot, ${target}!\n\n⏳ Lasts **7 days**.\n📢 1x \`@here\` and 1x \`@everyone\`.\n👥 Use \`?talk @user ...\` to invite people.\n🚫 Use \`?removetalk @user\` to remove them.`);
    return message.reply(`✅ Free slot opened for ${target} in ${ch}!`);
  }

  if (cmd === '?weekslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const weeks = parseInt(args[1]); const target = message.mentions.members.first();
    if (!target || isNaN(weeks) || weeks < 1) return message.reply('❌ Usage: `?weekslot <weeks> @user`');
    const exp = Date.now() + weeks * 7 * 24 * 60 * 60 * 1000;
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.week.emoji, exp);
    dbSaveSlot(ch.id, target.id, guild.id, 'week', SLOT_TYPES.week.emoji, exp);
    await ch.send(`🎰 Welcome to your slot, ${target}!\n\n⏳ Lasts **${weeks} week${weeks > 1 ? 's' : ''}**.\n📢 1x \`@here\` and 1x \`@everyone\`.\n👥 Use \`?talk @user ...\` to invite people.`);
    return message.reply(`✅ Weekly slot (${weeks}w) opened for ${target} in ${ch}!`);
  }

  if (cmd === '?monthslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const months = parseInt(args[1]); const target = message.mentions.members.first();
    if (!target || isNaN(months) || months < 1) return message.reply('❌ Usage: `?monthslot <months> @user`');
    const exp = Date.now() + months * 30 * 24 * 60 * 60 * 1000;
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.month.emoji, exp);
    dbSaveSlot(ch.id, target.id, guild.id, 'month', SLOT_TYPES.month.emoji, exp);
    await ch.send(`💎 Welcome to your slot, ${target}!\n\n⏳ Lasts **${months} month${months > 1 ? 's' : ''}**.\n📢 1x \`@here\` and 1x \`@everyone\`.\n👥 Use \`?talk @user ...\` to invite people.`);
    return message.reply(`✅ Monthly slot (${months}mo) opened for ${target} in ${ch}!`);
  }

  if (cmd === '?permslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.perm.emoji, null);
    dbSaveSlot(ch.id, target.id, guild.id, 'perm', SLOT_TYPES.perm.emoji, null);
    await ch.send(`⚜️ Welcome to your permanent slot, ${target}!\n\n♾️ Never expires.\n📢 1x \`@here\` and 1x \`@everyone\`.\n👥 Use \`?talk @user ...\` to invite people.`);
    return message.reply(`✅ Permanent slot opened for ${target} in ${ch}!`);
  }

  if (cmd === '?weekend') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    if (dbGetWeekendState(guild.id)) return message.reply('⚠️ Weekend slots are already open!');
    await openWeekend(guild);
    return message.reply('🎉 Weekend slots are now open for everyone!');
  }

  if (cmd === '?stopw') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    if (!dbGetWeekendState(guild.id)) return message.reply('⚠️ No weekend is currently active.');
    await closeWeekend(guild);
    return message.reply('🛑 Weekend slots have been closed.');
  }

  // ── @here / @everyone abuse — regular slots ────────────────────────────────
  const slotData = dbGetSlot(channel.id);
  if (slotData && message.author.id === slotData.userId) {
    if (slotData.infMentions) return;
    let abused = false;
    if (content.includes('@here'))     { if (slotData.hereUsed)     abused = true; else dbMarkHereUsed(channel.id); }
    if (content.includes('@everyone')) { if (slotData.everyoneUsed) abused = true; else dbMarkEveryoneUsed(channel.id); }
    if (abused) {
      await message.delete().catch(() => {});
      message.author.send(`⚠️ **Warning** — You exceeded your @here/@everyone limit in your slot on **${guild.name}**.\nEach slot allows exactly **1x \`@here\`** and **1x \`@everyone\`**.`).catch(() => {});
    }
    return;
  }

  // ── @here / @everyone abuse — weekend slots ────────────────────────────────
  const wData = dbGetWeekend(channel.id);
  if (wData && message.author.id === wData.user_id) {
    let abused = false;
    if (content.includes('@here'))     { if (wData.here_used)     abused = true; else dbMarkWHere(channel.id); }
    if (content.includes('@everyone')) { if (wData.everyone_used) abused = true; else dbMarkWEveryone(channel.id); }
    if (abused) {
      await message.delete().catch(() => {});
      message.author.send(`⚠️ **Warning** — You exceeded your @here/@everyone limit in your weekend slot on **${guild.name}**.`).catch(() => {});
    }
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Connected to ${client.guilds.cache.size} guild(s)`);
  for (const [, guild] of client.guilds.cache) {
    console.log(`Setting up: ${guild.name}`);
    if (!dbGetVerify(guild.id))  await sendVerifyPanel(guild).catch(console.error);
    if (!dbGetRules(guild.id))   await sendSlotRules(guild).catch(console.error);
    await ensureStaffSlots(guild).catch(console.error);
  }
  setInterval(checkExpiredSlots, 10 * 60 * 1000);
  scheduleWeekend();
  console.log('✅ Bot fully ready!');
});

client.on('error', (e) => console.error('Client error:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

console.log('Starting bot...');
client.login(process.env.DISCORD_TOKEN);
