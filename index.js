import 'dotenv/config';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

// ===== .env =====
const {
  DISCORD_TOKEN,
  DEEPL_KEY,
  // lista de endpoints separados por vírgulas (podes deixar só um)
  LIBRETRANSLATE_URLS = 'https://libretranslate.de,http://localhost:5000',
  ALLOWED_CHANNELS = '', // IDs separados por vírgulas; vazio = todos
} = process.env;

// ===== Config: flags → códigos de idioma (DeepL ou BCP-47) =====
const FLAG_TO_LANG = {
  '🇺🇸': 'EN-US', // English (US)
  '🇪🇸': 'ES',    // Spanish
  '🇫🇷': 'FR',    // French
  '🇵🇹': 'PT-PT', // Portuguese (Portugal)
  '🇮🇳': 'IN',    // Hindi
  '🇰🇷': 'KR',    // Korean
  '🇯🇵': 'JP',    // Japanese
  '🇵🇱': 'PL',    // Polish
  '🇹🇼': 'ZH-TW'  // Chinese (Traditional) -> força fallback
};

const DEEPL_SUPPORTED_TARGETS = new Set([
  'BG','CS','DA','DE','EL','EN','EN-GB','EN-US','ES','ET','FI','FR','HU',
  'ID','IT','JA','KO','LT','LV','NB','NL','PL','PT','PT-PT','PT-BR','RO',
  'RU','SK','SL','SV','TR','UK','ZH' // (sem ZH-TW para forçar fallback a Tradicional)
]);

const CHANNEL_ALLOWLIST = new Set(
  ALLOWED_CHANNELS.split(',').map(s => s.trim()).filter(Boolean)
);

const LIBRE_ENDPOINTS = (LIBRETRANSLATE_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ===== Discord client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // ativa no Developer Portal
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ===== Helpers =====
function isAllowedChannel(channel) {
  if (!CHANNEL_ALLOWLIST.size) return true;
  return CHANNEL_ALLOWLIST.has(channel?.id);
}

function preProcessText(text) {
  const t = (text || '').trim().toLowerCase();
  const dict = new Map([
    ['もし もし', 'hello'],
    ['もしもし', 'hello'],
    ['こんにちは', 'hello'],
    ['こんばんは', 'good evening'],
    ['ありがとう', 'thank you'],
    ['afrikaans dankie', 'thank you'],
    ['dankie', 'thank you'],
  ]);
  return dict.get(t) || text;
}

// timeout helper
function withTimeout(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(id) };
}

// ===== Tradução: DeepL =====
async function translateDeepL(text, target = 'EN-US') {
  const params = new URLSearchParams();
  params.append('text', text);
  params.append('target_lang', target);
  const res = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${DEEPL_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}`);
  const data = await res.json();
  return data?.translations?.[0]?.text || text;
}

// ===== Tradução: LibreTranslate (multi-endpoint robusto) =====
async function translateLibreAt(baseUrl, text, to = 'en') {
  const { signal, cancel } = withTimeout(8000);
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/,'')}/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Kingshot-TranslateBot/1.0 (+discord)'
      },
      body: JSON.stringify({ q: text, source: 'auto', target: to, format: 'text' }),
      signal
    });
  } finally {
    cancel();
  }

  if (!res.ok) {
    const bodyTxt = await res.text().catch(() => '');
    throw new Error(`Libre ${res.status} @ ${baseUrl} — ${bodyTxt.slice(0,120)}`);
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const bodyTxt = await res.text().catch(() => '');
    throw new Error(`Libre invalid content-type (${ct}) @ ${baseUrl} — ${bodyTxt.slice(0,80)}`);
  }

  let data;
  try { data = await res.json(); }
  catch (e) {
    const bodyTxt = await res.text().catch(() => '');
    throw new Error(`Libre JSON parse fail @ ${baseUrl} — ${bodyTxt.slice(0,120)}`);
  }

  return data?.translatedText || text;
}

async function translateLibre(text, to = 'en') {
  const list = LIBRE_ENDPOINTS.length ? LIBRE_ENDPOINTS : ['https://libretranslate.de'];
  let lastErr;
  for (const base of list) {
    try {
      return await translateLibreAt(base, text, to);
    } catch (e) {
      lastErr = e;
      console.warn(`[Libre] Falhou em ${base}: ${e.message}`);
    }
  }
  throw lastErr || new Error('Nenhum endpoint LibreTranslate disponível');
}

// ===== Tradução: Google (endpoint público não-oficial; último recurso) =====
async function translateGooglePublic(text, to = 'en') {
  const url = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google ${res.status}`);
  const json = await res.json();
  const chunks = (json?.[0] || []).map(seg => seg?.[0]).filter(Boolean);
  return chunks.join(' ') || text;
}

