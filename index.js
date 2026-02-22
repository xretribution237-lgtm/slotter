const {
  Client, GatewayIntentBits, PermissionFlagsBits, ChannelType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events,
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

// ─── Database Setup ────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS slots (
    channel_id   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    guild_id     TEXT NOT NULL,
    type         TEXT NOT NULL,
    slot_subtype TEXT DEFAULT 'private',
    emoji        TEXT NOT NULL,
    expires_at   INTEGER,
    here_used    INTEGER DEFAULT 0,
    everyone_used INTEGER DEFAULT 0,
    inf_mentions INTEGER DEFAULT 0,
    muted        INTEGER DEFAULT 0,
    locked       INTEGER DEFAULT 0,
    talk_limit   INTEGER DEFAULT 0,
    color        TEXT DEFAULT '5865F2',
    created_by   TEXT,
    last_activity INTEGER,
    auto_lock    INTEGER DEFAULT 0,
    suspended_until INTEGER,
    appeal       INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS slot_talk (
    channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS used_free_slots (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
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
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT NOT NULL, user_id TEXT NOT NULL,
    type         TEXT NOT NULL, emoji TEXT NOT NULL,
    opened_at    INTEGER NOT NULL, closed_at INTEGER,
    close_reason TEXT, created_by TEXT
  );
  CREATE TABLE IF NOT EXISTS slot_config (
    guild_id         TEXT PRIMARY KEY,
    slot_limit       INTEGER DEFAULT 0,
    default_duration INTEGER DEFAULT 604800000,
    cooldown_ms      INTEGER DEFAULT 0,
    inherit_perms    INTEGER DEFAULT 1,
    autolock_days    INTEGER DEFAULT 3,
    autorotate       INTEGER DEFAULT 0,
    activity_threshold INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS slot_cooldowns (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    available_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS slot_backups (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    backup_data TEXT NOT NULL, backed_up_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS claim_slots (
    channel_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    claimed_by TEXT,
    claimed_at INTEGER,
    expires_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS warnings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id  TEXT NOT NULL, user_id TEXT NOT NULL,
    reason    TEXT NOT NULL, issued_by TEXT NOT NULL,
    issued_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS strikes (
    guild_id  TEXT NOT NULL, user_id TEXT NOT NULL,
    count     INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS blacklist (
    guild_id  TEXT NOT NULL, user_id TEXT NOT NULL,
    reason    TEXT, blacklisted_at INTEGER,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id  TEXT NOT NULL,
    action    TEXT NOT NULL,
    target_id TEXT,
    by_id     TEXT NOT NULL,
    detail    TEXT,
    at        INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS remindme (
    guild_id   TEXT NOT NULL, user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL, enabled INTEGER DEFAULT 1,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS slot_roles (
    channel_id TEXT NOT NULL, role_id TEXT NOT NULL,
    PRIMARY KEY (channel_id, role_id)
  );
`);

// ─── DB Helpers ───────────────────────────────────────────────────────────────

const dbSaveSlot = (cid, uid, gid, type, emoji, exp, inf = 0, createdBy = null) => {
  db.prepare(`INSERT OR REPLACE INTO slots
    (channel_id,user_id,guild_id,type,emoji,expires_at,here_used,everyone_used,
     inf_mentions,muted,locked,talk_limit,color,created_by,last_activity,auto_lock,slot_subtype)
    VALUES(?,?,?,?,?,?,0,0,?,0,0,0,'5865F2',?,?,0,'private')`)
    .run(cid, uid, gid, type, emoji, exp ?? null, inf ? 1 : 0, createdBy, Date.now());
  db.prepare(`INSERT OR IGNORE INTO slot_history (guild_id,user_id,type,emoji,opened_at,created_by) VALUES(?,?,?,?,?,?)`)
    .run(gid, uid, type, emoji, Date.now(), createdBy);
};

const dbDeleteSlot = (cid, reason = 'removed') => {
  const row = db.prepare('SELECT * FROM slots WHERE channel_id=?').get(cid);
  if (row) db.prepare('UPDATE slot_history SET closed_at=?, close_reason=? WHERE guild_id=? AND user_id=? AND closed_at IS NULL')
    .run(Date.now(), reason, row.guild_id, row.user_id);
  db.prepare('DELETE FROM slot_talk WHERE channel_id=?').run(cid);
  db.prepare('DELETE FROM slot_roles WHERE channel_id=?').run(cid);
  db.prepare('DELETE FROM slots WHERE channel_id=?').run(cid);
};

const dbGetSlot         = (cid) => {
  const r = db.prepare('SELECT * FROM slots WHERE channel_id=?').get(cid);
  if (!r) return null;
  const talk = db.prepare('SELECT user_id FROM slot_talk WHERE channel_id=?').all(cid);
  return { ...r, userId: r.user_id, guildId: r.guild_id, expiresAt: r.expires_at,
    hereUsed: !!r.here_used, everyoneUsed: !!r.everyone_used, infMentions: !!r.inf_mentions,
    muted: !!r.muted, locked: !!r.locked, talkLimit: r.talk_limit,
    talkAllowed: new Set(talk.map(x => x.user_id)) };
};
const dbGetSlotByUser   = (g, u)    => db.prepare('SELECT * FROM slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbAllSlots        = ()        => db.prepare('SELECT channel_id FROM slots').all().map(r => r.channel_id);
const dbAllGuildSlots   = (g)       => db.prepare('SELECT * FROM slots WHERE guild_id=?').all(g);
const dbUserHasSlot     = (g, u)    => !!db.prepare('SELECT 1 FROM slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbMarkHereUsed    = (cid)     => db.prepare('UPDATE slots SET here_used=1 WHERE channel_id=?').run(cid);
const dbMarkEveryone    = (cid)     => db.prepare('UPDATE slots SET everyone_used=1 WHERE channel_id=?').run(cid);
const dbSetActivity     = (cid)     => db.prepare('UPDATE slots SET last_activity=? WHERE channel_id=?').run(Date.now(), cid);
const dbAddTalkUser     = (c, u)    => db.prepare('INSERT OR IGNORE INTO slot_talk(channel_id,user_id) VALUES(?,?)').run(c, u);
const dbRemoveTalkUser  = (c, u)    => db.prepare('DELETE FROM slot_talk WHERE channel_id=? AND user_id=?').run(c, u);
const dbClearTalkUsers  = (c)       => db.prepare('DELETE FROM slot_talk WHERE channel_id=?').run(c);
const dbGetTalkUsers    = (c)       => db.prepare('SELECT user_id FROM slot_talk WHERE channel_id=?').all(c).map(r => r.user_id);
const dbTalkCount       = (c)       => db.prepare('SELECT COUNT(*) as cnt FROM slot_talk WHERE channel_id=?').get(c).cnt;
const dbHasUsedFree     = (g, u)    => !!db.prepare('SELECT 1 FROM used_free_slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbMarkFreeUsed    = (g, u)    => db.prepare('INSERT OR IGNORE INTO used_free_slots(guild_id,user_id) VALUES(?,?)').run(g, u);
const dbUserHasWeekend  = (g, u)    => !!db.prepare('SELECT 1 FROM weekend_slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbSetMuted        = (c, v)    => db.prepare('UPDATE slots SET muted=? WHERE channel_id=?').run(v?1:0, c);
const dbSetLocked       = (c, v)    => db.prepare('UPDATE slots SET locked=? WHERE channel_id=?').run(v?1:0, c);
const dbSetTalkLimit    = (c, n)    => db.prepare('UPDATE slots SET talk_limit=? WHERE channel_id=?').run(n, c);
const dbSetColor        = (c, hex)  => db.prepare('UPDATE slots SET color=? WHERE channel_id=?').run(hex, c);
const dbSetSubtype      = (c, t)    => db.prepare('UPDATE slots SET slot_subtype=? WHERE channel_id=?').run(t, c);
const dbSetAppeal       = (c, v)    => db.prepare('UPDATE slots SET appeal=? WHERE channel_id=?').run(v?1:0, c);

const dbSaveVerify      = (g,c,m)   => db.prepare('INSERT OR REPLACE INTO verify_messages VALUES(?,?,?)').run(g,c,m);
const dbGetVerify       = (g)       => db.prepare('SELECT * FROM verify_messages WHERE guild_id=?').get(g);
const dbSaveRules       = (g,m)     => db.prepare('INSERT OR REPLACE INTO slot_rules_messages VALUES(?,?)').run(g,m);
const dbGetRules        = (g)       => db.prepare('SELECT * FROM slot_rules_messages WHERE guild_id=?').get(g);

const dbSaveWeekend     = (c,u,g)   => db.prepare('INSERT OR REPLACE INTO weekend_slots(channel_id,user_id,guild_id,here_used,everyone_used) VALUES(?,?,?,0,0)').run(c,u,g);
const dbGetWeekend      = (cid)     => db.prepare('SELECT * FROM weekend_slots WHERE channel_id=?').get(cid);
const dbDeleteWeekend   = (cid)     => db.prepare('DELETE FROM weekend_slots WHERE channel_id=?').run(cid);
const dbAllWeekends     = (g)       => db.prepare('SELECT channel_id FROM weekend_slots WHERE guild_id=?').all(g).map(r=>r.channel_id);
const dbMarkWHere       = (cid)     => db.prepare('UPDATE weekend_slots SET here_used=1 WHERE channel_id=?').run(cid);
const dbMarkWEveryone   = (cid)     => db.prepare('UPDATE weekend_slots SET everyone_used=1 WHERE channel_id=?').run(cid);
const dbGetWeekendState = (g)       => db.prepare('SELECT active FROM weekend_state WHERE guild_id=?').get(g)?.active ?? 0;
const dbSetWeekendState = (g,a)     => db.prepare('INSERT OR REPLACE INTO weekend_state(guild_id,active) VALUES(?,?)').run(g,a?1:0);

const dbGetConfig       = (g)       => db.prepare('SELECT * FROM slot_config WHERE guild_id=?').get(g) ?? { slot_limit:0,default_duration:604800000,cooldown_ms:0,inherit_perms:1,autolock_days:3,autorotate:0,activity_threshold:0 };
const dbSetConfig       = (g,k,v)   => { db.prepare('INSERT OR IGNORE INTO slot_config(guild_id) VALUES(?)').run(g); db.prepare(`UPDATE slot_config SET ${k}=? WHERE guild_id=?`).run(v,g); };
const dbGetCooldown     = (g,u)     => db.prepare('SELECT available_at FROM slot_cooldowns WHERE guild_id=? AND user_id=?').get(g,u);
const dbSetCooldown     = (g,u,t)   => db.prepare('INSERT OR REPLACE INTO slot_cooldowns(guild_id,user_id,available_at) VALUES(?,?,?)').run(g,u,t);
const dbGetHistory      = (g,u)     => db.prepare('SELECT * FROM slot_history WHERE guild_id=? AND user_id=? ORDER BY opened_at DESC LIMIT 10').all(g,u);
const dbSaveBackup      = (g,u,d)   => db.prepare('INSERT OR REPLACE INTO slot_backups VALUES(?,?,?,?)').run(g,u,JSON.stringify(d),Date.now());
const dbGetBackup       = (g,u)     => { const r=db.prepare('SELECT * FROM slot_backups WHERE guild_id=? AND user_id=?').get(g,u); return r?{...r,backup_data:JSON.parse(r.backup_data)}:null; };

const dbCreateClaimSlot = (c,g)     => db.prepare('INSERT OR REPLACE INTO claim_slots(channel_id,guild_id,claimed_by,claimed_at,expires_at) VALUES(?,?,NULL,NULL,NULL)').run(c,g);
const dbGetClaimSlot    = (c)       => db.prepare('SELECT * FROM claim_slots WHERE channel_id=?').get(c);
const dbAllClaimSlots   = (g)       => db.prepare('SELECT * FROM claim_slots WHERE guild_id=?').all(g);
const dbClaimIt         = (c,u,e)   => db.prepare('UPDATE claim_slots SET claimed_by=?,claimed_at=?,expires_at=? WHERE channel_id=?').run(u,Date.now(),e,c);
const dbDeleteClaim     = (c)       => db.prepare('DELETE FROM claim_slots WHERE channel_id=?').run(c);
const dbUserHasClaim    = (g,u)     => !!db.prepare('SELECT 1 FROM claim_slots WHERE guild_id=? AND claimed_by=?').get(g,u);

const dbAddWarning      = (g,u,r,by) => db.prepare('INSERT INTO warnings(guild_id,user_id,reason,issued_by,issued_at) VALUES(?,?,?,?,?)').run(g,u,r,by,Date.now());
const dbGetWarnings     = (g,u)     => db.prepare('SELECT * FROM warnings WHERE guild_id=? AND user_id=? ORDER BY issued_at DESC').all(g,u);
const dbClearWarnings   = (g,u)     => db.prepare('DELETE FROM warnings WHERE guild_id=? AND user_id=?').run(g,u);

const dbGetStrikes      = (g,u)     => db.prepare('SELECT count FROM strikes WHERE guild_id=? AND user_id=?').get(g,u)?.count ?? 0;
const dbAddStrike       = (g,u)     => { db.prepare('INSERT OR IGNORE INTO strikes(guild_id,user_id,count) VALUES(?,?,0)').run(g,u); db.prepare('UPDATE strikes SET count=count+1 WHERE guild_id=? AND user_id=?').run(g,u); return dbGetStrikes(g,u); };
const dbClearStrikes    = (g,u)     => db.prepare('DELETE FROM strikes WHERE guild_id=? AND user_id=?').run(g,u);

const dbBlacklist       = (g,u,r)   => db.prepare('INSERT OR REPLACE INTO blacklist(guild_id,user_id,reason,blacklisted_at) VALUES(?,?,?,?)').run(g,u,r,Date.now());
const dbUnblacklist     = (g,u)     => db.prepare('DELETE FROM blacklist WHERE guild_id=? AND user_id=?').run(g,u);
const dbIsBlacklisted   = (g,u)     => !!db.prepare('SELECT 1 FROM blacklist WHERE guild_id=? AND user_id=?').get(g,u);

const dbAudit           = (g,action,target,by,detail) => db.prepare('INSERT INTO audit_log(guild_id,action,target_id,by_id,detail,at) VALUES(?,?,?,?,?,?)').run(g,action,target,by,detail,Date.now());
const dbRecentAudit     = (g,n=10)  => db.prepare('SELECT * FROM audit_log WHERE guild_id=? ORDER BY at DESC LIMIT ?').all(g,n);
const dbModStats        = (g)       => db.prepare('SELECT by_id, COUNT(*) as total FROM audit_log WHERE guild_id=? GROUP BY by_id ORDER BY total DESC LIMIT 10').all(g);

const dbSetRemind       = (g,u,c)   => db.prepare('INSERT OR REPLACE INTO remindme(guild_id,user_id,channel_id,enabled) VALUES(?,?,?,1)').run(g,u,c);
const dbGetRemind       = (g,u)     => db.prepare('SELECT * FROM remindme WHERE guild_id=? AND user_id=?').get(g,u);
const dbAllReminders    = ()        => db.prepare('SELECT * FROM remindme WHERE enabled=1').all();

const dbAddSlotRole     = (c,r)     => db.prepare('INSERT OR IGNORE INTO slot_roles(channel_id,role_id) VALUES(?,?)').run(c,r);
const dbRemoveSlotRole  = (c,r)     => db.prepare('DELETE FROM slot_roles WHERE channel_id=? AND role_id=?').run(c,r);
const dbGetSlotRoles    = (c)       => db.prepare('SELECT role_id FROM slot_roles WHERE channel_id=?').all(c).map(r=>r.role_id);

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

const SLOT_SUBTYPES = {
  private:  { label: '🔒 Private',  viewable: false, sendable: false },
  public:   { label: '🌐 Public',   viewable: true,  sendable: true  },
  premium:  { label: '💎 Premium',  viewable: true,  sendable: false },
  event:    { label: '🎪 Event',    viewable: true,  sendable: true  },
};

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
  ],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isAdmin    = (m, g) => m.id === g.ownerId || m.permissions.has(PermissionFlagsBits.Administrator);
const hexToInt   = (hex)  => parseInt(hex.replace('#',''), 16);
const safeUser   = (u)    => u.toLowerCase().replace(/[^a-z0-9]/g,'');

function daysLeft(exp) {
  if (!exp) return null;
  const ms = exp - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
}

function fmtExpiry(exp) {
  if (!exp) return '♾️ Never';
  const d = daysLeft(exp);
  if (d === 0) return '⚠️ Expiring today';
  return `📅 ${new Date(exp).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})} (${d}d left)`;
}

function channelName(emoji, username, exp, isWeekend = false) {
  const s = safeUser(username);
  if (isWeekend) return `🎉-${s}s-weekend-slot`;
  if (!exp) return `${emoji}-${s}s-slot`;
  return `${emoji}-${s}s-slot-${daysLeft(exp)}d`;
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
  return { free:'🎲 Free',week:'🎰 Weekly',month:'💎 Monthly',perm:'⚜️ Permanent',owner:`${OWNER_EMOJI} Owner`,admin:'🛠️ Admin',weekend:'🎉 Weekend' }[type] ?? type;
}

function makeEmbed(color = '5865F2') {
  return new EmbedBuilder().setColor(hexToInt(color));
}

// ─── Apply Subtype Permissions ────────────────────────────────────────────────

async function applySubtypePerms(channel, subtype, guild) {
  const cfg = SLOT_SUBTYPES[subtype] ?? SLOT_SUBTYPES.private;
  const everyoneOverwrite = { id: guild.roles.everyone.id };
  if (cfg.viewable && cfg.sendable) {
    everyoneOverwrite.allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  } else if (cfg.viewable) {
    everyoneOverwrite.allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    everyoneOverwrite.deny  = [PermissionFlagsBits.SendMessages];
  } else {
    everyoneOverwrite.deny  = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  }
  await channel.permissionOverwrites.edit(guild.roles.everyone.id, everyoneOverwrite).catch(() => {});
}

// ─── Staff Auto-Slots ─────────────────────────────────────────────────────────

async function ensureStaffSlots(guild) {
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) {
    const row = dbGetSlotByUser(guild.id, owner.id);
    if (row && !guild.channels.cache.get(row.channel_id)) dbDeleteSlot(row.channel_id, 'stale');
    if (!dbUserHasSlot(guild.id, owner.id)) {
      const ch = await createSlotChannel(guild, owner.user, OWNER_EMOJI, null);
      dbSaveSlot(ch.id, owner.id, guild.id, 'owner', OWNER_EMOJI, null, true, 'system');
      await ch.send(OWNER_EMOJI + ' Welcome to your permanent owner slot, ' + owner.toString() + '!\n\n♾️ Infinite `@here` and `@everyone`.\n👥 Use `?talk @user` to invite.\n🚫 Use `?removetalk @user` to remove.');
    }
  }
  const members = await guild.members.fetch();
  for (const [, m] of members) {
    if (m.user.bot || m.id === guild.ownerId || !m.permissions.has(PermissionFlagsBits.Administrator)) continue;
    const row = dbGetSlotByUser(guild.id, m.id);
    if (row) { if (!guild.channels.cache.get(row.channel_id)) dbDeleteSlot(row.channel_id,'stale'); else continue; }
    if (dbUserHasSlot(guild.id, m.id)) continue;
    const ch = await createSlotChannel(guild, m.user, ADMIN_EMOJI, null);
    dbSaveSlot(ch.id, m.id, guild.id, 'admin', ADMIN_EMOJI, null, true, 'system');
    await ch.send('🛠️ Welcome to your permanent admin slot, ' + m.toString() + '!\n\n♾️ Infinite `@here` and `@everyone`.\n👥 Use `?talk @user` to invite.');
  }
}

// ─── Verify Panel ─────────────────────────────────────────────────────────────

async function sendVerifyPanel(guild) {
  const channel = guild.channels.cache.get(VERIFY_CHANNEL_ID);
  if (!channel) return;
  const existing = dbGetVerify(guild.id);
  if (existing) { const old = await channel.messages.fetch(existing.message_id).catch(()=>null); if (old) await old.delete().catch(()=>{}); }
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('👋  Welcome to Drop Vault')
    .setDescription('Click **✅ Verify** below to get the <@&' + MEMBER_ROLE_ID + '> role and access the server.\n\n> By verifying you agree to the server rules.')
    .setFooter({ text: 'One click is all it takes.' }).setTimestamp();
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success));
  const msg = await channel.send({ embeds: [embed], components: [row] });
  dbSaveVerify(guild.id, channel.id, msg.id);
}

// ─── Slot Rules Panel ─────────────────────────────────────────────────────────

async function sendSlotRules(guild) {
  const channel = guild.channels.cache.get(SLOT_RULES_CHANNEL_ID);
  if (!channel) return;
  const existing = dbGetRules(guild.id);
  if (existing) { const old = await channel.messages.fetch(existing.message_id).catch(()=>null); if (old) await old.delete().catch(()=>{}); }
  const N = '\n';
  const embed = new EmbedBuilder().setColor(0xf5c518).setTitle('📋  Drop Vault — Slot Rules')
    .setDescription('Welcome to **Drop Vault**. Slots are your personal space to advertise and sell products.' + N + N + 'Failure to comply = slot removed **without warning or refund**.')
    .addFields(
      { name:'✅ Eligibility', value:'> **15 vouches minimum** required.' + N + '> **Zero bad reviews** — any 1–3 star reviews disqualify you.' + N + '> **Proof of transactions** required.' },
      { name:'💳 Payment Proof', value:'> **Crypto** — on-chain TX hashes' + N + '> **PayPal** — screenshots with timestamps' + N + '> **CashApp** — screenshots with timestamps' + N + '> Must be unedited, show date, amount, and both parties.' },
      { name:'📦 Conduct', value:'> Advertise **your own products only**.' + N + '> No scamming, false advertising, or misleading listings.' + N + '> 1x `@here` and 1x `@everyone` per slot. Abuse = deleted + DM warning.' },
      { name:'⚠️ Enforcement', value:'> Violations = non-refundable removal.' + N + '> Scammers = permanent ban.' + N + '> Appeal via ticket or staff DM.' },
      { name:'🎉 Weekend Slots', value:'> Sat 12AM–Sun 11:59PM EST. Same rules apply.' }
    )
    .setFooter({ text: 'Drop Vault • Slot Rules' }).setTimestamp();
  const msg = await channel.send({ embeds: [embed] });
  await msg.pin().catch(()=>{});
  dbSaveRules(guild.id, msg.id);
}

// ─── Weekend ──────────────────────────────────────────────────────────────────

async function openWeekend(guild) {
  if (dbGetWeekendState(guild.id)) return;
  dbSetWeekendState(guild.id, true);
  const members = await guild.members.fetch();
  for (const [, m] of members) {
    if (m.user.bot || dbUserHasSlot(guild.id,m.id) || dbUserHasWeekend(guild.id,m.id)) continue;
    try {
      const ch = await createSlotChannel(guild, m.user, '🎉', null, WEEKEND_CATEGORY_NAME, true);
      dbSaveWeekend(ch.id, m.id, guild.id);
      await ch.send('🎉 Hey ' + m.toString() + ', enjoy your **Weekend Slot**!\n\n⏳ Through **Sunday 11:59 PM EST**.\n📢 1x `@here` and 1x `@everyone`.\n👥 Use `?talk @user` to invite people.');
    } catch(e) { console.error('Weekend slot error:', e); }
  }
}

async function closeWeekend(guild) {
  if (!dbGetWeekendState(guild.id)) return;
  for (const cid of dbAllWeekends(guild.id)) {
    const ch = guild.channels.cache.get(cid); if (ch) await ch.delete().catch(()=>{});
    dbDeleteWeekend(cid);
  }
  const cat = guild.channels.cache.find(c => c.type===ChannelType.GuildCategory && c.name===WEEKEND_CATEGORY_NAME);
  if (cat) await cat.delete().catch(()=>{});
  dbSetWeekendState(guild.id, false);
}

function scheduleWeekend() {
  setInterval(async () => {
    const now = new Date(Date.now() - 5*3600000);
    const [day,hour,min] = [now.getUTCDay(), now.getUTCHours(), now.getUTCMinutes()];
    for (const [, guild] of client.guilds.cache) {
      if (day===6 && hour===0 && min===0) await openWeekend(guild).catch(console.error);
      if (day===0 && hour===23 && min===59) await closeWeekend(guild).catch(console.error);
    }
  }, 60000);
}

// ─── Expiry + Auto-features ───────────────────────────────────────────────────

async function checkExpiredSlots() {
  // Regular slot expiry
  for (const cid of dbAllSlots()) {
    const data = dbGetSlot(cid); if (!data || !data.expiresAt) continue;
    if (Date.now() < data.expiresAt) {
      try {
        const guild = client.guilds.cache.get(data.guildId); if (!guild) continue;
        const ch = guild.channels.cache.get(cid); if (!ch) continue;
        const m = await guild.members.fetch(data.userId).catch(()=>null); if (!m) continue;
        const newName = channelName(data.emoji, m.user.username, data.expiresAt);
        if (ch.name !== newName) await ch.setName(newName).catch(()=>{});
      } catch {}
      continue;
    }
    try { const guild = client.guilds.cache.get(data.guildId); if (guild) { const ch = guild.channels.cache.get(cid); if (ch) await ch.delete().catch(()=>{}); } } catch {}
    dbDeleteSlot(cid, 'expired');
  }

  // Claim slot expiry — revert to unclaimed
  for (const [, guild] of client.guilds.cache) {
    for (const row of dbAllClaimSlots(guild.id)) {
      if (!row.claimed_by || !row.expires_at || Date.now() < row.expires_at) continue;
      const ch = guild.channels.cache.get(row.channel_id);
      if (ch) {
        await ch.permissionOverwrites.edit(row.claimed_by, { [PermissionFlagsBits.SendMessages]: false, [PermissionFlagsBits.ViewChannel]: false }).catch(()=>{});
        await ch.permissionOverwrites.edit(MEMBER_ROLE_ID, { [PermissionFlagsBits.ViewChannel]: true, [PermissionFlagsBits.ReadMessageHistory]: true }).catch(()=>{});
        await ch.setName('🎟️-unclaimed-slot').catch(()=>{});
        await ch.send('⏰ This slot expired and is available to claim again. Type `?claimslot` to grab it!');
      }
      // Remove from regular slots table too
      db.prepare('DELETE FROM slots WHERE channel_id=?').run(row.channel_id);
      db.prepare('UPDATE claim_slots SET claimed_by=NULL, claimed_at=NULL, expires_at=NULL WHERE channel_id=?').run(row.channel_id);
    }
  }

  // Auto-lock inactive slots
  for (const [, guild] of client.guilds.cache) {
    const cfg = dbGetConfig(guild.id);
    if (!cfg.autolock_days) continue;
    const threshold = cfg.autolock_days * 86400000;
    for (const row of dbAllGuildSlots(guild.id)) {
      if (row.locked || row.inf_mentions) continue;
      if (!row.last_activity) continue;
      if (Date.now() - row.last_activity < threshold) continue;
      const ch = guild.channels.cache.get(row.channel_id); if (!ch) continue;
      await ch.permissionOverwrites.edit(row.user_id, { [PermissionFlagsBits.SendMessages]: false }).catch(()=>{});
      dbSetLocked(row.channel_id, true);
      await ch.send('🔒 This slot has been automatically locked due to **' + cfg.autolock_days + ' days of inactivity**. Contact an admin to unlock it.');
    }
  }

  // Expiry reminders (3 days warning)
  for (const r of dbAllReminders()) {
    const row = dbGetSlotByUser(r.guild_id, r.user_id); if (!row || !row.expires_at) continue;
    const d = daysLeft(row.expires_at);
    if (d !== 3) continue;
    const user = await client.users.fetch(r.user_id).catch(()=>null); if (!user) continue;
    user.send('⏰ **Drop Vault Reminder** — Your slot expires in **3 days** (' + new Date(row.expires_at).toLocaleDateString('en-US') + '). Contact an admin to renew!').catch(()=>{});
  }

  // Suspended slot checks
  for (const [, guild] of client.guilds.cache) {
    for (const row of dbAllGuildSlots(guild.id)) {
      if (!row.suspended_until || row.suspended_until > Date.now()) continue;
      const ch = guild.channels.cache.get(row.channel_id); if (!ch) continue;
      await ch.permissionOverwrites.edit(row.user_id, { [PermissionFlagsBits.SendMessages]: true }).catch(()=>{});
      db.prepare('UPDATE slots SET suspended_until=NULL, locked=0 WHERE channel_id=?').run(row.channel_id);
      await ch.send('✅ This slot suspension has expired. Access restored.');
    }
  }
}

// ─── Help Embed ───────────────────────────────────────────────────────────────

function buildHelpEmbed(section) {
  const N = '\n';
  const sections = {
    main: () => new EmbedBuilder().setColor(0x5865f2).setTitle('📖  Drop Vault — Command Reference')
      .setDescription('Use `?help <section>` for details on a category.')
      .addFields(
        { name:'📊 Info', value:'`?help info`', inline:true },
        { name:'👥 Talk', value:'`?help talk`', inline:true },
        { name:'⏳ Time', value:'`?help time`', inline:true },
        { name:'🔇 Restrict', value:'`?help restrict`', inline:true },
        { name:'❌ Remove', value:'`?help remove`', inline:true },
        { name:'🔁 Transfer', value:'`?help transfer`', inline:true },
        { name:'🛡️ Moderation', value:'`?help mod`', inline:true },
        { name:'🎟️ Claims', value:'`?help claims`', inline:true },
        { name:'🔐 Roles/Perms', value:'`?help perms`', inline:true },
        { name:'📢 Announce', value:'`?help announce`', inline:true },
        { name:'🧾 Audit', value:'`?help audit`', inline:true },
        { name:'🧠 Auto', value:'`?help auto`', inline:true },
        { name:'🧹 Cleanup', value:'`?help cleanup`', inline:true },
        { name:'💾 Backup', value:'`?help backup`', inline:true },
        { name:'⚙️ Config', value:'`?help config`', inline:true },
      ).setFooter({ text:'Drop Vault • ?help <section> for more' }),

    info: () => new EmbedBuilder().setColor(0x5865f2).setTitle('📊 Info & Viewing')
      .addFields({ name:'Commands', value:
        '`?slotinfo @user` — slot type, expiry, owner, invited users' + N +
        '`?myslot` — your own slot info' + N +
        '`?slots` — list all active slots (admin)' + N +
        '`?listtalkers` — who has access to this slot' + N +
        '`?slotstats` — server slot statistics (admin)' + N +
        '`?slothistory @user` — past slot history (admin)' + N +
        '`?slotleaderboard` — most slot history' + N +
        '`?slotsummary @user` — quick condensed info (admin)' + N +
        '`?findslot #channel` — who owns a channel (admin)' + N +
        '`?slotcreatedby #channel` — which admin created it (admin)' + N +
        '`?topslots` — most active slots by message count (admin)' + N +
        '`?slotgrowth` — new slots in last 30 days (admin)' + N +
        '`?expiringsoon` — slots expiring within 3 days (admin)' + N +
        '`?filterslots <type>` — list slots by subtype (admin)' }),

    talk: () => new EmbedBuilder().setColor(0x5865f2).setTitle('👥 Talk / Invite Controls')
      .addFields({ name:'Commands', value:
        '`?talk @user ...` — invite users to your slot' + N +
        '`?removetalk @user ...` — remove invited users' + N +
        '`?revokealltalk` — remove ALL invited users' + N +
        '`?listtalkers` — show current invited users' + N +
        '`?talklimit <number>` — set max invited users (0=unlimited)' }),

    time: () => new EmbedBuilder().setColor(0x5865f2).setTitle('⏳ Managing Time (Admin)')
      .addFields({ name:'Commands', value:
        '`?extendslot <days> @user` — add days' + N +
        '`?reduceslot <days> @user` — remove days' + N +
        '`?setslotexpiry <YYYY-MM-DD> @user` — set exact date' + N +
        '`?renewslot @user` — renew with default duration' + N +
        '`?remindme` — opt in/out of 3-day expiry DM reminder' }),

    restrict: () => new EmbedBuilder().setColor(0x5865f2).setTitle('🔇 Restrictions (Admin)')
      .addFields({ name:'Commands', value:
        '`?muteslot @user` — remove owner send perms temporarily' + N +
        '`?unmuteslot @user` — restore send perms' + N +
        '`?lockslot @user` — lock slot (no one can send)' + N +
        '`?unlockslot @user` — unlock slot' + N +
        '`?tempsuspend @user <days>` — suspend slot for X days' + N +
        '`?appeal` — mark your slot as under appeal' }),

    remove: () => new EmbedBuilder().setColor(0x5865f2).setTitle('❌ Removals (Admin)')
      .addFields({ name:'Commands', value:
        '`?removeslot @user` — remove a slot' + N +
        '`?revokeslot @user` — alias for removeslot' + N +
        '`?terminateslot @user` — instant delete' + N +
        '`?blacklistslot @user <reason>` — prevent future slots' + N +
        '`?unblacklistslot @user` — remove blacklist' + N +
        '`?strike @user` — add a strike (3 = auto-revoke)' }),

    transfer: () => new EmbedBuilder().setColor(0x5865f2).setTitle('🔁 Transfers (Admin)')
      .addFields({ name:'Commands', value:
        '`?transferslot @from @to` — transfer ownership' + N +
        '`?forcetransfer @from @to` — admin override transfer' + N +
        '`?swapslots @user1 @user2` — swap two slots' }),

    mod: () => new EmbedBuilder().setColor(0x5865f2).setTitle('🛡️ Moderation (Admin)')
      .addFields({ name:'Commands', value:
        '`?warnuser @user <reason>` — log a warning' + N +
        '`?warnings @user` — view warning history' + N +
        '`?clearwarnings @user` — wipe warnings' + N +
        '`?strike @user` — add a strike (3 = auto-revoke)' + N +
        '`?clearstrikes @user` — wipe strikes' + N +
        '`?blacklistslot @user <reason>` — blacklist from future slots' + N +
        '`?unblacklistslot @user` — remove from blacklist' + N +
        '`?tempsuspend @user <days>` — suspend slot temporarily' }),

    claims: () => new EmbedBuilder().setColor(0x5865f2).setTitle('🎟️ Claim Slots')
      .addFields({ name:'Commands', value:
        '`?setclaim <number>` — create N claimable slots (admin)' + N +
        '`?claimslot` — claim an unclaimed slot (Member role required)' + N +
        '`?claimslots` — list all claim slots and their status (admin)' + N +
        '`?unclaimslot #channel` — force-reset a claimed slot (admin)' }),

    perms: () => new EmbedBuilder().setColor(0x5865f2).setTitle('🔐 Roles & Permissions (Admin)')
      .addFields({ name:'Commands', value:
        '`?slotrole @user <@role>` — assign a custom role in a slot channel' + N +
        '`?removeslotrole @user <@role>` — remove that role' + N +
        '`?slotperms @user` — view permissions for a slot' + N +
        '`?inheritperms on/off` — toggle invited users inheriting base perms' + N +
        '`?setslottype @user <private/public/premium/event>` — set slot subtype' + N +
        '`?upgradeslot @user <subtype>` — alias for setslottype' + N +
        '`?slotcolor <hex>` — set bot embed color for this slot' + N +
        '`?rename #channel <name>` — rename a slot channel' }),

    announce: () => new EmbedBuilder().setColor(0x5865f2).setTitle('📢 Announcements (Admin)')
      .addFields({ name:'Commands', value:
        '`?announce @user <message>` — send message to a user\'s slot' + N +
        '`?announceall <message>` — broadcast to ALL active slots' + N +
        '`?slotdm @user <message>` — DM a slot owner via bot' }),

    audit: () => new EmbedBuilder().setColor(0x5865f2).setTitle('🧾 Audit & Transparency (Admin)')
      .addFields({ name:'Commands', value:
        '`?slotaudit @user` — full breakdown of slot actions' + N +
        '`?recentactions` — last 10 mod actions' + N +
        '`?modstats` — which admin performed the most actions' + N +
        '`?slotcreatedby #channel` — which admin created the slot' }),

    auto: () => new EmbedBuilder().setColor(0x5865f2).setTitle('🧠 Automation (Admin)')
      .addFields({ name:'Commands', value:
        '`?autolock on/off` — auto-lock slots after inactivity' + N +
        '`?autorotate on/off` — auto-transfer if inactive 3 days' + N +
        '`?activitythreshold <messages>` — min activity required' + N +
        '`?autosuspend <days>` — auto-lock slots inactive X days' + N +
        '`?remindme` — opt in/out of expiry DM reminders' }),

    cleanup: () => new EmbedBuilder().setColor(0x5865f2).setTitle('🧹 Cleanup & Maintenance (Admin)')
      .addFields({ name:'Commands', value:
        '`?orphanedslots` — slots with missing channels' + N +
        '`?slotcheck` — scan all slots for issues' + N +
        '`?fixperms #channel` — reset permissions to template' + N +
        '`?rebuildslot @user` — recreate channel structure' + N +
        '`?bulkextend <days>` — extend ALL timed slots' + N +
        '`?reloadslots` — re-sync DB with Discord (debug)' + N +
        '`?debugslot @user` — raw slot data (debug)' + N +
        '`?dbcheck @user` — check DB integrity for user (debug)' + N +
        '`?forcerefreshperms @user` — reapply all permissions' }),

    backup: () => new EmbedBuilder().setColor(0x5865f2).setTitle('💾 Backup & Restore (Admin)')
      .addFields({ name:'Commands', value:
        '`?backupslot @user` — save slot permission snapshot' + N +
        '`?restoreslot @user` — restore from last backup' }),

    config: () => new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Configuration (Admin)')
      .addFields({ name:'Commands', value:
        '`?setslotlimit <number>` — max total slots (0=unlimited)' + N +
        '`?setdefaultduration <days>` — default slot duration' + N +
        '`?slotcooldown <hours>` — cooldown after slot removal' + N +
        '`?inheritperms on/off` — invited users inherit base perms' + N +
        '`?autolock on/off` — auto-lock inactive slots' + N +
        '`?autorotate on/off` — auto-transfer inactive slots' + N +
        '`?activitythreshold <messages>` — min activity before autolock' + N +
        '`?autosuspend <days>` — set inactivity threshold in days' }),
  };
  const fn = sections[section] ?? sections.main;
  return fn();
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  try { const r = member.guild.roles.cache.get(NEWBIE_ROLE_ID); if(r) await member.roles.add(r); } catch {}
  if (dbGetWeekendState(member.guild.id) && !dbUserHasSlot(member.guild.id, member.id)) {
    try {
      const ch = await createSlotChannel(member.guild, member.user, '🎉', null, WEEKEND_CATEGORY_NAME, true);
      dbSaveWeekend(ch.id, member.id, member.guild.id);
      await ch.send('🎉 Hey ' + member.toString() + ', enjoy your **Weekend Slot**!\n\n⏳ Through Sunday 11:59PM EST.\n📢 1x `@here` and 1x `@everyone`.');
    } catch {}
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== VERIFY_BUTTON_ID) return;
  const { member, guild } = interaction;
  try {
    if (member.roles.cache.has(MEMBER_ROLE_ID)) return interaction.reply({ content:"✅ Already verified!", ephemeral:true });
    const mr = guild.roles.cache.get(MEMBER_ROLE_ID);
    const nr = guild.roles.cache.get(NEWBIE_ROLE_ID);
    if (mr) await member.roles.add(mr);
    if (nr) await member.roles.remove(nr).catch(()=>{});
    await interaction.reply({ content:'✅ Verified! You now have the <@&' + MEMBER_ROLE_ID + '> role. Welcome!', ephemeral:true });
  } catch(e) {
    console.error('Verify error:', e);
    await interaction.reply({ content:'❌ Something went wrong. Contact an admin.', ephemeral:true });
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const { content, member, guild, channel } = message;
  const args = content.trim().split(/\s+/);
  const cmd  = args[0]?.toLowerCase();

  // Track activity
  const slotActivity = dbGetSlot(channel.id);
  if (slotActivity) dbSetActivity(channel.id);

  // ══ ?help ══════════════════════════════════════════════════════════════════
  if (cmd === '?help') {
    const section = args[1]?.toLowerCase() ?? 'main';
    return message.reply({ embeds: [buildHelpEmbed(section)] });
  }

  // ══ PANELS ═════════════════════════════════════════════════════════════════
  if (cmd === '?sendverify') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    await sendVerifyPanel(guild); return message.reply('✅ Verify panel sent!');
  }
  if (cmd === '?slotrules') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    await sendSlotRules(guild); return message.reply('✅ Rules posted!');
  }

  // ══ INFO ═══════════════════════════════════════════════════════════════════
  if (cmd === '?slots') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const rows = dbAllGuildSlots(guild.id);
    if (!rows.length) return message.reply('No active slots.');
    const lines = rows.map(r => {
      const exp = r.expires_at ? daysLeft(r.expires_at) + 'd' : '∞';
      const st = r.locked ? '🔒' : r.muted ? '🔇' : r.appeal ? '⚖️' : '✅';
      return st + ' ' + r.emoji + ' <@' + r.user_id + '> — ' + r.type + ' (' + exp + ') [' + (r.slot_subtype||'private') + ']';
    });
    const embed = makeEmbed().setTitle('🎰 Active Slots — ' + rows.length).setDescription(lines.join('\n')).setTimestamp();
    return message.reply({ embeds:[embed] });
  }

  if (cmd === '?slotstats') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const all = dbAllGuildSlots(guild.id);
    const claims = dbAllClaimSlots(guild.id);
    const embed = makeEmbed().setTitle('📈 Slot Statistics')
      .addFields(
        { name:'Total Active', value:''+all.length, inline:true },
        { name:'Permanent', value:''+all.filter(r=>!r.expires_at).length, inline:true },
        { name:'Timed', value:''+all.filter(r=>r.expires_at).length, inline:true },
        { name:'Expiring ≤3 days', value:''+all.filter(r=>r.expires_at&&daysLeft(r.expires_at)<=3).length, inline:true },
        { name:'Locked', value:''+all.filter(r=>r.locked).length, inline:true },
        { name:'Muted', value:''+all.filter(r=>r.muted).length, inline:true },
        { name:'Claim Slots', value:''+claims.length, inline:true },
        { name:'Unclaimed', value:''+claims.filter(r=>!r.claimed_by).length, inline:true },
        { name:'Under Appeal', value:''+all.filter(r=>r.appeal).length, inline:true },
      ).setTimestamp();
    return message.reply({ embeds:[embed] });
  }

  if (cmd === '?slotinfo') {
    const target = message.mentions.members.first() ?? member;
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply('❌ **' + target.user.username + '** has no active slot.');
    const talkers = dbGetTalkUsers(row.channel_id);
    const roles = dbGetSlotRoles(row.channel_id);
    const embed = makeEmbed(row.color).setTitle(row.emoji + ' ' + target.user.username + "'s Slot")
      .addFields(
        { name:'Type', value:slotTypeLabel(row.type), inline:true },
        { name:'Subtype', value:SLOT_SUBTYPES[row.slot_subtype]?.label ?? '🔒 Private', inline:true },
        { name:'Channel', value:'<#' + row.channel_id + '>', inline:true },
        { name:'Expiry', value:fmtExpiry(row.expires_at), inline:false },
        { name:'Status', value:row.locked?'🔒 Locked':row.muted?'🔇 Muted':row.appeal?'⚖️ Under Appeal':'✅ Active', inline:true },
        { name:'@here', value:row.here_used?'✅ Used':'❌ Available', inline:true },
        { name:'@everyone', value:row.everyone_used?'✅ Used':'❌ Available', inline:true },
        { name:'Invited (' + talkers.length + ')', value:talkers.length?talkers.map(u=>'<@'+u+'>').join(', '):'None' },
        { name:'Slot Roles', value:roles.length?roles.map(r=>'<@&'+r+'>').join(', '):'None' },
      ).setTimestamp();
    return message.reply({ embeds:[embed] });
  }

  if (cmd === '?myslot') {
    const row = dbGetSlotByUser(guild.id, member.id);
    if (!row) return message.reply("❌ You don't have an active slot.");
    const talkers = dbGetTalkUsers(row.channel_id);
    const embed = makeEmbed(row.color).setTitle(row.emoji + ' Your Slot')
      .addFields(
        { name:'Type', value:slotTypeLabel(row.type), inline:true },
        { name:'Channel', value:'<#'+row.channel_id+'>', inline:true },
        { name:'Subtype', value:SLOT_SUBTYPES[row.slot_subtype]?.label??'🔒 Private', inline:true },
        { name:'Expiry', value:fmtExpiry(row.expires_at) },
        { name:'Status', value:row.locked?'🔒 Locked':row.muted?'🔇 Muted':row.appeal?'⚖️ Appeal':'✅ Active', inline:true },
        { name:'Invited', value:talkers.length?talkers.map(u=>'<@'+u+'>').join(', '):'None' },
      ).setTimestamp();
    return message.reply({ embeds:[embed] });
  }

  if (cmd === '?slotsummary') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply('❌ No active slot.');
    const warns = dbGetWarnings(guild.id, target.id).length;
    const strikes = dbGetStrikes(guild.id, target.id);
    const history = dbGetHistory(guild.id, target.id).length;
    return message.reply(
      row.emoji + ' **' + target.user.username + '** — ' + slotTypeLabel(row.type) +
      ' | ' + fmtExpiry(row.expires_at) +
      ' | Status: ' + (row.locked?'🔒':row.muted?'🔇':'✅') +
      ' | ⚠️ ' + warns + ' warns | ⛔ ' + strikes + ' strikes | 📜 ' + history + ' total slots'
    );
  }

  if (cmd === '?listtalkers') {
    const slotData = dbGetSlot(channel.id);
    if (!slotData) return message.reply('❌ Not a slot channel.');
    const talkers = dbGetTalkUsers(channel.id);
    if (!talkers.length) return message.reply('No invited users.');
    return message.reply({ embeds:[makeEmbed(slotData.color).setTitle('👥 Invited Users').setDescription(talkers.map((u,i)=>(i+1)+'. <@'+u+'>').join('\n')).setFooter({ text:talkers.length + ' user(s)' })] });
  }

  if (cmd === '?slothistory') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const history = dbGetHistory(guild.id, target.id);
    if (!history.length) return message.reply('No history for **' + target.user.username + '**.');
    const lines = history.map(r => r.emoji + ' **' + r.type + '** — ' + new Date(r.opened_at).toLocaleDateString('en-US') + ' → ' + (r.closed_at?new Date(r.closed_at).toLocaleDateString('en-US'):'Active') + (r.close_reason?' ('+r.close_reason+')':''));
    return message.reply({ embeds:[makeEmbed().setTitle('📜 Slot History — ' + target.user.username).setDescription(lines.join('\n')).setTimestamp()] });
  }

  if (cmd === '?slotleaderboard') {
    const rows = db.prepare('SELECT user_id, COUNT(*) as total FROM slot_history WHERE guild_id=? GROUP BY user_id ORDER BY total DESC LIMIT 10').all(guild.id);
    if (!rows.length) return message.reply('No history yet.');
    const lines = rows.map((r,i) => '**'+(i+1)+'.** <@'+r.user_id+'> — '+r.total+' slot(s)');
    return message.reply({ embeds:[makeEmbed().setTitle('🏆 Slot Leaderboard').setDescription(lines.join('\n')).setTimestamp()] });
  }

  if (cmd === '?topslots') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const rows = dbAllGuildSlots(guild.id);
    const sorted = rows.filter(r=>r.last_activity).sort((a,b)=>b.last_activity-a.last_activity).slice(0,10);
    if (!sorted.length) return message.reply('No activity data yet.');
    const lines = sorted.map((r,i) => '**'+(i+1)+'.** '+r.emoji+' <@'+r.user_id+'> — Last active: <t:'+Math.floor(r.last_activity/1000)+':R>');
    return message.reply({ embeds:[makeEmbed().setTitle('📊 Most Recently Active Slots').setDescription(lines.join('\n')).setTimestamp()] });
  }

  if (cmd === '?slotgrowth') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const since = Date.now() - 30*86400000;
    const rows = db.prepare('SELECT * FROM slot_history WHERE guild_id=? AND opened_at > ?').all(guild.id, since);
    return message.reply({ embeds:[makeEmbed().setTitle('📈 Slot Growth (Last 30 Days)').addFields({ name:'New Slots', value:''+rows.length, inline:true },{ name:'Types', value:['free','week','month','perm'].map(t=>t+': '+rows.filter(r=>r.type===t).length).join(' | ') }).setTimestamp()] });
  }

  if (cmd === '?expiringsoon') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const soon = dbAllGuildSlots(guild.id).filter(r=>r.expires_at&&daysLeft(r.expires_at)<=3);
    if (!soon.length) return message.reply('No slots expiring within 3 days.');
    const lines = soon.map(r=>'⚠️ '+r.emoji+' <@'+r.user_id+'> — '+fmtExpiry(r.expires_at));
    return message.reply({ embeds:[makeEmbed().setTitle('⚠️ Expiring Soon').setDescription(lines.join('\n')).setTimestamp()] });
  }

  if (cmd === '?filterslots') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const type = args[1]?.toLowerCase();
    if (!type) return message.reply('❌ Usage: `?filterslots <private/public/premium/event/free/week/month/perm>`');
    const rows = dbAllGuildSlots(guild.id).filter(r => r.slot_subtype===type || r.type===type);
    if (!rows.length) return message.reply('No slots of type **' + type + '**.');
    const lines = rows.map(r=>r.emoji+' <@'+r.user_id+'> — '+r.type+' ['+r.slot_subtype+']');
    return message.reply({ embeds:[makeEmbed().setTitle('🔍 Slots: ' + type + ' (' + rows.length + ')').setDescription(lines.join('\n'))] });
  }

  if (cmd === '?findslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('❌ Mention a channel.');
    const row = dbGetSlot(ch.id);
    const claim = dbGetClaimSlot(ch.id);
    if (!row && !claim) return message.reply('❌ That channel is not a registered slot.');
    if (claim && !claim.claimed_by) return message.reply('🎟️ That is an **unclaimed** claim slot.');
    const uid = row?.user_id ?? claim?.claimed_by;
    return message.reply('🔍 That slot belongs to <@'+uid+'>.');
  }

  if (cmd === '?slotcreatedby') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('❌ Mention a channel.');
    const row = dbGetSlot(ch.id);
    if (!row) return message.reply('❌ Not a registered slot.');
    const by = row.created_by ? '<@'+row.created_by+'>' : 'Unknown (created before logging)';
    return message.reply('🔍 <#'+ch.id+'> was created by **' + by + '**.');
  }

  // ══ TALK CONTROLS ══════════════════════════════════════════════════════════
  if (cmd === '?talk') {
    const sd = dbGetSlot(channel.id); const wd = dbGetWeekend(channel.id);
    const ownerId = sd?.userId ?? wd?.user_id ?? null;
    if (!ownerId) return;
    if (message.author.id !== ownerId) return message.reply('❌ Only the slot owner can use `?talk`.');
    const targets = message.mentions.members;
    if (!targets?.size) return message.reply('❌ Mention at least one user.');
    if (sd?.talkLimit > 0 && dbTalkCount(channel.id) >= sd.talkLimit)
      return message.reply('❌ Talk limit reached (' + sd.talkLimit + ' users max).');
    const cfg = dbGetConfig(guild.id);
    const added = [];
    for (const [,t] of targets) {
      if (t.id === ownerId) continue;
      const perms = { [PermissionFlagsBits.SendMessages]:true, [PermissionFlagsBits.ViewChannel]:true, [PermissionFlagsBits.ReadMessageHistory]:true };
      if (cfg.inherit_perms) { perms[PermissionFlagsBits.AttachFiles]=true; perms[PermissionFlagsBits.EmbedLinks]=true; }
      await channel.permissionOverwrites.edit(t.id, perms).catch(()=>{});
      if (sd) dbAddTalkUser(channel.id, t.id);
      added.push(t.toString());
    }
    if (added.length) return message.reply('✅ Invited ' + added.join(', '));
  }

  if (cmd === '?removetalk' || cmd === '?revoketalk' || cmd === '?untalk') {
    const sd = dbGetSlot(channel.id); if (!sd) return;
    if (message.author.id !== sd.userId && !isAdmin(member,guild)) return message.reply('❌ Only the slot owner or admins.');
    const targets = message.mentions.members;
    if (!targets?.size) return message.reply('❌ Mention at least one user.');
    const removed = [];
    for (const [,t] of targets) {
      if (t.id === sd.userId) continue;
      await channel.permissionOverwrites.edit(t.id, { [PermissionFlagsBits.SendMessages]:false }).catch(()=>{});
      dbRemoveTalkUser(channel.id, t.id);
      removed.push(t.toString());
    }
    if (removed.length) return message.reply('✅ Removed ' + removed.join(', '));
  }

  if (cmd === '?revokealltalk') {
    const sd = dbGetSlot(channel.id); if (!sd) return;
    if (message.author.id !== sd.userId && !isAdmin(member,guild)) return message.reply('❌ Only the slot owner or admins.');
    const talkers = dbGetTalkUsers(channel.id);
    if (!talkers.length) return message.reply('No invited users to remove.');
    for (const uid of talkers) await channel.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]:false }).catch(()=>{});
    dbClearTalkUsers(channel.id);
    return message.reply('✅ Removed all ' + talkers.length + ' invited user(s).');
  }

  if (cmd === '?talklimit') {
    const sd = dbGetSlot(channel.id); if (!sd) return;
    if (message.author.id !== sd.userId && !isAdmin(member,guild)) return message.reply('❌ Only the slot owner or admins.');
    const n = parseInt(args[1]);
    if (isNaN(n)||n<0) return message.reply('❌ Usage: `?talklimit <number>` (0=unlimited)');
    dbSetTalkLimit(channel.id, n);
    return message.reply('✅ Talk limit set to **' + (n===0?'unlimited':n) + '**.');
  }

  // ══ TIME MANAGEMENT ════════════════════════════════════════════════════════
  if (cmd === '?extendslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const days = parseInt(args[1]); const target = message.mentions.members.first();
    if (!target||isNaN(days)||days<1) return message.reply('❌ Usage: `?extendslot <days> @user`');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply('❌ No active slot.');
    if (!row.expires_at) return message.reply('❌ Slot is permanent.');
    const newExp = row.expires_at + days*86400000;
    db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    dbAudit(guild.id, 'extend', target.id, member.id, '+'+days+'d');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) { const m2=await guild.members.fetch(target.id).catch(()=>null); if(m2) await ch.setName(channelName(row.emoji,m2.user.username,newExp)).catch(()=>{}); }
    return message.reply('✅ Extended by ' + days + 'd. New expiry: ' + fmtExpiry(newExp));
  }

  if (cmd === '?reduceslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const days = parseInt(args[1]); const target = message.mentions.members.first();
    if (!target||isNaN(days)||days<1) return message.reply('❌ Usage: `?reduceslot <days> @user`');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row||!row.expires_at) return message.reply('❌ No timed slot found.');
    const newExp = Math.max(row.expires_at - days*86400000, Date.now()+60000);
    db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    dbAudit(guild.id, 'reduce', target.id, member.id, '-'+days+'d');
    return message.reply('✅ Reduced by ' + days + 'd. New expiry: ' + fmtExpiry(newExp));
  }

  if (cmd === '?setslotexpiry') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const dateStr = args[1]; const target = message.mentions.members.first();
    if (!target||!dateStr) return message.reply('❌ Usage: `?setslotexpiry <YYYY-MM-DD> @user`');
    const newExp = new Date(dateStr).getTime();
    if (isNaN(newExp)) return message.reply('❌ Invalid date. Use `YYYY-MM-DD`.');
    if (newExp <= Date.now()) return message.reply('❌ Date must be in the future.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply('❌ No active slot.');
    db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    dbAudit(guild.id, 'setexpiry', target.id, member.id, dateStr);
    return message.reply('✅ Expiry set to ' + fmtExpiry(newExp));
  }

  if (cmd === '?renewslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row||!row.expires_at) return message.reply('❌ No timed slot found.');
    const newExp = Date.now() + dbGetConfig(guild.id).default_duration;
    db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    dbAudit(guild.id, 'renew', target.id, member.id, 'renewed');
    return message.reply('✅ Renewed. New expiry: ' + fmtExpiry(newExp));
  }

  if (cmd === '?remindme') {
    const row = dbGetSlotByUser(guild.id, member.id);
    if (!row) return message.reply("❌ You don't have an active slot.");
    const existing = dbGetRemind(guild.id, member.id);
    if (existing?.enabled) {
      db.prepare('UPDATE remindme SET enabled=0 WHERE guild_id=? AND user_id=?').run(guild.id, member.id);
      return message.reply('🔕 Expiry reminders **disabled**.');
    } else {
      dbSetRemind(guild.id, member.id, channel.id);
      return message.reply('🔔 Expiry reminders **enabled** — you\'ll get a DM 3 days before expiry.');
    }
  }

  // ══ RESTRICTIONS ═══════════════════════════════════════════════════════════
  if (cmd === '?muteslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]:false }).catch(()=>{});
    dbSetMuted(row.channel_id, true);
    dbAudit(guild.id, 'mute', target.id, member.id, 'muted');
    return message.reply('🔇 **' + target.user.username + "'s** slot muted.");
  }

  if (cmd === '?unmuteslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]:true }).catch(()=>{});
    dbSetMuted(row.channel_id, false);
    dbAudit(guild.id, 'unmute', target.id, member.id, 'unmuted');
    return message.reply('✅ **' + target.user.username + "'s** slot unmuted.");
  }

  if (cmd === '?lockslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) {
      await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]:false }).catch(()=>{});
      for (const uid of dbGetTalkUsers(row.channel_id)) await ch.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]:false }).catch(()=>{});
    }
    dbSetLocked(row.channel_id, true);
    dbAudit(guild.id, 'lock', target.id, member.id, 'locked');
    return message.reply('🔒 **' + target.user.username + "'s** slot locked.");
  }

  if (cmd === '?unlockslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) {
      await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]:true }).catch(()=>{});
      for (const uid of dbGetTalkUsers(row.channel_id)) await ch.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]:true }).catch(()=>{});
    }
    dbSetLocked(row.channel_id, false);
    dbAudit(guild.id, 'unlock', target.id, member.id, 'unlocked');
    return message.reply('✅ **' + target.user.username + "'s** slot unlocked.");
  }

  if (cmd === '?tempsuspend') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const days = parseInt(args[1]); const target = message.mentions.members.first();
    if (!target||isNaN(days)||days<1) return message.reply('❌ Usage: `?tempsuspend <days> @user`');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const until = Date.now() + days*86400000;
    db.prepare('UPDATE slots SET suspended_until=?, locked=1 WHERE channel_id=?').run(until, row.channel_id);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) {
      await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]:false }).catch(()=>{});
      await ch.send('⏸️ This slot has been suspended for **' + days + ' day(s)**. It will auto-unlock on ' + new Date(until).toLocaleDateString('en-US') + '.');
    }
    dbAudit(guild.id, 'suspend', target.id, member.id, days+'d');
    return message.reply('⏸️ **' + target.user.username + "'s** slot suspended for " + days + ' day(s).');
  }

  if (cmd === '?appeal') {
    const row = dbGetSlotByUser(guild.id, member.id);
    if (!row) return message.reply("❌ You don't have an active slot.");
    dbSetAppeal(row.channel_id, true);
    dbAudit(guild.id, 'appeal', member.id, member.id, 'appeal filed');
    return message.reply('⚖️ Your slot has been marked **under appeal**. An admin will review it shortly.');
  }

  // ══ REMOVALS ═══════════════════════════════════════════════════════════════
  if (cmd === '?removeslot' || cmd === '?revokeslot' || cmd === '?terminateslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const cfg = dbGetConfig(guild.id);
    if (cfg.cooldown_ms > 0) dbSetCooldown(guild.id, target.id, Date.now() + cfg.cooldown_ms);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.delete().catch(()=>{});
    const reason = cmd==='?terminateslot' ? 'terminated' : 'removed';
    dbDeleteSlot(row.channel_id, reason);
    dbAudit(guild.id, reason, target.id, member.id, reason);
    return message.reply('✅ Slot removed for **' + target.user.username + '**.');
  }

  if (cmd === '?blacklistslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const reason = args.slice(2).join(' ') || 'No reason provided';
    dbBlacklist(guild.id, target.id, reason);
    dbAudit(guild.id, 'blacklist', target.id, member.id, reason);
    return message.reply('⛔ **' + target.user.username + '** blacklisted from future slots. Reason: ' + reason);
  }

  if (cmd === '?unblacklistslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    dbUnblacklist(guild.id, target.id);
    dbAudit(guild.id, 'unblacklist', target.id, member.id, 'removed from blacklist');
    return message.reply('✅ **' + target.user.username + '** removed from blacklist.');
  }

  if (cmd === '?strike') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const count = dbAddStrike(guild.id, target.id);
    dbAudit(guild.id, 'strike', target.id, member.id, 'strike '+count);
    if (count >= 3) {
      // Auto-revoke
      const row = dbGetSlotByUser(guild.id, target.id);
      if (row) {
        const ch = guild.channels.cache.get(row.channel_id);
        if (ch) await ch.delete().catch(()=>{});
        dbDeleteSlot(row.channel_id, 'auto-revoked (3 strikes)');
        dbAudit(guild.id, 'auto-revoke', target.id, client.user.id, '3 strikes');
      }
      dbClearStrikes(guild.id, target.id);
      return message.reply('⛔ **' + target.user.username + '** has received their **3rd strike** — slot automatically revoked!');
    }
    return message.reply('⚠️ Strike **' + count + '/3** issued to **' + target.user.username + '**.' + (count===2?' One more strike = auto-revoke!':''));
  }

  if (cmd === '?clearstrikes') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    dbClearStrikes(guild.id, target.id);
    return message.reply('✅ Strikes cleared for **' + target.user.username + '**.');
  }

  // ══ TRANSFERS ══════════════════════════════════════════════════════════════
  if (cmd === '?transferslot' || cmd === '?forcetransfer') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const mentions = [...message.mentions.members.values()];
    if (mentions.length < 2) return message.reply('❌ Mention two users: `?transferslot @from @to`');
    const [from, to] = mentions;
    const row = dbGetSlotByUser(guild.id, from.id); if (!row) return message.reply('❌ **' + from.user.username + '** has no slot.');
    if (dbUserHasSlot(guild.id, to.id)) return message.reply('❌ **' + to.user.username + '** already has a slot.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) {
      await ch.permissionOverwrites.edit(from.id, { [PermissionFlagsBits.SendMessages]:false, [PermissionFlagsBits.ViewChannel]:false }).catch(()=>{});
      await ch.permissionOverwrites.edit(to.id, { [PermissionFlagsBits.SendMessages]:true, [PermissionFlagsBits.ViewChannel]:true, [PermissionFlagsBits.ReadMessageHistory]:true, [PermissionFlagsBits.AttachFiles]:true, [PermissionFlagsBits.EmbedLinks]:true }).catch(()=>{});
      await ch.setName(channelName(row.emoji, to.user.username, row.expires_at)).catch(()=>{});
    }
    db.prepare('UPDATE slots SET user_id=? WHERE channel_id=?').run(to.id, row.channel_id);
    dbAudit(guild.id, 'transfer', to.id, member.id, from.id+' → '+to.id);
    return message.reply('✅ Slot transferred from **' + from.user.username + '** to **' + to.user.username + '**.');
  }

  if (cmd === '?swapslots') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const mentions = [...message.mentions.members.values()];
    if (mentions.length < 2) return message.reply('❌ Mention two users.');
    const [u1,u2] = mentions;
    const r1=dbGetSlotByUser(guild.id,u1.id); const r2=dbGetSlotByUser(guild.id,u2.id);
    if (!r1) return message.reply('❌ **' + u1.user.username + '** has no slot.');
    if (!r2) return message.reply('❌ **' + u2.user.username + '** has no slot.');
    db.prepare('UPDATE slots SET user_id=? WHERE channel_id=?').run(u2.id,r1.channel_id);
    db.prepare('UPDATE slots SET user_id=? WHERE channel_id=?').run(u1.id,r2.channel_id);
    const ch1=guild.channels.cache.get(r1.channel_id); const ch2=guild.channels.cache.get(r2.channel_id);
    if (ch1) { await ch1.permissionOverwrites.edit(u1.id,{[PermissionFlagsBits.SendMessages]:false}).catch(()=>{}); await ch1.permissionOverwrites.edit(u2.id,{[PermissionFlagsBits.SendMessages]:true,[PermissionFlagsBits.ViewChannel]:true}).catch(()=>{}); await ch1.setName(channelName(r1.emoji,u2.user.username,r1.expires_at)).catch(()=>{}); }
    if (ch2) { await ch2.permissionOverwrites.edit(u2.id,{[PermissionFlagsBits.SendMessages]:false}).catch(()=>{}); await ch2.permissionOverwrites.edit(u1.id,{[PermissionFlagsBits.SendMessages]:true,[PermissionFlagsBits.ViewChannel]:true}).catch(()=>{}); await ch2.setName(channelName(r2.emoji,u1.user.username,r2.expires_at)).catch(()=>{}); }
    dbAudit(guild.id,'swap',u1.id,member.id,u1.id+'↔'+u2.id);
    return message.reply('✅ Swapped slots between **' + u1.user.username + '** and **' + u2.user.username + '**.');
  }

  // ══ MODERATION ═════════════════════════════════════════════════════════════
  if (cmd === '?warnuser') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const reason = args.slice(2).join(' ') || 'No reason provided';
    dbAddWarning(guild.id, target.id, reason, member.id);
    const total = dbGetWarnings(guild.id, target.id).length;
    dbAudit(guild.id,'warn',target.id,member.id,reason);
    return message.reply('⚠️ Warning issued to **' + target.user.username + '**. They now have **' + total + '** warning(s). Reason: ' + reason);
  }

  if (cmd === '?warnings') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const warns = dbGetWarnings(guild.id, target.id);
    if (!warns.length) return message.reply('**' + target.user.username + '** has no warnings.');
    const lines = warns.map((w,i) => '**'+(i+1)+'.** '+w.reason+' — by <@'+w.issued_by+'> on '+new Date(w.issued_at).toLocaleDateString('en-US'));
    return message.reply({ embeds:[makeEmbed().setTitle('⚠️ Warnings — ' + target.user.username).setDescription(lines.join('\n'))] });
  }

  if (cmd === '?clearwarnings') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    dbClearWarnings(guild.id, target.id);
    dbAudit(guild.id,'clearwarnings',target.id,member.id,'cleared');
    return message.reply('✅ Warnings cleared for **' + target.user.username + '**.');
  }

  // ══ ANNOUNCEMENTS ══════════════════════════════════════════════════════════
  if (cmd === '?announce') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const msg = args.slice(2).join(' ');
    if (!msg) return message.reply('❌ Usage: `?announce @user <message>`');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply('❌ **' + target.user.username + '** has no active slot.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (!ch) return message.reply('❌ Could not find slot channel.');
    const embed = makeEmbed(row.color).setTitle('📢 Staff Announcement').setDescription(msg).setFooter({ text:'From: ' + member.user.username }).setTimestamp();
    await ch.send({ embeds:[embed] });
    dbAudit(guild.id,'announce',target.id,member.id,msg);
    return message.reply('✅ Announcement sent to **' + target.user.username + "'s** slot.");
  }

  if (cmd === '?announceall') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const msg = args.slice(1).join(' ');
    if (!msg) return message.reply('❌ Usage: `?announceall <message>`');
    const rows = dbAllGuildSlots(guild.id);
    let sent = 0;
    for (const row of rows) {
      const ch = guild.channels.cache.get(row.channel_id); if (!ch) continue;
      const embed = makeEmbed(row.color).setTitle('📢 Staff Announcement').setDescription(msg).setFooter({ text:'From: '+member.user.username+' • Sent to all slots' }).setTimestamp();
      await ch.send({ embeds:[embed] }).catch(()=>{});
      sent++;
    }
    dbAudit(guild.id,'announceall','all',member.id,msg);
    return message.reply('✅ Announcement sent to **' + sent + '** slot(s).');
  }

  if (cmd === '?slotdm') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const msg = args.slice(2).join(' ');
    if (!msg) return message.reply('❌ Usage: `?slotdm @user <message>`');
    const sent = await target.user.send('📬 **Staff message from Drop Vault** (sent by ' + member.user.username + '):\n\n' + msg).catch(()=>null);
    if (!sent) return message.reply('❌ Could not DM **' + target.user.username + '** — they may have DMs disabled.');
    dbAudit(guild.id,'slotdm',target.id,member.id,msg);
    return message.reply('✅ DM sent to **' + target.user.username + '**.');
  }

  // ══ CLAIMS ═════════════════════════════════════════════════════════════════
  if (cmd === '?setclaim') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const num = parseInt(args[1]);
    if (isNaN(num)||num<1||num>50) return message.reply('❌ Usage: `?setclaim <1-50>`');
    const category = await getOrCreateCategory(guild, SLOT_CATEGORY_NAME);
    const created = [];
    for (let i=0;i<num;i++) {
      try {
        const ch = await guild.channels.create({
          name:'🎟️-unclaimed-slot', type:ChannelType.GuildText, parent:category.id,
          permissionOverwrites:[
            { id:guild.roles.everyone.id, deny:[PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel] },
            { id:MEMBER_ROLE_ID, allow:[PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
            { id:client.user.id, allow:[PermissionFlagsBits.SendMessages,PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ReadMessageHistory] },
          ],
        });
        dbCreateClaimSlot(ch.id, guild.id);
        await ch.send('🎟️ **This slot is available to claim!**\n\n> Type `?claimslot` in this channel to claim it for **7 days**.\n> You must have the **Member** role.\n> Only one claim per member at a time.');
        created.push(ch);
      } catch(e) { console.error('Claim slot error:', e); }
    }
    dbAudit(guild.id,'setclaim',null,member.id,'created '+created.length);
    return message.reply('✅ Created **' + created.length + '** claimable slot(s)!');
  }

  if (cmd === '?claimslot') {
    const claimData = dbGetClaimSlot(channel.id); if (!claimData) return;
    if (!member.roles.cache.has(MEMBER_ROLE_ID)) return message.reply('❌ You need the **Member** role to claim a slot.');
    if (claimData.claimed_by) return message.reply('❌ This slot has already been claimed.');
    if (dbUserHasSlot(guild.id,member.id)) return message.reply('❌ You already have an active slot.');
    if (dbUserHasWeekend(guild.id,member.id)) return message.reply('❌ You already have a weekend slot.');
    if (dbUserHasClaim(guild.id,member.id)) return message.reply('❌ You have already claimed a slot.');
    if (dbIsBlacklisted(guild.id,member.id)) return message.reply('❌ You are blacklisted from claiming slots.');
    const exp = Date.now() + 7*86400000;
    dbClaimIt(channel.id, member.id, exp);
    await channel.permissionOverwrites.edit(MEMBER_ROLE_ID, { [PermissionFlagsBits.ViewChannel]:false, [PermissionFlagsBits.SendMessages]:false }).catch(()=>{});
    await channel.permissionOverwrites.edit(member.id, { [PermissionFlagsBits.SendMessages]:true, [PermissionFlagsBits.ViewChannel]:true, [PermissionFlagsBits.ReadMessageHistory]:true, [PermissionFlagsBits.AttachFiles]:true, [PermissionFlagsBits.EmbedLinks]:true, [PermissionFlagsBits.MentionEveryone]:true }).catch(()=>{});
    const safe = safeUser(member.user.username);
    await channel.setName('🎲-'+safe+'s-slot-7d').catch(()=>{});
    await channel.send('🎲 ' + member.toString() + ' has claimed this slot!\n\n⏳ Expires <t:'+Math.floor(exp/1000)+':R>.\n📢 1x `@here` and 1x `@everyone`.\n👥 Use `?talk @user` to invite people.');
    dbSaveSlot(channel.id, member.id, guild.id, 'free', '🎲', exp, false, 'claim');
    dbAudit(guild.id,'claim',member.id,member.id,'claimed slot');
  }

  if (cmd === '?claimslots') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const claims = dbAllClaimSlots(guild.id);
    if (!claims.length) return message.reply('No claim slots set up. Use `?setclaim <number>`.');
    const lines = claims.map(r => r.claimed_by ? '✅ <#'+r.channel_id+'> — claimed by <@'+r.claimed_by+'> | expires '+fmtExpiry(r.expires_at) : '🎟️ <#'+r.channel_id+'> — **Unclaimed**');
    return message.reply({ embeds:[makeEmbed().setTitle('🎟️ Claim Slots — ' + claims.length).setDescription(lines.join('\n')).setTimestamp()] });
  }

  if (cmd === '?unclaimslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const ch = message.mentions.channels.first(); if (!ch) return message.reply('❌ Mention a channel.');
    const claim = dbGetClaimSlot(ch.id); if (!claim) return message.reply('❌ Not a claim slot.');
    if (!claim.claimed_by) return message.reply('⚠️ That slot is already unclaimed.');
    await ch.permissionOverwrites.edit(claim.claimed_by, { [PermissionFlagsBits.SendMessages]:false, [PermissionFlagsBits.ViewChannel]:false }).catch(()=>{});
    await ch.permissionOverwrites.edit(MEMBER_ROLE_ID, { [PermissionFlagsBits.ViewChannel]:true, [PermissionFlagsBits.ReadMessageHistory]:true }).catch(()=>{});
    await ch.setName('🎟️-unclaimed-slot').catch(()=>{});
    await ch.send('🎟️ This slot has been reset by an admin and is available to claim again. Type `?claimslot` to grab it!');
    db.prepare('DELETE FROM slots WHERE channel_id=?').run(ch.id);
    db.prepare('UPDATE claim_slots SET claimed_by=NULL, claimed_at=NULL, expires_at=NULL WHERE channel_id=?').run(ch.id);
    dbAudit(guild.id,'unclaim',claim.claimed_by,member.id,'force unclaimed');
    return message.reply('✅ Claim slot reset and is now available again.');
  }

  // ══ ROLES & PERMS ══════════════════════════════════════════════════════════
  if (cmd === '?slotrole') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    const role = message.mentions.roles.first();
    if (!target||!role) return message.reply('❌ Usage: `?slotrole @user @role`');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.permissionOverwrites.edit(role.id, { [PermissionFlagsBits.ViewChannel]:true, [PermissionFlagsBits.SendMessages]:true, [PermissionFlagsBits.ReadMessageHistory]:true }).catch(()=>{});
    dbAddSlotRole(row.channel_id, role.id);
    return message.reply('✅ Role <@&'+role.id+'> added to **' + target.user.username + "'s** slot.");
  }

  if (cmd === '?removeslotrole') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    const role = message.mentions.roles.first();
    if (!target||!role) return message.reply('❌ Usage: `?removeslotrole @user @role`');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.permissionOverwrites.delete(role.id).catch(()=>{});
    dbRemoveSlotRole(row.channel_id, role.id);
    return message.reply('✅ Role removed from **' + target.user.username + "'s** slot.");
  }

  if (cmd === '?slotperms') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const ch = guild.channels.cache.get(row.channel_id); if (!ch) return message.reply('❌ Channel not found.');
    const overwrites = ch.permissionOverwrites.cache;
    const lines = [];
    for (const [id, ow] of overwrites) {
      const entity = guild.roles.cache.get(id) ?? await guild.members.fetch(id).catch(()=>null);
      const name = entity ? (entity.name ?? entity.user?.username ?? id) : id;
      const allow = ow.allow.toArray().slice(0,5).join(', ') || 'none';
      const deny  = ow.deny.toArray().slice(0,5).join(', ') || 'none';
      lines.push('**' + name + '**: ✅ ' + allow + ' | ❌ ' + deny);
    }
    return message.reply({ embeds:[makeEmbed().setTitle('🔐 Permissions — ' + target.user.username + "'s Slot").setDescription(lines.join('\n') || 'No overwrites').setTimestamp()] });
  }

  if (cmd === '?inheritperms') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const val = args[1]?.toLowerCase();
    if (val !== 'on' && val !== 'off') return message.reply('❌ Usage: `?inheritperms on/off`');
    dbSetConfig(guild.id, 'inherit_perms', val==='on'?1:0);
    return message.reply('✅ Inherit perms **' + val + '**. Invited users will ' + (val==='on'?'now':'no longer') + ' inherit AttachFiles and EmbedLinks.');
  }

  if (cmd === '?setslottype' || cmd === '?upgradeslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first();
    const subtype = (cmd==='?setslottype' ? args[2] : args[1])?.toLowerCase();
    if (!target||!subtype||!SLOT_SUBTYPES[subtype]) return message.reply('❌ Usage: `?setslottype @user <private/public/premium/event>`');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    dbSetSubtype(row.channel_id, subtype);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await applySubtypePerms(ch, subtype, guild);
    dbAudit(guild.id,'settype',target.id,member.id,subtype);
    return message.reply('✅ **' + target.user.username + "'s** slot type set to **" + SLOT_SUBTYPES[subtype].label + '**.');
  }

  if (cmd === '?slotcolor') {
    const sd = dbGetSlot(channel.id);
    if (!sd) return message.reply('❌ Use this inside a slot channel.');
    if (message.author.id !== sd.userId && !isAdmin(member,guild)) return message.reply('❌ Only the slot owner or admins.');
    const hex = args[1]?.replace('#','');
    if (!hex||!/^[0-9a-fA-F]{6}$/.test(hex)) return message.reply('❌ Usage: `?slotcolor <hex>` e.g. `?slotcolor FF5733`');
    dbSetColor(channel.id, hex);
    const embed = makeEmbed(hex).setTitle('🎨 Slot Color Updated').setDescription('Bot embeds in this slot will now use this color.').setTimestamp();
    return message.reply({ embeds:[embed] });
  }

  if (cmd === '?rename') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const ch = message.mentions.channels.first();
    const newName = args.slice(2).join('-').toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,100);
    if (!ch||!newName) return message.reply('❌ Usage: `?rename #channel <new-name>`');
    await ch.setName(newName).catch(()=>{});
    return message.reply('✅ Channel renamed to **' + newName + '**.');
  }

  // ══ AUDIT ══════════════════════════════════════════════════════════════════
  if (cmd === '?slotaudit') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const actions = db.prepare('SELECT * FROM audit_log WHERE guild_id=? AND target_id=? ORDER BY at DESC LIMIT 15').all(guild.id, target.id);
    const warns = dbGetWarnings(guild.id,target.id).length;
    const strikes = dbGetStrikes(guild.id,target.id);
    const blacklisted = dbIsBlacklisted(guild.id,target.id);
    const history = dbGetHistory(guild.id,target.id).length;
    let desc = '⚠️ **' + warns + '** warnings | ⛔ **' + strikes + '** strikes | 📜 **' + history + '** total slots | Blacklisted: ' + (blacklisted?'**Yes**':'No') + '\n\n';
    if (actions.length) desc += actions.map(a => '`'+a.action+'` by <@'+a.by_id+'> — '+(a.detail||'')+'  <t:'+Math.floor(a.at/1000)+':R>').join('\n');
    else desc += '_No recorded actions._';
    return message.reply({ embeds:[makeEmbed().setTitle('🧾 Slot Audit — ' + target.user.username).setDescription(desc).setTimestamp()] });
  }

  if (cmd === '?recentactions') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const actions = dbRecentAudit(guild.id, 10);
    if (!actions.length) return message.reply('No recorded actions yet.');
    const lines = actions.map(a => '`'+a.action+'` on <@'+a.target_id+'> by <@'+a.by_id+'> — '+(a.detail||'')+'  <t:'+Math.floor(a.at/1000)+':R>');
    return message.reply({ embeds:[makeEmbed().setTitle('🧾 Recent Actions').setDescription(lines.join('\n')).setTimestamp()] });
  }

  if (cmd === '?modstats') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const stats = dbModStats(guild.id);
    if (!stats.length) return message.reply('No mod actions recorded yet.');
    const lines = stats.map((r,i) => '**'+(i+1)+'.** <@'+r.by_id+'> — '+r.total+' action(s)');
    return message.reply({ embeds:[makeEmbed().setTitle('📊 Mod Action Stats').setDescription(lines.join('\n')).setTimestamp()] });
  }

  // ══ AUTOMATION ═════════════════════════════════════════════════════════════
  if (cmd === '?autolock') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const val = args[1]?.toLowerCase();
    if (val!=='on'&&val!=='off') return message.reply('❌ Usage: `?autolock on/off`');
    dbSetConfig(guild.id, 'autolock_days', val==='on' ? 3 : 0);
    return message.reply('✅ Auto-lock **' + val + '**.' + (val==='on'?' Slots inactive for **3 days** will be locked automatically.':''));
  }

  if (cmd === '?autorotate') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const val = args[1]?.toLowerCase();
    if (val!=='on'&&val!=='off') return message.reply('❌ Usage: `?autorotate on/off`');
    dbSetConfig(guild.id, 'autorotate', val==='on'?1:0);
    return message.reply('✅ Auto-rotate **' + val + '**.' + (val==='on'?' Slots inactive for 3 days will notify the owner.':''));
  }

  if (cmd === '?autosuspend') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const days = parseInt(args[1]);
    if (isNaN(days)||days<1) return message.reply('❌ Usage: `?autosuspend <days>`');
    dbSetConfig(guild.id, 'autolock_days', days);
    return message.reply('✅ Auto-lock threshold set to **' + days + ' days** of inactivity.');
  }

  if (cmd === '?activitythreshold') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const n = parseInt(args[1]);
    if (isNaN(n)||n<0) return message.reply('❌ Usage: `?activitythreshold <messages>` (0=disabled)');
    dbSetConfig(guild.id, 'activity_threshold', n);
    return message.reply('✅ Activity threshold set to **' + (n===0?'disabled':n+' messages') + '**.');
  }

  // ══ CLEANUP & MAINTENANCE ══════════════════════════════════════════════════
  if (cmd === '?orphanedslots') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const orphans = dbAllGuildSlots(guild.id).filter(r=>!guild.channels.cache.get(r.channel_id));
    if (!orphans.length) return message.reply('✅ No orphaned slots found.');
    const lines = orphans.map(r=>r.emoji+' <@'+r.user_id+'> — channel `'+r.channel_id+'` missing');
    return message.reply({ embeds:[makeEmbed().setTitle('👻 Orphaned Slots (' + orphans.length + ')').setDescription(lines.join('\n')).setFooter({text:'Use ?slotcheck to clean these up'}).setTimestamp()] });
  }

  if (cmd === '?slotcheck') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    let cleaned = 0;
    for (const row of dbAllGuildSlots(guild.id)) {
      if (!guild.channels.cache.get(row.channel_id)) { dbDeleteSlot(row.channel_id,'orphan-cleanup'); cleaned++; }
    }
    const active = dbAllGuildSlots(guild.id).length;
    return message.reply('✅ Slot check complete. **' + cleaned + '** orphaned entries removed. **' + active + '** active slots remain.');
  }

  if (cmd === '?fixperms') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const ch = message.mentions.channels.first(); if (!ch) return message.reply('❌ Mention a channel.');
    const row = dbGetSlot(ch.id); if (!row) return message.reply('❌ Not a registered slot.');
    const target = await guild.members.fetch(row.user_id).catch(()=>null);
    if (!target) return message.reply('❌ Could not fetch slot owner.');
    await ch.permissionOverwrites.set([
      { id:guild.roles.everyone.id, deny:[PermissionFlagsBits.SendMessages,PermissionFlagsBits.ViewChannel] },
      { id:target.id, allow:[PermissionFlagsBits.SendMessages,PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.MentionEveryone] },
      { id:client.user.id, allow:[PermissionFlagsBits.SendMessages,PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ReadMessageHistory] },
    ]).catch(()=>{});
    if (row.slot_subtype) await applySubtypePerms(ch, row.slot_subtype, guild);
    return message.reply('✅ Permissions reset to template for <#' + ch.id + '>.');
  }

  if (cmd === '?rebuildslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const oldCh = guild.channels.cache.get(row.channel_id);
    const cat = oldCh?.parent ?? await getOrCreateCategory(guild, SLOT_CATEGORY_NAME);
    if (oldCh) await oldCh.delete().catch(()=>{});
    const newCh = await createSlotChannel(guild, target.user, row.emoji, row.expires_at);
    db.prepare('UPDATE slots SET channel_id=? WHERE user_id=? AND guild_id=?').run(newCh.id, target.id, guild.id);
    await newCh.send('🔧 Slot rebuilt by an admin. Welcome back, ' + target.toString() + '!');
    dbAudit(guild.id,'rebuild',target.id,member.id,'rebuilt');
    return message.reply('✅ Slot rebuilt for **' + target.user.username + '** in ' + newCh.toString());
  }

  if (cmd === '?bulkextend') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const days = parseInt(args[1]);
    if (isNaN(days)||days<1) return message.reply('❌ Usage: `?bulkextend <days>`');
    const rows = dbAllGuildSlots(guild.id).filter(r=>r.expires_at);
    for (const row of rows) {
      const newExp = row.expires_at + days*86400000;
      db.prepare('UPDATE slots SET expires_at=? WHERE channel_id=?').run(newExp, row.channel_id);
    }
    dbAudit(guild.id,'bulkextend','all',member.id,'+'+days+'d to '+rows.length+' slots');
    return message.reply('✅ Extended **' + rows.length + '** timed slot(s) by **' + days + '** day(s).');
  }

  if (cmd === '?reloadslots') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    let cleaned = 0;
    for (const row of dbAllGuildSlots(guild.id)) {
      if (!guild.channels.cache.get(row.channel_id)) { dbDeleteSlot(row.channel_id,'reload-cleanup'); cleaned++; }
    }
    return message.reply('🔄 Slots re-synced. **' + cleaned + '** stale entries removed.');
  }

  if (cmd === '?forcerefreshperms') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const ch = guild.channels.cache.get(row.channel_id); if (!ch) return message.reply('❌ Channel not found.');
    await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.SendMessages]:!row.muted&&!row.locked, [PermissionFlagsBits.ViewChannel]:true, [PermissionFlagsBits.ReadMessageHistory]:true, [PermissionFlagsBits.AttachFiles]:true, [PermissionFlagsBits.EmbedLinks]:true }).catch(()=>{});
    const talkers = dbGetTalkUsers(row.channel_id);
    for (const uid of talkers) await ch.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]:!row.locked, [PermissionFlagsBits.ViewChannel]:true }).catch(()=>{});
    if (row.slot_subtype) await applySubtypePerms(ch, row.slot_subtype, guild);
    return message.reply('✅ Permissions force-refreshed for <#' + ch.id + '>.');
  }

  if (cmd === '?debugslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id);
    if (!row) return message.reply('No slot data found for **' + target.user.username + '**.');
    return message.reply('```json\n' + JSON.stringify(row, null, 2).slice(0, 1900) + '\n```');
  }

  if (cmd === '?dbcheck') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const slot = dbGetSlotByUser(guild.id,target.id);
    const warns = dbGetWarnings(guild.id,target.id).length;
    const strikes = dbGetStrikes(guild.id,target.id);
    const blacklisted = dbIsBlacklisted(guild.id,target.id);
    const history = dbGetHistory(guild.id,target.id).length;
    const usedFree = dbHasUsedFree(guild.id,target.id);
    const hasClaim = dbUserHasClaim(guild.id,target.id);
    const lines = [
      'Active Slot: ' + (slot?'✅ '+slot.channel_id:'❌ None'),
      'Warnings: ' + warns,
      'Strikes: ' + strikes,
      'Blacklisted: ' + (blacklisted?'⛔ Yes':'✅ No'),
      'Used Free Slot: ' + (usedFree?'Yes':'No'),
      'Has Claim: ' + (hasClaim?'Yes':'No'),
      'Slot History Count: ' + history,
    ];
    return message.reply('```\n' + lines.join('\n') + '\n```');
  }

  // ══ BACKUP ═════════════════════════════════════════════════════════════════
  if (cmd === '?backupslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No slot found.');
    const talkers = dbGetTalkUsers(row.channel_id);
    const roles = dbGetSlotRoles(row.channel_id);
    dbSaveBackup(guild.id, target.id, { ...row, talkers, roles });
    return message.reply('✅ Backup saved for **' + target.user.username + '**\'s slot.');
  }

  if (cmd === '?restoreslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    const backup = dbGetBackup(guild.id, target.id); if (!backup) return message.reply('❌ No backup found.');
    const row = dbGetSlotByUser(guild.id, target.id); if (!row) return message.reply('❌ No active slot to restore into.');
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch && backup.backup_data.talkers?.length) {
      for (const uid of backup.backup_data.talkers) {
        await ch.permissionOverwrites.edit(uid, { [PermissionFlagsBits.SendMessages]:true, [PermissionFlagsBits.ViewChannel]:true, [PermissionFlagsBits.ReadMessageHistory]:true }).catch(()=>{});
        dbAddTalkUser(row.channel_id, uid);
      }
    }
    return message.reply('✅ Restored **' + target.user.username + "'s** slot from backup (" + new Date(backup.backed_up_at).toLocaleDateString() + ').');
  }

  // ══ CONFIG ═════════════════════════════════════════════════════════════════
  if (cmd === '?setslotlimit') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const n = parseInt(args[1]); if (isNaN(n)||n<0) return message.reply('❌ Usage: `?setslotlimit <number>` (0=unlimited)');
    dbSetConfig(guild.id,'slot_limit',n);
    return message.reply('✅ Slot limit: **' + (n===0?'unlimited':n) + '**.');
  }

  if (cmd === '?setdefaultduration') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const days = parseInt(args[1]); if (isNaN(days)||days<1) return message.reply('❌ Usage: `?setdefaultduration <days>`');
    dbSetConfig(guild.id,'default_duration',days*86400000);
    return message.reply('✅ Default duration: **' + days + ' days**.');
  }

  if (cmd === '?slotcooldown') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const hours = parseInt(args[1]); if (isNaN(hours)||hours<0) return message.reply('❌ Usage: `?slotcooldown <hours>` (0=disabled)');
    dbSetConfig(guild.id,'cooldown_ms',hours*3600000);
    return message.reply('✅ Slot cooldown: **' + (hours===0?'disabled':hours+'h') + '**.');
  }

  // ══ WEEKEND ════════════════════════════════════════════════════════════════
  if (cmd === '?weekend') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    if (dbGetWeekendState(guild.id)) return message.reply('⚠️ Weekend slots already open!');
    await openWeekend(guild);
    return message.reply('🎉 Weekend slots open for everyone!');
  }

  if (cmd === '?stopw') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    if (!dbGetWeekendState(guild.id)) return message.reply('⚠️ No active weekend.');
    await closeWeekend(guild);
    return message.reply('🛑 Weekend slots closed.');
  }

  // ══ SLOT CREATION ══════════════════════════════════════════════════════════
  if (cmd === '?freeslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    if (dbIsBlacklisted(guild.id,target.id)) return message.reply('❌ **' + target.user.username + '** is blacklisted.');
    if (dbHasUsedFree(guild.id,target.id)) return message.reply('❌ **' + target.user.username + '** already used their free slot.');
    const cfg = dbGetConfig(guild.id);
    if (cfg.cooldown_ms>0) { const cd=dbGetCooldown(guild.id,target.id); if(cd&&cd.available_at>Date.now()) { const hrs=Math.ceil((cd.available_at-Date.now())/3600000); return message.reply('❌ On cooldown for '+hrs+' more hour(s).'); } }
    const exp = Date.now() + 7*86400000;
    dbMarkFreeUsed(guild.id,target.id);
    const ch = await createSlotChannel(guild, target.user, '🎲', exp);
    dbSaveSlot(ch.id, target.id, guild.id, 'free', '🎲', exp, false, member.id);
    await ch.send('🎲 Welcome to your slot, ' + target.toString() + '!\n\n⏳ Lasts **7 days**.\n📢 1x `@here` and 1x `@everyone`.\n👥 Use `?talk @user` to invite people.');
    dbAudit(guild.id,'create',target.id,member.id,'free slot');
    return message.reply('✅ Free slot opened for ' + target.toString() + ' in ' + ch.toString());
  }

  if (cmd === '?weekslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const weeks = parseInt(args[1]); const target = message.mentions.members.first();
    if (!target||isNaN(weeks)||weeks<1) return message.reply('❌ Usage: `?weekslot <weeks> @user`');
    if (dbIsBlacklisted(guild.id,target.id)) return message.reply('❌ **' + target.user.username + '** is blacklisted.');
    const exp = Date.now() + weeks*7*86400000;
    const ch = await createSlotChannel(guild, target.user, '🎰', exp);
    dbSaveSlot(ch.id, target.id, guild.id, 'week', '🎰', exp, false, member.id);
    await ch.send('🎰 Welcome to your slot, ' + target.toString() + '!\n\n⏳ Lasts **'+weeks+' week'+(weeks>1?'s':'')+'**.\n📢 1x `@here` and 1x `@everyone`.\n👥 Use `?talk @user` to invite people.');
    dbAudit(guild.id,'create',target.id,member.id,weeks+'w slot');
    return message.reply('✅ Weekly slot (' + weeks + 'w) opened for ' + target.toString());
  }

  if (cmd === '?monthslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const months = parseInt(args[1]); const target = message.mentions.members.first();
    if (!target||isNaN(months)||months<1) return message.reply('❌ Usage: `?monthslot <months> @user`');
    if (dbIsBlacklisted(guild.id,target.id)) return message.reply('❌ **' + target.user.username + '** is blacklisted.');
    const exp = Date.now() + months*30*86400000;
    const ch = await createSlotChannel(guild, target.user, '💎', exp);
    dbSaveSlot(ch.id, target.id, guild.id, 'month', '💎', exp, false, member.id);
    await ch.send('💎 Welcome to your slot, ' + target.toString() + '!\n\n⏳ Lasts **'+months+' month'+(months>1?'s':'')+'**.\n📢 1x `@here` and 1x `@everyone`.\n👥 Use `?talk @user` to invite people.');
    dbAudit(guild.id,'create',target.id,member.id,months+'mo slot');
    return message.reply('✅ Monthly slot (' + months + 'mo) opened for ' + target.toString());
  }

  if (cmd === '?permslot') {
    if (!isAdmin(member,guild)) return message.reply('❌ Admins only.');
    const target = message.mentions.members.first(); if (!target) return message.reply('❌ Mention a user.');
    if (dbIsBlacklisted(guild.id,target.id)) return message.reply('❌ **' + target.user.username + '** is blacklisted.');
    const ch = await createSlotChannel(guild, target.user, '⚜️', null);
    dbSaveSlot(ch.id, target.id, guild.id, 'perm', '⚜️', null, false, member.id);
    await ch.send('⚜️ Welcome to your permanent slot, ' + target.toString() + '!\n\n♾️ Never expires.\n📢 1x `@here` and 1x `@everyone`.\n👥 Use `?talk @user` to invite people.');
    dbAudit(guild.id,'create',target.id,member.id,'perm slot');
    return message.reply('✅ Permanent slot opened for ' + target.toString());
  }

  // ══ @here/@everyone abuse ══════════════════════════════════════════════════
  const sd2 = dbGetSlot(channel.id);
  if (sd2 && message.author.id === sd2.userId) {
    if (sd2.infMentions) return;
    let abused = false;
    if (content.includes('@here'))     { if (sd2.hereUsed)     abused=true; else dbMarkHereUsed(channel.id); }
    if (content.includes('@everyone')) { if (sd2.everyoneUsed) abused=true; else dbMarkEveryone(channel.id); }
    if (abused) {
      await message.delete().catch(()=>{});
      message.author.send('⚠️ **Drop Vault Warning** — You exceeded your @here/@everyone limit in your slot. Each slot allows exactly **1x `@here`** and **1x `@everyone`**.').catch(()=>{});
    }
    return;
  }
  const wd2 = dbGetWeekend(channel.id);
  if (wd2 && message.author.id === wd2.user_id) {
    let abused = false;
    if (content.includes('@here'))     { if (wd2.here_used)     abused=true; else dbMarkWHere(channel.id); }
    if (content.includes('@everyone')) { if (wd2.everyone_used) abused=true; else dbMarkWEveryone(channel.id); }
    if (abused) {
      await message.delete().catch(()=>{});
      message.author.send('⚠️ **Drop Vault Warning** — You exceeded your @here/@everyone limit in your weekend slot.').catch(()=>{});
    }
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log('✅ Logged in as ' + client.user.tag);
  console.log('📡 ' + client.guilds.cache.size + ' guild(s)');
  for (const [, guild] of client.guilds.cache) {
    console.log('Setting up: ' + guild.name);
    if (!dbGetVerify(guild.id))  await sendVerifyPanel(guild).catch(console.error);
    if (!dbGetRules(guild.id))   await sendSlotRules(guild).catch(console.error);
    await ensureStaffSlots(guild).catch(console.error);
  }
  setInterval(checkExpiredSlots, 10*60*1000);
  setInterval(async () => {
    // Expiry reminder check (runs every hour)
    for (const r of dbAllReminders()) {
      const row = dbGetSlotByUser(r.guild_id, r.user_id); if (!row?.expires_at) continue;
      if (daysLeft(row.expires_at) !== 3) continue;
      const user = await client.users.fetch(r.user_id).catch(()=>null); if (!user) continue;
      user.send('⏰ **Drop Vault** — Your slot expires in **3 days**! Contact an admin to renew.').catch(()=>{});
    }
  }, 60*60*1000);
  scheduleWeekend();
  console.log('✅ Bot fully ready!');
});

client.on('error', e => console.error('Client error:', e));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));

console.log('Starting bot...');
client.login(process.env.DISCORD_TOKEN);
