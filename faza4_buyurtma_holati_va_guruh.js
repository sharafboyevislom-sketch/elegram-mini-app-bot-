// ════════════════════════════════════════════════════════════════════
// FAZA 4 — Buyurtma holati oqimi + restoran ish guruhiga bildirishnoma
//
// Kutubxona: node-telegram-bot-api (loglardan tasdiqlangan)
// Talab qilinadi: bot.js'da mavjud `bot` (TelegramBot instance) va
// `supabase` (createClient bilan yaratilgan) obyektlari
//
// CLAUDE CODE UCHUN INTEGRATSIYA:
//   1. Bu fayldagi funksiyalarni bot.js'ga import qiling yoki joylashtiring
//   2. `notifyRestaurantGroup(bot, orderId)` ni — mijoz checkout tugatgan joyda
//      (hozirgi "buyurtma yaratildi" logikasi tugagandan keyin) chaqiring
//   3. `registerOrderFlowHandlers(bot)` ni bot ishga tushganda bir marta
//      chaqiring (masalan bot.js oxirida)
//
// Holat oqimi (orders.status, bazada CHECK constraint sifatida tayyor):
//   new -> confirmed -> preparing -> ready -> courier_assigned -> on_the_way -> delivered
//   (har qanday bosqichdan -> cancelled)
// ════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STATUS_LABEL = {
  new: "🆕 Yangi",
  confirmed: "✅ Qabul qilindi",
  preparing: "👨‍🍳 Tayyorlanmoqda",
  ready: "📦 Tayyor",
  courier_assigned: "🚴 Kuryerga berildi",
  on_the_way: "🛣 Yo'lda",
  delivered: "🏁 Yetkazildi",
  cancelled: "❌ Bekor qilindi",
};

// ─────────────────────────────────────────────────────────────────
// 1. Yangi buyurtma kelganda — restoran guruhiga xabar yuborish
// ─────────────────────────────────────────────────────────────────
async function notifyRestaurantGroup(bot, orderId) {
  const { data: order, error } = await supabase
    .from('orders')
    .select(`
      id, total_amount, payment_method, address_text, latitude, longitude, status,
      business:business_id ( name, group_chat_id ),
      customer:customer_id ( full_name, phone, telegram_id ),
      order_items ( product_name, price, quantity )
    `)
    .eq('id', orderId)
    .single();

  if (error || !order) {
    console.error('notifyRestaurantGroup: buyurtma topilmadi', error);
    return;
  }
  if (!order.business?.group_chat_id) {
    console.warn(`notifyRestaurantGroup: business'da group_chat_id yo'q (order ${orderId})`);
    return;
  }

  const itemsText = order.order_items
    .map((i) => `• ${i.product_name} x${i.quantity} — ${Number(i.price).toLocaleString('ru-RU')} so'm`)
    .join('\n');

  const paymentText = order.payment_method === 'card' ? "💳 Kartaga o'tkazma" : "💵 Naqd";

  const text =
    `🆕 <b>Yangi buyurtma!</b>\n\n` +
    `${itemsText}\n\n` +
    `💰 Jami: <b>${Number(order.total_amount).toLocaleString('ru-RU')} so'm</b>\n` +
    `${paymentText}\n` +
    `👤 ${order.customer?.full_name ?? "Noma'lum"} ${order.customer?.phone ? '· ' + order.customer.phone : ''}\n` +
    `📍 ${order.address_text ?? "Manzil xaritada belgilangan"}`;

  await bot.sendMessage(order.business.group_chat_id, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Qabul qilish', callback_data: `ord_accept:${order.id}` },
          { text: '❌ Bekor qilish', callback_data: `ord_cancel:${order.id}` },
        ],
      ],
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// 2. Guruhdagi tugmalar bosilganda — status o'tishlari
// ─────────────────────────────────────────────────────────────────
function registerOrderFlowHandlers(bot) {
  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    const [action, orderId] = data.split(':');
    if (!orderId || !action.startsWith('ord_')) return; // boshqa handlerlarga tegishli bo'lishi mumkin

    try {
      if (action === 'ord_accept') {
        await updateOrderStatus(orderId, 'confirmed', query.from.id);
        await editGroupMessage(bot, query, orderId, 'confirmed', [
          [{ text: '📦 Tayyor', callback_data: `ord_ready:${orderId}` }],
        ]);
        await notifyCustomer(bot, orderId, "✅ Buyurtmangiz qabul qilindi, tayyorlanmoqda!");
      }

      else if (action === 'ord_cancel') {
        // Sabab so'raymiz (force-reply)
        const sent = await bot.sendMessage(query.message.chat.id, '❓ Bekor qilish sababini yozing:', {
          reply_markup: { force_reply: true },
        });
        pendingCancelReasons.set(sent.message_id, { orderId, byTelegramId: query.from.id });
      }

      else if (action === 'ord_ready') {
        await updateOrderStatus(orderId, 'ready');
        await editGroupMessage(bot, query, orderId, 'ready', [
          [{ text: '🚴 Kuryerga berish', callback_data: `ord_assign:${orderId}` }],
        ]);
        await notifyCustomer(bot, orderId, "📦 Buyurtmangiz tayyor, kuryer kutilmoqda!");
      }

      // DIQQAT: 'ord_assign' shu yerda emas — faza6.js'dagi
      // registerCourierAssignmentHandlers(bot) uni ushlaydi (showCourierPicker
      // o'sha faylda joylashgan, aylanma require'dan qochish uchun shunday qilindi).

      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error('order flow callback xatosi:', err);
      await bot.answerCallbackQuery(query.id, { text: 'Xatolik yuz berdi, qayta urinib ko\'ring' });
    }
  });

  // Bekor qilish sababi javobini tutib olish
  bot.on('message', async (msg) => {
    if (!msg.reply_to_message) return;
    const pending = pendingCancelReasons.get(msg.reply_to_message.message_id);
    if (!pending) return;

    await updateOrderStatus(pending.orderId, 'cancelled', pending.byTelegramId, msg.text);
    await bot.sendMessage(msg.chat.id, `❌ Buyurtma bekor qilindi.\nSabab: ${msg.text}`);
    await notifyCustomer(bot, pending.orderId, `❌ Afsuski buyurtmangiz bekor qilindi.\nSabab: ${msg.text}`);
    pendingCancelReasons.delete(msg.reply_to_message.message_id);
  });
}