// ===== Orquestrador: DeepL -> Libre -> Google =====
async function smartTranslate(original, targetDeepL = 'EN-US') {
  const text = preProcessText(original);
  const targetBase = targetDeepL.split('-')[0].toLowerCase();

  if (DEEPL_KEY && DEEPL_SUPPORTED_TARGETS.has(targetDeepL.toUpperCase())) {
    try {
      return await translateDeepL(text, targetDeepL);
    } catch (e) {
      console.warn(`DeepL falhou (${e.message}). A tentar Libre...`);
    }
  }
  try {
    return await translateLibre(text, targetBase);
  } catch (e) {
    console.warn(`Libre falhou (${e.message}). A tentar Google público...`);
  }
  try {
    return await translateGooglePublic(text, targetBase);
  } catch (e) {
    console.warn(`Google público falhou (${e.message}). A devolver original.`);
    return text;
  }
}

// ===== UI: criar botões (máx. 2 rows, 5 por row) =====
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Constrói 1..N rows com 1..5 botões cada; ignora rows vazias
function buildFlagRows(messageId) {
  const pairs = Object.entries(FLAG_TO_LANG)
    .filter(([flag, lang]) => typeof flag === 'string' && flag.length && typeof lang === 'string' && lang.length);

  const flags = pairs.map(([flag]) => flag);
  if (!flags.length) return [];

  const rows = [];
  for (const group of chunk(flags, 5)) {
    const row = new ActionRowBuilder();
    for (const flag of group) {
      const lang = FLAG_TO_LANG[flag];
      if (!lang) continue;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tr:${lang}:${messageId}`)
          .setLabel(flag) // emoji como label
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (row.components.length >= 1 && row.components.length <= 5) {
      rows.push(row);
    }
    if (rows.length === 2) break; // máximo 2 linhas
  }
  return rows;
}

// ===== 1) Ao surgir uma mensagem, publicar control message com botões =====
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.guild || !message.channel) return;
    if (!isAllowedChannel(message.channel)) return;
    if (!message.content?.trim()) return;

    const rows = buildFlagRows(message.id);

    if (!rows.length) {
      console.warn('⚠️ Sem rows de botões válidas — a ignorar components.');
      await message.reply({
        content: 'Translate this message:',
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    await message.reply({
      content: 'Translate this message:',
      components: rows,
      allowedMentions: { repliedUser: false }
    });
  } catch (err) {
    console.error('MessageCreate error:', err);
  }
});

// ===== 2) Clique no botão → traduzir e responder EPHEMERAL =====
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const custom = interaction.customId; // "tr:<LANG>:<MESSAGE_ID>"
    if (!custom.startsWith('tr:')) return;

    const [, lang, msgId] = custom.split(':');
    const channel = interaction.channel;
    if (!channel) return;

    let originalMsg;
    try {
      originalMsg = await channel.messages.fetch(msgId);
    } catch {
      return interaction.reply({ content: 'Original message not found.', ephemeral: true });
    }

    const original = originalMsg?.content?.trim();
    if (!original) {
      return interaction.reply({ content: 'No text to translate in that message.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true }); // 🔒 privado

    const translated = await smartTranslate(original, lang);

    const embed = new EmbedBuilder()
      .setTitle(`🌐 Translation (${lang})`)
      .setDescription(translated || '*Translation failed.*')
      .setFooter({ text: `Requested by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction?.deferred || interaction?.replied) {
      await interaction.editReply({ content: 'An error occurred while translating.' }).catch(() => {});
    } else {
      await interaction.reply({ content: 'An error occurred while translating.', ephemeral: true }).catch(() => {});
    }
  }
});

// ===== Login =====
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});
client.login(DISCORD_TOKEN);
