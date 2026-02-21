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
    here_used INTEGER DEFAULT 0, everyone_used INTEGER DEFAULT 0, inf_mentions INTEGER DEFAULT 0
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
`);

// ─── DB Helpers ───────────────────────────────────────────────────────────────

const dbSaveSlot = (cid, uid, gid, type, emoji, exp, inf = 0) =>
  db.prepare(`INSERT OR REPLACE INTO slots
    (channel_id,user_id,guild_id,type,emoji,expires_at,here_used,everyone_used,inf_mentions)
    VALUES(?,?,?,?,?,?,0,0,?)`).run(cid, uid, gid, type, emoji, exp ?? null, inf ? 1 : 0);

const dbDeleteSlot = (cid) => {
  db.prepare('DELETE FROM slot_talk WHERE channel_id=?').run(cid);
  db.prepare('DELETE FROM slots WHERE channel_id=?').run(cid);
};

const dbGetSlot = (cid) => {
  const r = db.prepare('SELECT * FROM slots WHERE channel_id=?').get(cid);
  if (!r) return null;
  const talk = db.prepare('SELECT user_id FROM slot_talk WHERE channel_id=?').all(cid);
  return { userId: r.user_id, guildId: r.guild_id, type: r.type, emoji: r.emoji,
    expiresAt: r.expires_at, hereUsed: !!r.here_used, everyoneUsed: !!r.everyone_used,
    infMentions: !!r.inf_mentions, talkAllowed: new Set(talk.map(x => x.user_id)) };
};

const dbAllSlots        = ()      => db.prepare('SELECT channel_id FROM slots').all().map(r => r.channel_id);
const dbMarkHereUsed    = (cid)   => db.prepare('UPDATE slots SET here_used=1 WHERE channel_id=?').run(cid);
const dbMarkEveryoneUsed= (cid)   => db.prepare('UPDATE slots SET everyone_used=1 WHERE channel_id=?').run(cid);
const dbAddTalkUser     = (c, u)  => db.prepare('INSERT OR IGNORE INTO slot_talk(channel_id,user_id) VALUES(?,?)').run(c, u);
const dbHasUsedFree     = (g, u)  => !!db.prepare('SELECT 1 FROM used_free_slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbMarkFreeUsed    = (g, u)  => db.prepare('INSERT OR IGNORE INTO used_free_slots(guild_id,user_id) VALUES(?,?)').run(g, u);
const dbUserHasSlot     = (g, u)  => !!db.prepare('SELECT 1 FROM slots WHERE guild_id=? AND user_id=?').get(g, u);
const dbUserHasWeekend  = (g, u)  => !!db.prepare('SELECT 1 FROM weekend_slots WHERE guild_id=? AND user_id=?').get(g, u);

const dbSaveVerify      = (g, c, m) => db.prepare('INSERT OR REPLACE INTO verify_messages(guild_id,channel_id,message_id) VALUES(?,?,?)').run(g, c, m);
const dbGetVerify       = (g)     => db.prepare('SELECT * FROM verify_messages WHERE guild_id=?').get(g);
const dbSaveRules       = (g, m)  => db.prepare('INSERT OR REPLACE INTO slot_rules_messages(guild_id,message_id) VALUES(?,?)').run(g, m);
const dbGetRules        = (g)     => db.prepare('SELECT * FROM slot_rules_messages WHERE guild_id=?').get(g);

const dbSaveWeekend     = (c, u, g) => db.prepare('INSERT OR REPLACE INTO weekend_slots(channel_id,user_id,guild_id,here_used,everyone_used) VALUES(?,?,?,0,0)').run(c, u, g);
const dbGetWeekend      = (cid)   => db.prepare('SELECT * FROM weekend_slots WHERE channel_id=?').get(cid);
const dbDeleteWeekend   = (cid)   => db.prepare('DELETE FROM weekend_slots WHERE channel_id=?').run(cid);
const dbAllWeekends     = (g)     => db.prepare('SELECT channel_id FROM weekend_slots WHERE guild_id=?').all(g).map(r => r.channel_id);
const dbMarkWHere       = (cid)   => db.prepare('UPDATE weekend_slots SET here_used=1 WHERE channel_id=?').run(cid);
const dbMarkWEveryone   = (cid)   => db.prepare('UPDATE weekend_slots SET everyone_used=1 WHERE channel_id=?').run(cid);
const dbGetWeekendState = (g)     => db.prepare('SELECT active FROM weekend_state WHERE guild_id=?').get(g)?.active ?? 0;
const dbSetWeekendState = (g, a)  => db.prepare('INSERT OR REPLACE INTO weekend_state(guild_id,active) VALUES(?,?)').run(g, a ? 1 : 0);

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
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
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
      { id: user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ],
  });
}

// ─── Staff Auto-Slots ─────────────────────────────────────────────────────────

async function ensureStaffSlots(guild) {
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner && !dbUserHasSlot(guild.id, owner.id)) {
    const ch = await createSlotChannel(guild, owner.user, OWNER_EMOJI, null);
    dbSaveSlot(ch.id, owner.id, guild.id, 'owner', OWNER_EMOJI, null, true);
    await ch.send(`${OWNER_EMOJI} Welcome to your permanent owner slot, ${owner}!\n\n♾️ Infinite \`@here\` and \`@everyone\` — no limits.\n👥 Use \`?talk @user1 @user2 ...\` to invite people.`);
  }

  const members = await guild.members.fetch();
  for (const [, m] of members) {
    if (m.user.bot || m.id === guild.ownerId) continue;
    if (!m.permissions.has(PermissionFlagsBits.Administrator)) continue;
    if (dbUserHasSlot(guild.id, m.id)) continue;
    const ch = await createSlotChannel(guild, m.user, ADMIN_EMOJI, null);
    dbSaveSlot(ch.id, m.id, guild.id, 'admin', ADMIN_EMOJI, null, true);
    await ch.send(`🛠️ Welcome to your permanent admin slot, ${m}!\n\n♾️ Infinite \`@here\` and \`@everyone\` — no limits.\n👥 Use \`?talk @user1 @user2 ...\` to invite people.`);
  }
}

