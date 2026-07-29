# Lunomi WA Gateway

WhatsApp gateway dan CS AI untuk Lunomi Hub. Service ini menerima pesan
WhatsApp melalui Baileys, menyimpan konteks pelanggan di Supabase, meminta
respons dari provider AI, lalu mengirimkannya kembali ke chat WhatsApp.

> Dokumen ini ditujukan untuk operator dan agen engineering berikutnya. Jangan
> menyimpan API key, token GitHub, QR WhatsApp, atau nilai secret di repository.

## Fungsi utama

- Menghubungkan akun WhatsApp Business melalui QR / Linked Devices.
- Menangani pesan masuk dan mengirim respons CS AI dalam Bahasa Indonesia.
- Mengambil katalog dan memproses tool bisnis melalui `aiEngine.js`.
- Membatasi pembuatan pesanan: pesanan hanya boleh dibuat setelah pelanggan
  menyatakan detail pesanan dengan jelas dan memberi konfirmasi eksplisit.
- Menyimpan sesi, pengaturan WhatsApp, dan konteks percakapan di Supabase.
- Menjalankan pemicu cron ke aplikasi Lunomi Web untuk automations dan laporan
  harian.

## Arsitektur singkat

| Komponen | Tanggung jawab |
| --- | --- |
| `index.js` | Server Express, koneksi Baileys, endpoint HTTP, pengiriman balasan, dan cron scheduler. |
| `aiEngine.js` | Persona CS, tool calling, provider AI, katalog, dan respons fallback. |
| `orderPolicy.js` | Guardrail agar tool `create_wa_order` tidak terpanggil oleh pesan ambigu. |
| `waReplyDelivery.js` | Resolusi JID, pengiriman respons, dan fallback saat WhatsApp memakai LID. |
| `deliveryTracker.js` | Pencatatan receipt pengiriman yang masih menunggu. |
| `waSessionManager.js` | Sesi pelanggan, konteks percakapan, dan konfigurasi WA pada Supabase. |
| `useSupabaseAuth.js` | Penyimpanan kredensial autentikasi Baileys di Supabase. |
| `baileysRuntime.js` | Adapter kompatibilitas runtime Baileys. |
| `test/` | Regression test untuk provider, order policy, delivery, auth, dan runtime. |

## Prasyarat

- Node.js **22 atau lebih baru**.
- Proyek Supabase yang sudah memiliki tabel/konfigurasi Lunomi yang diperlukan.
- Akun WhatsApp yang dapat ditautkan sebagai perangkat.
- Akses ke provider AI minimal satu; Gemini direkomendasikan sebagai provider
  utama.
- Untuk produksi, service Render dan environment variable-nya harus tersedia.

## Instalasi dan menjalankan lokal

```bash
git clone https://github.com/lunomiagent/lunomi-wa-gateway.git
cd lunomi-wa-gateway
npm ci
copy .env.example .env
npm start
```

Pada Windows, bila `copy` tidak tersedia dari shell yang dipakai, salin
`.env.example` menjadi `.env` melalui File Explorer atau PowerShell. Isi semua
secret hanya di `.env` lokal atau dashboard environment provider; `.env` tidak
boleh di-commit.

Endpoint operasional:

| Endpoint | Kegunaan |
| --- | --- |
| `GET /status` | Health check: koneksi WA, QR tersedia, mode AI, dan jumlah receipt tertunda. |
| `GET /qr` | Halaman QR untuk menautkan ulang WhatsApp bila belum terhubung. |
| `POST /api/wa/test-ai` | Menguji respons AI tanpa mengirim pesan WhatsApp. |
| `POST /send` | Mengirim pesan WhatsApp melalui gateway. |
| `POST /broadcast` | Mengirim broadcast (gunakan hanya dengan otorisasi bisnis). |
| `POST /api/wa/pause` / `resume` | Menjeda atau mengaktifkan CS AI. |
| `GET` / `POST /api/wa/settings` | Membaca atau memperbarui pengaturan WA. |
| `POST /api/wa/join-group` | Bergabung ke grup notifikasi dari invite code yang tersimpan. |

