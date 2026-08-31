// ════════════════════════════════════════════════════════════════════
// FAZA 6 (qoldiq) — Kuryerni oziq-ovqat buyurtmasiga biriktirish,
// "Qabul qildim" -> Live Location so'rash, yetkazilgach baholash
//
// Haydovchi paneli / jonli xarita / OSRM marshrut — ALLAQACHON BOR
// (taksi uchun qurilgan). Bu fayl ularni oziq-ovqat buyurtmalariga
// (orders.courier_id) ham ulaydi.
// ════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { updateOrderStatus, STATUS_LABEL } = require('./faza4_buyurtma_holati_va_guruh');

// ─────────────────────────────────────────────────────────────────
// 1. "Kuryerga berish" bosilganda — faol kuryerlar ro'yxatini ko'rsatish
//    (faza4.js'dagi 'ord_assign' callback shu funksiyani chaqiradi)
// ─────────────────────────────────────────────────────────────────
async function showCourierPicker(bot, query, orderId) {
  const { data: drivers, error } = await supabase
    .from('drivers')
    .select('id, full_name, rating, is_online')
    .eq('is_active', true)
    .order('is_online', { ascending: false }) // onlaynlar birinchi
    .order('rating', { ascending: false });

  if (error || !drivers?.length) {
    await bot.sendMessage(query.message.chat.id, 'Hozircha faol kuryer topilmadi.');
    return;
  }

  const buttons = drivers.map((d) => [
    {
      text: `${d.is_online ? '🟢' : '⚪️'} ${d.full_name} — ⭐️${Number(d.rating).toFixed(1)}`,
      callback_data: `ord_courier:${orderId}:${d.id}`,
    },
  ]);

  await bot.sendMessage(query.message.chat.id, 'Kimga beramiz?', {
    reply_markup: { inline_keyboard: buttons },
  });
}

// ─────────────────────────────────────────────────────────────────
// 2. Kuryer tanlanganda — biriktirish + kuryerga xabar + botga tugma
// ─────────────────────────────────────────────────────────────────
function registerCourierAssignmentHandlers(bot) {
  bot.on('callback_query', async (query) => {
    const data = query.data || '';

    if (data.startsWith('ord_assign:')) {
      const [, orderId] = data.split(':');
      await showCourierPicker(bot, query, orderId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('ord_courier:')) {
      const [, orderId, driverId] = data.split(':');
      await supabase.from('orders').update({ courier_id: driverId }).eq('id', orderId);
      await updateOrderStatus(orderId, 'courier_assigned');

      const { data: driver } = await supabase.from('drivers').select('telegram_id, full_name').eq('id', driverId).single();
      const { data: order } = await supabase
        .from('orders')
        .select('id, address_text, latitude, longitude, business:business_id(name)')
        .eq('id', orderId)
        .single();

      if (driver?.telegram_id) {
        await bot.sendMessage(
          driver.telegram_id,
          `🚴 Sizga yangi yetkazib berish!\n\n📍 ${order.business?.name}\n🏠 ${order.address_text ?? 'Manzil xaritada'}`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: '✅ Qabul qildim', callback_data: `ord_courier_ack:${orderId}` }]],
            },
          }
        );
      }
      await bot.answerCallbackQuery(query.id, { text: `${driver?.full_name} ga biriktirildi` });
    }

    else if (data.startsWith('ord_courier_ack:')) {
      const [, orderId] = data.split(':');
      await updateOrderStatus(orderId, 'on_the_way');

      // Telegram Live Location'ni bot avtomatik yoqolmaydi — foydalanuvchi
      // o'zi location ulashish tugmasini bosishi kerak. Shu sababli aniq
      // yo'riqnoma bilan so'raymiz (reply keyboard, faqat shu chat uchun):
      await bot.sendMessage(query.message.chat.id, 'Buyurtmani qabul qildingiz. Endi joylashuvingizni ulashing 👇', {
        reply_markup: {
          keyboard: [[{ text: '📍 Live Location yuborish', request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      await bot.answerCallbackQuery(query.id);
    }
  });

  // Kuryer joylashuvini yuborganda — drivers jadvali yangilanadi
  // (Mini App xaritasi shu ustunlarni real-time o'qiydi — Supabase Realtime orqali)
  bot.on('location', async (msg) => {
    await supabase
      .from('drivers')
      .update({
        current_latitude: msg.location.latitude,
        current_longitude: msg.location.longitude,
        location_updated_at: new Date().toISOString(),
      })
      .eq('telegram_id', msg.from.id);
  });
}

// ─────────────────────────────────────────────────────────────────
// 3. "Yetkazildi" belgilanganda — mijozdan baho so'rash
//    (kuryer tugmasi yoki admin panel "Yetkazildi" bossa shu chaqiriladi)
// ─────────────────────────────────────────────────────────────────
async function askForRating(bot, orderId) {
  await updateOrderStatus(orderId, 'delivered');
  // Bu yerda trg_calculate_order_commission trigger avtomatik ishlaydi —
  // commission_amount/restaurant_payout bazada o'zi hisoblanadi.

  const { data: order } = await supabase
    .from('orders')
    .select('courier_id, customer:customer_id(telegram_id)')
    .eq('id', orderId)
    .single();

  if (!order?.customer?.telegram_id || !order.courier_id) return;

  await bot.sendMessage(order.customer.telegram_id, "🏁 Yetkazildi! Kuryerni baholang:", {
    reply_markup: {
      inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: '⭐️'.repeat(n), callback_data: `rate:${orderId}:${n}` }))],
    },
  });
}

function registerRatingHandler(bot) {
  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    if (!data.startsWith('rate:')) return;
    const [, orderId, ratingStr] = data.split(':');

    const { data: order } = await supabase.from('orders').select('courier_id').eq('id', orderId).single();
    if (!order?.courier_id) return;

    await supabase.from('courier_ratings').insert({
      driver_id: order.courier_id,
      order_id: orderId,
      rating: Number(ratingStr),
    });

    // Kuryerning avg reytingini yangilaymiz
    const { data: ratings } = await supabase.from('courier_ratings').select('rating').eq('driver_id', order.courier_id);
    const avg = ratings.reduce((s, r) => s + r.rating, 0) / ratings.length;
    await supabase.from('drivers').update({ rating: avg.toFixed(2) }).eq('id', order.courier_id);

    await bot.editMessageText('Rahmat! Bahoyingiz yuborildi 🙏', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });
    await bot.answerCallbackQuery(query.id);
  });
}

module.exports = {
  showCourierPicker,
  registerCourierAssignmentHandlers,
  askForRating,
  registerRatingHandler,
};
