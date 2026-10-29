<!-- doc_id: privasi | source_type: internal_policy | version: 2026-01 | needs_verification: false -->
# Kebijakan Privasi Asisten AI Modal Mitra Contoh (FIKTIF)

## Data yang Dikumpulkan
Asisten AI ini mengumpulkan data yang diberikan langsung dalam percakapan (nama, nomor pinjaman/ID pendana, pertanyaan) untuk keperluan verifikasi dan layanan. Data sensitif (NIK, nomor HP, email) ditandai/diredaksi oleh sistem sebelum diproses model AI; nilai asli hanya tersimpan sementara di memori sesi sisi server untuk verifikasi, tidak dikirim ke model bahasa.

## Privasi Antar-Anggota Majelis
Karena model bisnis berbasis kelompok (majelis), data operasional seperti jadwal pertemuan bersifat dibagikan dalam kelompok. Namun data pribadi dan status finansial individu (sisa angsuran, status terlambat, nomor kontak) milik satu mitra TIDAK PERNAH ditampilkan ke mitra lain dalam majelis yang sama, termasuk jika yang bertanya adalah anggota majelis yang sama. Setiap sesi hanya dapat mengakses data milik identitas yang terverifikasi di sesi itu sendiri.

## Verifikasi Identitas Sebelum Akses Data Pribadi
Data pribadi/finansial hanya ditampilkan setelah verifikasi dua faktor berhasil (nomor pinjaman/ID pendana + tanggal lahir). Klaim identitas dari pengguna TIDAK dipercaya tanpa verifikasi ini, termasuk jika pengguna menyebutkan nama atau data yang terdengar benar.

## Hak Subjek Data (UU PDP No. 27/2022)
Mitra dan pendana memiliki hak untuk mengakses, mengoreksi, menghapus data pribadinya, serta hak untuk menolak keputusan yang diambil semata-mata berdasarkan pemrosesan otomatis yang berdampak signifikan bagi dirinya (lihat ringkasan UU PDP). Permintaan ini dicatat oleh asisten AI sebagai tiket DSR dan ditinjau tim yang berwenang — TIDAK dieksekusi otomatis oleh AI.

## Larangan Keputusan Kredit Otomatis
Sesuai prinsip UU PDP terkait keputusan otomatis, asisten AI TIDAK PERNAH memutuskan atau menjanjikan hasil persetujuan pinjaman, plafon, maupun restrukturisasi secara otomatis. Keputusan tersebut selalu melibatkan tinjauan manusia (petugas lapangan/tim kredit).
