// ════════════════════════════════════════════════════════════════════
// FAZA 8 — Guruh marketing dvigateli
//
// GEMINI_API_KEY Railway'da allaqachon sozlangan.
// Kerak: `npm install node-cron @google/genai`
// Ishga tushirish: bot.js oxirida `require('./faza8_guruh_marketing')(bot);`
// ════════════════════════════════════════════════════════════════════

const cron = require('node-cron');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

module.exports = function initGroupMarketing(bot) {
  // Tushlik va kechki ovqatga 1 soat qolganda (12:00 va 19:00 ga tayyorlab qo'yish uchun 11:00/18:00)
  cron.schedule('0 11 * * *', () => triggerReadyOffers(bot, 'lunch'));
  cron.schedule('0 18 * * *', () => triggerReadyOffers(bot, 'dinner'));
};

// ─────────────────────────────────────────────────────────────────
// 1. "draft" holatidagi takliflarni tekshirib, post yaratib, yuborish
//    (admin oldindan `group_offers`ga qator qo'shib qo'yadi — mahsulot,
//    guruh narxi, miqdor cheklovi; bu cron uni "sotuvga chiqaradi")
// ─────────────────────────────────────────────────────────────────
async function triggerReadyOffers(bot, mealSlot) {
  const { data: offers, error } = await supabase
    .from('group_offers')
    .select(`
      id, original_price, group_price, quantity_limit, expires_at,
      product:product_id ( name, description, image_url ),
      business:business_id ( name, region_id )
    `)
    .eq('status', 'draft');

  if (error || !offers?.length) return;

  for (const offer of offers) {
    try {
      const postText = await generatePostText(offer);
      await supabase.from('group_offers').update({ post_text: postText, status: 'sent', sent_at: new Date().toISOString() }).eq('id', offer.id);

      const { data: groups } = await supabase
        .from('groups')
        .select('telegram_group_id')
        .eq('is_active', true)
        .eq('region_id', offer.business.region_id);

      const discountPct = Math.round((1 - offer.group_price / offer.original_price) * 100);
      const caption =
        `${postText}\n\n` +
        `~${Number(offer.original_price).toLocaleString('ru-RU')} so'm~ → ` +
        `<b>${Number(offer.group_price).toLocaleString('ru-RU')} so'm</b> (-${discountPct}%)\n` +
        `Faqat ${offer.quantity_limit} ta!`;

      for (const g of groups ?? []) {
        const sendFn = offer.product.image_url
          ? bot.sendPhoto(g.telegram_group_id, offer.product.image_url, {
              caption,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[{ text: "🛒 Olish", callback_data: `claim_offer:${offer.id}` }]] },
            })
          : bot.sendMessage(g.telegram_group_id, caption, {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[{ text: "🛒 Olish", callback_data: `claim_offer:${offer.id}` }]] },
            });
        await sendFn.catch((e) => console.error(`guruhga (${g.telegram_group_id}) yuborishda xato:`, e));
      }
    } catch (e) {
      console.error(`group_offer ${offer.id} yuborishda xato:`, e);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// 2. Gemini orqali reklama matnini yaratish
//    Model: Flash darajasi yetarli (qisqa, oddiy matn generatsiyasi)
// ─────────────────────────────────────────────────────────────────
async function generatePostText(offer) {
  const prompt =
    `Sen "${offer.business.name}" restorani uchun Telegram guruhiga qisqa, ` +
    `jozibali reklama posti yozyapsan. Mahsulot: "${offer.product.name}" ` +
    `(${offer.product.description ?? ''}). ` +
    `2-3 gapdan oshmasin, emoji ishlat, lekin ko'p bo'lmasin. ` +
    `Narx va chegirmani o'zing yozma — ular alohida qo'shiladi. ` +
    `Faqat post matnini qaytar, boshqa hech narsa yozma.`;

  const response = await genai.models.generateContent({
    model: 'gemini-flash-latest',
    contents: prompt,
  });

  return response.text?.trim() || `${offer.product.name} — bugungi maxsus taklif!`;
}

// ─────────────────────────────────────────────────────────────────
// 3. Guruhda "Olish" bosilganda — atomik ravishda joy band qilish
// ─────────────────────────────────────────────────────────────────
function registerGroupOfferHandlers(bot) {
  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    if (!data.startsWith('claim_offer:')) return;
    const [, offerId] = data.split(':');

    const { data: claimed, error } = await supabase.rpc('claim_group_offer', { p_offer_id: offerId, p_qty: 1 });

    if (error || !claimed) {
      await bot.answerCallbackQuery(query.id, { text: 'Afsuski, tugab qoldi 😔', show_alert: true });
      return;
    }

    // Mijozni bot'dagi shaxsiy chatga checkout uchun yo'naltiramiz
    await bot.answerCallbackQuery(query.id, { text: "Band qilindi! Botdan buyurtmani yakunlang." });
    await bot.sendMessage(
      query.from.id,
      `🎉 Taklif band qilindi! Buyurtmani yakunlash uchun Mini App'ni oching.`
    ).catch(() => {
      // Foydalanuvchi botni hali /start qilmagan bo'lishi mumkin — jim o'tkazamiz
    });
  });
}

module.exports.registerGroupOfferHandlers = registerGroupOfferHandlers;
module.exports.generatePostText = generatePostText;
