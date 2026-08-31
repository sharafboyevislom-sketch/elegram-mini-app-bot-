// ════════════════════════════════════════════════════════════════════
// FAZA 7 — 15 kunlik hisob-kitob avtomatlashtirish
//
// Komissiya hisoblash allaqachon bazada ishlaydi (trigger:
// calculate_order_commission) — bu fayl faqat DAVR boshqaruvi va
// eslatma/blok cron ishini qiladi.
//
// Kerak: `npm install node-cron`
// Ishga tushirish: bot.js oxirida `require('./faza7_hisobkitob_cron')(bot);`
// ════════════════════════════════════════════════════════════════════

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const PERIOD_DAYS = 15;
const REMINDER_DAY = 13;
const BLOCK_DAY = 16;

module.exports = function initSettlementCron(bot) {
  // Har kuni 02:05 da tekshiradi (16-kun bloki spetsifikatsiyada "16-kun, 02:00" deyilgan)
  cron.schedule('5 2 * * *', () => runDailyCheck(bot));

  // Har oyning 1 va 16-sanasida — muddati o'tgan restoranlar uchun yangi davr ochish
  cron.schedule('10 0 1,16 * *', () => openNewPeriodsIfNeeded());
};

async function runDailyCheck(bot) {
  const { data: settlements, error } = await supabase
    .from('settlements')
    .select('id, business_id, period_start, period_end, commission_owed, amount_paid, status, business:business_id(name, group_chat_id)')
    .in('status', ['open', 'due']);

  if (error) {
    console.error('settlement cron: o\'qishda xatolik', error);
    return;
  }

  const today = new Date();

  for (const s of settlements) {
    const dayInPeriod = Math.floor((today - new Date(s.period_start)) / 86400000) + 1;
    const owed = Number(s.commission_owed) - Number(s.amount_paid || 0);
    if (owed <= 0) continue; // to'langan

    if (dayInPeriod === REMINDER_DAY && s.status === 'open') {
      await supabase.from('settlements').update({ status: 'due' }).eq('id', s.id);
      if (s.business?.group_chat_id) {
        await bot.sendMessage(
          s.business.group_chat_id,
          `⏰ Eslatma: hisob-kitob muddati yaqinlashmoqda.\n` +
            `Davr: ${s.period_start} — ${s.period_end}\n` +
            `Qarz: ${owed.toLocaleString('ru-RU')} so'm\n` +
            `To'lov muddati: ${new Date(new Date(s.period_start).getTime() + BLOCK_DAY * 86400000).toLocaleDateString('ru-RU')}gacha`
        ).catch((e) => console.error('reminder yuborishda xato:', e));
      }
    }

    if (dayInPeriod >= BLOCK_DAY && s.status !== 'overdue') {
      await supabase.from('settlements').update({ status: 'overdue' }).eq('id', s.id);
      await supabase.from('businesses').update({ is_active: false }).eq('id', s.business_id);
      if (s.business?.group_chat_id) {
        await bot.sendMessage(
          s.business.group_chat_id,
          `🚫 Hisob-kitob muddati o'tdi (${owed.toLocaleString('ru-RU')} so'm qarz).\n` +
            `Yangi buyurtmalar vaqtincha to'xtatildi. To'lovni tasdiqlash uchun admin bilan bog'laning.`
        ).catch((e) => console.error('blok xabarini yuborishda xato:', e));
      }
    }
  }
}

// Muddati tugagan (yoki hali umuman davri bo'lmagan) faol restoranlar uchun
// yangi 15-kunlik davr ochadi
async function openNewPeriodsIfNeeded() {
  const { data: businesses } = await supabase.from('businesses').select('id').eq('is_active', true);

  for (const b of businesses ?? []) {
    const { data: last } = await supabase
      .from('settlements')
      .select('period_end, status')
      .eq('business_id', b.id)
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle();

    const needsNew = !last || (last.status === 'paid' && new Date(last.period_end) < new Date());
    if (!needsNew) continue;

    const start = last ? addDays(new Date(last.period_end), 1) : new Date();
    const end = addDays(start, PERIOD_DAYS - 1);

    await supabase.rpc('generate_settlement', {
      p_business_id: b.id,
      p_period_start: start.toISOString().slice(0, 10),
      p_period_end: end.toISOString().slice(0, 10),
    });
  }
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ADMIN "To'landi" bosganda chaqiriladigan funksiya — admin panelga ulanadi
// (masalan bir REST/RPC endpoint yoki to'g'ridan-to'g'ri Supabase update):
async function markSettlementPaid(settlementId, confirmedByName) {
  const { data: s } = await supabase.from('settlements').select('business_id, commission_owed').eq('id', settlementId).single();
  await supabase
    .from('settlements')
    .update({ status: 'paid', amount_paid: s.commission_owed, paid_at: new Date().toISOString(), confirmed_by: confirmedByName })
    .eq('id', settlementId);
  await supabase.from('businesses').update({ is_active: true }).eq('id', s.business_id);
}

module.exports.markSettlementPaid = markSettlementPaid;