### Notifikasi grup dan human takeover

Simpan invite code grup pada `wa_settings` dengan key `group_invite_code`, lalu
panggil `POST /api/wa/join-group` setelah akun WhatsApp terhubung. JID hasil join
disimpan otomatis sebagai `notification_group`. Gateway mengirim alert ke grup
untuk pesanan, komplain, permintaan kasir, pesan gambar pelanggan, dan balasan
AI yang membuat komitmen jadwal/kerja sama yang perlu diverifikasi manusia.

Key `ai_pause_duration_minutes` mengatur durasi takeover (default 60 menit).
Pesan gambar pelanggan diteruskan ke grup sebagai media dan AI dijeda agar tim
Cleco Pii dapat meninjau gambar secara manual.

## Konfigurasi environment

Mulai dari [`.env.example`](.env.example). Nama variable berikut didukung oleh
kode saat ini; nilai aktual harus disimpan di Render atau file `.env` lokal.

| Variable | Wajib | Keterangan |
| --- | --- | --- |
| `SUPABASE_URL` | Ya | URL proyek Supabase. |
| `SUPABASE_KEY` | Ya | Key Supabase untuk service gateway sesuai konfigurasi proyek. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Disarankan | Provider AI utama (Gemini). Alias lama `GEMINI_API_KEY` juga dibaca. |
| `OPENAI_API_KEY` | Disarankan | Key provider OpenAI-compatible/OpenAgentic sebagai fallback kedua. |
| `OPENAI_BASE_URL` | Disarankan | Base URL OpenAI-compatible; default kode mengarah ke OpenAgentic. |
| `LUNOMI_AGENT_MODEL` | Disarankan | Nama model OpenAI-compatible, misalnya model Claude yang tersedia di provider tersebut. |
| `GROQ_API_KEY` | Disarankan | Key Groq sebagai fallback ketiga. |
| `GROQ_BASE_URL` | Opsional | Base URL Groq; default adalah endpoint OpenAI-compatible Groq. |
| `GROQ_MODEL` | Opsional | Model Groq; default `llama-3.3-70b-versatile`. |
| `WA_DELIVERY_RECEIPT_TIMEOUT_MS` | Opsional | Batas tunggu receipt pengiriman dalam milidetik; default `30000`. |
| `WA_CUSTOMER_OUTLET_CODE` | Ya di produksi | Scope outlet seluruh tool pada gateway WA; untuk service ini wajib `CP` (Cleco Pii). |
| `DEFAULT_WA_PHONE` | Opsional | Nomor pemilik/default untuk konteks sesi. |
| `PORT` | Platform | Port HTTP; default lokal `3001`. Render mengaturnya sesuai service. |
| `CRON_SECRET` | Ya di produksi | Secret yang **sama** dengan aplikasi Lunomi Web untuk endpoint cron. Jangan menuliskan nilainya di kode atau dokumentasi. |

Setelah mengubah environment variable di Render, lakukan deploy/restart service
agar proses Node membaca nilai yang baru.

## Urutan provider AI dan perilaku CS

Urutan provider pada implementasi saat ini adalah:

1. Gemini (`GOOGLE_GENERATIVE_AI_API_KEY`)
2. Provider OpenAI-compatible/OpenAgentic (`OPENAI_API_KEY`, `OPENAI_BASE_URL`,
   `LUNOMI_AGENT_MODEL`)
3. Groq (`GROQ_API_KEY`)

Jika respons terlihat seperti Groq padahal Gemini/Claude diharapkan, cek
log startup/provider dan pastikan environment variable provider yang lebih
tinggi prioritasnya tersedia serta deployment sudah menggunakan revisi terbaru.
Jangan mengubah urutan fallback tanpa regression test karena ini memengaruhi
gaya bahasa, biaya, dan keandalan CS.