// ─── Verify Panel ─────────────────────────────────────────────────────────────

async function sendVerifyPanel(guild) {
  const channel = guild.channels.cache.get(VERIFY_CHANNEL_ID);
  if (!channel) return console.warn('Verify channel not found:', VERIFY_CHANNEL_ID);

  const existing = dbGetVerify(guild.id);
  if (existing) {
    const old = await channel.messages.fetch(existing.message_id).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('👋  Welcome — Get Access')
    .setDescription(`Ready to join the community?\n\nClick the **✅ Verify** button below to receive the <@&${MEMBER_ROLE_ID}> role and unlock the server.\n\n> By verifying, you confirm you have read and agree to the server rules.`)
    .setFooter({ text: 'One click is all it takes.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  dbSaveVerify(guild.id, channel.id, msg.id);
  console.log('Verify panel sent in #' + channel.name);
}

// ─── Slot Rules Panel ─────────────────────────────────────────────────────────

async function sendSlotRules(guild) {
  const channel = guild.channels.cache.get(SLOT_RULES_CHANNEL_ID);
  if (!channel) return console.warn('Slot rules channel not found:', SLOT_RULES_CHANNEL_ID);

  const existing = dbGetRules(guild.id);
  if (existing) {
    const old = await channel.messages.fetch(existing.message_id).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }

  const N = '\n';
  const embed = new EmbedBuilder()
    .setColor(0xf5c518)
    .setTitle('📋  Drop Vault — Slot Rules')
    .setDescription('Welcome to **Drop Vault**. Slots are your personal space to advertise and sell products to the community.' + N + N + 'Read the following rules carefully. Failure to comply will result in your slot being removed **without warning or refund**.')
    .addFields(
      { name: '✅  Eligibility Requirements',
        value: '> **15 vouches minimum** — At least 15 verified positive vouches required.' + N +
               '> **Zero bad reviews** — Any 1–3 star reviews or complaints disqualify you immediately.' + N +
               '> **Proof of transactions** — Verifiable transaction history required (see Payment Proof).' },
      { name: '💳  Accepted Payment Proof',
        value: '> **Crypto** — On-chain transaction IDs/hashes (BTC, ETH, LTC, USDT, etc.)' + N +
               '> **PayPal** — Screenshots of completed transactions with timestamps' + N +
               '> **CashApp** — Screenshots of completed payments with timestamps' + N +
               '> All proof must be **unedited** and show the **date, amount, and both parties**.' },
      { name: '📦  Slot Conduct',
        value: '> Only advertise and sell **your own products or services**.' + N +
               '> **No scamming, misleading listings, or false advertising** of any kind.' + N +
               '> Transactions are **between buyer and seller** — Drop Vault is not liable for disputes.' + N +
               '> You get **1x @here** and **1x @everyone** per slot — do not abuse them.' + N +
               '> Owner and admin slots are exempt from ping limits.' },
      { name: '🔔  Mention Rules',
        value: '> **Free / Paid slots** — 1x `@here` and 1x `@everyone` for the lifetime of the slot.' + N +
               '> Abusing mentions = message **silently deleted** + **DM warning**.' + N +
               '> Repeated abuse = **immediate slot removal**.' },
      { name: '⚠️  Enforcement',
        value: '> Admins may remove any slot at any time for rule violations.' + N +
               '> Slot removals due to violations are **non-refundable**.' + N +
               '> Scammers will be **permanently banned** from Drop Vault.' + N +
               '> To dispute a removal, open a ticket or contact staff directly.' },
      { name: '🎉  Weekend Slots',
        value: '> Every **Saturday 12:00 AM – Sunday 11:59 PM EST**, all members get a free temp slot.' + N +
               '> Weekend slots follow the same rules — 1x `@here` and 1x `@everyone`.' + N +
               '> Members with an active slot do not receive a weekend slot.' }
    )
    .setFooter({ text: 'Drop Vault • Slot Rules  |  Last updated by staff' })
    .setTimestamp();

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
    if (m.user.bot) continue;
    if (dbUserHasSlot(guild.id, m.id) || dbUserHasWeekend(guild.id, m.id)) continue;
    try {
      const ch = await createSlotChannel(guild, m.user, '🎉', null, WEEKEND_CATEGORY_NAME, true);
      dbSaveWeekend(ch.id, m.id, guild.id);
      await ch.send(`🎉 Hey ${m}, enjoy your **Weekend Slot**!\n\n⏳ Available through **Sunday 11:59 PM EST**.\n📢 You have **1x \`@here\`** and **1x \`@everyone\`** to use.\n👥 Use \`?talk @user1 @user2 ...\` to invite people.`);
    } catch (e) { console.error('Weekend slot error:', e); }
  }
  console.log('Weekend slots opened for', guild.name);
}

async function closeWeekend(guild) {
  if (!dbGetWeekendState(guild.id)) return;
  for (const cid of dbAllWeekends(guild.id)) {
    const ch = guild.channels.cache.get(cid);
    if (ch) await ch.delete().catch(() => {});
    dbDeleteWeekend(cid);
  }
  const cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === WEEKEND_CATEGORY_NAME);
  if (cat) await cat.delete().catch(() => {});
  dbSetWeekendState(guild.id, false);
  console.log('Weekend slots closed for', guild.name);
}

function scheduleWeekend() {
  setInterval(async () => {
    const now  = new Date(Date.now() - 5 * 60 * 60 * 1000); // EST = UTC-5
    const day  = now.getUTCDay();
    const hour = now.getUTCHours();
    const min  = now.getUTCMinutes();
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
        const guild = client.guilds.cache.get(data.guildId);
        if (!guild) continue;
        const channel = guild.channels.cache.get(cid);
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
      if (guild) { const ch = guild.channels.cache.get(cid); if (ch) await ch.delete().catch(() => {}); }
    } catch {}
    dbDeleteSlot(cid);
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const role = member.guild.roles.cache.get(NEWBIE_ROLE_ID);
    if (role) await member.roles.add(role);
  } catch (e) { console.error('Newbie role error:', e); }

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
    if (member.roles.cache.has(MEMBER_ROLE_ID))
      return interaction.reply({ content: "✅ You're already verified!", ephemeral: true });
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

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const { content, member, guild, channel } = message;
  const args = content.trim().split(/\s+/);
  const cmd  = args[0]?.toLowerCase();

  if (cmd === '?sendverify') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    await sendVerifyPanel(guild);
    return message.reply('✅ Verify panel sent!');
  }

  if (cmd === '?slotrules') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    await sendSlotRules(guild);
    return message.reply('✅ Slot rules posted!');
  }

  if (cmd === '?removeslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    const row = db.prepare('SELECT channel_id FROM slots WHERE guild_id=? AND user_id=?').get(guild.id, target.id);
    if (!row) return message.reply(`❌ **${target.user.username}** has no active slot.`);
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch) await ch.delete().catch(() => {});
    dbDeleteSlot(row.channel_id);
    return message.reply(`✅ Slot removed for **${target.user.username}**.`);
  }

  if (cmd === '?freeslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mention a user.');
    if (dbHasUsedFree(guild.id, target.id)) return message.reply(`❌ **${target.user.username}** already used their free slot.`);
    const exp = Date.now() + SLOT_TYPES.free.duration;
    dbMarkFreeUsed(guild.id, target.id);
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.free.emoji, exp);
    dbSaveSlot(ch.id, target.id, guild.id, 'free', SLOT_TYPES.free.emoji, exp);
    await ch.send(`🎲 Welcome to your slot, ${target}!\n\n⏳ Lasts **7 days**.\n📢 1x \`@here\` and 1x \`@everyone\`.\n👥 Use \`?talk @user ...\` to invite people.`);
    return message.reply(`✅ Free slot opened for ${target} in ${ch}!`);
  }

  if (cmd === '?weekslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const weeks = parseInt(args[1]);
    const target = message.mentions.members.first();
    if (!target || isNaN(weeks) || weeks < 1) return message.reply('❌ Usage: `?weekslot <weeks> @user`');
    const exp = Date.now() + weeks * 7 * 24 * 60 * 60 * 1000;
    const ch = await createSlotChannel(guild, target.user, SLOT_TYPES.week.emoji, exp);
    dbSaveSlot(ch.id, target.id, guild.id, 'week', SLOT_TYPES.week.emoji, exp);
    await ch.send(`🎰 Welcome to your slot, ${target}!\n\n⏳ Lasts **${weeks} week${weeks > 1 ? 's' : ''}**.\n📢 1x \`@here\` and 1x \`@everyone\`.\n👥 Use \`?talk @user ...\` to invite people.`);
    return message.reply(`✅ Weekly slot (${weeks}w) opened for ${target} in ${ch}!`);
  }

  if (cmd === '?monthslot') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Admins/owner only.');
    const months = parseInt(args[1]);
    const target = message.mentions.members.first();
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

  if (cmd === '?talk') {
    const slotData    = dbGetSlot(channel.id);
    const weekendData = dbGetWeekend(channel.id);
    const ownerId     = slotData?.userId ?? weekendData?.user_id ?? null;
    if (!ownerId) return;
    if (message.author.id !== ownerId) return message.reply('❌ Only the slot owner can use `?talk`.');
    const targets = message.mentions.members;
    if (!targets || targets.size === 0) return message.reply('❌ Mention at least one user.');
    const added = [];
    for (const [, t] of targets) {
      if (t.id === ownerId) continue;
      await channel.permissionOverwrites.edit(t.id, {
        [PermissionFlagsBits.SendMessages]: true,
        [PermissionFlagsBits.ViewChannel]: true,
        [PermissionFlagsBits.ReadMessageHistory]: true,
      }).catch(() => {});
      if (slotData) dbAddTalkUser(channel.id, t.id);
      added.push(t.toString());
    }
    if (added.length) return message.reply(`✅ Invited ${added.join(', ')} to this slot.`);
    return;
  }

  // @here / @everyone abuse — regular slots
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

  // @here / @everyone abuse — weekend slots
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
    console.log(`Setting up guild: ${guild.name}`);
    if (!dbGetVerify(guild.id))  await sendVerifyPanel(guild).catch(console.error);
    if (!dbGetRules(guild.id))   await sendSlotRules(guild).catch(console.error);
    await ensureStaffSlots(guild).catch(console.error);
  }

  setInterval(checkExpiredSlots, 10 * 60 * 1000);
  scheduleWeekend();
  console.log('✅ Bot fully ready!');
});

client.on('error', (error) => console.error('Client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

console.log('Starting bot...');
client.login(process.env.DISCORD_TOKEN);
