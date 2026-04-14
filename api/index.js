import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import Groq from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const app = express();
app.use(express.json());

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;
const sheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(botToken); 
const genAI = new GoogleGenerativeAI(geminiApiKey);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);

// =====================================================================
// SUPABASE SESSION HELPERS (Pengganti userSessions={})
// =====================================================================
const getSession = async (chatId) => {
  const { data, error } = await supabase.from('user_sessions').select('session_data').eq('chat_id', chatId).single();
  return data ? data.session_data : null;
};

const setSession = async (chatId, sessionData) => {
  await supabase.from('user_sessions').upsert({ chat_id: chatId, session_data: sessionData, updated_at: new Date() });
};

const deleteSession = async (chatId) => {
  await supabase.from('user_sessions').delete().eq('chat_id', chatId);
};

// =====================================================================
// PROMPT & HELPER FUNCTIONS
// ===================================================================== 

// =====================================================================
// PROMPT & HELPER FUNCTIONS
// =====================================================================
const promptDeteksiJenis = `Kamu adalah AI klasifikasi transaksi keuangan.
Dari kalimat user, tentukan apakah ini "Pemasukan" atau "Pengeluaran".
Kembalikan HANYA satu kata: Pemasukan atau Pengeluaran. Tanpa teks lain apapun.`;

const promptPengeluaran = `Kamu adalah AI pencatat pengeluaran keuangan.
Ekstrak data dari kalimat user menjadi JSON dengan struktur TEPAT ini:
{
  "item": "nama barang atau jasa yang dibeli",
  "kategori": "kategori pengeluaran misal Makanan Transportasi Coffee Shop dll",
  "nominal": 25000,
  "tempat": "nama tempat atau null",
  "tujuan": "tujuan kegiatan atau null",
  "partisipan": "bersama siapa atau null",
  "metode_bayar": "Cash atau QRIS atau Transfer atau null",
  "rating": "nilai 1-5 atau ulasan singkat atau null"
}
ATURAN KETAT:
- nominal harus angka (integer), bukan string. Jika tidak disebutkan isi 0.
- Untuk field yang tidak ada informasinya, isi dengan nilai null (bukan string "null").
- Kembalikan JSON murni saja, TANPA markdown backtick, TANPA komentar, TANPA teks tambahan.`;

const promptPemasukan = `Kamu adalah AI pencatat pemasukan keuangan.
Ekstrak data dari kalimat user menjadi JSON dengan struktur TEPAT ini:
{
  "sumber_pemasukan": "asal uang misal Gaji Dikasih boss Jual barang dll",
  "kategori": "kategori pemasukan misal Gaji Bonus Uang Saku dll",
  "nominal": 50000,
  "catatan": "catatan tambahan atau null"
}
ATURAN KETAT:
- nominal harus angka (integer), bukan string. Jika tidak disebutkan isi 0.
- Untuk field yang tidak ada informasinya, isi dengan nilai null (bukan string "null").
- Kembalikan JSON murni saja, TANPA markdown backtick, TANPA komentar, TANPA teks tambahan.`;

const formatTeks = (teks) => (teks !== null && teks !== undefined && teks !== 'null') ? String(teks) : '-';

const ekstrakJson = (rawText) => {
  let cleaned = rawText
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  let braceDepth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{') {
      if (braceDepth === 0) start = i;
      braceDepth++;
    } else if (cleaned[i] === '}') {
      braceDepth--;
      if (braceDepth === 0 && start !== -1) {
        end = i;
        break;
      }
    }
  }

  if (start === -1 || end === -1) {
    throw new Error("Format JSON tidak ditemukan dari AI. Raw: " + rawText.substring(0, 200));
  }
  return JSON.parse(cleaned.substring(start, end + 1));
};

const parseIndoDate = (dateStr) => {
  if (!dateStr) return 0;
  try {
    const cleanStr = String(dateStr).replace(' (Edited)', '');
    const [datePart, timePart] = cleanStr.split(', ');
    const [d, m, y] = datePart.split('/');
    const [hr, min, sec] = timePart.split('.');
    return new Date(y, m - 1, d, hr, min, sec).getTime();
  } catch (e) {
    return 0;
  }
};