Persona CS harus tetap ramah, membantu, dan menjawab pesan pembuka seperti
"halo" atau nama outlet secara natural. Pesan pendek/ambigu seperti "tes",
"ok", "cek", atau "pesan" **tidak boleh** membuat pesanan. Untuk pesanan,
AI harus mengumpulkan item dan jumlah, menampilkan ringkasan, lalu menunggu
konfirmasi eksplisit pelanggan sebelum memanggil `create_wa_order`.

## WhatsApp, LID, dan delivery receipt

WhatsApp dapat mengirim pesan dengan JID berbasis LID (contoh akhiran
`@lid`) walaupun nomor telepon pelanggan tersedia sebagai `senderPn` atau
`remoteJidAlt`. Balasan pertama harus ditujukan ke **exact inbound JID** untuk
menjaga routing perangkat; fallback nomor/JID alternatif hanya digunakan oleh
mekanisme delivery bila diperlukan. Jangan mengirim paralel ke beberapa JID,
karena dapat menggandakan balasan atau membuat status audit tampak sukses
sementara pelanggan tidak menerima pesan.

Log "submitted" atau munculnya outbound message di audit berarti gateway sudah
menyerahkan pesan ke Baileys; itu belum selalu membuktikan pesan sudah diterima
di perangkat pelanggan. Gunakan delivery receipt/log berikutnya saat tersedia.

Jika audit mencatat outbound tetapi chat WhatsApp tidak menerima respons:

1. Pastikan akun WA masih connected lewat `GET /status` atau `/qr`.
2. Cari exact inbound JID, `senderPn`, dan mapping LID pada log service.
3. Periksa error/receipt setelah `sendMessage`, bukan hanya log submit.
4. Pastikan versi Baileys tetap sesuai `package.json`; jangan downgrade tanpa
   menguji alur LID dan multi-device.

## Packages utama

| Package | Fungsi |
| --- | --- |
| `baileys` | Koneksi WhatsApp multi-device dan event pesan. |
| `express` | API HTTP dan health check. |
| `@supabase/supabase-js` | Sesi, auth state Baileys, dan data Lunomi di Supabase. |
| `@google/generative-ai` | Client Gemini. |
| `node-cron` | Scheduler pemicu automation dan laporan harian. |
| `pino` | Logging runtime Baileys. |
| `qrcode-terminal` | Menampilkan QR saat development. |
| `cors` | Konfigurasi akses HTTP lintas-origin. |

Gunakan `npm ci` untuk instalasi yang konsisten karena repository menyertakan
`package-lock.json`. Versi Node minimum didefinisikan di `package.json`.

## Pengujian

```bash
npm test
```

Test suite menggunakan `node --test` dan mencakup prioritas provider,
guardrail order, delivery receipt/JID, Baileys runtime, serta penyimpanan auth.
Sebelum mengubah AI atau pengiriman WA, tambahkan regression test terlebih
dahulu—terutama untuk pesan ambigu dan JID `@lid`.

## Deploy Render

Konfigurasi service ada pada [`render.yaml`](render.yaml):

- build command: `npm install`
- start command: `npm start`
- health check: `/status`
- environment: Node web service

Checklist deploy:

1. Pastikan seluruh environment wajib ada di Render; jangan menyimpan nilai
   secret di `render.yaml`.
2. Push commit yang telah dites ke branch produksi (`main`).
3. Tunggu deploy selesai, lalu buka `GET /status`.
4. Jika `isConnected` bernilai `false`, buka `/qr` dan tautkan kembali akun
   WhatsApp sesuai prosedur operasional.
5. Uji satu pesan pembuka, satu pertanyaan katalog, dan satu alur order yang
   belum dikonfirmasi. Pastikan tidak ada order otomatis.
