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

// ─── Database Setup ───────────────────────────────────────────────────────────

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
    everyone_used INTEGER DEFAULT 0
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
`);

// ─── DB Helpers ───────────────────────────────────────────────────────────────

function dbSaveSlot(channelId, userId, guildId, type, emoji, expiresAt) {
  db.prepare(`
    INSERT OR REPLACE INTO slots (channel_id, user_id, guild_id, type, emoji, expires_at, here_used, everyone_used)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0)
  `).run(channelId, userId, guildId, type, emoji, expiresAt ?? null);
}

function dbDeleteSlot(channelId) {
  db.prepare('DELETE FROM slot_talk WHERE channel_id = ?').run(channelId);
  db.prepare('DELETE FROM slots WHERE channel_id = ?').run(channelId);
}

function dbGetSlot(channelId) {
  const row = db.prepare('SELECT * FROM slots WHERE channel_id = ?').get(channelId);
  if (!row) return null;
  const talk = db.prepare('SELECT user_id FROM slot_talk WHERE channel_id = ?').all(channelId);
  return {
    userId: row.user_id,
    guildId: row.guild_id,
    type: row.type,
    emoji: row.emoji,
    expiresAt: row.expires_at,
    hereUsed: !!row.here_used,
    everyoneUsed: !!row.everyone_used,
    talkAllowed: new Set(talk.map((r) => r.user_id)),
  };
}

function dbAllSlots() {
  return db.prepare('SELECT channel_id FROM slots').all().map((r) => r.channel_id);
}

function dbMarkHereUsed(channelId) {
  db.prepare('UPDATE slots SET here_used = 1 WHERE channel_id = ?').run(channelId);
}

function dbMarkEveryoneUsed(channelId) {
  db.prepare('UPDATE slots SET everyone_used = 1 WHERE channel_id = ?').run(channelId);
}

function dbAddTalkUser(channelId, userId) {
  db.prepare('INSERT OR IGNORE INTO slot_talk (channel_id, user_id) VALUES (?, ?)').run(channelId, userId);
}

function dbHasUsedFreeSlot(guildId, userId) {
  return !!db.prepare('SELECT 1 FROM used_free_slots WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}

function dbMarkFreeSlotUsed(guildId, userId) {
  db.prepare('INSERT OR IGNORE INTO used_free_slots (guild_id, user_id) VALUES (?, ?)').run(guildId, userId);
}

function dbSaveVerifyMessage(guildId, channelId, messageId) {
  db.prepare('INSERT OR REPLACE INTO verify_messages (guild_id, channel_id, message_id) VALUES (?, ?, ?)').run(guildId, channelId, messageId);
}

function dbGetVerifyMessage(guildId) {
  return db.prepare('SELECT * FROM verify_messages WHERE guild_id = ?').get(guildId);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const NEWBIE_ROLE_ID     = '1474836752756768880';
const MEMBER_ROLE_ID     = '1474837032001081486';
const VERIFY_CHANNEL_ID  = '1474836719143616545';
const VERIFY_BUTTON_ID   = 'verify_button';
const SLOT_CATEGORY_NAME = '🎰 SLOTS';

const SLOT_TYPES = {
  free:  { emoji: '🎲', duration: 7 * 24 * 60 * 60 * 1000 },
  week:  { emoji: '🎰', duration: null },
  month: { emoji: '💎', duration: null },
  perm:  { emoji: '⚜️', duration: null },
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

function isAdminOrOwner(member, guild) {
  return (
    member.id === guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  const ms = expiresAt - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function channelName(emoji, username, expiresAt) {
  const safe = username.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!expiresAt) return `${emoji}-${safe}s-slot`;
  return `${emoji}-${safe}s-slot-${daysRemaining(expiresAt)}d`;
}

async function getOrCreateSlotsCategory(guild) {
  let cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === SLOT_CATEGORY_NAME
  );
  if (!cat) {
    cat = await guild.channels.create({ name: SLOT_CATEGORY_NAME, type: ChannelType.GuildCategory });
  }
  return cat;
}

async function createSlotChannel(guild, user, emoji, expiresAt) {
  const category = await getOrCreateSlotsCategory(guild);
  return guild.channels.create({
    name: channelName(emoji, user.username, expiresAt),
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

// ─── Verify Panel ─────────────────────────────────────────────────────────────

async function sendVerifyPanel(guild) {
  const channel = guild.channels.cache.get(VERIFY_CHANNEL_ID);
  if (!channel) return console.warn('⚠️  Verify channel not found:', VERIFY_CHANNEL_ID);

  // Delete old panel if exists
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

// ─── Expiry Loop ──────────────────────────────────────────────────────────────

async function checkExpiredSlots() {
  for (const channelId of dbAllSlots()) {
    const data = dbGetSlot(channelId);
    if (!data || !data.expiresAt) continue;

    if (Date.now() < data.expiresAt) {
      // Update channel name with current days remaining
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

    // Expired — delete silently, no notification
    try {
      const guild = client.guilds.cache.get(data.guildId);
      if (guild) {
        const channel = guild.channels.cache.get(channelId);
        if (channel) await channel.delete().catch(() => {});
      }
    } catch {}
    dbDeleteSlot(channelId);
  }
}

// ─── Auto Role on Join ────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const role = member.guild.roles.cache.get(NEWBIE_ROLE_ID);
    if (role) await member.roles.add(role);
  } catch (err) {
    console.error('Failed to assign Newbie role:', err);
  }
});

// ─── Verify Button ────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== VERIFY_BUTTON_ID) return;

  const { member, guild } = interaction;

  try {
    if (member.roles.cache.has(MEMBER_ROLE_ID)) {
      return interaction.reply({ content: '✅ You\'re already verified!', ephemeral: true });
    }

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
    await interaction.reply({ content: '❌ Something went wrong. Please contact an admin.', ephemeral: true });
  }
});

// ─── Message Commands ─────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const { content, member, guild, channel } = message;
  const args = content.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();

  // ?sendverify — re-send the verify panel (admin/owner only)
  if (cmd === '?sendverify') {
    if (!isAdminOrOwner(member, guild)) return message.reply('❌ Only admins/owner can do that.');
    await sendVerifyPanel(guild);
    return message.reply('✅ Verify panel sent!');
  }

  // ?freeslot @user
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

  // ?weekslot <weeks> @user
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

  // ?monthslot <months> @user
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

  // ?permslot @user
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

  // ?talk @user1 @user2 ... (inside a slot channel only)
  if (cmd === '?talk') {
    const slotData = dbGetSlot(channel.id);
    if (!slotData) return;
    if (message.author.id !== slotData.userId)
      return message.reply('❌ Only the slot owner can use `?talk`.');

    const targets = message.mentions.members;
    if (!targets || targets.size === 0)
      return message.reply('❌ Mention at least one user to invite.');

    const added = [];
    for (const [, t] of targets) {
      if (t.id === slotData.userId) continue;
      dbAddTalkUser(channel.id, t.id);
      await channel.permissionOverwrites.edit(t.id, {
        [PermissionFlagsBits.SendMessages]: true,
        [PermissionFlagsBits.ViewChannel]: true,
        [PermissionFlagsBits.ReadMessageHistory]: true,
      }).catch(() => {});
      added.push(t.toString());
    }

    if (added.length) return message.reply(`✅ Invited ${added.join(', ')} to chat in this slot.`);
    return;
  }

  // @here / @everyone abuse detection (slot channels only)
  const slotData = dbGetSlot(channel.id);
  if (slotData && message.author.id === slotData.userId) {
    const usedHere      = content.includes('@here');
    const usedEveryone  = content.includes('@everyone');
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
        `Each slot allows exactly **1x \`@here\`** and **1x \`@everyone\`**. Further abuse may result in slot removal.`
      ).catch(() => {});
    }
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Send verify panel on first boot if not already sent
  for (const [, guild] of client.guilds.cache) {
    if (!dbGetVerifyMessage(guild.id)) {
      await sendVerifyPanel(guild).catch(console.error);
    }
  }

  setInterval(checkExpiredSlots, 10 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
