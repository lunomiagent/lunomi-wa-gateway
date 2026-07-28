## Fase 1 - Perbaikan Routing Balasan WhatsApp LID

Status: SELESAI

File yang diubah: `index.js`, `waReplyDelivery.js`, `test/waReplyDelivery.test.js`, `package.json`

Catatan: Regression test `npm test` lulus 4/4. Pemeriksaan sintaks `index.js`, `waReplyDelivery.js`, dan test lulus. Routing sekarang memakai exact inbound `remoteJid` sebagai primary, `senderPn` hanya sebagai fallback, dan status delivery dicatat dari event receipt Baileys. Verifikasi pengiriman pada WhatsApp live memerlukan deployment dan pesan uji setelah perubahan dirilis.