6. Pantau Render Logs untuk error provider, disconnect WhatsApp, dan delivery
   receipt.

## Cron Lunomi Web

Gateway menjadwalkan panggilan ke Lunomi Web dengan zona waktu
`Asia/Jakarta`:

- Automation Canvas: setiap jam pada menit `00`.
- Laporan harian: setiap hari pukul `17:00` WIB.

Keduanya memakai `CRON_SECRET`. Error `Unauthorized: Secret cron tidak cocok
atau tidak disediakan` menunjukkan nilai di gateway dan aplikasi Lunomi Web
berbeda, kosong, atau proses belum dideploy ulang setelah perubahan environment.
Perbaiki konfigurasi secret di dashboard, bukan dengan menaruh nilainya dalam
source code atau URL yang dibagikan publik.

> Catatan teknis untuk agen: `index.js` saat ini masih memiliki fallback secret
> lama untuk kompatibilitas. Itu bukan konfigurasi yang aman dan tidak boleh
> diandalkan. Tugas hardening terpisah sebaiknya menghapus fallback tersebut
> setelah `CRON_SECRET` terverifikasi tersedia di semua environment produksi.

## Release dan handoff untuk agen berikutnya

Versi package saat ini dapat dilihat di `package.json`. Repository tidak
memiliki script release otomatis yang terdefinisi di `package.json`; buat tag
atau ubah versi hanya jika pemilik proyek meminta release resmi.

Sebelum commit/release:

1. Jalankan `npm test` dan `git diff --check`.
2. Tinjau `git status --short`; jangan ikut menambahkan script investigasi,
   file QR, kredensial, `.env`, atau perubahan kerja pengguna yang tidak
   terkait.
3. Stage file secara eksplisit, commit dengan pesan yang menjelaskan perubahan,
   lalu push ke `main` hanya dengan persetujuan pemilik proyek.
4. Verifikasi deploy Render dan satu alur WA nyata setelah push.
5. Catat provider yang dipakai, hasil health check, dan batas verifikasi pada
   handoff; jangan mengklaim pesan terkirim tanpa receipt/pengujian perangkat.

Untuk perubahan apa pun, agen harus menjaga batas berikut:

- Jangan mengekspos atau menyalin secret ke issue, README, log, atau commit.
- Jangan melakukan `git reset --hard`, menghapus branch, atau mengubah deploy
  production tanpa instruksi eksplisit.
- Jangan menghapus guardrail order atau fallback delivery hanya untuk membuat
  log terlihat berhasil.
- Pertahankan perubahan pengguna yang tidak berkaitan dan laporkan bila ada
  file kerja tidak terlacak.

## Troubleshooting cepat

| Gejala | Pemeriksaan pertama |
| --- | --- |
| Audit ada, tetapi WA tidak menerima balasan | Koneksi `/status`, exact inbound LID/JID, dan delivery receipt. |
| Jawaban terasa seperti Groq | Key Gemini/OpenAgentic tidak tersedia, invalid, rate-limited, atau deploy masih versi lama. |
| Pesan biasa membuat order | Periksa `orderPolicy.js`, prompt/tool call, lalu tambahkan regression test untuk teks tersebut. |
| QR terus muncul | Auth state Baileys tidak tersimpan/terbaca di Supabase atau akun WA terputus. |
| Cron 401/Unauthorized | Samakan `CRON_SECRET` di gateway dan Lunomi Web, lalu restart/redeploy gateway. |
| Service Render down | Buka Render Logs, cek `GET /status`, env wajib, dan koneksi Supabase/WhatsApp. |

## Status verifikasi dokumen

Dokumen ini menjelaskan kontrak source code yang ada saat dibuat. Ia bukan
bukti bahwa akun WhatsApp, provider AI, Supabase, Render, atau cron sedang
sehat di production. Agen berikutnya wajib memverifikasi layanan live melalui
log dan health check sebelum menyatakan perbaikan selesai.