const deteksiJenisTransaksi = async (model, text) => {
  const result = await model.generateContent(`${promptDeteksiJenis}\n\nKalimat user: "${text}"`);
  const raw = result.response.text().trim().toLowerCase();
  if (raw.includes('pemasukan')) return 'Pemasukan';
  return 'Pengeluaran';
};

const ekstrakDetailTransaksi = async (model, jenisTransaksi, text, imageParts = null) => {
  const prompt = jenisTransaksi === 'Pemasukan' ? promptPemasukan : promptPengeluaran;
  const fullPrompt = `${prompt}\n\nTeks user: "${text}"`;
  
  let result;
  if (imageParts) {
    const imagePrompt = `${prompt}\n\nTolong ekstrak dari gambar/struk ini.${text ? `\nCatatan user: "${text}"` : ""}`;
    result = await model.generateContent([imagePrompt, ...imageParts]);
  } else {
    result = await model.generateContent(fullPrompt);
  }
  
  const data = ekstrakJson(result.response.text());
  data.jenis_transaksi = jenisTransaksi;
  return data;
};

const deteksiJenisTransaksiGroq = async (text) => {
  const response = await groq.chat.completions.create({
    messages: [{ role: "user", content: `${promptDeteksiJenis}\n\nKalimat user: "${text}"` }],
    model: "llama-3.3-70b-versatile",
    temperature: 0,
  });
  const raw = response.choices[0]?.message?.content.trim().toLowerCase() || '';
  if (raw.includes('pemasukan')) return 'Pemasukan';
  return 'Pengeluaran';
};

const ekstrakDetailTransaksiGroq = async (jenisTransaksi, text) => {
  const prompt = jenisTransaksi === 'Pemasukan' ? promptPemasukan : promptPengeluaran;
  const response = await groq.chat.completions.create({
    messages: [{ role: "user", content: `${prompt}\n\nTeks user: "${text}"` }],
    model: "llama-3.3-70b-versatile",
    temperature: 0,
  });
  const data = ekstrakJson(response.choices[0]?.message?.content);
  data.jenis_transaksi = jenisTransaksi; 
  return data;
};