const pendingCancelReasons = new Map(); // message_id -> { orderId, byTelegramId }

// ─────────────────────────────────────────────────────────────────
// Yordamchi funksiyalar
// ─────────────────────────────────────────────────────────────────
async function updateOrderStatus(orderId, status, byTelegramId = null, cancelReason = null) {
  const patch = { status };
  if (status === 'confirmed') patch.accepted_by_telegram_id = byTelegramId;
  if (status === 'cancelled') {
    patch.cancelled_by_telegram_id = byTelegramId;
    patch.cancel_reason = cancelReason;
  }
  const { error } = await supabase.from('orders').update(patch).eq('id', orderId);
  if (error) console.error('updateOrderStatus xatosi:', error);
}

async function editGroupMessage(bot, query, orderId, status, nextButtons) {
  const newText = query.message.text.split('\n\n📍')[0]; // narx/tarkib qismini saqlab qolamiz
  try {
    await bot.editMessageText(`${newText}\n\nHolat: ${STATUS_LABEL[status]}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: nextButtons },
    });
  } catch (e) {
    console.error('editGroupMessage xatosi:', e);
  }
}

async function notifyCustomer(bot, orderId, text) {
  const { data: order } = await supabase
    .from('orders')
    .select('customer:customer_id ( telegram_id )')
    .eq('id', orderId)
    .single();
  if (order?.customer?.telegram_id) {
    await bot.sendMessage(order.customer.telegram_id, text).catch((e) =>
      console.error('notifyCustomer xatosi:', e)
    );
  }
}

module.exports = { notifyRestaurantGroup, registerOrderFlowHandlers, updateOrderStatus, STATUS_LABEL };

// DIQQAT: `showCourierPicker` funksiyasi shu faylda emas — faza6 faylida.
// Ikkala faylni ham import qilib, `bot`ni ikkalasiga ham uzatish kerak bo'ladi
// (yoki ularni bitta modulga birlashtiring — Claude Code buni loyihangizning
// modul tuzilishiga (CommonJS/ESM) qarab to'g'ri joylashtiradi).