const simpanKeSheets = async (chatId, data) => {
  try {
    await bot.sendMessage(chatId, '⏳ Sedang menyimpan ke Google Sheets...');
    await doc.loadInfo();
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    let pesanSukses = '';

    if (data.jenis_transaksi === 'Pemasukan') {
      const sheet = doc.sheetsByIndex[1];
      await sheet.addRow([timestamp, formatTeks(data.sumber_pemasukan), data.nominal || 0, formatTeks(data.kategori), formatTeks(data.catatan)]);
      pesanSukses = `✅ **Sukses! Pemasukan berhasil dicatat.**\n\n📅 Waktu: ${timestamp}\n🤑 Sumber: ${formatTeks(data.sumber_pemasukan)}\n💰 Nominal: Rp ${(data.nominal || 0).toLocaleString('id-ID')}\n📂 Kategori: ${formatTeks(data.kategori)}\n📝 Catatan: ${formatTeks(data.catatan)}`;
    } else {
      const sheet = doc.sheetsByIndex[0];
      await sheet.addRow([timestamp, formatTeks(data.item), formatTeks(data.kategori), data.nominal || 0, formatTeks(data.tempat), formatTeks(data.tujuan), formatTeks(data.partisipan), formatTeks(data.metode_bayar), formatTeks(data.rating)]);
      pesanSukses = `✅ **Sukses! Pengeluaran berhasil dicatat.**\n\n📅 Waktu: ${timestamp}\n☕ Item: ${formatTeks(data.item)}\n📂 Kategori: ${formatTeks(data.kategori)}\n💰 Nominal: Rp ${(data.nominal || 0).toLocaleString('id-ID')}\n📍 Tempat: ${formatTeks(data.tempat)}\n🎯 Tujuan: ${formatTeks(data.tujuan)}\n👥 Partisipan: ${formatTeks(data.partisipan)}\n💳 Metode: ${formatTeks(data.metode_bayar)}\n⭐ Rating: ${formatTeks(data.rating)}`;
    }

    await bot.sendMessage(chatId, pesanSukses, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Gagal nyimpen ke Sheets:", error);
    await bot.sendMessage(chatId, '❌ Waduh, gagal nyimpen ke Google Sheets. Coba cek log terminal ya.');
  }
};

const updateKeSheets = async (chatId, data, targetSheetIndex = 0) => {
  try {
    await bot.sendMessage(chatId, '⏳ Sedang mengupdate baris terakhir di Google Sheets...');
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[targetSheetIndex];
    const rows = await sheet.getRows();

    if (rows.length === 0) {
      await bot.sendMessage(chatId, 'Gagal update: Data masih kosong.');
      return;
    }

    const lastRow = rows[rows.length - 1];
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    let pesanEdit = '';

    if (targetSheetIndex === 1) {
      lastRow.assign({
        'Waktu': timestamp + ' (Edited)',
        'Sumber Pemasukan': formatTeks(data.sumber_pemasukan),
        'Nominal': data.nominal || 0,
        'Kategori': formatTeks(data.kategori),
        'Catatan': formatTeks(data.catatan)
      });
      pesanEdit = `✅ **Edit Sukses! Data Pemasukan terakhir berhasil diubah.**\n\n📅 Waktu: ${timestamp} (Edited)\n🤑 Sumber: ${formatTeks(data.sumber_pemasukan)}\n💰 Nominal: Rp ${(data.nominal || 0).toLocaleString('id-ID')}\n📂 Kategori: ${formatTeks(data.kategori)}\n📝 Catatan: ${formatTeks(data.catatan)}`;
    } else {
      lastRow.assign({
        'Waktu': timestamp + ' (Edited)',
        'Item': formatTeks(data.item),
        'Kategori': formatTeks(data.kategori),
        'Nominal': data.nominal || 0,
        'Tempat': formatTeks(data.tempat),
        'Tujuan': formatTeks(data.tujuan),
        'Partisipan': formatTeks(data.partisipan),
        'Metode': formatTeks(data.metode_bayar),
        'Rating': formatTeks(data.rating)
      });
      pesanEdit = `✅ **Edit Sukses! Data Pengeluaran terakhir berhasil diubah.**\n\n📅 Waktu: ${timestamp} (Edited)\n☕ Item: ${formatTeks(data.item)}\n📂 Kategori: ${formatTeks(data.kategori)}\n💰 Nominal: Rp ${(data.nominal || 0).toLocaleString('id-ID')}\n📍 Tempat: ${formatTeks(data.tempat)}\n🎯 Tujuan: ${formatTeks(data.tujuan)}\n👥 Partisipan: ${formatTeks(data.partisipan)}\n💳 Metode: ${formatTeks(data.metode_bayar)}\n⭐ Rating: ${formatTeks(data.rating)}`;
    }

    await lastRow.save();
    await bot.sendMessage(chatId, pesanEdit, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Gagal update ke Sheets:", error);
    await bot.sendMessage(chatId, '❌ Waduh, gagal edit data di Google Sheets. Pastikan nama Header di sheets udah sesuai.');
  }
};

const isKosong = (val) => {
  if (val === null || val === undefined) return true;
  const str = String(val).toLowerCase().trim();
  return str === '' || str === 'null' || str === 'tidak disebutkan' || str === '-';
};

const cekDataKurang = async (chatId, draftData, action = 'create', targetSheetIndex = 0) => {
  if (targetSheetIndex === 1) {
    if (isKosong(draftData.sumber_pemasukan)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "sumber_pemasukan", action, targetSheetIndex });
      await bot.sendMessage(chatId, `Eh, **sumber pemasukannya** dari mana nih?\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    if (!draftData.nominal || draftData.nominal === 0) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "nominal", action, targetSheetIndex });
      await bot.sendMessage(chatId, `Eh, **nominalnya** berapa duit? (Ketik angkanya aja) 💸`, { parse_mode: "Markdown" });
      return true;
    }
    if (isKosong(draftData.kategori)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "kategori", action, targetSheetIndex });
      await bot.sendMessage(chatId, `**Kategorinya** apa nih?\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    return false;
  } else {
    if (isKosong(draftData.item)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "item", action, targetSheetIndex });
      await bot.sendMessage(chatId, `Eh, **nama barang/jasanya** belum dapet nih. Tadi beli apa?\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    if (!draftData.nominal || draftData.nominal === 0) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "nominal", action, targetSheetIndex });
      await bot.sendMessage(chatId, `Eh, **harganya** belum dapet nih. Berapa duit tadi? 💸`, { parse_mode: "Markdown" });
      return true;
    }
    if (isKosong(draftData.kategori)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "kategori", action, targetSheetIndex });
      await bot.sendMessage(chatId, `**Kategorinya** masuk ke mana nih?\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    if (isKosong(draftData.tempat)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "tempat", action, targetSheetIndex });
      await bot.sendMessage(chatId, `**Tempatnya** di mana nih bos?\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    if (isKosong(draftData.tujuan)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "tujuan", action, targetSheetIndex });
      await bot.sendMessage(chatId, `Eh, **tujuannya** belum disebut nih.\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    if (isKosong(draftData.partisipan)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "partisipan", action, targetSheetIndex });
      await bot.sendMessage(chatId, `Perginya sama **siapa** nih?\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    if (isKosong(draftData.metode_bayar)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "metode_bayar", action, targetSheetIndex });
      await bot.sendMessage(chatId, `Bayarnya pakai **metode** apa?\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    if (isKosong(draftData.rating)) {
      await setSession(chatId, { mode: 'missing_field', draft: draftData, missingField: "rating", action, targetSheetIndex });
      await bot.sendMessage(chatId, `Terakhir nih, **Rating** berapa?\nKetik **'x'** buat skip.`, { parse_mode: "Markdown" });
      return true;
    }
    return false;
  }
};

// =====================================================================
// FITUR ANALISIS (Compound + GPT-OSS 120B)
// =====================================================================

const tarikDataSheetsUntukAnalisis = async () => {
  await doc.loadInfo();
  const sheetPengeluaran = doc.sheetsByIndex[0];
  const sheetPemasukan = doc.sheetsByIndex[1];

  // Kita tarik maksimal 50 baris terakhir agar Vercel tidak timeout & hemat token
  const rowsKeluar = await sheetPengeluaran.getRows();
  const rowsMasuk = await sheetPemasukan.getRows();
  
  const recentKeluar = rowsKeluar.slice(-50);
  const recentMasuk = rowsMasuk.slice(-50);

  let dataCSV = "=== PENGELUARAN ===\nTanggal,Item,Kategori,Nominal\n";
  recentKeluar.forEach(row => {
    if (row.get('Item')) dataCSV += `${row.get('Waktu')},${row.get('Item')},${row.get('Kategori')},${row.get('Nominal')}\n`;
  });

  dataCSV += "\n=== PEMASUKAN ===\nTanggal,Sumber,Kategori,Nominal\n";
  recentMasuk.forEach(row => {
    if (row.get('Sumber Pemasukan')) dataCSV += `${row.get('Waktu')},${row.get('Sumber Pemasukan')},${row.get('Kategori')},${row.get('Nominal')}\n`;
  });

  return dataCSV;
};

const jalankanAnalisisKeuangan = async (chatId) => {
  try {
    await bot.sendMessage(chatId, '🔍 Mengumpulkan data mentah dari database...');
    const dataCSV = await tarikDataSheetsUntukAnalisis();

    await bot.sendMessage(chatId, '🤖 GOAT GPT sedang melakukan komputasi dan crunching data matematis...');
    
    // TAHAP 1: Compound AI untuk Analisis Data Akurat
    const promptCompound = `Berikut adalah data riwayat keuangan format CSV.
Tugasmu sebagai Data Analyst murni:
1. Hitung total pemasukan dan total pengeluaran.
2. Cari selisihnya (Net Cashflow).
3. Identifikasi top 3 kategori pengeluaran terbesar.
4. Temukan pola atau anomali jika ada.
Keluarkan output teknis yang murni data dan statistik. Dilarang memberikan opini.
\nData:\n${dataCSV}`;

    const analisisResponse = await groq.chat.completions.create({
      messages: [{ role: "user", content: promptCompound }],
      model: "openai/gpt-oss-120b", // Pakai model paling flagship
      temperature: 0, // WAJIB 0 biar akurat ngitung angkanya
    });
    const analisisMentah = analisisResponse.choices[0]?.message?.content;

    await bot.sendMessage(chatId, '🗣️ Mengoper hasil ke GPT-OSS 120B untuk merangkai saran...');

    // TAHAP 2: GPT-OSS 120B untuk Humanize & Komunikasi
    const promptGptOss = `Kamu adalah asisten penasihat keuangan pribadi. 
Berikan respons dalam bahasa Indonesia yang asyik, tajam, santai, namun sangat suportif. Bicaralah selayaknya mengobrol dengan sesama Software Engineer. Gunakan analogi dari dunia programming, backend development, atau deployment arsitektur (misalnya: menyebut pengeluaran bocor sebagai 'memory leak', menabung sebagai 'optimasi database', atau sisa uang tipis sebagai 'resource limit').
Jangan panggil user dengan sebutan Bapak/Ibu. Langsung ke poinnya dan berikan kritik membangun tentang cashflow-nya.

ATURAN FORMATTING KETAT (UNTUK TAMPILAN TELEGRAM):
1. DILARANG KERAS menggunakan Tabel Markdown (| kolom | kolom |). Gunakan list biasa.
2. DILARANG KERAS menggunakan tag HTML seperti <br>.
3. DILARANG menggunakan Heading dengan hashtag (seperti # atau ##). 
4. Untuk membuat judul atau sub-judul, cukup gunakan teks tebal dengan format: **Judul Bagian**
5. Gunakan bullet points (-) untuk menjabarkan poin-poin.
6. Jaga agar output ringkas, padat, dan maksimal 4 paragraf utama agar tidak melebihi limit karakter chat.

Berikut adalah hasil hitungan matematis dari AI Data Analyst:
${analisisMentah}`;
    const gptOssResponse = await groq.chat.completions.create({
      messages: [{ role: "user", content: promptGptOss }],
      model: "openai/gpt-oss-120b", // Model raksasa khusus komunikasi NLP
      temperature: 0.7, // Ditinggikan sedikit agar bahasanya lebih kreatif
    });

    const saranFinal = gptOssResponse.choices[0]?.message?.content;
    const pesanLengkap = `📊 **Laporan Arsitektur Keuanganmu**\n\n${saranFinal}`;
    
    if (pesanLengkap.length > 4000) {
      const chunks = pesanLengkap.match(/[\s\S]{1,3900}(\n\n|$)/g) || [pesanLengkap.substring(0, 4000), pesanLengkap.substring(4000)];
      for (let i = 0; i < chunks.length; i++) {
        await bot.sendMessage(chatId, chunks[i].trim(), { parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(chatId, pesanLengkap, { parse_mode: "Markdown" });
    }

  } catch (error) {
    console.error("Gagal melakukan analisis:", error);
    await bot.sendMessage(chatId, '❌ Server sedang sibuk atau AI gagal menganalisis datamu. Coba lagi nanti ya.');
  }
};

// =====================================================================
// PERUBAHAN UTAMA: Fungsi diganti dari bot.on ke prosesPesan
// =====================================================================
const prosesPesan = async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';

  if (text === '/batal') {
    await deleteSession(chatId);
    await bot.sendMessage(chatId, 'Oke, proses sebelumnya dibatalkan. Ada yang mau dicatat lagi?');
    return;
  }

  if (text === '/start') {
    await deleteSession(chatId);
    await bot.sendMessage(chatId, `Halo, Akbar! 👋 Aku bot my keuangan gw anjay.\n\nCommand yang tersedia:\n📝 Langsung ketik pengeluaran/pemasukanmu\n📸 Kirim Foto Struk Belanjaanmu\n📊 /analisis - Review arsitektur keuanganmu\n↩️ /undo - Hapus data terakhir\n✏️ /edit - Ubah data terakhir\n❌ /batal - Batalkan percakapan bot`);
    return;
  }

  if (text === '/analisis') {
    await deleteSession(chatId);
    await jalankanAnalisisKeuangan(chatId);
    return;
  }

  if (text === '/undo') {
    await deleteSession(chatId);
    try {
      await bot.sendMessage(chatId, '⏳ Sedang mencari data terakhir untuk di-undo...');
      await doc.loadInfo();
      const sheet0 = doc.sheetsByIndex[0];
      const sheet1 = doc.sheetsByIndex[1];
      const rows0 = await sheet0.getRows();
      const rows1 = await sheet1.getRows();

      const lastRow0 = rows0.length > 0 ? rows0[rows0.length - 1] : null;
      const lastRow1 = rows1.length > 0 ? rows1[rows1.length - 1] : null;

      const time0 = lastRow0 ? parseIndoDate(lastRow0.get('Waktu')) : 0;
      const time1 = lastRow1 ? parseIndoDate(lastRow1.get('Waktu')) : 0;

      if (time0 === 0 && time1 === 0) {
        await bot.sendMessage(chatId, 'Pencatatan masih kosong nih, nggak ada yang bisa di-undo.');
        return;
      }

      let lastRowToDelete = null;
      let deletedName = '';

      if (time1 > time0) {
        lastRowToDelete = lastRow1;
        deletedName = `Pemasukan: ${lastRow1.get('Sumber Pemasukan') || 'Tidak diketahui'}`;
      } else {
        lastRowToDelete = lastRow0;
        deletedName = `Pengeluaran: ${lastRow0.get('Item') || 'Tidak diketahui'}`;
      }

      await lastRowToDelete.delete();
      await bot.sendMessage(chatId, `✅ **Sukses di-undo!** Data "${deletedName}" udah dihapus dari Sheets.`, { parse_mode: "Markdown" });
    } catch (error) {
      console.error("Gagal undo:", error);
      await bot.sendMessage(chatId, '❌ Gagal nge-undo data. Coba cek terminal.');
    }
    return;
  }

  if (text === '/edit') {
    await deleteSession(chatId);
    try {
      await bot.sendMessage(chatId, '⏳ Sedang mengambil data terakhir kamu...');
      await doc.loadInfo();
      const sheet0 = doc.sheetsByIndex[0];
      const sheet1 = doc.sheetsByIndex[1];
      const rows0 = await sheet0.getRows();
      const rows1 = await sheet1.getRows();

      const lastRow0 = rows0.length > 0 ? rows0[rows0.length - 1] : null;
      const lastRow1 = rows1.length > 0 ? rows1[rows1.length - 1] : null;

      const time0 = lastRow0 ? parseIndoDate(lastRow0.get('Waktu')) : 0;
      const time1 = lastRow1 ? parseIndoDate(lastRow1.get('Waktu')) : 0;

      if (time0 === 0 && time1 === 0) {
        await bot.sendMessage(chatId, 'Belum ada data yang bisa di-edit nih.');
        return;
      }

      let targetSheetIndex = 0;
      let jenisInfo = '';

      if (time1 > time0) {
        targetSheetIndex = 1;
        jenisInfo = `🤑 **${lastRow1.get('Sumber Pemasukan') || 'Sumber Tidak Diketahui'}** - Rp ${lastRow1.get('Nominal') || '0'}`;
      } else {
        targetSheetIndex = 0;
        jenisInfo = `☕ **${lastRow0.get('Item') || 'Item Tidak Diketahui'}** - Rp ${lastRow0.get('Nominal') || '0'}`;
      }

      userSessions[chatId] = { mode: 'edit_prompt', targetSheetIndex };
      await bot.sendMessage(chatId, `Data terakhir di Sheets:\n${jenisInfo}\n\nKetik kalimat revisi yang bener buat ngegantiin data ini.\n\nAtau ketik /batal kalau nggak jadi edit.`, { parse_mode: "Markdown" });
    } catch (error) {
      console.error("Gagal ambil data buat edit:", error);
      await bot.sendMessage(chatId, '❌ Gagal narik data terakhir. Coba lagi nanti.');
    }
    return;
  }

  const session = await getSession(chatId);
  if (session) {

    if (session.mode === 'edit_prompt') {
      await bot.sendMessage(chatId, '⏳ Sebentar, lagi ekstrak editan datanya...');
      try {
        const targetSheetIndex = session.targetSheetIndex;
        const prompt = targetSheetIndex === 1 ? promptPemasukan : promptPengeluaran;
        
        const response = await groq.chat.completions.create({
          messages: [{ role: "user", content: `${prompt}\n\nTeks user: "${text}"` }],
          model: "llama-3.3-70b-versatile",
          temperature: 0,
        });

        const data = ekstrakJson(response.choices[0]?.message?.content);
        data.jenis_transaksi = targetSheetIndex === 1 ? 'Pemasukan' : 'Pengeluaran';

        const adaYangKurang = await cekDataKurang(chatId, data, 'edit', targetSheetIndex);
        if (!adaYangKurang) {
          await updateKeSheets(chatId, data, targetSheetIndex);
          await deleteSession(chatId);
        }
      } catch (error) {
        console.error("Error AI saat edit:", error);
        await bot.sendMessage(chatId, '❌ Wah, AI-nya bingung. Coba format kalimat editnya dirapihin dikit ya.');
      }
      return;
    }

    if (session.mode === 'missing_field') {
      const missingField = session.missingField;

      if (text.toLowerCase() === 'x') {
        if (missingField === 'nominal') {
          await bot.sendMessage(chatId, `Waduh, kalau nominal nggak boleh di-skip bos! Ketik angkanya ya 😅`);
          return;
        } else {
          session.draft[missingField] = null;
        }
      } else {
        if (missingField === 'nominal') {
          let nominalValue = parseInt(text.replace(/[^0-9]/g, ''));
          if (nominalValue > 0 && nominalValue < 1000) nominalValue *= 1000;

          if (isNaN(nominalValue) || nominalValue === 0) {
            await bot.sendMessage(chatId, `Format angka salah nih. Coba ketik angkanya aja 😅`);
            return;
          }
          session.draft[missingField] = nominalValue;
        } else {
          session.draft[missingField] = text;
        }
      }

      const masihAdaYangKurang = await cekDataKurang(chatId, session.draft, session.action, session.targetSheetIndex);
      if (!masihAdaYangKurang) {
        if (session.action === 'edit') {
          await updateKeSheets(chatId, session.draft, session.targetSheetIndex);
        } else {
          await simpanKeSheets(chatId, session.draft);
        }
        await deleteSession(chatId);
      }
      return;
    }
  }

  const isDocumentImage = msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/');
  if (!text && !msg.photo && !isDocumentImage) return;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    let data;

    if (msg.photo || isDocumentImage) {
      await bot.sendMessage(chatId, '📸 Gambar diterima! Gemini lagi nge-scan struknya nih...');
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
      const fileLink = await bot.getFileLink(fileId);

      const response = await fetch(fileLink);
      const arrayBuffer = await response.arrayBuffer();
      const base64Image = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = isDocumentImage ? msg.document.mime_type : 'image/jpeg';

      const imageParts = [{ inlineData: { data: base64Image, mimeType } }];

      const jenisTransaksi = text ? await deteksiJenisTransaksi(model, text) : 'Pengeluaran';
      data = await ekstrakDetailTransaksi(model, jenisTransaksi, text, imageParts);
    } else {
      await bot.sendMessage(chatId, '⏳ Teks diterima! Llama 3 lagi ekstrak datanya...');
      const jenisTransaksi = await deteksiJenisTransaksiGroq(text);
      data = await ekstrakDetailTransaksiGroq(jenisTransaksi, text);
    }

    const targetSheetIndex = data.jenis_transaksi === 'Pemasukan' ? 1 : 0;
    const adaYangKurang = await cekDataKurang(chatId, data, 'create', targetSheetIndex);

    if (!adaYangKurang) {
      await simpanKeSheets(chatId, data);
    }
  } catch (error) {
    console.error("Error dari AI:", error);
    await bot.sendMessage(chatId, '❌ Wah, AI-nya gagal paham nih. Pastiin kata-katanya jelas ya.');
  }
};

const simpanKeSheetsAPI = async (data, targetSheetIndex) => {
  await doc.loadInfo();
  const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const sheet = doc.sheetsByIndex[targetSheetIndex];

  if (targetSheetIndex === 1) {
    await sheet.addRow([timestamp, formatTeks(data.sumber_pemasukan), data.nominal || 0, formatTeks(data.kategori), formatTeks(data.catatan)]);
  } else {
    await sheet.addRow([timestamp, formatTeks(data.item), formatTeks(data.kategori), data.nominal || 0, formatTeks(data.tempat), formatTeks(data.tujuan), formatTeks(data.partisipan), formatTeks(data.metode_bayar), formatTeks(data.rating)]);
  }
};

// =====================================================================
// ENDPOINTS VERCEL
// =====================================================================
app.get('/', (req, res) => {
  res.send('Server Bot Keuangan Berjalan di Vercel!');
});

// PERUBAHAN UTAMA: Endpoint Webhook sekarang akan AWAIT fungsi prosesPesan
app.post('/api/webhook', async (req, res) => {
  try {
    const msg = req.body.message || req.body.edited_message;
    if (msg) {
      await prosesPesan(msg); // <--- Vercel dipaksa nunggu ini kelar
    }
  } catch (error) {
    console.error("Error Webhook:", error);
  } finally {
    res.status(200).send('OK'); // <--- Baru boleh matiin server
  }
});

app.post('/api/catat', async (req, res) => {
  const { text } = req.body; 
  if (!text) return res.status(400).json({ error: 'Teks tidak boleh kosong' });

  try {
    const jenisTransaksi = await deteksiJenisTransaksiGroq(text);
    const data = await ekstrakDetailTransaksiGroq(jenisTransaksi, text);
    const targetSheetIndex = data.jenis_transaksi === 'Pemasukan' ? 1 : 0;
    
    if (targetSheetIndex === 1) { 
      if (isKosong(data.sumber_pemasukan)) return res.status(400).json({ error: 'Sumber pemasukan belum jelas nih.' });
      if (!data.nominal || data.nominal === 0) return res.status(400).json({ error: 'Nominal pemasukannya belum ada atau nol.' });
    } else { 
      if (isKosong(data.item)) return res.status(400).json({ error: 'Nama barang/jasa pengeluaran belum jelas.' });
      if (!data.nominal || data.nominal === 0) return res.status(400).json({ error: 'Harga/nominal pengeluarannya belum ada atau nol.' });
    }

    await simpanKeSheetsAPI(data, targetSheetIndex); 
    res.status(200).json({ success: true, message: `${jenisTransaksi} berhasil dicatat!`, data: data });
  } catch (error) {
    console.error("Error API:", error);
    res.status(500).json({ error: 'Gagal memproses data via AI' });
  }
});

app.post('/api/ekstrak', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Teks tidak boleh kosong' });
  try {
    const jenisTransaksi = await deteksiJenisTransaksiGroq(text);
    const data = await ekstrakDetailTransaksiGroq(jenisTransaksi, text);
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error /api/ekstrak:", error);
    res.status(500).json({ error: 'Gagal memproses data via AI' });
  }
});

app.post('/api/simpan', async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Data tidak boleh kosong' });
  try {
    const targetSheetIndex = data.jenis_transaksi === 'Pemasukan' ? 1 : 0;
    if (targetSheetIndex === 1) {
      if (isKosong(data.sumber_pemasukan)) return res.status(400).json({ error: 'Sumber pemasukan belum diisi.' });
      if (!data.nominal || data.nominal === 0) return res.status(400).json({ error: 'Nominal pemasukan belum diisi.' });
    } else {
      if (isKosong(data.item)) return res.status(400).json({ error: 'Nama item belum diisi.' });
      if (!data.nominal || data.nominal === 0) return res.status(400).json({ error: 'Nominal belum diisi.' });
    }
    await simpanKeSheetsAPI(data, targetSheetIndex);
    res.status(200).json({ success: true, message: `✅ ${data.jenis_transaksi} berhasil dicatat ke Sheets!` });
  } catch (error) {
    console.error("Error /api/simpan:", error);
    res.status(500).json({ error: 'Gagal menyimpan data ke Sheets' });
  }
});

export default app;