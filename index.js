// Polyfill untuk DOMMatrix yang dibutuhkan oleh pdfjs-dist / pdf-parse di Node.js
if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {};
}

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const Tesseract = require('tesseract.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { exec } = require('child_process');

// Definisikan File Penyimpanan Data Persisten
const CONFIG_FILE = './config.json';
const SQLITE_DB_FILE = './database.sqlite';
const DATABASE_FILE = './database.json'; // kept for legacy migration
const SESSION_DB_FILE = './chat_sessions.json'; // kept for legacy migration

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// Pastikan file config ada sebelum memulai aplikasi
if (!fs.existsSync(CONFIG_FILE)) {
    console.error('Error: File config.json tidak ditemukan!');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));

// Sanitize API URL to guarantee it points to the correct Completions endpoint
let apiEndpoint = config.api_url;
if (apiEndpoint && !apiEndpoint.includes('/chat/completions') && !apiEndpoint.includes('/api/chat')) {
    apiEndpoint = apiEndpoint.replace(/\/+$/, '') + '/v1/chat/completions';
}

// Credentials Configuration for Admin Dashboard Login
const ADMIN_USERNAME = config.admin_username || 'admin';
let ADMIN_PASSWORD = config.admin_password;

if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = Math.random().toString(36).substring(2, 10);
    console.log(`\n======================================================`);
    console.log(`[SECURITY] Password Admin tidak diset di config.json.`);
    console.log(`| Kata sandi acak yang dibuat: ${ADMIN_PASSWORD}`);
    console.log(`| Silakan simpan kata sandi ini untuk login dasbor!`);
    console.log(`| Username: ${ADMIN_USERNAME}`);
    console.log(`======================================================\n`);
} else {
    console.log(`\n[SECURITY] Username login dasbor: ${ADMIN_USERNAME}\n`);
}

// State Management
let historyLog = { finance: [], agenda: [] };
let sheetsSummaryCache = { data: null, timestamp: 0 };
let reminders = [];
let groupConfigs = { group_configs: {} };
let shopData = { host_admins: [], customers: [] };

// Central Database Object Cache
let dbData = {
    chat_sessions: {},
    log_history: { finance: [], agenda: [] },
    reminders: [],
    group_configs: { group_configs: {} },
    shop_data: { host_admins: [], customers: [] }
};

let db; // Global SQLite Database Connection Handle

// Fungsi Inisialisasi Database Terpusat SQLite dengan Migrasi Data Otomatis
async function initDatabase() {
    try {
        db = await open({
            filename: SQLITE_DB_FILE,
            driver: sqlite3.Database
        });
        
        await db.exec(`
            CREATE TABLE IF NOT EXISTS key_value_store (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);
        console.log('[DB] Tabel key_value_store di SQLite siap.');

        // Muat data dari SQLite
        const rows = await db.all('SELECT key, value FROM key_value_store');
        const store = {};
        rows.forEach(r => {
            try { store[r.key] = JSON.parse(r.value); } catch(e) {}
        });

        const hasDataInSqlite = rows.length > 0;
        
        if (hasDataInSqlite) {
            console.log('[DB] Muat memory cache dari database SQLite.');
            dbData = {
                chat_sessions: store.chat_sessions || {},
                log_history: store.log_history || { finance: [], agenda: [] },
                reminders: store.reminders || [],
                group_configs: store.group_configs || { group_configs: {} },
                shop_data: store.shop_data || { host_admins: [], customers: [] }
            };
        } else {
            console.log('[DB] SQLite kosong. Memeriksa database lama untuk migrasi...');
            
            // Cek file database.json lama
            if (fs.existsSync(DATABASE_FILE)) {
                try {
                    const raw = fs.readFileSync(DATABASE_FILE, 'utf-8');
                    dbData = JSON.parse(raw);
                    console.log('[DB] database.json ditemukan. Memigrasikan ke SQLite...');
                    
                    const keys = ['chat_sessions', 'log_history', 'reminders', 'group_configs', 'shop_data'];
                    for (const key of keys) {
                        const val = dbData[key] || (key === 'chat_sessions' ? {} : key === 'reminders' ? [] : key === 'group_configs' ? { group_configs: {} } : { host_admins: [], customers: [] });
                        await db.run('INSERT OR REPLACE INTO key_value_store (key, value) VALUES (?, ?)', key, JSON.stringify(val));
                    }
                    console.log('[DB] Migrasi data dari database.json ke SQLite berhasil.');
                    
                    try { fs.renameSync(DATABASE_FILE, DATABASE_FILE + '.bak'); } catch(e) {}
                } catch (err) {
                    console.error('[DB] Gagal memigrasikan database.json lama:', err.message);
                }
            } else {
                console.log('[DB] Tidak ada data lama. Menginisialisasi SQLite dengan objek kosong.');
                const keys = ['chat_sessions', 'log_history', 'reminders', 'group_configs', 'shop_data'];
                for (const key of keys) {
                    const val = key === 'chat_sessions' ? {} : key === 'reminders' ? [] : key === 'group_configs' ? { group_configs: {} } : { host_admins: [], customers: [] };
                    await db.run('INSERT OR REPLACE INTO key_value_store (key, value) VALUES (?, ?)', key, JSON.stringify(val));
                }
            }
        }
        
        // Sinkronisasi ke variabel memori aplikasi
        chatSessions = dbData.chat_sessions;
        historyLog = dbData.log_history;
        reminders = dbData.reminders;
        groupConfigs = dbData.group_configs;
        shopData = dbData.shop_data;
        
    } catch (err) {
        console.error('[DB] Error saat inisialisasi SQLite:', err.message);
    }
}

// Helper untuk Menyimpan Perubahan Data ke SQLite secara Asinkronus di Background
async function saveDatabase() {
    try {
        if (!db) return;
        dbData.log_history = historyLog;
        dbData.reminders = reminders;
        dbData.group_configs = groupConfigs;
        dbData.shop_data = shopData;
        
        const keys = ['log_history', 'reminders', 'group_configs', 'shop_data'];
        for (const key of keys) {
            await db.run('INSERT OR REPLACE INTO key_value_store (key, value) VALUES (?, ?)', key, JSON.stringify(dbData[key]));
        }
    } catch (err) {
        console.error('[DB] Gagal menulis perubahan ke SQLite:', err.message);
    }
}

async function saveDatabaseAsync() {
    await saveDatabase();
}

// Redefinisikan pembaca/penyimpan agar kompatibel dengan kode Express & WA lainnya
function loadHistory() {
    console.log('Database riwayat transaksi SQLite siap.');
}
function saveHistory() {
    saveDatabase();
}

function loadReminders() {
    console.log(`Berhasil memuat ${reminders.length} pengingat dari SQLite.`);
}
function saveReminders() {
    saveDatabase();
}

function loadGroupConfigs() {
    console.log('Database konfigurasi grup SQLite siap.');
}
function saveGroupConfigs() {
    saveDatabase();
}

function loadShopData() {
    console.log('Database data toko SQLite siap.');
}
function saveShopData() {
    saveDatabase();
}

global.pinnedHostAdmins = [];

async function syncPinnedHostAdmins() {
    if (!client) return;
    try {
        const chats = await client.getChats();
        const pinnedAdmins = chats
            .filter(chat => chat.pinned && !chat.isGroup)
            .map(chat => chat.id.user + '@c.us');
        
        global.pinnedHostAdmins = pinnedAdmins;
        
        // Juga sinkronkan ke database lokal
        shopData.host_admins = pinnedAdmins;
        saveShopData();
        
        console.log(`[Host Admin] Sinkronisasi ${pinnedAdmins.length} Host Admin dari chat tersemat.`);
    } catch (err) {
        console.error('[Host Admin] Gagal sinkronisasi chat tersemat:', err.message);
    }
}

function parseReminderTime(timeStr) {
    const now = new Date();
    const wibOffset = 7 * 60 * 60 * 1000;
    const nowUtc = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
    const nowWib = new Date(nowUtc + wibOffset);

    let targetDate = new Date(nowWib);
    const cleanStr = timeStr.toLowerCase().trim();

    // Ekstrak HH:MM atau HH.MM
    const timeMatch = cleanStr.match(/([01]\d|2[0-3])[:.]([0-5]\d)/);
    if (!timeMatch) return null;

    const hh = parseInt(timeMatch[1], 10);
    const mm = parseInt(timeMatch[2], 10);

    targetDate.setHours(hh, mm, 0, 0);

    if (cleanStr.includes('besok')) {
        targetDate.setDate(targetDate.getDate() + 1);
    } else if (cleanStr.includes('lusa')) {
        targetDate.setDate(targetDate.getDate() + 2);
    } else {
        const dateMatch = cleanStr.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?/);
        if (dateMatch) {
            const day = parseInt(dateMatch[1], 10);
            const month = parseInt(dateMatch[2], 10) - 1;
            const year = dateMatch[3] ? parseInt(dateMatch[3], 10) : targetDate.getFullYear();
            
            targetDate.setDate(day);
            targetDate.setMonth(month);
            targetDate.setFullYear(year);
        } else {
            if (targetDate.getTime() <= nowWib.getTime()) {
                targetDate.setDate(targetDate.getDate() + 1);
            }
        }
    }

    const diff = targetDate.getTime() - nowWib.getTime();
    return new Date(now.getTime() + diff);
}

function startReminderScheduler() {
    console.log('[Scheduler] Memulai scheduler pengingat otomatis...');
    setInterval(async () => {
        if (currentStatus !== 'CONNECTED') return;

        const now = new Date();
        let updated = false;

        for (let reminder of reminders) {
            if (!reminder.sent) {
                const reminderTime = new Date(reminder.time);
                if (now.getTime() >= reminderTime.getTime()) {
                    console.log(`[Reminder] Mengirim pengingat: "${reminder.message}"...`);
                    try {
                        // Gunakan chatId pembuat pengingat, atau fallback ke nomor Bos jika kosong
                        let targetChatId = reminder.chatId;
                        if (!targetChatId || targetChatId.trim() === '' || targetChatId === '@c.us') {
                            if (config.boss_number && config.boss_number.trim() !== '') {
                                targetChatId = config.boss_number.replace(/\D/g, '') + '@c.us';
                            }
                        }

                        if (!targetChatId || targetChatId === '@c.us') {
                            throw new Error('Nomor tujuan pengingat (chatId / boss_number) tidak valid atau kosong.');
                        }

                        const reminderMsg = `🔔 *PENGINGAT ASISTEN PRIBADI* 🔔\n\nHalo Bos! Saya di sini untuk mengingatkan Bos:\n👉 *${reminder.message}*`;
                        
                        await client.sendMessage(targetChatId, reminderMsg);
                        reminder.sent = true;
                        updated = true;

                        io.emit('message_log', {
                            chatId: targetChatId,
                            body: `🔔 [Pengingat Terkirim] ${reminder.message}`,
                            type: 'outgoing',
                            timestamp: Date.now()
                        });
                    } catch (err) {
                        console.error('[Reminder] Gagal mengirim pengingat:', err.message);
                    }
                }
            }
        }

        if (updated) {
            reminders = reminders.filter(r => !r.sent);
            saveReminders();
        }
    }, 30000);
}

function addHistoryLog(type, entry) {
    const newEntry = {
        ...entry,
        tanggal: new Date().toISOString()
    };
    
    if (type === 'finance') {
        if (!historyLog.finance) historyLog.finance = [];
        historyLog.finance.unshift(newEntry);
        if (historyLog.finance.length > 15) historyLog.finance.pop();
    } else if (type === 'agenda') {
        if (!historyLog.agenda) historyLog.agenda = [];
        historyLog.agenda.unshift(newEntry);
        if (historyLog.agenda.length > 15) historyLog.agenda.pop();
    }
    saveHistory();
    io.emit('history_updated', historyLog);
}

// Setup Express Web Server & Socket.io
// Setup Express Web Server & Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = config.port || 3000;

app.use(express.json());

// Global Session Token Store (In-Memory)
const activeSessions = new Set();

// Middleware Autentikasi Dasbor
function checkAuth(req, res, next) {
    // 1. Izinkan akses ke halaman login dan API login
    const publicPaths = ['/login', '/api/login', '/favicon.ico'];
    if (publicPaths.includes(req.path)) {
        return next();
    }

    // 2. Ambil token sesi dari cookie
    let token = null;
    const cookies = req.headers.cookie;
    if (cookies) {
        const parts = cookies.split(';');
        for (const part of parts) {
            const [k, v] = part.trim().split('=');
            if (k === 'session_token') {
                token = v;
                break;
            }
        }
    }

    // 3. Verifikasi keaktifan token
    if (token && activeSessions.has(token)) {
        return next();
    }

    // 4. Tolak akses jika tidak terautentikasi
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
}

// Rute Autentikasi
app.use(checkAuth);

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
        activeSessions.add(token);
        res.cookie('session_token', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 }); // 24 jam
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, error: 'Username atau password salah!' });
});

app.post('/api/logout', (req, res) => {
    const cookies = req.headers.cookie;
    if (cookies) {
        const parts = cookies.split(';');
        for (const part of parts) {
            const [k, v] = part.trim().split('=');
            if (k === 'session_token') {
                activeSessions.delete(v);
                break;
            }
        }
    }
    res.clearCookie('session_token');
    res.json({ success: true });
});

app.get('/api/auth-status', (req, res) => {
    res.json({ authenticated: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/knowledge', express.static(path.join(__dirname, 'knowledge')));
app.use('/media', express.static(path.join(__dirname, 'media')));

// Ensure directories exist
const KNOWLEDGE_DIR = './knowledge';
const MEDIA_DIR = './media';
if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR);
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// Multer Storage Configuration to keep original file names
const knowledgeStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, KNOWLEDGE_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const knowledgeUpload = multer({ storage: knowledgeStorage });

const mediaStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const mediaUpload = multer({ storage: mediaStorage });

// Web Dashboard API Endpoints
app.get('/api/files', (req, res) => {
    try {
        const knowledgeFiles = fs.readdirSync(KNOWLEDGE_DIR);
        const mediaFiles = fs.readdirSync(MEDIA_DIR);
        res.json({ knowledge: knowledgeFiles, media: mediaFiles });
    } catch (err) {
        res.status(500).send('Gagal membaca direktori berkas.');
    }
});

app.post('/api/upload/knowledge', knowledgeUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('Tidak ada file yang diunggah.');
    res.sendStatus(200);
});

app.post('/api/upload/media', mediaUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('Tidak ada file yang diunggah.');
    res.sendStatus(200);
});

app.post('/api/files/delete', (req, res) => {
    const { type, filename } = req.body;
    if (!type || !filename) return res.status(400).send('Permintaan tidak valid.');
    
    const targetDir = type === 'knowledge' ? KNOWLEDGE_DIR : MEDIA_DIR;
    const targetPath = path.join(targetDir, filename);
    
    try {
        if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
            res.sendStatus(200);
        } else {
            res.status(404).send('Berkas tidak ditemukan.');
        }
    } catch (err) {
        res.status(500).send('Gagal menghapus berkas.');
    }
});

// GET Config
app.get('/api/config', (req, res) => {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            res.json(configData);
        } else {
            res.status(404).send('Berkas konfigurasi tidak ditemukan.');
        }
    } catch (err) {
        res.status(500).send('Gagal membaca berkas konfigurasi.');
    }
});

app.post('/api/config', (req, res) => {
    try {
        const { 
            provider, gemini_api_keys, api_url, model_name, max_tokens, api_key, google_sheets_url, system_prompt_template,
            groq_api_key, groq_model,
            deepseek_api_key, deepseek_model,
            qwen_api_key, qwen_model,
            openrouter_api_key, openrouter_model,
            boss_number, report_time
        } = req.body;
        
        // Update in-memory config object
        config.provider = provider || 'gemini';
        config.gemini_api_keys = gemini_api_keys || [];
        config.api_url = api_url;
        config.model_name = model_name;
        config.max_tokens = parseInt(max_tokens, 10) || 1000;
        config.api_key = api_key;
        
        if (google_sheets_url !== undefined) {
            config.google_sheets_url = google_sheets_url;
        }
        if (system_prompt_template !== undefined) {
            config.system_prompt_template = system_prompt_template;
        }

        // Save keys for other providers
        if (groq_api_key !== undefined) config.groq_api_key = groq_api_key;
        if (groq_model !== undefined) config.groq_model = groq_model;
        
        if (deepseek_api_key !== undefined) config.deepseek_api_key = deepseek_api_key;
        if (deepseek_model !== undefined) config.deepseek_model = deepseek_model;
        
        if (qwen_api_key !== undefined) config.qwen_api_key = qwen_api_key;
        if (qwen_model !== undefined) config.qwen_model = qwen_model;
        
        if (openrouter_api_key !== undefined) config.openrouter_api_key = openrouter_api_key;
        if (openrouter_model !== undefined) config.openrouter_model = openrouter_model;

        if (boss_number !== undefined) config.boss_number = boss_number;
        if (report_time !== undefined) config.report_time = report_time;

        // Re-sanitize apiEndpoint
        apiEndpoint = config.api_url;
        if (apiEndpoint && !apiEndpoint.includes('/chat/completions') && !apiEndpoint.includes('/api/chat')) {
            apiEndpoint = apiEndpoint.replace(/\/+$/, '') + '/v1/chat/completions';
        }

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
        console.log('Konfigurasi berhasil diperbarui.');
        res.sendStatus(200);
    } catch (err) {
        console.error('Gagal menyimpan konfigurasi:', err.message);
        res.status(500).send('Gagal menyimpan berkas konfigurasi.');
    }
});

// REST API: Get WA Groups List
app.get('/api/groups', async (req, res) => {
    try {
        let groups = [];
        if (currentStatus === 'CONNECTED') {
            const chats = await client.getChats();
            const liveGroups = chats.filter(c => c.isGroup);
            groups = liveGroups.map(g => ({
                id: g.id._serialized,
                name: g.name || g.id._serialized,
                unreadCount: g.unreadCount
            }));
        }
        
        const configuredGroupIds = Object.keys(groupConfigs.group_configs);
        configuredGroupIds.forEach(id => {
            if (!groups.some(g => g.id === id)) {
                groups.push({
                    id: id,
                    name: groupConfigs.group_configs[id].groupName || id,
                    unreadCount: 0
                });
            }
        });
        
        groups = groups.map(g => {
            const cfg = groupConfigs.group_configs[g.id] || {};
            return {
                ...g,
                enabled: cfg.enabled !== undefined ? cfg.enabled : false,
                useAiFallback: cfg.useAiFallback !== undefined ? cfg.useAiFallback : true,
                triggerPrefix: cfg.triggerPrefix !== undefined ? cfg.triggerPrefix : '',
                allowedKnowledgeFiles: cfg.allowedKnowledgeFiles || []
            };
        });
        
        res.json(groups);
    } catch (err) {
        console.error('Gagal mengambil daftar grup WA:', err.message);
        const groups = Object.keys(groupConfigs.group_configs).map(id => {
            const cfg = groupConfigs.group_configs[id];
            return {
                id: id,
                name: cfg.groupName || id,
                unreadCount: 0,
                enabled: cfg.enabled !== undefined ? cfg.enabled : false,
                useAiFallback: cfg.useAiFallback !== undefined ? cfg.useAiFallback : true,
                triggerPrefix: cfg.triggerPrefix !== undefined ? cfg.triggerPrefix : '',
                allowedKnowledgeFiles: cfg.allowedKnowledgeFiles || []
            };
        });
        res.json(groups);
    }
});

// REST API: Get Group Configuration
app.get('/api/group-config/:groupId', (req, res) => {
    try {
        const { groupId } = req.params;
        const cfg = groupConfigs.group_configs[groupId] || {
            groupName: groupId,
            enabled: false,
            useAiFallback: true,
            triggerPrefix: '',
            allowedKnowledgeFiles: [],
            categoryFooter: 'Silakan pilih menu dengan mengetik angkanya:',
            contentFooter: 'Ketik *0* untuk kembali ke menu sebelumnya, atau *#* untuk kembali ke menu utama.',
            menuTree: {
                id: "root",
                name: "Menu Utama",
                type: "category",
                text: "Silakan pilih salah satu opsi di bawah ini:",
                children: []
            }
        };
        res.json(cfg);
    } catch (err) {
        res.status(500).send('Gagal mengambil konfigurasi grup: ' + err.message);
    }
});

app.post('/api/group-config/:groupId', (req, res) => {
    try {
        const { groupId } = req.params;
        const { 
            groupName, enabled, useAiFallback, triggerPrefix, allowedKnowledgeFiles, 
            categoryFooter, contentFooter, menuTree,
            categoryEmoji, contentEmoji, enableNumberNavigation,
            universalHeader, universalFooter, welcomeMessage, autoCloseSchedule, extraTriggers
        } = req.body;
        
        groupConfigs.group_configs[groupId] = {
            groupName: groupName || groupId,
            enabled: enabled !== undefined ? enabled : false,
            useAiFallback: useAiFallback !== undefined ? useAiFallback : true,
            triggerPrefix: triggerPrefix !== undefined ? triggerPrefix : '',
            allowedKnowledgeFiles: allowedKnowledgeFiles || [],
            categoryFooter: categoryFooter !== undefined ? categoryFooter : 'Silakan pilih menu dengan mengetik angkanya:',
            contentFooter: contentFooter !== undefined ? contentFooter : 'Ketik *0* untuk kembali ke menu sebelumnya, atau *#* untuk kembali ke menu utama.',
            menuTree: menuTree || { id: "root", name: "Menu Utama", type: "category", text: "Silakan pilih salah satu opsi di bawah ini:", children: [] },
            categoryEmoji: categoryEmoji || '📁',
            contentEmoji: contentEmoji || '📄',
            enableNumberNavigation: enableNumberNavigation !== undefined ? enableNumberNavigation : true,
            universalHeader: universalHeader || '',
            universalFooter: universalFooter || '',
            welcomeMessage: welcomeMessage || '',
            autoCloseSchedule: autoCloseSchedule || { enabled: false, openTime: '08:00', closeTime: '17:00', activeDays: [1,2,3,4,5] },
            extraTriggers: extraTriggers || []
        };
        
        saveGroupConfigs();
        console.log(`Konfigurasi grup ${groupName || groupId} berhasil disimpan.`);
        res.sendStatus(200);
    } catch (err) {
        console.error('Gagal menyimpan konfigurasi grup:', err.message);
        res.status(500).send('Gagal menyimpan konfigurasi grup: ' + err.message);
    }
});

// REST API: Get Pinned Chats (potential Host Admins)
app.get('/api/shop/pinned-chats', async (req, res) => {
    try {
        if (!client) {
            return res.json([]);
        }
        const chats = await client.getChats();
        const pinnedChats = chats.filter(chat => chat.pinned && !chat.isGroup);
        
        const result = pinnedChats.map(chat => {
            const jid = chat.id._serialized;
            const isHostAdmin = (shopData.host_admins || []).includes(jid);
            return {
                id: jid,
                name: chat.name || chat.id.user,
                phone: chat.id.user,
                isHostAdmin: isHostAdmin
            };
        });
        
        res.json(result);
    } catch (err) {
        console.error('Gagal mengambil chat tersemat:', err.message);
        res.status(500).send('Gagal mengambil chat tersemat: ' + err.message);
    }
});

// REST API: Get Host Admins
app.get('/api/shop/admins', (req, res) => {
    try {
        res.json(shopData.host_admins || []);
    } catch (err) {
        res.status(500).send('Gagal mengambil Host Admin: ' + err.message);
    }
});

// REST API: Save Host Admins
app.post('/api/shop/admins', (req, res) => {
    try {
        const { host_admins } = req.body;
        shopData.host_admins = host_admins || [];
        saveShopData();
        res.sendStatus(200);
    } catch (err) {
        res.status(500).send('Gagal menyimpan Host Admin: ' + err.message);
    }
});

// REST API: Get Customers
app.get('/api/shop/customers', (req, res) => {
    try {
        res.json(shopData.customers || []);
    } catch (err) {
        res.status(500).send('Gagal mengambil daftar pelanggan: ' + err.message);
    }
});

// REST API: Save Customers
app.post('/api/shop/customers', (req, res) => {
    try {
        const { customers } = req.body;
        shopData.customers = customers || [];
        saveShopData();
        res.sendStatus(200);
    } catch (err) {
        res.status(500).send('Gagal menyimpan pelanggan: ' + err.message);
    }
});

// REST API: Get Customer Chat Logs (Isolated)
app.get('/api/shop/logs/:contactId', (req, res) => {
    try {
        const { contactId } = req.params;
        const session = chatSessions[contactId];
        if (session && session.history) {
            res.json(session.history);
        } else {
            res.json([]);
        }
    } catch (err) {
        res.status(500).send('Gagal mengambil log obrolan pelanggan: ' + err.message);
    }
});

// REST API: Broadcast Promo to all active groups
app.post('/api/shop/broadcast', async (req, res) => {
    try {
        const { message, media } = req.body;
        if (!message || message.trim() === '') {
            return res.status(400).send('Pesan broadcast tidak boleh kosong');
        }

        const activeGroupIds = Object.keys(groupConfigs.group_configs).filter(id => {
            return groupConfigs.group_configs[id].enabled;
        });

        if (activeGroupIds.length === 0) {
            return res.status(400).send('Tidak ada grup aktif untuk dikirimi broadcast');
        }

        let mediaObj = null;
        if (media && media.trim() !== '') {
            const mediaPath = path.join('./media', media.trim());
            if (fs.existsSync(mediaPath)) {
                const fileData = fs.readFileSync(mediaPath);
                const base64Data = fileData.toString('base64');
                const mimeType = getMimeType(mediaPath);
                mediaObj = new MessageMedia(mimeType, base64Data, path.basename(mediaPath));
            }
        }

        let successCount = 0;
        for (const groupId of activeGroupIds) {
            try {
                await client.sendMessage(groupId, message);
                if (mediaObj) {
                    await client.sendMessage(groupId, mediaObj);
                }
                successCount++;
            } catch (err) {
                console.error(`Gagal mengirim broadcast ke ${groupId}:`, err.message);
            }
        }

        res.json({ success: true, count: successCount, total: activeGroupIds.length });
    } catch (err) {
        console.error('Gagal menjalankan broadcast:', err.message);
        res.status(500).send('Gagal mengirim siaran massal: ' + err.message);
    }
});

// REST API: Trigger Open/Close all groups (Shop Action)
app.post('/api/shop/action', async (req, res) => {
    try {
        const { action } = req.body;
        if (!client) {
            return res.status(400).send('WhatsApp Client belum siap');
        }
        
        const activeGroupIds = Object.keys(groupConfigs.group_configs).filter(id => {
            return groupConfigs.group_configs[id].enabled;
        });

        if (activeGroupIds.length === 0) {
            return res.status(400).send('Tidak ada grup aktif untuk dikirimi aksi');
        }

        let successCount = 0;
        const isClose = (action === 'tutup');

        for (const gId of activeGroupIds) {
            try {
                const chat = await client.getChatById(gId);
                await chat.setMessagesAdminsOnly(isClose);
                
                const noticeMsg = isClose 
                    ? "🔒 *Pemberitahuan:* Toko telah ditutup. Hanya Admin yang dapat mengirim pesan."
                    : "🔓 *Pemberitahuan:* Toko telah dibuka kembali. Grup dibuka untuk umum.";
                
                await client.sendMessage(gId, noticeMsg);
                successCount++;
            } catch (err) {
                console.error(`Gagal ${action} grup ${gId}:`, err.message);
            }
        }

        res.json({ success: true, count: successCount });
    } catch (err) {
        res.status(500).send('Gagal menjalankan aksi toko: ' + err.message);
    }
});

// REST API: Send direct message to contact
app.post('/api/shop/send-message', async (req, res) => {
    try {
        const { to, message } = req.body;
        if (!client) {
            return res.status(400).send('WhatsApp Client belum siap');
        }
        if (!to || !message) {
            return res.status(400).send('Tujuan dan pesan tidak boleh kosong');
        }
        
        const cleanTo = to.replace(/\D/g, '') + '@c.us';
        await client.sendMessage(cleanTo, message);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Gagal mengirim pesan: ' + err.message);
    }
});

// REST API: Toggle group enabled status safely
app.post('/api/host-admin/toggle-group', (req, res) => {
    try {
        const { groupId, enabled } = req.body;
        if (!groupId) {
            return res.status(400).send('Group ID tidak boleh kosong');
        }
        
        let gCfg = groupConfigs.group_configs[groupId];
        if (!gCfg) {
            // Inisialisasi default jika belum ada
            gCfg = {
                groupName: groupId,
                enabled: enabled,
                useAiFallback: true,
                triggerPrefix: '',
                allowedKnowledgeFiles: [],
                categoryFooter: 'Silakan pilih menu dengan mengetik angkanya:',
                contentFooter: 'Ketik *0* untuk kembali ke menu sebelumnya, atau *#* untuk kembali ke menu utama.',
                menuTree: { id: "root", name: "Menu Utama", type: "category", text: "Silakan pilih salah satu opsi di bawah ini:", children: [] }
            };
            groupConfigs.group_configs[groupId] = gCfg;
        } else {
            gCfg.enabled = enabled;
        }
        
        saveGroupConfigs();
        io.emit('group_config_updated', { groupId });
        res.json({ success: true, enabled: gCfg.enabled });
    } catch (err) {
        console.error('Gagal toggle group status:', err.message);
        res.status(500).send('Gagal memperbarui status grup: ' + err.message);
    }
});

// REST API: Update menu tree node status safely
app.post('/api/host-admin/update-node-status', (req, res) => {
    try {
        const { groupId, nodeId, status } = req.body;
        if (!groupId || !nodeId || !status) {
            return res.status(400).send('Input tidak lengkap');
        }
        
        const gCfg = groupConfigs.group_configs[groupId];
        if (!gCfg || !gCfg.menuTree) {
            return res.status(400).send('Konfigurasi grup atau menu tree tidak ditemukan');
        }
        
        const node = findNodeById(gCfg.menuTree, nodeId);
        if (!node) {
            return res.status(404).send('Menu item tidak ditemukan');
        }
        
        node.status = status;
        saveGroupConfigs();
        io.emit('group_config_updated', { groupId });
        res.json({ success: true, status: node.status });
    } catch (err) {
        console.error('Gagal mengubah status node menu:', err.message);
        res.status(500).send('Gagal mengubah status menu item: ' + err.message);
    }
});

// REST API: Open or close specific group manually
app.post('/api/host-admin/open-close-group', async (req, res) => {
    try {
        const { groupId, action } = req.body;
        if (!client) {
            return res.status(400).send('WhatsApp Client belum siap');
        }
        
        const chat = await client.getChatById(groupId);
        const isClose = (action === 'tutup');
        await chat.setMessagesAdminsOnly(isClose);
        
        const noticeMsg = isClose 
            ? "🔒 *Pemberitahuan:* Toko telah ditutup. Hanya Admin yang dapat mengirim pesan."
            : "🔓 *Pemberitahuan:* Toko telah dibuka kembali. Grup dibuka untuk umum.";
        
        await client.sendMessage(groupId, noticeMsg);
        res.json({ success: true });
    } catch (err) {
        console.error(`Gagal ${action} grup spesifik ${groupId}:`, err.message);
        res.status(500).send('Gagal mengontrol status grup: ' + err.message);
    }
});

// REST API: Save group scheduler config safely
app.post('/api/host-admin/group-scheduler', (req, res) => {
    try {
        const { groupId, schedulerEnabled, openTime, closeTime } = req.body;
        if (!groupId) {
            return res.status(400).send('Group ID tidak boleh kosong');
        }
        
        const gCfg = groupConfigs.group_configs[groupId];
        if (!gCfg) {
            return res.status(404).send('Grup tidak ditemukan');
        }
        
        gCfg.autoCloseSchedule = gCfg.autoCloseSchedule || { enabled: false, openTime: '08:00', closeTime: '17:00', activeDays: [1,2,3,4,5] };
        gCfg.autoCloseSchedule.enabled = schedulerEnabled;
        gCfg.autoCloseSchedule.openTime = openTime || '08:00';
        gCfg.autoCloseSchedule.closeTime = closeTime || '17:00';
        
        saveGroupConfigs();
        io.emit('group_config_updated', { groupId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Gagal mengubah jadwal: ' + err.message);
    }
});

// REST API: Add group trigger with media
app.post('/api/host-admin/add-trigger', (req, res) => {
    try {
        const { groupId, keyword, reply, media, allGroups } = req.body;
        if (!groupId || !keyword || !reply) {
            return res.status(400).send('Input tidak lengkap');
        }
        
        const newTrigger = {
            keyword: keyword.trim(),
            reply: reply.trim(),
            media: media ? media.trim() : ''
        };
        
        if (allGroups) {
            // Terapkan ke semua grup
            Object.keys(groupConfigs.group_configs).forEach(gId => {
                const gCfg = groupConfigs.group_configs[gId];
                if (gCfg) {
                    gCfg.extraTriggers = gCfg.extraTriggers || [];
                    gCfg.extraTriggers = gCfg.extraTriggers.filter(t => t.keyword.toLowerCase().trim() !== keyword.toLowerCase().trim());
                    gCfg.extraTriggers.push(newTrigger);
                }
            });
        } else {
            // Terapkan ke grup spesifik
            const gCfg = groupConfigs.group_configs[groupId];
            if (!gCfg) {
                return res.status(404).send('Grup tidak ditemukan');
            }
            gCfg.extraTriggers = gCfg.extraTriggers || [];
            gCfg.extraTriggers = gCfg.extraTriggers.filter(t => t.keyword.toLowerCase().trim() !== keyword.toLowerCase().trim());
            gCfg.extraTriggers.push(newTrigger);
        }
        
        saveGroupConfigs();
        io.emit('group_config_updated', {});
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Gagal menambahkan trigger: ' + err.message);
    }
});

// REST API: Delete group trigger
app.post('/api/host-admin/delete-trigger', (req, res) => {
    try {
        const { groupId, keyword } = req.body;
        if (!groupId || !keyword) {
            return res.status(400).send('Input tidak lengkap');
        }
        
        const gCfg = groupConfigs.group_configs[groupId];
        if (!gCfg) {
            return res.status(404).send('Grup tidak ditemukan');
        }
        
        gCfg.extraTriggers = gCfg.extraTriggers || [];
        gCfg.extraTriggers = gCfg.extraTriggers.filter(t => t.keyword.toLowerCase().trim() !== keyword.toLowerCase().trim());
        
        saveGroupConfigs();
        io.emit('group_config_updated', { groupId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Gagal menghapus trigger: ' + err.message);
    }
});

// REST API: Save group welcome message safely
app.post('/api/host-admin/welcome-message', (req, res) => {
    try {
        const { groupId, welcomeMessage } = req.body;
        if (!groupId) {
            return res.status(400).send('Group ID tidak boleh kosong');
        }
        
        const gCfg = groupConfigs.group_configs[groupId];
        if (!gCfg) {
            return res.status(404).send('Grup tidak ditemukan');
        }
        
        gCfg.welcomeMessage = welcomeMessage;
        saveGroupConfigs();
        io.emit('group_config_updated', { groupId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Gagal menyimpan pesan selamat datang: ' + err.message);
    }
});

// REST API: Rename file inside storage directories safely
app.post('/api/files/rename', (req, res) => {
    try {
        const { type, oldFilename, newFilename } = req.body;
        if (!type || !oldFilename || !newFilename) {
            return res.status(400).send('Input tidak lengkap');
        }
        
        const targetDir = type === 'knowledge' ? KNOWLEDGE_DIR : MEDIA_DIR;
        const oldPath = path.join(targetDir, oldFilename);
        const newPath = path.join(targetDir, newFilename);
        
        if (!fs.existsSync(oldPath)) {
            return res.status(404).send('Berkas lama tidak ditemukan');
        }
        
        if (fs.existsSync(newPath)) {
            return res.status(400).send('Nama berkas baru sudah digunakan');
        }
        
        fs.renameSync(oldPath, newPath);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Gagal mengubah nama berkas: ' + err.message);
    }
});

// GET History Log
app.get('/api/history', (req, res) => {
    res.json(historyLog);
});

// GET AI Memory
app.get('/api/memory', (req, res) => {
    try {
        const memoryPath = path.join(KNOWLEDGE_DIR, '00_memori_otomatis.txt');
        if (fs.existsSync(memoryPath)) {
            const memoryContent = fs.readFileSync(memoryPath, 'utf-8');
            res.json({ content: memoryContent });
        } else {
            res.json({ content: '' });
        }
    } catch (err) {
        res.status(500).send('Gagal membaca memori otomatis.');
    }
});

// POST Save AI Memory
app.post('/api/memory', (req, res) => {
    try {
        const { content } = req.body;
        const memoryPath = path.join(KNOWLEDGE_DIR, '00_memori_otomatis.txt');
        fs.writeFileSync(memoryPath, content || '', 'utf-8');
        console.log('Memori otomatis berhasil diperbarui.');
        res.sendStatus(200);
    } catch (err) {
        console.error('Gagal menyimpan memori otomatis:', err.message);
        res.status(500).send('Gagal menyimpan memori otomatis.');
    }
});

// POST Restart WhatsApp Client (selalu hapus sesi → QR scan baru)
app.post('/api/whatsapp/restart', async (req, res) => {
    try {
        console.log('[API] Menerima instruksi restart WhatsApp...');

        // 1. Update status UI
        currentStatus = 'INITIALIZING';
        currentQrCode = null;
        io.emit('whatsapp_status', { status: currentStatus });

        // 2. Kill semua Chrome & hapus LOCK files
        await cleanupHeadlessChrome();

        // 3. Destroy client lama (max 5 detik)
        if (client) {
            try {
                await Promise.race([
                    client.destroy(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
                ]);
                console.log('[API] WhatsApp Client lama berhasil dihancurkan.');
            } catch (err) {
                console.warn('[API] Destroy timeout/error (diabaikan):', err.message);
            }
            client = null;
        }

        // 4. SELALU hapus seluruh folder sesi agar mulai dari QR baru
        const sessionPath = path.join(__dirname, 'session');
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log('[API] Folder sesi ./session berhasil dihapus. Siap scan QR baru.');
            } catch (err) {
                console.warn('[API] Gagal menghapus sesi (diabaikan):', err.message);
            }
        }

        // 5. Reset flag lalu buat client baru → akan muncul QR Code
        isRestarting = false;
        console.log('[API] Memulai inisialisasi ulang WhatsApp Client...');
        createNewClient();

        res.sendStatus(200);
    } catch (err) {
        console.error('[API] Gagal me-restart WhatsApp Client:', err.message);
        res.status(500).send('Gagal melakukan restart client: ' + err.message);
    }
});

// Setup WhatsApp Client dengan Puppeteer Arguments untuk stabilitas RAM
const puppeteerOptions = {
    handleSIGINT: false,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions'
    ]
};

// Deteksi otomatis jika berjalan di Android (Termux)
if (process.platform === 'android') {
    const termuxChromiumPath = '/data/data/com.termux/files/usr/bin/chromium';
    if (fs.existsSync(termuxChromiumPath)) {
        puppeteerOptions.executablePath = termuxChromiumPath;
        console.log(`[WhatsApp] Terdeteksi berjalan di Termux. Menggunakan chromium: ${termuxChromiumPath}`);
    } else {
        console.warn(`[WhatsApp] Peringatan: Berjalan di Termux tetapi chromium tidak ditemukan di ${termuxChromiumPath}. Pastikan Anda sudah menjalankan 'pkg install chromium'.`);
    }
} else if (config.puppeteer_executable_path && config.puppeteer_executable_path.trim() !== '') {
    // Kustom path dari config.json (jika di-set secara manual)
    puppeteerOptions.executablePath = config.puppeteer_executable_path.trim();
    console.log(`[WhatsApp] Menggunakan custom puppeteer executablePath: ${puppeteerOptions.executablePath}`);
}

let client;

function cleanupHeadlessChrome() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            return resolve();
        }
        // Kill semua Chrome headless dulu
        const killCmd = 'powershell -Command "Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"';
        exec(killCmd, () => {
            // Tunggu 1.5 detik agar OS melepaskan lock
            setTimeout(() => {
                // Hapus semua file LOCK yang tersisa di folder sesi
                const sessionPath = path.join(__dirname, 'session');
                if (fs.existsSync(sessionPath)) {
                    const removeLocks = (dir) => {
                        try {
                            const entries = fs.readdirSync(dir, { withFileTypes: true });
                            for (const entry of entries) {
                                const fullPath = path.join(dir, entry.name);
                                if (entry.isDirectory()) {
                                    removeLocks(fullPath);
                                } else if (entry.name === 'LOCK') {
                                    try { fs.unlinkSync(fullPath); } catch(_) {}
                                }
                            }
                        } catch(_) {}
                    };
                    removeLocks(sessionPath);
                    console.log('[Cleanup] Chrome dihentikan & semua file LOCK sesi dihapus.');
                } else {
                    console.log('[Cleanup] Chrome dihentikan (folder sesi belum ada).');
                }
                resolve();
            }, 1500);
        });
    });
}

let isRestarting = false;
let initWatchdogTimer = null;

function createNewClient() {
    if (isRestarting) {
        console.log('[WA] Inisialisasi sudah berjalan, permintaan duplikat diabaikan.');
        return;
    }
    isRestarting = true;

    // Bersihkan watchdog sebelumnya jika ada
    if (initWatchdogTimer) {
        clearTimeout(initWatchdogTimer);
        initWatchdogTimer = null;
    }

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './session' }),
        puppeteer: puppeteerOptions
    });
    attachClientListeners();
    client.initialize();

    // Watchdog: jika tidak READY/QR dalam 90 detik, restart otomatis
    initWatchdogTimer = setTimeout(async () => {
        if (currentStatus === 'INITIALIZING' || currentStatus === 'DISCONNECTED') {
            console.log('[Watchdog] WhatsApp terlalu lama di status INITIALIZING. Memulai restart otomatis...');
            isRestarting = false;
            await cleanupHeadlessChrome();
            if (client) {
                try { 
                    await Promise.race([
                        client.destroy(),
                        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))
                    ]); 
                } catch(_) {}
                client = null;
            }
            await new Promise(r => setTimeout(r, 1500));
            createNewClient();
        }
    }, 180000);
}

// State Management
const activeLocks = new Set(); // Mengunci user agar tidak double-request saat LLM sedang memproses
let chatSessions = {}; // In-Memory Cache untuk Riwayat Percakapan
let currentStatus = 'DISCONNECTED'; // CONNECTED, INITIALIZING, QR_RECEIVED, DISCONNECTED
let currentQrCode = null;

// Load Database Sesi Persisten dari file JSON saat startup
function loadSessions() {
    chatSessions = dbData.chat_sessions || {};
    console.log('Database riwayat percakapan berhasil dimuat.');
}

// Menyimpan Database Sesi ke File JSON (Asinkronus)
async function saveSessions() {
    try {
        dbData.chat_sessions = chatSessions;
        await saveDatabaseAsync();
    } catch (err) {
        console.error('Gagal menyimpan database riwayat ke file:', err.message);
    }
}

// Fungsi Pencari Knowledge Base menggunakan metode Fuzzy Matcher Sederhana
function getKnowledgeContext(userMessage) {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
        return 'Tidak ada dokumen referensi lembaga yang tersedia.';
    }

    const files = fs.readdirSync(KNOWLEDGE_DIR);
    let matchedContent = '';
    const messageLower = userMessage.toLowerCase();

    for (const file of files) {
        const filePath = path.join(KNOWLEDGE_DIR, file);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const fileNameNoExt = path.basename(file, path.extname(file)).toLowerCase();

        // Cari berdasarkan kesamaan kata kunci pada nama file atau isi konten
        const keywords = fileNameNoExt.split('_');
        const isMatched = keywords.some(keyword => messageLower.includes(keyword)) || 
                          messageLower.includes(fileNameNoExt) ||
                          (fileContent.toLowerCase().includes(messageLower) && userMessage.length > 4);

        if (isMatched) {
            matchedContent += `\n[BERKAS: ${file}]\n${fileContent}\n`;
        }
    }

    return matchedContent || 'Gunakan pengetahuan umum lembaga yang ramah.';
}

// Algoritma Pencocokan Kata Kunci (Database)
function findPresetMatch(userMessage) {
    const msg = userMessage.toLowerCase().trim();
    
    for (const preset of dbPresets) {
        const matched = preset.keywords.some(kw => 
            msg === kw || 
            msg.startsWith(kw + ' ') || 
            msg.endsWith(' ' + kw) || 
            msg.includes(' ' + kw + ' ') || 
            (msg.includes(kw) && kw.length > 5)
        );
        if (matched) {
            return preset.draft;
        }
    }
    
    return null;
}

// Fungsi untuk menggabungkan seluruh file referensi untuk Mode Deep Think
function getAllKnowledgeContext() {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
        return 'Tidak ada dokumen referensi lembaga yang tersedia.';
    }

    const files = fs.readdirSync(KNOWLEDGE_DIR);
    let allContent = '';

    for (const file of files) {
        if (file.endsWith('.txt') || file.endsWith('.md')) {
            const filePath = path.join(KNOWLEDGE_DIR, file);
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            allContent += `\n[BERKAS: ${file}]\n${fileContent}\n`;
        }
    }

    return allContent || 'Gunakan pengetahuan umum lembaga yang ramah.';
}

// ══════════════════════════════════════════════════════
// FLAG FITUR: Set false untuk menonaktifkan fitur keuangan
// ══════════════════════════════════════════════════════
const FITUR_KEUANGAN = false;

// State untuk menyimpan transaksi kuitansi yang menunggu konfirmasi (YA/TIDAK)
const pendingTransactions = new Map();

// Mengonversi singkatan nominal (misal: 50rb -> 50000, 1.5jt -> 1500000)
function parseNominal(text) {
    if (!text) return 0;
    
    // Clean and lowercase
    let cleaned = text.toLowerCase().replace(/[\s\r\n]+/g, '').trim();
    
    // Check multiplier
    let multiplier = 1;
    if (cleaned.endsWith('rb') || cleaned.endsWith('k')) {
        multiplier = 1000;
        cleaned = cleaned.replace(/rb|k/g, '');
    } else if (cleaned.endsWith('jt')) {
        multiplier = 1000000;
        cleaned = cleaned.replace(/jt/g, '');
    }
    
    // Remove formatting dots/commas
    cleaned = cleaned.replace(/,/g, '.');
    const parts = cleaned.split('.');
    if (parts.length > 2) {
        cleaned = parts.join('');
    } else if (parts.length === 2) {
        if (multiplier === 1 && parts[1].length === 3) {
            cleaned = parts.join('');
        } else {
            cleaned = parseFloat(cleaned);
        }
    }
    
    let num = parseFloat(cleaned);
    if (isNaN(num)) return 0;
    
    return Math.round(num * multiplier);
}

// Mengekstrak informasi dari template pintasan keuangan (seperti: + 1 jt jajan, keluar 50k bensin)
function parseShortcutMessage(userMessage) {
    const msg = userMessage.toLowerCase().trim();
    // Tentukan apakah pesan menggunakan tanda + / - / masuk / keluar di awal
    const prefixMatch = msg.match(/^(\+|-|masuk|keluar)\s*(.+)$/i);
    if (!prefixMatch) return null;

    const action = prefixMatch[1].toLowerCase();
    const rest = prefixMatch[2].trim();

    // Regex untuk mencocokkan nominal dengan unit terpisah spasi opsional (contoh: 1 jt, 1.5 juta, 100 rb, 50k, 250000)
    // dilanjutkan dengan spasi dan keterangan
    const nominalRegex = /^(\d+(?:[.,]\d+)?\s*(?:jt|juta|rb|ribu|k)?)\s+(.+)$/i;
    const match = rest.match(nominalRegex);
    if (!match) return null;

    const rawNominal = match[1];
    const keterangan = prefixMatch[2].substring(rawNominal.length).trim(); // Ambil keterangan asli dengan huruf kapital dari user

    // Bersihkan spasi di dalam nominal agar bisa diproses oleh parseNominal (contoh: "1 jt" -> "1jt")
    const cleanedNominalStr = rawNominal.replace(/\s+/g, '');
    const nominalVal = parseNominal(cleanedNominalStr);

    const type = (action === '+' || action === 'masuk') ? 'Pemasukan' : 'Pengeluaran';

    return {
        type,
        nominal: nominalVal,
        keterangan: keterangan
    };
}

// Mengirimkan payload data ke Google Apps Script Web App
async function sendToGoogleSheets(payload) {
    const sheetsUrl = config.google_sheets_url;
    if (!sheetsUrl) {
        throw new Error('URL Google Sheets belum dikonfigurasi di dashboard.');
    }
    
    const response = await axios.post(sheetsUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
    });
    
    if (response.data && response.data.status === 'success') {
        // Hapus cache agar pembacaan berikutnya mendapatkan data terbaru
        sheetsSummaryCache.data = null;
        sheetsSummaryCache.timestamp = 0;
        return true;
    } else {
        throw new Error(response.data ? response.data.message : 'Respon tidak valid dari Google Sheets.');
    }
}

// Mengambil ringkasan data keuangan & agenda dari Google Sheets secara real-time (dengan cache 60 detik)
async function fetchSheetsSummary(forceRefresh = false) {
    const now = Date.now();
    // Jika cache berumur kurang dari 60 detik, gunakan cache (kecuali jika dipaksa refresh)
    if (!forceRefresh && sheetsSummaryCache.data && (now - sheetsSummaryCache.timestamp < 60000)) {
        return sheetsSummaryCache.data;
    }
    
    const sheetsUrl = config.google_sheets_url;
    if (!sheetsUrl) {
        return null;
    }
    
    try {
        console.log('[Google Sheets] Mengambil ringkasan data terbaru secara real-time...');
        const response = await axios.post(sheetsUrl, {
            action: 'read_data'
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
        
        if (response.data && response.data.status === 'success') {
            sheetsSummaryCache.data = response.data;
            sheetsSummaryCache.timestamp = now;
            return response.data;
        }
    } catch (err) {
        console.error('Gagal fetchSheetsSummary dari Google Sheets:', err.message);
    }
    
    return sheetsSummaryCache.data;
}

// Menjalankan OCR lokal untuk kuitansi/nota belanja
async function performOCR(imageBuffer) {
    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng');
    return text;
}

// Global pointer untuk rotasi key (round-robin)
let currentGeminiKeyIndex = 0;

// Fungsi untuk memanggil API Gemini menggunakan satu key tertentu
async function callGemini(systemPrompt, chatHistory, isJson = false, apiKey) {
    const model = config.model_name && config.model_name.startsWith('gemini') 
        ? config.model_name 
        : 'gemini-2.5-flash';
        
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    const contents = chatHistory.map(msg => {
        const role = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
        return {
            role: role,
            parts: [{ text: msg.content }]
        };
    });
    
    const payload = {
        contents: contents
    };
    
    if (systemPrompt) {
        payload.systemInstruction = {
            parts: [{ text: systemPrompt }]
        };
    }
    
    payload.generationConfig = {
        temperature: isJson ? 0.1 : 0.7,
        maxOutputTokens: config.max_tokens || 1000
    };
    
    if (isJson) {
        payload.generationConfig.responseMimeType = "application/json";
    }
    
    let response;
    try {
        response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });
    } catch (err) {
        if (err.response) {
            console.error('[Gemini API Error Response]:', JSON.stringify(err.response.data));
        }
        throw err;
    }
    
    if (response.data && response.data.candidates && response.data.candidates[0].content) {
        return response.data.candidates[0].content.parts[0].text.trim();
    } else {
        throw new Error('Respon tidak valid dari Gemini API.');
    }
}

// Fungsi pembungkus panggilan Gemini dengan dukungan Pool (Stok API Keys) dan Auto-Fallback
async function callGeminiWithPool(systemPrompt, chatHistory, isJson = false) {
    let keys = config.gemini_api_keys || [];
    
    // Fallback jika masih menggunakan struktur key tunggal
    if (keys.length === 0 && config.gemini_api_key) {
        keys = [config.gemini_api_key];
    }
    if (keys.length === 0 && config.api_key) {
        keys = [config.api_key];
    }
    
    // Filter key kosong/tidak valid
    keys = keys.filter(k => k && k.trim().length > 0);
    
    if (keys.length === 0) {
        throw new Error('Tidak ada API Key Gemini yang tersedia di dalam stok (pool).');
    }
    
    let lastError = null;
    
    // Coba memanggil API menggunakan key secara bergantian (round-robin) dan fallback ke key berikutnya jika gagal
    for (let i = 0; i < keys.length; i++) {
        // Rotasikan index key
        const index = (currentGeminiKeyIndex + i) % keys.length;
        const activeKey = keys[index];
        const maskedKey = activeKey.substring(0, 6) + '...' + activeKey.substring(activeKey.length - 4);
        
        try {
            console.log(`[Gemini Pool] Mencoba memanggil API menggunakan Key #${index + 1} (${maskedKey})`);
            const result = await callGemini(systemPrompt, chatHistory, isJson, activeKey);
            
            // Simpan index key yang berhasil agar digunakan lagi pada panggilan berikutnya
            currentGeminiKeyIndex = index;
            return result;
        } catch (err) {
            console.warn(`[Gemini Pool] Key #${index + 1} gagal digunakan: ${err.message}`);
            lastError = err;
        }
    }
    
    throw new Error(`Seluruh API Key di stok gagal digunakan. Error terakhir: ${lastError ? lastError.message : 'Unknown'}`);
}

// Fungsi untuk memanggil API LM Studio (Lokal)
async function callLMStudio(systemPrompt, chatHistory, isJson = false) {
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    
    chatHistory.forEach(msg => {
        messages.push({
            role: msg.role === 'model' ? 'assistant' : msg.role,
            content: msg.content
        });
    });
    
    let response;
    try {
        response = await axios.post(apiEndpoint, {
            model: config.model_name,
            messages: messages,
            stream: false,
            temperature: isJson ? 0.1 : 0.7,
            max_tokens: isJson ? 250 : (config.max_tokens || 1000)
        }, {
            headers: {
                'Authorization': `Bearer ${config.api_key || 'lm-studio'}`,
                'Content-Type': 'application/json'
            },
            timeout: 120000
        });
    } catch (err) {
        if (err.response) {
            console.error('[LM Studio API Error Response]:', JSON.stringify(err.response.data));
        }
        throw err;
    }
    
    let content = response.data.choices[0].message.content.trim();
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    
    if (isJson) {
        content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    }
    
    return content;
}

// Fungsi untuk memanggil API OpenAI-compatible (Groq, DeepSeek, Qwen, OpenRouter, dll)
async function callOpenAiCompatible(url, apiKey, model, systemPrompt, chatHistory, isJson = false) {
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    
    chatHistory.forEach(msg => {
        messages.push({
            role: msg.role === 'model' ? 'assistant' : msg.role,
            content: msg.content
        });
    });
    
    const payload = {
        model: model,
        messages: messages,
        stream: false,
        temperature: isJson ? 0.1 : 0.7,
        max_tokens: isJson ? 250 : (config.max_tokens || 1000)
    };
    
    if (isJson) {
        payload.response_format = { type: 'json_object' };
    }
    
    let response;
    try {
        response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${apiKey || ''}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });
    } catch (err) {
        if (err.response) {
            console.error(`[OpenAI-Compatible API Error Response from ${url}]:`, JSON.stringify(err.response.data));
        }
        throw err;
    }
    
    let content = response.data.choices[0].message.content.trim();
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    
    if (isJson) {
        content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    }
    
    return content;
}

// Fungsi pembungkus AI Provider
async function callAiProvider(systemPrompt, chatHistory, isJson = false) {
    if (config.provider === 'gemini') {
        return await callGeminiWithPool(systemPrompt, chatHistory, isJson);
    } else if (config.provider === 'groq') {
        const apiKey = config.groq_api_key;
        const model = config.groq_model || 'llama-3.3-70b-versatile';
        const url = 'https://api.groq.com/openai/v1/chat/completions';
        return await callOpenAiCompatible(url, apiKey, model, systemPrompt, chatHistory, isJson);
    } else if (config.provider === 'deepseek') {
        const apiKey = config.deepseek_api_key;
        const model = config.deepseek_model || 'deepseek-chat';
        const url = 'https://api.deepseek.com/chat/completions';
        return await callOpenAiCompatible(url, apiKey, model, systemPrompt, chatHistory, isJson);
    } else if (config.provider === 'qwen') {
        const apiKey = config.qwen_api_key;
        const model = config.qwen_model || 'qwen-plus';
        const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
        return await callOpenAiCompatible(url, apiKey, model, systemPrompt, chatHistory, isJson);
    } else if (config.provider === 'openrouter') {
        const apiKey = config.openrouter_api_key;
        const model = config.openrouter_model || 'meta-llama/llama-3.3-70b-instruct';
        const url = 'https://openrouter.ai/api/v1/chat/completions';
        return await callOpenAiCompatible(url, apiKey, model, systemPrompt, chatHistory, isJson);
    } else {
        return await callLMStudio(systemPrompt, chatHistory, isJson);
    }
}

// Menggunakan LLM untuk mengekstrak nominal dan deskripsi dari hasil OCR
async function extractReceiptDetails(ocrText) {
    const systemPrompt = `Kamu adalah AI pembuat keputusan ekstraksi data keuangan.
Tugasmu adalah menganalisis teks hasil pembacaan OCR dari sebuah foto kuitansi atau nota belanja, lalu mengekstrak informasi keuangan berupa TOTAL NOMINAL pembelanjaan (dalam rupiah) dan DESKRIPSI SINGKAT tujuan pengeluaran tersebut.

Keluaran Anda HARUS berupa format JSON bersih seperti contoh berikut:
{
  "nominal": 150000,
  "keterangan": "Beli bensin di Pertamina"
}

[ATURAN PENTING]
- nominal: Harus berupa angka bulat (integer) saja, tanpa tanda titik, koma, atau Rp.
- keterangan: Deskripsi singkat max 5 kata (misal: "Beli bensin", "Makan siang", "Belanja ATK").
- Jika tidak menemukan total nominal yang jelas, tebak angka terbesar yang masuk akal sebagai total pengeluaran.`;

    try {
        const content = await callAiProvider(systemPrompt, [{ role: 'user', content: `TEKS OCR KUITANSI:\n${ocrText}` }], true);
        const data = JSON.parse(content);
        return {
            nominal: parseInt(data.nominal, 10) || 0,
            keterangan: data.keterangan || 'Pengeluaran Kuitansi'
        };
    } catch (e) {
        console.error('Gagal mengekstrak struk belanja:', e.message);
        return {
            nominal: 0,
            keterangan: 'Gagal mengekstrak struk belanja'
        };
    }
}

// Algoritma lokal untuk mendeteksi apakah teks OCR adalah kuitansi/nota tanpa memanggil AI (menghemat token)
function isReceiptText(text) {
    const txt = text.toLowerCase();
    
    // 1. Kata kunci yang sering muncul di kuitansi/nota/struk belanja
    const receiptKeywords = [
        'total', 'jumlah', 'subtotal', 'grand total', 'netto', 'ppn', 'tax', 'ongkir', 
        'cashier', 'kasir', 'struk', 'nota', 'kuitansi', 'receipt', 'invoice', 'bill',
        'tunai', 'kembalian', 'kembali', 'bayar', 'debit', 'credit', 'payment',
        'harga', 'pcs', 'qty', 'item', 'disc', 'diskon', 'belanja', 'pembelian'
    ];
    
    // 2. Hitung berapa banyak kata kunci yang cocok
    let matchCount = 0;
    receiptKeywords.forEach(kw => {
        if (txt.includes(kw)) {
            matchCount++;
        }
    });
    
    // 3. Deteksi pola angka nominal uang (misal: Rp 50.000, 15,000, 50k, 50rb)
    const hasNominalPattern = /rp\.?\s*\d+[\d.,]*/i.test(txt) || 
                              /\b\d{1,3}([.,]\d{3})+\b/.test(txt) || 
                              /\b\d+\s*(rb|k|jt)\b/i.test(txt);
    
    // Jika ada minimal 2 kata kunci kuitansi ATAU (minimal 1 kata kunci DAN ada pola nominal uang)
    return (matchCount >= 2) || (matchCount >= 1 && hasNominalPattern);
}

// Algoritma lokal untuk mem-parsing kalimat transaksi keuangan sederhana (menghemat token)
function localParseFinanceMessage(text) {
    const msg = text.toLowerCase().trim();
    
    // 1. Cari pola nominal uang di dalam teks
    const moneyRegex = /\b\d+([.,]\d+)?\s*(rb|k|jt|juta|ribu)?\b/gi;
    const matches = msg.match(moneyRegex);
    if (!matches) return null;
    
    let nominalStr = '';
    let nominalVal = 0;
    
    for (const match of matches) {
        const val = parseNominal(match);
        if (val > 100) { // Anggap nominal transaksi yang masuk akal > 100 rupiah
            nominalStr = match;
            nominalVal = val;
            break;
        }
    }
    
    if (nominalVal <= 0) return null;
    
    // 2. Tentukan tipe transaksi berdasarkan kata kunci
    const incomeKeywords = ['masuk', 'pemasukan', 'gaji', 'terima', 'dapat', 'income', 'ditambahkan', 'transfer masuk'];
    const expenseKeywords = ['keluar', 'pengeluaran', 'beli', 'bayar', 'belanja', 'biaya', 'ongkos', 'parkir', 'makan', 'minum', 'toll', 'listrik', 'pulsa'];
    
    let isIncome = false;
    let isExpense = false;
    
    incomeKeywords.forEach(kw => {
        if (msg.includes(kw)) isIncome = true;
    });
    expenseKeywords.forEach(kw => {
        if (msg.includes(kw)) isExpense = true;
    });
    
    let type = 'Pengeluaran';
    if (isIncome && !isExpense) {
        type = 'Pemasukan';
    } else if (isExpense) {
        type = 'Pengeluaran';
    } else {
        // Jika tidak ada kata kunci yang jelas, biarkan AI yang mengklasifikasikan
        return null;
    }
    
    // 3. Ekstrak keterangan (buang nominal uang dan kata kunci dari teks asli)
    let keterangan = text;
    
    // Hapus nominal uang
    const escNominal = nominalStr.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    keterangan = keterangan.replace(new RegExp(escNominal, 'gi'), '');
    
    // Hapus kata kunci indikator
    const allKeywords = [...incomeKeywords, ...expenseKeywords, 'catat', 'pencatatan', 'uang'];
    allKeywords.forEach(kw => {
        keterangan = keterangan.replace(new RegExp('\\b' + kw + '\\b', 'gi'), '');
    });
    
    keterangan = keterangan.replace(/[\s\-,;]+/g, ' ').trim();
    
    if (!keterangan) {
        keterangan = type === 'Pemasukan' ? 'Pemasukan Tunai' : 'Pengeluaran Harian';
    }
    
    return {
        intent: 'finance',
        type: type,
        nominal: nominalVal,
        keterangan: keterangan
    };
}

// Menggunakan LLM untuk mengklasifikasi pesan bebas menjadi intent finance/agenda
// Fungsi untuk mendapatkan representasi waktu lokal saat ini dalam bahasa Indonesia
function getCurrentTimeString() {
    const now = new Date();
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    
    const dayName = days[now.getDay()];
    const day = now.getDate();
    const monthName = months[now.getMonth()];
    const year = now.getFullYear();
    
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    return `${dayName}, ${day} ${monthName} ${year} pukul ${hours}:${minutes}:${seconds} WIB`;
}

// Algoritma lokal untuk mendeteksi laporan saldo, list pengeluaran/pemasukan, dan filter harian (0 token)
async function handleLocalReportCommands(userMessage, msg) {
    const msgLower = userMessage.toLowerCase().trim();
    const chatId = msg.from;

    // 1. Deteksi kata kunci laporan
    const isSaldo = ['sisa uang', 'sisa kas', 'saldo kas', 'saldo', 'total saldo', 'uang saya', 'sisa saldo', 'kas saat ini', 'cek saldo', 'sisa'].some(kw => msgLower.includes(kw));
    const isListPengeluaran = ['list pengeluaran', 'daftar pengeluaran', 'rekap pengeluaran', 'rincian pengeluaran', 'tampilkan pengeluaran', 'pengeluaran', 'rekap pengeluaran'].some(kw => msgLower === kw || msgLower.includes(kw));
    const isListPemasukan = ['list pemasukan', 'daftar pemasukan', 'rekap pemasukan', 'rincian pemasukan', 'tampilkan pemasukan', 'pemasukan', 'rekap pemasukan'].some(kw => msgLower === kw || msgLower.includes(kw));
    const isListTotal = ['list total', 'total list', 'rekap total', 'semua transaksi', 'list transaksi', 'daftar transaksi', 'total', 'rekap'].some(kw => msgLower === kw || msgLower.includes(kw));
    
    const hasReportKw = ['laporan', 'rekap', 'transaksi', 'list', 'daftar', 'rincian', 'pengeluaran', 'pemasukan', 'sisa', 'saldo', 'total'].some(kw => msgLower.includes(kw));
    const isToday = msgLower.includes('hari ini');
    const isYesterday = msgLower.includes('kemarin');
    const isDateMatch = msgLower.match(/tanggal\s*(\d{1,2})/);

    // Jika tidak mencocokkan kata kunci laporan apa pun, return false
    if (!isSaldo && !isListPengeluaran && !isListPemasukan && !isListTotal && !(hasReportKw && (isToday || isYesterday || isDateMatch))) {
        return false;
    }

    // Ambil data Google Sheets secara real-time (bypass cache agar selalu segar)
    const summary = await fetchSheetsSummary(true);
    if (!summary) {
        await msg.reply('❌ Maaf Bos, gagal mengambil data dari Google Sheets. Pastikan URL Google Sheets sudah dikonfigurasi di dashboard.');
        return true;
    }

    // A. Penanganan Laporan Saldo
    if (isSaldo && !isListPengeluaran && !isListPemasukan && !isToday && !isYesterday && !isDateMatch) {
        const replyMsg = `💼 *Informasi Saldo Kas Anda* 📊\n\n` +
                         `- *Saldo Kas Saat Ini*: *Rp ${summary.saldoKas.toLocaleString('id-ID')}*\n` +
                         `- *Total Pemasukan*: *Rp ${summary.totalPemasukan.toLocaleString('id-ID')}*\n` +
                         `- *Total Pengeluaran*: *Rp ${summary.totalPengeluaran.toLocaleString('id-ID')}*\n\n` +
                         `💡 Tip: Ketik *list pengeluaran* atau *list pemasukan* untuk rincian transaksi terbaru.`;
        await msg.reply(replyMsg);
        io.emit('message_log', {
            chatId,
            body: `[Laporan Lokal - Saldo] Dikirim ke user`,
            type: 'outgoing',
            timestamp: Date.now()
        });
        return true;
    }

    // B. Penanganan List Pengeluaran
    if (isListPengeluaran && !isToday && !isYesterday && !isDateMatch) {
        const expenses = summary.financeList ? summary.financeList.filter(f => f.tipe === 'Pengeluaran') : [];
        let replyMsg = `📋 *Daftar Pengeluaran Terbaru Bos* 📉\n\n`;
        if (expenses.length === 0) {
            replyMsg += `_(Belum ada catatan pengeluaran)_`;
        } else {
            expenses.slice(0, 10).forEach(f => {
                const dateStr = f.tanggal ? new Date(f.tanggal).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
                replyMsg += `- [${dateStr}] *Rp ${f.nominal.toLocaleString('id-ID')}* (${f.keterangan})\n`;
            });
            replyMsg += `\n💼 *Saldo Kas Saat Ini*: *Rp ${summary.saldoKas.toLocaleString('id-ID')}*\n`;
            replyMsg += `\n💡 _(Menampilkan maksimal 10 transaksi pengeluaran terbaru. Seluruh pengeluaran dihitung dalam Saldo Kas di atas. Rekap lengkap di Google Spreadsheet)_`;
        }
        await msg.reply(replyMsg);
        io.emit('message_log', {
            chatId,
            body: `[Laporan Lokal - List Pengeluaran] Dikirim ke user`,
            type: 'outgoing',
            timestamp: Date.now()
        });
        return true;
    }

    // C. Penanganan List Pemasukan
    if (isListPemasukan && !isToday && !isYesterday && !isDateMatch) {
        const income = summary.financeList ? summary.financeList.filter(f => f.tipe === 'Pemasukan') : [];
        let replyMsg = `📋 *Daftar Pemasukan Terbaru Bos* 📈\n\n`;
        if (income.length === 0) {
            replyMsg += `_(Belum ada catatan pemasukan)_`;
        } else {
            income.slice(0, 10).forEach(f => {
                const dateStr = f.tanggal ? new Date(f.tanggal).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
                replyMsg += `- [${dateStr}] *Rp ${f.nominal.toLocaleString('id-ID')}* (${f.keterangan})\n`;
            });
            replyMsg += `\n💼 *Saldo Kas Saat Ini*: *Rp ${summary.saldoKas.toLocaleString('id-ID')}*\n`;
            replyMsg += `\n💡 _(Menampilkan maksimal 10 transaksi pemasukan terbaru. Seluruh pemasukan dihitung dalam Saldo Kas di atas. Rekap lengkap di Google Spreadsheet)_`;
        }
        await msg.reply(replyMsg);
        io.emit('message_log', {
            chatId,
            body: `[Laporan Lokal - List Pemasukan] Dikirim ke user`,
            type: 'outgoing',
            timestamp: Date.now()
        });
        return true;
    }

    // C.5. Penanganan List Total (Semua Transaksi Terbaru)
    if (isListTotal && !isToday && !isYesterday && !isDateMatch) {
        const transactions = summary.financeList || [];
        let replyMsg = `📊 *Rekap Transaksi & Saldo Total Bos*\n\n` +
                         `- *Saldo Kas Saat Ini*: *Rp ${summary.saldoKas.toLocaleString('id-ID')}*\n` +
                         `- *Total Pemasukan*: *Rp ${summary.totalPemasukan.toLocaleString('id-ID')}*\n` +
                         `- *Total Pengeluaran*: *Rp ${summary.totalPengeluaran.toLocaleString('id-ID')}*\n\n` +
                         `*Daftar Transaksi Terbaru (Gabungan)*:\n`;

        if (transactions.length === 0) {
            replyMsg += `_(Belum ada catatan transaksi)_`;
        } else {
            // Ambil maksimal 15 transaksi terbaru
            transactions.slice(0, 15).forEach(f => {
                const dateStr = f.tanggal ? new Date(f.tanggal).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
                const prefix = f.tipe === 'Pemasukan' ? '🟢 [Masuk]' : '🔴 [Keluar]';
                replyMsg += `- ${prefix} [${dateStr}] *Rp ${f.nominal.toLocaleString('id-ID')}* (${f.keterangan})\n`;
            });
            replyMsg += `\n💡 _(Menampilkan maksimal 15 transaksi terbaru secara real-time. Saldo Kas & Total dihitung dari seluruh riwayat spreadsheet Anda)_`;
        }
        await msg.reply(replyMsg);
        io.emit('message_log', {
            chatId,
            body: `[Laporan Lokal - List Total] Dikirim ke user`,
            type: 'outgoing',
            timestamp: Date.now()
        });
        return true;
    }

    // D. Penanganan Filter Harian
    if (isToday || isYesterday || isDateMatch) {
        const targetDate = new Date();
        let label = 'Hari ini';

        if (isYesterday) {
            targetDate.setDate(targetDate.getDate() - 1);
            label = 'Kemarin';
        } else if (isDateMatch) {
            const dayNum = parseInt(isDateMatch[1], 10);
            targetDate.setDate(dayNum);
            label = `Tanggal ${dayNum}`;
        }

        const targetYear = targetDate.getFullYear();
        const targetMonth = targetDate.getMonth();
        const targetDay = targetDate.getDate();

        const transactions = summary.financeList ? summary.financeList.filter(f => {
            if (!f.tanggal) return false;
            const fDate = new Date(f.tanggal);
            return fDate.getFullYear() === targetYear &&
                   fDate.getMonth() === targetMonth &&
                   fDate.getDate() === targetDay;
        }) : [];

        const filterTipe = msgLower.includes('pengeluaran') ? 'Pengeluaran' : (msgLower.includes('pemasukan') ? 'Pemasukan' : null);
        let filteredTrans = transactions;
        if (filterTipe) {
            filteredTrans = transactions.filter(t => t.tipe === filterTipe);
        }

        let totalIncome = 0;
        let totalExpense = 0;
        transactions.forEach(t => {
            if (t.tipe === 'Pemasukan') totalIncome += t.nominal;
            else if (t.tipe === 'Pengeluaran') totalExpense += t.nominal;
        });

        const targetDateStr = targetDate.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
        let replyMsg = `📊 *Laporan Keuangan ${label} (${targetDateStr})*\n\n`;

        if (filterTipe) {
            replyMsg += `🔍 Filter Kategori: *${filterTipe}*\n`;
        }

        replyMsg += `- *Total Pemasukan*: Rp ${totalIncome.toLocaleString('id-ID')}\n` +
                     `- *Total Pengeluaran*: Rp ${totalExpense.toLocaleString('id-ID')}\n` +
                     `- *Netto Harian*: Rp ${(totalIncome - totalExpense).toLocaleString('id-ID')}\n\n` +
                     `*Rincian Transaksi*:\n`;

        if (filteredTrans.length === 0) {
            replyMsg += `_(Tidak ada catatan transaksi ${filterTipe ? filterTipe.toLowerCase() : ''} untuk tanggal ini)_`;
        } else {
            filteredTrans.forEach(t => {
                const timeStr = t.tanggal ? new Date(t.tanggal).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
                const prefix = t.tipe === 'Pemasukan' ? '🟢 [Masuk]' : '🔴 [Keluar]';
                replyMsg += `- ${prefix} Pukul ${timeStr} : *Rp ${t.nominal.toLocaleString('id-ID')}* (${t.keterangan})\n`;
            });
        }

        await msg.reply(replyMsg);
        io.emit('message_log', {
            chatId,
            body: `[Laporan Lokal - Filter ${label}] Dikirim ke user`,
            type: 'outgoing',
            timestamp: Date.now()
        });
        return true;
    }

    return false;
}

// Fungsi untuk menghasilkan analisis intent dan obrolan AI secara terpadu (Unified AI)
async function generateUnifiedAiResponse(userMessage, chatId) {
    // 1. Ambil berkas basis pengetahuan & memori
    const memoryPath = path.join(KNOWLEDGE_DIR, '00_memori_otomatis.txt');
    let memoryContent = '';
    if (fs.existsSync(memoryPath)) {
        memoryContent = fs.readFileSync(memoryPath, 'utf-8');
    }
    const knowledgeContext = getAllKnowledgeContext();
    
    // 1.5. Ambil data real-time Google Sheets jika tersedia
    let sheetsContext = '';
    try {
        const summary = await fetchSheetsSummary();
        if (summary) {
            sheetsContext = `
[DATA KEUANGAN & AGENDA REAL-TIME GOOGLE SHEETS]
- Total Pemasukan: Rp ${summary.totalPemasukan.toLocaleString('id-ID')}
- Total Pengeluaran: Rp ${summary.totalPengeluaran.toLocaleString('id-ID')}
- Saldo Kas Saat Ini (Uang Anda): Rp ${summary.saldoKas.toLocaleString('id-ID')}

10 Transaksi Keuangan Terakhir:
${summary.financeList && summary.financeList.length > 0 
    ? summary.financeList.slice(0, 10).map(f => `- ${f.tipe === 'Pemasukan' ? 'Masuk' : 'Keluar'}: Rp ${f.nominal.toLocaleString('id-ID')} (${f.keterangan})`).join('\n')
    : '(Belum ada catatan keuangan)'}

5 Agenda / Jadwal Terakhir:
${summary.agendaList && summary.agendaList.length > 0
    ? summary.agendaList.slice(0, 5).map(a => `- ${a.waktu}: ${a.acara}`).join('\n')
    : '(Belum ada agenda terjadwal)'}
`.trim();
        }
    } catch (err) {
        console.error('Gagal memproses sheetsContext untuk AI:', err.message);
    }
    
    // Gabungkan memori otomatis dengan berkas basis pengetahuan lain dan data real-time sheets
    const timeString = getCurrentTimeString();
    const currentTimeContext = `[INFORMASI WAKTU SEKARANG]\n- Hari, Tanggal & Jam saat ini: ${timeString}\n- Zona Waktu: UTC+7 (WIB)\n\n`;
    const combinedContext = `${currentTimeContext}[MEMORI PRIBADI BOS]\n${memoryContent}\n\n[DOKUMEN PENDUKUNG]\n${knowledgeContext}\n\n${sheetsContext}`.trim();
    
    // 2. Buat system prompt dari template
    let systemPrompt = config.system_prompt_template.replace('{KNOWLEDGE_BASE_CONTENT}', combinedContext);
    
    // Tambahkan instruksi klasifikasi intent & format output JSON terpadu
    systemPrompt += `\n\n[INSTRUKSI KLASIFIKASI & FORMAT OUTPUT JSON UTAMA (WAJIB DIPATUHI)]
Tugas utama Anda saat ini adalah menganalisis pesan terbaru dari Bos dan mendeteksi tujuannya (intent):
1. finance: Mencatat pemasukan atau pengeluaran uang (misalnya: belanja, gaji, bayar tagihan, dll).
2. reminder: Permintaan dari Bos untuk diingatkan tentang sesuatu pada waktu tertentu (misalnya: "ingatkan saya nanti jam 15:30 untuk jemput anak", "tolong ingatkan besok jam 9 buat laporan").
3. agenda: Mencatat agenda, jadwal, janji, rapat, atau tugas (todos) ke spreadsheet tanpa memerlukan pengingat waktu real-time.
4. chat: Obrolan umum, pertanyaan, diskusi, basa-basi, atau permintaan lainnya.

Keluaran Anda HARUS selalu berupa format JSON bersih sesuai dengan salah satu struktur di bawah ini (JANGAN mengeluarkan teks lain di luar JSON):

Jika intent adalah "finance":
{
  "intent": "finance",
  "data": {
    "type": "Pemasukan" | "Pengeluaran",
    "nominal": <angka nominal uang bulat, integer saja>,
    "keterangan": "<deskripsi singkat tujuan transaksi, max 5 kata>"
  }
}

Jika intent adalah "reminder":
{
  "intent": "reminder",
  "data": {
    "waktu": "<keterangan waktu pengingat dalam bahasa Indonesia, misal: besok 09:00 atau nanti 15:30 atau 18/06 jam 10:00>",
    "pesan": "<pesan yang ingin diingatkan kepada Bos, max 10 kata>"
  }
}

Jika intent adalah "agenda":
{
  "intent": "agenda",
  "data": {
    "waktu": "<waktu/tanggal acara yang dimaksud, gunakan informasi waktu saat ini sebagai acuan>",
    "acara": "<nama acara/kegiatan/tugas, max 5 kata>"
  }
}

Jika intent adalah "chat":
{
  "intent": "chat",
  "reply": "<balasan obrolan Anda yang ramah, sopan, membantu, dan sigap. JANGAN PERNAH menyertakan tabel/ringkasan total keuangan (seperti Total Pemasukan, Total Pengeluaran, Saldo Kas/Sisa Uang) pada bagian reply ini. Cukup jawab pertanyaan Bos secara singkat dan langsung.>"
}

[PANDUAN NOMINAL]
Kenali singkatan nominal uang:
- rb / rebu / k = ribuan (contoh: 50rb / 50k -> 50000)
- jt / juta = jutaan (contoh: 1.5jt -> 1500000)

[PANDUAN PERHITUNGAN TOTAL & NOMINAL]
- JANGAN PERNAH menyertakan ringkasan total keuangan (Total Pemasukan, Total Pengeluaran, Saldo Kas) pada balasan obrolan Anda. Ringkasan saldo dan kas sudah ditangani secara otomatis oleh sistem lokal.
- Jika Bos bertanya tentang transaksi tertentu (misalnya "berapa habis bensin hari ini"), hitunglah hanya berdasarkan daftar [10 Transaksi Keuangan Terakhir] yang tertulis di atas, lalu jawab dengan bahasa alami yang singkat (misal: "Bos menghabiskan Rp 27.000 untuk bensin hari ini berdasarkan transaksi terbaru"). JANGAN melakukan operasi matematika atau penambahan pada angka saldo total.
- Abaikan angka total saldo/pengeluaran/pemasukan yang ada di riwayat percakapan sebelumnya jika nilainya berbeda dengan data real-time saat ini. Data real-time saat ini di atas adalah kebenaran mutlak.

[PANDUAN KEPRIBADIAN & BAHASA]
JANGAN menuliskan proses berpikir (thinking/reasoning process) or menggunakan tag <think>. Jawab secara langsung dalam format JSON di atas.`;

    // Penegasan instruksi memori sebagai Undang-Undang Tertinggi AI (Konstitusi Bot)
    if (memoryContent.trim()) {
        const constitutionHeader = `[UNDANG-UNDANG TERTINGGI AI / KONSTITUSI BOT (MUTLAK & OVERRIDE ALL RULES)]\n` +
                                   `Aturan berikut ditulis langsung oleh Bos Anda dan bersifat MUTLAK. ` +
                                   `Jika ada pertentangan antara panduan kepribadian default asisten di bawah dengan Undang-Undang di bawah ini, Anda WAJIB MENGABAIKAN panduan default dan sepenuhnya mematuhi Undang-Undang Tertinggi berikut:\n` +
                                   `${memoryContent.trim()}\n\n========================================\n\n`;
        
        systemPrompt = constitutionHeader + systemPrompt;
        
        systemPrompt += `\n\n[PENEGASAN KONSTITUSI]\nPENTING: Sebagai asisten yang setia dan patuh, Anda harus menerapkan dan mematuhi seluruh aturan dalam [UNDANG-UNDANG TERTINGGI AI] di atas tanpa pengecualian dalam setiap balasan Anda ke Bos!`;
    }
    
    // 3. Ambil riwayat percakapan untuk chatId
    if (!chatSessions[chatId]) {
        chatSessions[chatId] = { history: [] };
    } else if (Array.isArray(chatSessions[chatId])) {
        chatSessions[chatId] = { history: chatSessions[chatId] };
    } else if (!chatSessions[chatId].history) {
        chatSessions[chatId].history = [];
    }
    const history = chatSessions[chatId].history;
    
    const chatHistory = [];
    const recentHistory = history.slice(-8);
    recentHistory.forEach(msg => {
        chatHistory.push({
            role: msg.role,
            content: msg.content
        });
    });
    
    chatHistory.push({ role: 'user', content: userMessage });
    
    // Panggil AI dengan isJson = true
    const content = await callAiProvider(systemPrompt, chatHistory, true);
    
    let result;
    try {
        result = JSON.parse(content);
    } catch (e) {
        console.warn('Gagal mem-parsing JSON respon terpadu AI, mencoba memulihkan JSON:', e.message);
        
        // Coba perbaiki JSON dengan menambahkan tanda kutip dan penutup jika terpotong
        let parsed = null;
        try {
            let fixedContent = content.trim();
            if (!fixedContent.endsWith('}')) {
                if (fixedContent.endsWith('"')) {
                    fixedContent += '}';
                } else {
                    fixedContent += '"}';
                }
            }
            parsed = JSON.parse(fixedContent);
        } catch (innerErr) {
            // Gagal memperbaiki secara langsung
        }

        if (parsed && parsed.reply) {
            result = parsed;
        } else {
            // Coba gunakan regex untuk mengekstrak isi field "reply"
            const replyMatch = content.match(/"reply"\s*:\s*"([\s\S]*?)"/i) || 
                               content.match(/"reply"\s*:\s*"([\s\S]*?)$/i);
            
            if (replyMatch && replyMatch[1]) {
                let cleanReply = replyMatch[1].trim();
                if (cleanReply.endsWith('"')) {
                    cleanReply = cleanReply.substring(0, cleanReply.length - 1);
                }
                result = {
                    intent: 'chat',
                    reply: cleanReply
                };
            } else {
                // Fallback terakhir: buang kurung kurawal dan tag JSON agar terlihat seperti teks biasa
                let cleanText = content.replace(/\{[\s\S]*?"reply"\s*:\s*"/i, '')
                                      .replace(/"\s*,\s*"intent"[\s\S]*/gi, '')
                                      .replace(/"\s*\}\s*$/g, '')
                                      .trim();
                result = {
                    intent: 'chat',
                    reply: cleanText || content
                };
            }
        }
    }
    
    // Update riwayat percakapan jika intent adalah chat (obrolan umum)
    if (result.intent === 'chat' && result.reply) {
        history.push({ role: 'user', content: userMessage });
        history.push({ role: 'assistant', content: result.reply });
        
        if (history.length > 10) {
            chatSessions[chatId].history = history.slice(-10);
        }
        await saveSessions();
    }
    
    return result;
}

// Fungsi untuk menghasilkan balasan percakapan biasa untuk grup (tanpa JSON intent)
async function generateGroupAiResponse(userMessage, systemPrompt, chatId) {
    if (!chatSessions[chatId]) {
        chatSessions[chatId] = { history: [] };
    }
    const history = chatSessions[chatId].history;
    const chatHistory = [];
    const recentHistory = history.slice(-8);
    recentHistory.forEach(msg => {
        chatHistory.push({
            role: msg.role,
            content: msg.content
        });
    });
    
    chatHistory.push({ role: 'user', content: userMessage });
    
    // Panggil AI provider untuk balasan teks biasa
    const content = await callAiProvider(systemPrompt, chatHistory, false);
    
    // Simpan ke riwayat sesi percakapan
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: content });
    
    if (history.length > 20) {
        chatSessions[chatId].history = history.slice(-10);
    }
    await saveSessions();
    
    return { reply: content };
}

// Fungsi untuk menyimpan ingatan baru ke memori otomatis AI
function appendToMemory(text) {
    const memoryPath = path.join(KNOWLEDGE_DIR, '00_memori_otomatis.txt');
    let content = '';
    if (fs.existsSync(memoryPath)) {
        content = fs.readFileSync(memoryPath, 'utf-8');
    }
    content = content.trim();
    if (content) {
        content += `\n- ${text}`;
    } else {
        content = `- ${text}`;
    }
    fs.writeFileSync(memoryPath, content, 'utf-8');
    io.emit('memory_updated', { content });
}

// Inisialisasi Database
(async () => {
    await initDatabase();
    loadHistory();
    loadSessions();
    loadReminders();
    loadGroupConfigs();
    loadShopData();
})();

// Socket.io Connection Logic
io.on('connection', (socket) => {
    console.log('Dashboard client terhubung ke WebSocket.');
    
    // Kirim status & QR saat ini saat dashboard baru dibuka
    socket.emit('whatsapp_status', { status: currentStatus });
    if (currentQrCode && currentStatus !== 'CONNECTED') {
        socket.emit('qr', currentQrCode);
    }
});

// Mengikat seluruh event listener ke instance client WhatsApp aktif
function attachClientListeners() {
    client.on('qr', (qr) => {
        console.log('\n======================================================');
        console.log('SILAKAN SCAN QR CODE BERIKUT DENGAN APLIKASI WHATSAPP:');
        console.log('======================================================\n');
        qrcode.generate(qr, { small: true });
        
        // Reset flag agar restart berikutnya bisa berjalan
        isRestarting = false;
        if (initWatchdogTimer) { clearTimeout(initWatchdogTimer); initWatchdogTimer = null; }

        currentStatus = 'QR_RECEIVED';
        currentQrCode = qr;
        io.emit('whatsapp_status', { status: currentStatus });
        io.emit('qr', qr);
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`Menginisialisasi WhatsApp: ${percent}% - ${message}`);
        currentStatus = 'INITIALIZING';
        io.emit('whatsapp_status', { status: currentStatus });
    });

    client.on('ready', () => {
        console.log('\n======================================================');
        console.log('Chatbot WhatsApp AI Lokal (Qwen) Berhasil Tersambung!');
        console.log('======================================================\n');

        // Reset flag dan hapus watchdog karena sudah READY
        isRestarting = false;
        if (initWatchdogTimer) { clearTimeout(initWatchdogTimer); initWatchdogTimer = null; }

        currentStatus = 'CONNECTED';
        currentQrCode = null;
        io.emit('whatsapp_status', { status: currentStatus });
        
        syncPinnedHostAdmins();
        // Jalankan sinkronisasi berkala setiap 2 menit
        setInterval(syncPinnedHostAdmins, 120000);
        
        startDailyReportScheduler();
        startReminderScheduler();
        startGroupScheduleScheduler();

        // Kirim notifikasi reconnect jika sebelumnya disconnect
        if (global.wasDisconnected) {
            setTimeout(async () => {
                try {
                    const reconnectMsg = `⚠️ *NOTIFIKASI SISTEM BOT* ⚠️\n\n` +
                                         `Koneksi bot WhatsApp sempat *TERPUTUS* pada *${global.disconnectTime || 'waktu tidak diketahui'}*.\n\n` +
                                         `🟢 Saat ini bot telah *BERHASIL TERHUBUNG KEMBALI* dan aktif merespon obrolan.`;
                    
                    const adminTargets = new Set();
                    const cleanBoss = config.boss_number ? (config.boss_number.replace(/\D/g, '') + '@c.us') : '';
                    if (cleanBoss) adminTargets.add(cleanBoss);
                    (shopData.host_admins || []).forEach(admin => {
                        adminTargets.add(admin.replace(/\D/g, '') + '@c.us');
                    });
                    
                    for (const adminTarget of adminTargets) {
                        try {
                            await client.sendMessage(adminTarget, reconnectMsg);
                        } catch(err) {
                            console.error('Gagal mengirim notifikasi reconnect ke admin:', err.message);
                        }
                    }
                    global.wasDisconnected = false;
                    global.disconnectTime = null;
                } catch(err) {
                    console.error('Gagal memproses notifikasi reconnect:', err.message);
                }
            }, 5000); // Tunggu 5 detik agar client benar-benar stabil
        }
    });

    client.on('disconnected', (reason) => {
        console.log('Koneksi WhatsApp terputus:', reason);
        // Lepas flag saat terputus agar bisa restart lagi
        isRestarting = false;
        currentStatus = 'DISCONNECTED';
        currentQrCode = null;
        io.emit('whatsapp_status', { status: currentStatus });
        
        // Simpan status terputus untuk dikirim saat reconnect nanti
        global.wasDisconnected = true;
        global.disconnectTime = new Date().toLocaleString('id-ID');
    });

    client.on('group_join', async (notification) => {
        try {
            const groupId = notification.chatId;
            const cfg = groupConfigs.group_configs[groupId];
            if (!cfg || !cfg.enabled) return;
            
            const welcomeTemplate = cfg.welcomeMessage || "Halo @user, selamat bergabung! Disini kami menyediakan berbagai apk paket premium yang murah untuk anda. Ketik *list* untuk melihat produk kami.";
            
            // Ambil metadata grup untuk mendapatkan nama tampilan dari profil user itu sendiri
            let groupChat = null;
            try { groupChat = await client.getChatById(groupId); } catch(_) {}
            
            for (const participantId of notification.recipientIds) {
                const contact = await client.getContactById(participantId);
                
                // Prioritas: nama tampilan di grup (bukan nama kontak tersimpan admin)
                let displayName = '';
                if (groupChat && groupChat.participants) {
                    const participant = groupChat.participants.find(p => 
                        p.id && p.id._serialized === participantId
                    );
                    if (participant && participant.name) {
                        displayName = participant.name;
                    }
                }
                // Fallback ke pushname (nama profil publik WhatsApp, bukan kontak tersimpan)
                if (!displayName) {
                    displayName = contact.pushname || '';
                }
                
                const userMentionId = participantId.split('@')[0];
                let userTag = `@${userMentionId}`;
                if (displayName) {
                    userTag = `${displayName}`;
                }
                
                const finalMessage = welcomeTemplate.replace('@user', userTag);
                await client.sendMessage(groupId, finalMessage, {
                    mentions: [contact]
                });
            }
        } catch (err) {
            console.error('Gagal mengirim pesan selamat datang:', err.message);
        }
    });

    client.on('message', handleIncomingMessage);
}

// Variabel & Fungsi Scheduler Laporan Harian Otomatis
let lastSentReportDate = '';

async function sendDailyReport() {
    try {
        if (!config.boss_number || config.boss_number.trim() === '') {
            console.log('[Scheduler] Nomor WhatsApp Bos belum dikonfigurasi. Laporan dibatalkan.');
            return;
        }

        console.log('[Scheduler] Mengambil data Google Sheets untuk laporan harian...');
        const summary = await fetchSheetsSummary(true);
        if (!summary) {
            console.error('[Scheduler] Gagal mengambil ringkasan Google Sheets untuk laporan.');
            return;
        }

        const cleanBoss = config.boss_number.replace(/\D/g, '') + '@c.us';
        
        // Format tanggal hari ini
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Jakarta' };
        const todayStr = new Date().toLocaleDateString('id-ID', options);

        let reportMsg = `💼 *LAPORAN HARIAN ASISTEN PRIBADI* 📊\n`;
        reportMsg += `📅 *Hari/Tanggal*: ${todayStr}\n\n`;
        
        reportMsg += `💰 *Ringkasan Keuangan*:\n`;
        reportMsg += `- *Saldo Kas*: Rp ${summary.saldoKas.toLocaleString('id-ID')}\n`;
        reportMsg += `- *Total Pemasukan*: Rp ${summary.totalPemasukan.toLocaleString('id-ID')}\n`;
        reportMsg += `- *Total Pengeluaran*: Rp ${summary.totalPengeluaran.toLocaleString('id-ID')}\n\n`;

        reportMsg += `📅 *5 Agenda Terdekat*:\n`;
        if (summary.agendaList && summary.agendaList.length > 0) {
            const topAgendas = summary.agendaList.slice(0, 5);
            topAgendas.forEach((agenda, idx) => {
                reportMsg += `${idx + 1}. *${agenda.waktu}*: ${agenda.acara}\n`;
            });
        } else {
            reportMsg += `_(Belum ada agenda terdaftar)_\n`;
        }

        reportMsg += `\nSemoga hari ini berjalan lancar dan penuh keberhasilan, Bos! 🚀`;

        console.log(`[Scheduler] Mengirim laporan harian ke nomor Bos: ${cleanBoss}`);
        await client.sendMessage(cleanBoss, reportMsg);

        // Emit outgoing message log ke dashboard
        io.emit('message_log', {
            chatId: cleanBoss,
            body: `[Laporan Terjadwal Harian] Dikirim otomatis`,
            type: 'outgoing',
            timestamp: Date.now()
        });

    } catch (err) {
        console.error('[Scheduler] Gagal mengirim laporan harian:', err.message);
    }
}

function startDailyReportScheduler() {
    console.log('[Scheduler] Memulai scheduler laporan harian otomatis...');
    setInterval(async () => {
        if (currentStatus !== 'CONNECTED') return;

        const now = new Date();
        // Dapatkan string waktu WIB format "HH:MM"
        const parts = now.toLocaleTimeString('en-US', {
            timeZone: 'Asia/Jakarta',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit'
        }).split(':');
        
        if (parts.length < 2) return;
        const hh = parts[0].padStart(2, '0');
        const mm = parts[1].padStart(2, '0');
        const timeStr = `${hh}:${mm}`;

        // Dapatkan string tanggal WIB format "YYYY-MM-DD"
        const dateStr = now.toLocaleDateString('en-US', {
            timeZone: 'Asia/Jakarta',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });

        const targetTime = config.report_time || '08:00';

        if (timeStr === targetTime && lastSentReportDate !== dateStr) {
            console.log(`[Scheduler] Waktu cocok (${timeStr}), mengirim laporan harian...`);
            lastSentReportDate = dateStr;
            await sendDailyReport();
        }
    }, 30000); // Cek setiap 30 detik
}

const groupOpenStates = new Map();

async function checkGroupSchedules() {
    try {
        if (currentStatus !== 'CONNECTED') return;

        const now = new Date();
        const timeParts = now.toLocaleTimeString('en-US', {
            timeZone: 'Asia/Jakarta',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit'
        }).split(':');
        
        if (timeParts.length < 2) return;
        const timeStr = `${timeParts[0].padStart(2, '0')}:${timeParts[1].padStart(2, '0')}`;

        // Dapatkan nama hari WIB (e.g. "Monday")
        const weekdayStr = now.toLocaleDateString('en-US', {
            timeZone: 'Asia/Jakarta',
            weekday: 'long'
        });

        const dayMap = {
            'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5, 'Saturday': 6, 'Sunday': 7
        };
        const currentDayVal = dayMap[weekdayStr] || now.getDay();

        const groupIds = Object.keys(groupConfigs.group_configs);
        for (const groupId of groupIds) {
            const cfg = groupConfigs.group_configs[groupId];
            if (!cfg || !cfg.enabled || !cfg.autoCloseSchedule || !cfg.autoCloseSchedule.enabled) {
                continue;
            }

            const schedule = cfg.autoCloseSchedule;
            const openTime = schedule.openTime; // "08:00"
            const closeTime = schedule.closeTime; // "17:00"
            const activeDays = schedule.activeDays || []; // [1, 2, 3, 4, 5]

            let shouldBeOpen = true;
            
            if (activeDays.length > 0 && !activeDays.includes(currentDayVal)) {
                shouldBeOpen = false;
            } else {
                if (openTime && closeTime) {
                    if (timeStr < openTime || timeStr >= closeTime) {
                        shouldBeOpen = false;
                    }
                }
            }

            const prevState = groupOpenStates.get(groupId);

            if (prevState !== shouldBeOpen) {
                groupOpenStates.set(groupId, shouldBeOpen);
                
                if (prevState !== undefined) {
                    try {
                        const chat = await client.getChatById(groupId);
                        await chat.setMessagesAdminsOnly(!shouldBeOpen);
                        
                        const msgText = shouldBeOpen 
                            ? "🔔 *Pemberitahuan Otomatis:* Jam operasional toko telah dimulai. Grup dibuka kembali untuk umum. Silakan ajukan pesanan Anda!"
                            : "🔔 *Pemberitahuan Otomatis:* Jam operasional toko telah berakhir. Grup ditutup sementara. Hanya Admin yang dapat mengirim pesan.";
                        
                        await client.sendMessage(groupId, msgText);
                        console.log(`[Scheduler] Status Grup ${cfg.groupName || groupId} diubah ke ${shouldBeOpen ? 'BUKA' : 'TUTUP'}.`);
                    } catch (err) {
                        console.error(`[Scheduler] Gagal mengubah setelan grup ${groupId}:`, err.message);
                    }
                } else {
                    console.log(`[Scheduler] Sinkronisasi awal status Grup ${cfg.groupName || groupId}: ${shouldBeOpen ? 'BUKA' : 'TUTUP'}.`);
                }
            }
        }
    } catch (err) {
        console.error('[Scheduler Error] Gagal memeriksa jadwal grup:', err.message);
    }
}

function startGroupScheduleScheduler() {
    console.log('[Scheduler] Memulai scheduler otomatisasi buka/tutup grup...');
    // Jalankan pengecekan pertama setelah 5 detik startup
    setTimeout(checkGroupSchedules, 5000);
    // Jalankan setiap 60 detik
    setInterval(checkGroupSchedules, 60000);
}



// Helper: Kirim Menu Detail Grup Konfigurasi untuk Host Admin di WA
async function sendGroupDetailMenu(msg, groupId, senderId) {
    const gCfg = groupConfigs.group_configs[groupId];
    if (!gCfg) {
        await msg.reply("⚠️ Konfigurasi grup tidak ditemukan.");
        global.adminMenuStates.delete(senderId);
        return;
    }
    
    const botStatus = gCfg.enabled ? "🟢 AKTIF" : "🔴 NONAKTIF";
    const schedInfo = (gCfg.autoCloseSchedule && gCfg.autoCloseSchedule.enabled)
        ? `🟢 AKTIF (${gCfg.autoCloseSchedule.openTime} - ${gCfg.autoCloseSchedule.closeTime})`
        : "🔴 NONAKTIF";
        
    let detailText = `⚙️ *PENGATURAN GRUP: ${gCfg.groupName || groupId}* ⚙️\n\n` +
                     `🔌 Status Bot: *${botStatus}*\n` +
                     `⏰ Jadwal Otomatis: *${schedInfo}*\n\n` +
                     `Pilih opsi berikut dengan mengetik angkanya:\n\n` +
                     `1️⃣ 🔌 *Toggle Status Bot* (Aktif/Nonaktif)\n` +
                     `2️⃣ 🔓 *Buka Grup* (Manual khusus grup ini)\n` +
                     `3️⃣ 🔒 *Tutup Grup* (Manual khusus grup ini)\n` +
                     `4️⃣ ⏰ *Kelola Jadwal Otomatis*\n` +
                     `5️⃣ ➕ *Tambah Trigger Baru* (Khusus grup ini)\n\n` +
                     `_Ketik *0* untuk kembali ke pilihan grup, atau *batal* untuk keluar._`;
                     
    await msg.reply(detailText);
}

// Helper: Dapatkan emoji status menu (tersedia/habis/pre-order)
function getStatusEmoji(status) {
    if (!status) return '';
    const s = status.trim().toLowerCase();
    if (s === 'tersedia' || s === 'sedia' || s === 'ready') return ' ✅';
    if (s === 'habis' || s === 'kosong' || s === 'tidak tersedia') return ' ❌';
    if (s === 'pre-order' || s === 'preorder' || s === 'po') return ' ⏳';
    return '';
}

// Sesi navigasi menu interaktif anggota di grup
const customerMenuStates = new Map();

// Helper: Cari node di dalam menuTree rekursif
function findNodeById(node, id) {
    if (node.id === id) return node;
    if (node.children && Array.isArray(node.children)) {
        for (const child of node.children) {
            const found = findNodeById(child, id);
            if (found) return found;
        }
    }
    return null;
}

// Helper: Cari node berdasarkan nama (case-insensitive) dan kembalikan node beserta daftar ID parent-nya
function findNodeByName(node, name, parentPath = []) {
    if (node && node.name && node.name.toLowerCase().trim() === name.toLowerCase().trim()) {
        return { node, parentPath };
    }
    if (node && node.children && Array.isArray(node.children)) {
        for (const child of node.children) {
            const path = [...parentPath, node.id];
            const result = findNodeByName(child, name, path);
            if (result) return result;
        }
    }
    return null;
}

// Helper: Dapatkan semua node konten (barang) dari seluruh konfigurasi grup
function getAllContentNodes() {
    const list = [];
    if (!groupConfigs || !groupConfigs.group_configs) return list;
    const groupIds = Object.keys(groupConfigs.group_configs);
    for (const gId of groupIds) {
        const cfg = groupConfigs.group_configs[gId];
        if (!cfg) continue;
        
        const collect = (node, groupName) => {
            if (!node) return;
            if (node.type === 'content') {
                list.push({
                    groupId: gId,
                    groupName,
                    nodeId: node.id,
                    name: node.name,
                    status: node.status || '',
                    text: node.text || '',
                    isPromo: node.isPromo || false
                });
            }
            if (node.children && Array.isArray(node.children)) {
                node.children.forEach(child => collect(child, groupName));
            }
        };
        
        if (cfg.menuTree) {
            collect(cfg.menuTree, cfg.groupName || gId);
        }
    }
    return list;
}

// Helper: Ambil semua node konten yang berstatus Promo dari sebuah grup
function getAllPromoNodes(menuTree, categoryPath) {
    const results = [];
    const path = categoryPath || [];
    const collect = (node, currentPath) => {
        if (node.type === 'content' && node.isPromo === true) {
            results.push({ node, categoryPath: currentPath });
        }
        if (node.children && Array.isArray(node.children)) {
            const childPath = node.type === 'category' && node.id !== 'root'
                ? [...currentPath, node.name]
                : currentPath;
            node.children.forEach(child => collect(child, childPath));
        }
    };
    if (menuTree) collect(menuTree, path);
    return results;
}

// Helper: Render menu untuk grup
function renderGroupMenuMessage(node, cfg = {}) {
    const catEmoji = cfg.categoryEmoji || '📁';
    const conEmoji = cfg.contentEmoji || '📄';
    const showNumber = cfg.enableNumberNavigation !== false;
    
    let msg = '';
    
    // Prepend universal header
    if (cfg.universalHeader && cfg.universalHeader.trim() !== '') {
        msg += `${cfg.universalHeader.trim()}\n\n`;
    }
    
    msg += `${catEmoji} *${node.name}*\n\n`;
    
    // Tampilkan deskripsi kategori jika ada
    if (node.text && node.text.trim() !== '') {
        msg += `${node.text.trim()}\n\n`;
    }
    
    if (node.type === 'category' && node.children && node.children.length > 0) {
        const optionIntro = cfg.categoryFooter || "Silakan pilih menu dengan mengetik angkanya:";
        msg += `${optionIntro}\n\n`;
        
        // Urutkan anak menu berdasarkan abjad A-Z
        const sortedChildren = [...node.children].sort((a, b) => {
            return (a.name || '').localeCompare(b.name || '', 'id', { sensitivity: 'base' });
        });
        
        const numMap = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
        const getNumberEmoji = (num) => {
            return num.toString().split('').map(digit => numMap[parseInt(digit, 10)] || digit).join('');
        };
        
        sortedChildren.forEach((child, index) => {
            const numEmoji = showNumber ? `${getNumberEmoji(index + 1)} ` : '🔹 ';
            const emoji = child.type === 'category' ? catEmoji : (child.isPromo ? '🔥' : conEmoji);
            const statusSuffix = child.type === 'content' ? getStatusEmoji(child.status) : '';
            const promoBadge = child.isPromo ? ' 🔥' : '';
            msg += `${numEmoji}${emoji} *${child.name}*${promoBadge}${statusSuffix}\n`;
        });
        
        // Hanya tampilkan navigasi jika bukan root menu utama
        if (node.id !== 'root') {
            msg += `\n${showNumber ? '0️⃣ ' : '🔙 '}*Kembali ke Menu Sebelumnya*`;
            msg += `\n${showNumber ? '#️⃣ ' : '🏠 '}*Kembali ke Menu Utama*`;
        }
    }
    
    // Append universal footer
    if (cfg.universalFooter && cfg.universalFooter.trim() !== '') {
        msg += `\n\n${cfg.universalFooter.trim()}`;
    }
    
    return msg;
}

// Helper: Tentukan Mime-Type file
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.txt': 'text/plain',
        '.zip': 'application/zip',
        '.rar': 'application/vnd.rar',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.csv': 'text/csv',
        '.json': 'application/json',
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript'
    };
    return mimeMap[ext] || 'application/octet-stream';
}

// Helper: Ambil konten referensi knowledge base spesifik grup
function getGroupKnowledgeContext(allowedFiles) {
    if (!allowedFiles || allowedFiles.length === 0) {
        return 'Gunakan pengetahuan umum lembaga yang ramah.';
    }
    let context = '';
    allowedFiles.forEach(file => {
        const filePath = path.join('./knowledge', file);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            context += `\n[BERKAS: ${file}]\n${content}\n`;
        }
    });
    return context || 'Gunakan pengetahuan umum lembaga yang ramah.';
}

// Main Handler Pesan Masuk
async function handleIncomingMessage(msg) {
    const chatId = msg.from;
    const userMessage = msg.body ? msg.body.trim() : '';

    if (chatId === 'status@broadcast') return;

    const isGroup = msg.isGroupMsg || chatId.includes('@g.us');
    
    // Tentukan apakah pengirim adalah Bos
    const isSenderBoss = (() => {
        if (!config.boss_number || config.boss_number.trim() === '') return true;
        const cleanBoss = config.boss_number.replace(/\D/g, '');
        const sender = msg.author || msg.from;
        const cleanSender = sender.split('@')[0].replace(/\D/g, '');
        return cleanSender === cleanBoss;
    })();

    // Tentukan apakah pengirim adalah Host Admin
    const isSenderHostAdmin = (() => {
        if (isSenderBoss) return true;
        const senderId = msg.author || msg.from;
        const sender = senderId.split('@')[0].replace(/\D/g, '') + '@c.us';
        const senderLid = senderId.split('@')[0].replace(/\D/g, '') + '@lid';
        return (shopData.host_admins || []).some(admin => {
            const cleanAdmin = admin.replace(/\D/g, '');
            return cleanAdmin === sender.split('@')[0] || cleanAdmin === senderLid.split('@')[0];
        });
    })();

    const senderId = msg.author || msg.from;

    // Inisialisasi peta sesi menu admin jika belum ada
    if (!global.adminMenuStates) {
        global.adminMenuStates = new Map();
    }

    const adminSession = global.adminMenuStates.get(senderId);
    const textLower = userMessage.toLowerCase().trim();

    // Cek Pemicu Menu Admin Utama (Hanya di Chat Pribadi)
    if (!isGroup && isSenderHostAdmin && (textLower === '!admin' || textLower === 'admin' || textLower === 'menu admin' || textLower === 'menu' || textLower === 'bantuan' || textLower === 'help')) {
        global.adminMenuStates.set(senderId, { step: 'root', lastActive: Date.now() });
        
        let adminMenuText = `🛡️ *MENU UTAMA HOST ADMIN* 🛡️\n\n` +
                            `Silakan pilih perintah dengan mengetik angkanya:\n\n` +
                            `1️⃣ 👥 *Kelola Konfigurasi Grup WA*\n` +
                            `2️⃣ 🔓 *Buka Toko* (Semua Grup)\n` +
                            `3️⃣ 🔒 *Tutup Toko* (Semua Grup)\n` +
                            `4️⃣ 📦 *Kelola Status Stok Barang*\n` +
                            `5️⃣ 📣 *Kirim Broadcast / Siaran Massal*\n` +
                            `6️⃣ 👥 *Lihat Daftar Pelanggan*\n` +
                            `7️⃣ ➕ *Tambah Trigger Kata Kunci Baru* (Semua Grup)\n` +
                            `8️⃣ 📝 *Update Panduan & Aturan Bot*\n` +
                            `9️⃣ 🛍️ *Tambah Produk ke Menu*\n` +
                            `🔟 ✏️ *Edit / Hapus Produk Menu*\n\n` +
                            `_Ketik *batal* untuk keluar dari menu admin._`;
        
        await msg.reply(adminMenuText);
        return;
    }

    // Jalankan Sesi Menu Admin Aktif (Hanya di Chat Pribadi)
    if (!isGroup && isSenderHostAdmin && adminSession && (Date.now() - adminSession.lastActive < 300000)) {
        adminSession.lastActive = Date.now();
        
        if (textLower === 'batal' || textLower === 'keluar') {
            global.adminMenuStates.delete(senderId);
            await msg.reply("🚪 Keluar dari Menu Host Admin.");
            return;
        }

        if (adminSession.step === 'root') {
            if (userMessage === '1') {
                const groupIds = Object.keys(groupConfigs.group_configs);
                if (groupIds.length === 0) {
                    await msg.reply("⚠️ Belum ada grup WA yang dikonfigurasi.");
                    global.adminMenuStates.delete(senderId);
                    return;
                }
                
                adminSession.step = 'select_group';
                adminSession.groupIds = groupIds;
                
                let listText = `👥 *PILIH GRUP WA UNTUK DIATUR* 👥\n\n` +
                               `Ketik nomor grup yang ingin Anda atur:\n\n`;
                groupIds.forEach((gId, idx) => {
                    const gCfg = groupConfigs.group_configs[gId];
                    listText += `*${idx + 1}*. ${gCfg.groupName || gId}\n`;
                });
                listText += `\n_Ketik *batal* untuk membatalkan._`;
                await msg.reply(listText);
                return;
            } else if (userMessage === '2') {
                let successCount = 0;
                const groupIds = Object.keys(groupConfigs.group_configs);
                for (const gId of groupIds) {
                    try {
                        const chat = await client.getChatById(gId);
                        await chat.setMessagesAdminsOnly(false);
                        await client.sendMessage(gId, "🔔 *Pemberitahuan:* Toko telah dibuka kembali. Grup dibuka untuk umum!");
                        successCount++;
                    } catch (err) {
                        console.error(`Gagal membuka grup ${gId}:`, err.message);
                    }
                }
                global.adminMenuStates.delete(senderId);
                await msg.reply(`🔓 Toko dibuka! Berhasil membuka ${successCount} grup.`);
                return;
            } else if (userMessage === '3') {
                let successCount = 0;
                const groupIds = Object.keys(groupConfigs.group_configs);
                for (const gId of groupIds) {
                    try {
                        const chat = await client.getChatById(gId);
                        await chat.setMessagesAdminsOnly(true);
                        await client.sendMessage(gId, "🔔 *Pemberitahuan:* Toko telah ditutup. Hanya Admin yang dapat mengirim pesan.");
                        successCount++;
                    } catch (err) {
                        console.error(`Gagal menutup grup ${gId}:`, err.message);
                    }
                }
                global.adminMenuStates.delete(senderId);
                await msg.reply(`🔒 Toko ditutup! Berhasil mengunci ${successCount} grup.`);
                return;
            } else if (userMessage === '4') {
                const nodes = getAllContentNodes();
                if (nodes.length === 0) {
                    await msg.reply("⚠️ Belum ada menu barang bertipe Konten di grup.");
                    global.adminMenuStates.delete(senderId);
                    return;
                }
                
                adminSession.step = 'manage_stock';
                adminSession.nodes = nodes;
                
                let replyText = `📦 *KELOLA STATUS STOK BARANG*\n\n` +
                                 `Pilih nomor barang untuk mengubah statusnya:\n\n`;
                nodes.forEach((n, idx) => {
                    const statusEmoji = n.status === 'Tersedia' ? '🟢' : n.status === 'Habis' ? '🔴' : n.status === 'Pre-order' ? '🟡' : '⚪';
                    replyText += `*${idx + 1}*️⃣ ${statusEmoji} *${n.name}* (${n.groupName})\n   Status: ${n.status || 'Belum Diatur'}\n`;
                });
                replyText += `\nFormat ubah: *[nomor] [status]*\n` +
                             `Pilihan status: *Tersedia*, *Habis*, *Pre-order*\n` +
                             `Contoh ketik: *1 Habis* (untuk mengubah barang nomor 1 menjadi Habis).\n\n` +
                             `_Ketik *batal* untuk membatalkan._`;
                
                await msg.reply(replyText);
                return;
            } else if (userMessage === '5') {
                adminSession.step = 'broadcast_input';
                await msg.reply("📣 *KIRIM BROADCAST MASSAL*\n\nSilakan ketik pesan siaran yang ingin dikirimkan ke seluruh grup aktif:\n\n_Ketik *batal* untuk membatalkan._");
                return;
            } else if (userMessage === '6') {
                let replyText = "👥 *DAFTAR PELANGGAN TOKO:*\n\n";
                if (shopData.customers && shopData.customers.length > 0) {
                    shopData.customers.forEach((c, idx) => {
                        replyText += `${idx + 1}. *${c.name}* (${c.phone})\n   Catatan: ${c.notes || '-'}\n`;
                    });
                } else {
                    replyText += "Belum ada pelanggan terdaftar.";
                }
                global.adminMenuStates.delete(senderId);
                await msg.reply(replyText);
                return;
            } else if (userMessage === '7') {
                adminSession.step = 'trigger_input';
                await msg.reply("➕ *TAMBAH TRIGGER KATA KUNCI BARU*\n\nSilakan ketik pemicu dan respon dengan format:\n*[kata_kunci] | [respon_balasan]*\n\nContoh: *alamat | Toko kami berlokasi di Jl. Melati No. 5.*\n\n_Ketik *batal* untuk membatalkan._");
                return;
            } else if (userMessage === '8') {
                const fs = require('fs');
                const path = require('path');
                const memPath = path.join(__dirname, 'knowledge', '00_memori_otomatis.txt');
                let currentMem = '';
                try { currentMem = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8').trim() : '(Kosong)'; } catch(_) {}
                adminSession.step = 'panduan_input';
                await msg.reply(`📝 *UPDATE PANDUAN & ATURAN BOT*\n\nPanduan saat ini:\n_${currentMem || '(Kosong)'}_ \n\nKetik panduan/aturan bot yang baru untuk menggantikannya.\n\nContoh: _Bot ini adalah asisten toko sepatu Bos. Balas dengan ramah, gunakan bahasa santai._\n\n_Ketik *batal* untuk membatalkan._`);
                return;
            } else if (userMessage === '9') {
                const groupIds = Object.keys(groupConfigs.group_configs);
                if (groupIds.length === 0) {
                    await msg.reply("⚠️ Belum ada grup WA yang dikonfigurasi. Tambahkan grup dulu lewat dashboard web.");
                    global.adminMenuStates.delete(senderId);
                    return;
                }
                adminSession.step = 'add_product_select_group';
                adminSession.groupIds = groupIds;
                let listText9 = `🛍️ *TAMBAH PRODUK KE MENU*\n\nPilih grup tujuan dengan mengetik nomornya:\n\n`;
                groupIds.forEach((gId, idx) => {
                    const gCfg = groupConfigs.group_configs[gId];
                    listText9 += `${idx + 1}. ${gCfg.groupName || gId}\n`;
                });
                listText9 += `\n_Ketik *batal* untuk membatalkan._`;
                await msg.reply(listText9);
                return;
            } else if (userMessage === '10') {
                const groupIds = Object.keys(groupConfigs.group_configs);
                if (groupIds.length === 0) {
                    await msg.reply("⚠️ Belum ada grup WA yang dikonfigurasi.");
                    global.adminMenuStates.delete(senderId);
                    return;
                }
                adminSession.step = 'edit_product_select_group';
                adminSession.groupIds = groupIds;
                let listText10 = `✏️ *EDIT / HAPUS PRODUK MENU*\n\nPilih grup yang produknya ingin diedit:\n\n`;
                groupIds.forEach((gId, idx) => {
                    const gCfg = groupConfigs.group_configs[gId];
                    listText10 += `${idx + 1}. ${gCfg.groupName || gId}\n`;
                });
                listText10 += `\n_Ketik *batal* untuk membatalkan._`;
                await msg.reply(listText10);
                return;
            } else {
                await msg.reply("⚠️ Pilihan tidak valid. Silakan ketik angka 1 sampai 10, atau ketik *batal* untuk keluar.");
                return;
            }
        }
        
        if (adminSession.step === 'select_group') {
            const idx = parseInt(userMessage.trim(), 10) - 1;
            const groupIds = adminSession.groupIds || [];
            const targetGroupId = groupIds[idx];
            if (!targetGroupId) {
                await msg.reply(`⚠️ Pilihan tidak valid. Masukkan angka antara 1 sampai ${groupIds.length}.`);
                return;
            }
            
            adminSession.step = 'group_detail';
            adminSession.selectedGroupId = targetGroupId;
            await sendGroupDetailMenu(msg, targetGroupId, senderId);
            return;
        }

        if (adminSession.step === 'group_detail') {
            const selectedGroupId = adminSession.selectedGroupId;
            const gCfg = groupConfigs.group_configs[selectedGroupId];
            if (!gCfg) {
                await msg.reply("⚠️ Grup tidak ditemukan.");
                global.adminMenuStates.delete(senderId);
                return;
            }
            
            if (userMessage === '0') {
                const groupIds = Object.keys(groupConfigs.group_configs);
                adminSession.step = 'select_group';
                adminSession.groupIds = groupIds;
                
                let listText = `👥 *PILIH GRUP WA UNTUK DIATUR* 👥\n\n` +
                               `Ketik nomor grup yang ingin Anda atur:\n\n`;
                groupIds.forEach((gId, idx) => {
                    const cfg = groupConfigs.group_configs[gId];
                    listText += `*${idx + 1}*. ${cfg.groupName || gId}\n`;
                });
                listText += `\n_Ketik *batal* untuk membatalkan._`;
                await msg.reply(listText);
                return;
            }
            
            if (userMessage === '1') {
                gCfg.enabled = !gCfg.enabled;
                saveGroupConfigs();
                io.emit('group_config_updated', { groupId: selectedGroupId });
                await msg.reply(`🔌 Status bot untuk grup *${gCfg.groupName || selectedGroupId}* kini *${gCfg.enabled ? 'AKTIF' : 'NONAKTIF'}*!`);
                await sendGroupDetailMenu(msg, selectedGroupId, senderId);
                return;
            } else if (userMessage === '2') {
                try {
                    const chat = await client.getChatById(selectedGroupId);
                    await chat.setMessagesAdminsOnly(false);
                    await client.sendMessage(selectedGroupId, "🔓 *Pemberitahuan:* Toko telah dibuka kembali. Grup dibuka untuk umum!");
                    await msg.reply("🔓 Berhasil membuka grup manual.");
                } catch(err) {
                    await msg.reply("❌ Gagal membuka grup: " + err.message);
                }
                await sendGroupDetailMenu(msg, selectedGroupId, senderId);
                return;
            } else if (userMessage === '3') {
                try {
                    const chat = await client.getChatById(selectedGroupId);
                    await chat.setMessagesAdminsOnly(true);
                    await client.sendMessage(selectedGroupId, "🔒 *Pemberitahuan:* Toko telah ditutup. Hanya Admin yang dapat mengirim pesan.");
                    await msg.reply("🔒 Berhasil menutup grup manual.");
                } catch(err) {
                    await msg.reply("❌ Gagal menutup grup: " + err.message);
                }
                await sendGroupDetailMenu(msg, selectedGroupId, senderId);
                return;
            } else if (userMessage === '4') {
                adminSession.step = 'group_scheduler_input';
                await msg.reply("⏰ *KELOLA JADWAL OTOMATIS* ⏰\n\nKetik konfigurasi dengan format:\n*[aktif/nonaktif] | [jam_buka] | [jam_tutup]*\n\nContoh: *aktif | 08:00 | 17:00*\nContoh: *nonaktif*\n\n_Ketik *batal* untuk membatalkan._");
                return;
            } else if (userMessage === '5') {
                adminSession.step = 'group_trigger_input';
                await msg.reply("➕ *TAMBAH TRIGGER BARU GRUP* ➕\n\nKetik trigger baru dengan format:\n*[kata_kunci] | [teks_balasan] | [nama_media_opsional]*\n\nContoh: *alamat | Toko kami di Jl. Melati No. 5*\nContoh: *brosur | Unduh brosur terbaru kami | brosur.pdf*\n\n_Ketik *batal* untuk membatalkan._");
                return;
            } else {
                await msg.reply("⚠️ Pilihan tidak valid. Silakan ketik angka 1 sampai 5, atau 0 untuk kembali.");
                return;
            }
        }

        if (adminSession.step === 'group_scheduler_input') {
            const selectedGroupId = adminSession.selectedGroupId;
            const gCfg = groupConfigs.group_configs[selectedGroupId];
            if (!gCfg) {
                await msg.reply("⚠️ Grup tidak ditemukan.");
                global.adminMenuStates.delete(senderId);
                return;
            }
            
            const parts = userMessage.split('|');
            const mode = parts[0].trim().toLowerCase();
            
            if (mode === 'nonaktif' || mode === 'matikan' || mode === 'off') {
                gCfg.autoCloseSchedule = gCfg.autoCloseSchedule || { enabled: false, openTime: '08:00', closeTime: '17:00', activeDays: [1,2,3,4,5] };
                gCfg.autoCloseSchedule.enabled = false;
                saveGroupConfigs();
                io.emit('group_config_updated', { groupId: selectedGroupId });
                await msg.reply("⏰ Jadwal otomatis dinonaktifkan.");
            } else {
                if (parts.length < 3) {
                    await msg.reply("⚠️ Format salah. Gunakan format:\n*aktif | [jam_buka] | [jam_tutup]*\nContoh: *aktif | 08:00 | 17:00*");
                    return;
                }
                const openTime = parts[1].trim();
                const closeTime = parts[2].trim();
                
                gCfg.autoCloseSchedule = gCfg.autoCloseSchedule || { enabled: false, openTime: '08:00', closeTime: '17:00', activeDays: [1,2,3,4,5] };
                gCfg.autoCloseSchedule.enabled = true;
                gCfg.autoCloseSchedule.openTime = openTime;
                gCfg.autoCloseSchedule.closeTime = closeTime;
                saveGroupConfigs();
                io.emit('group_config_updated', { groupId: selectedGroupId });
                await msg.reply(`⏰ Jadwal otomatis diaktifkan (${openTime} - ${closeTime}).`);
            }
            
            adminSession.step = 'group_detail';
            await sendGroupDetailMenu(msg, selectedGroupId, senderId);
            return;
        }
        
        if (adminSession.step === 'group_trigger_input') {
            const selectedGroupId = adminSession.selectedGroupId;
            const gCfg = groupConfigs.group_configs[selectedGroupId];
            if (!gCfg) {
                await msg.reply("⚠️ Grup tidak ditemukan.");
                global.adminMenuStates.delete(senderId);
                return;
            }
            
            const parts = userMessage.split('|');
            if (parts.length < 2) {
                await msg.reply("⚠️ Format salah. Gunakan format:\n*[kata_kunci] | [teks_balasan] | [nama_media_opsional]*");
                return;
            }
            
            const keyword = parts[0].trim();
            const reply = parts[1].trim();
            const media = parts[2] ? parts[2].trim() : '';
            
            gCfg.extraTriggers = gCfg.extraTriggers || [];
            gCfg.extraTriggers = gCfg.extraTriggers.filter(t => t.keyword.toLowerCase().trim() !== keyword.toLowerCase().trim());
            gCfg.extraTriggers.push({ keyword, reply, media });
            saveGroupConfigs();
            io.emit('group_config_updated', { groupId: selectedGroupId });
            
            const mediaInfo = media ? ` dengan media: ${media}` : '';
            await msg.reply(`✅ Berhasil menambahkan trigger *"${keyword}"*${mediaInfo} khusus untuk grup ini.`);
            
            adminSession.step = 'group_detail';
            await sendGroupDetailMenu(msg, selectedGroupId, senderId);
            return;
        }

        if (adminSession.step === 'manage_stock') {
            const parts = userMessage.trim().split(/\s+/);
            if (parts.length < 2) {
                await msg.reply("⚠️ Format salah. Ketik dengan format: *[nomor] [status]*\nContoh: *1 Habis*");
                return;
            }
            
            const index = parseInt(parts[0], 10) - 1;
            const newStatusInput = parts.slice(1).join(' ').trim().toLowerCase();
            
            const validStatuses = {
                'tersedia': 'Tersedia',
                'habis': 'Habis',
                'pre-order': 'Pre-order',
                'preorder': 'Pre-order'
            };
            
            const newStatus = validStatuses[newStatusInput];
            if (!newStatus) {
                await msg.reply("⚠️ Status tidak valid. Pilih antara: *Tersedia*, *Habis*, *Pre-order*");
                return;
            }
            
            const nodes = adminSession.nodes || [];
            const targetNodeInfo = nodes[index];
            if (!targetNodeInfo) {
                await msg.reply(`⚠️ Nomor pilihan tidak valid. Masukkan angka antara 1 sampai ${nodes.length}.`);
                return;
            }
            
            const groupConfig = groupConfigs.group_configs[targetNodeInfo.groupId];
            if (groupConfig && groupConfig.menuTree) {
                const node = findNodeById(groupConfig.menuTree, targetNodeInfo.nodeId);
                if (node) {
                    node.status = newStatus;
                    saveGroupConfigs();
                    io.emit('group_config_updated', { groupId: targetNodeInfo.groupId });
                    global.adminMenuStates.delete(senderId);
                    await msg.reply(`✅ Berhasil mengubah status *${targetNodeInfo.name}* menjadi *${newStatus}*!`);
                    return;
                }
            }
            
            await msg.reply("❌ Gagal memperbarui status menu.");
            global.adminMenuStates.delete(senderId);
            return;
        }
        
        if (adminSession.step === 'broadcast_input') {
            const broadcastText = userMessage.trim();
            const activeGroupIds = Object.keys(groupConfigs.group_configs).filter(id => {
                return groupConfigs.group_configs[id].enabled;
            });
            
            if (activeGroupIds.length === 0) {
                await msg.reply("⚠️ Tidak ada grup aktif untuk dikirimi broadcast.");
                global.adminMenuStates.delete(senderId);
                return;
            }
            
            let successCount = 0;
            for (const gId of activeGroupIds) {
                try {
                    await client.sendMessage(gId, broadcastText);
                    successCount++;
                } catch (err) {
                    console.error(`Gagal mengirim broadcast admin ke ${gId}:`, err.message);
                }
            }
            
            global.adminMenuStates.delete(senderId);
            await msg.reply(`📣 Broadcast massal berhasil terkirim ke ${successCount} dari ${activeGroupIds.length} grup aktif!`);
            return;
        }
        
        if (adminSession.step === 'trigger_input') {
            const parts = userMessage.split('|');
            if (parts.length < 2) {
                await msg.reply("⚠️ Format salah. Gunakan tanda pembatas pipa (|).\nContoh: *alamat | Jl. Melati No. 5*");
                return;
            }
            
            const keyword = parts[0].trim();
            const reply = parts.slice(1).join('|').trim();
            
            if (!keyword || !reply) {
                await msg.reply("⚠️ Kata kunci dan respon balasan tidak boleh kosong!");
                return;
            }
            
            const groupIds = Object.keys(groupConfigs.group_configs);
            let updateCount = 0;
            for (const gId of groupIds) {
                const gCfg = groupConfigs.group_configs[gId];
                if (gCfg) {
                    gCfg.extraTriggers = gCfg.extraTriggers || [];
                    gCfg.extraTriggers = gCfg.extraTriggers.filter(t => t.keyword.toLowerCase().trim() !== keyword.toLowerCase().trim());
                    gCfg.extraTriggers.push({ keyword, reply });
                    updateCount++;
                }
            }
            
            saveGroupConfigs();
            io.emit('group_config_updated', {});
            global.adminMenuStates.delete(senderId);
            await msg.reply(`✅ Berhasil menambahkan trigger kata kunci *"${keyword}"* ke ${updateCount} grup!`);
            return;
        }

        if (adminSession.step === 'panduan_input') {
            const newPanduan = userMessage.trim();
            const fsM = require('fs');
            const pathM = require('path');
            const memPath = pathM.join(__dirname, 'knowledge', '00_memori_otomatis.txt');
            try {
                fsM.writeFileSync(memPath, newPanduan, 'utf-8');
                io.emit('memory_updated', {});
                global.adminMenuStates.delete(senderId);
                await msg.reply(`✅ *Panduan & Aturan Bot berhasil diperbarui!*\n\nPanduan baru:\n_${newPanduan}_`);
            } catch(err) {
                await msg.reply(`❌ Gagal menyimpan panduan: ${err.message}`);
                global.adminMenuStates.delete(senderId);
            }
            return;
        }

        // =================== ALUR TAMBAH PRODUK BARU ===================
        if (adminSession.step === 'add_product_select_group') {
            const idx = parseInt(userMessage.trim(), 10) - 1;
            const groupIds = adminSession.groupIds || [];
            const targetGroupId = groupIds[idx];
            if (!targetGroupId) {
                await msg.reply(`⚠️ Pilihan tidak valid. Masukkan angka 1 sampai ${groupIds.length}.`);
                return;
            }
            adminSession.selectedGroupId = targetGroupId;
            const gCfg = groupConfigs.group_configs[targetGroupId];
            const menuTree = gCfg.menuTree || { children: [] };

            // Kumpulkan semua kategori yang ada
            const categories = [];
            const collectCats = (node) => {
                if (node.type === 'category') {
                    categories.push({ id: node.id, name: node.name, ref: node });
                    if (node.children) node.children.forEach(collectCats);
                }
            };
            collectCats(menuTree);
            adminSession.categories = categories;

            let catText = `📂 *PILIH KATEGORI*\n\nKetik nomor kategori tujuan produk baru:\n\n`;
            categories.forEach((c, i) => { catText += `${i + 1}. ${c.name}\n`; });
            catText += `${categories.length + 1}. ➕ *Buat Kategori Baru*\n\n_Ketik *batal* untuk membatalkan._`;
            adminSession.step = 'add_product_select_cat';
            await msg.reply(catText);
            return;
        }

        if (adminSession.step === 'add_product_select_cat') {
            const categories = adminSession.categories || [];
            const idx = parseInt(userMessage.trim(), 10) - 1;

            if (idx === categories.length) {
                // Buat kategori baru
                adminSession.step = 'add_product_new_cat_name';
                await msg.reply(`📂 *BUAT KATEGORI BARU*\n\nKetik nama kategori baru:\n\n_Ketik *batal* untuk membatalkan._`);
                return;
            }

            if (!categories[idx]) {
                await msg.reply(`⚠️ Pilihan tidak valid. Masukkan angka 1 sampai ${categories.length + 1}.`);
                return;
            }
            adminSession.selectedCatId = categories[idx].id;
            adminSession.step = 'add_product_name';
            await msg.reply(`✏️ *NAMA PRODUK*\n\nKetik nama produk yang ingin ditambahkan:\n\n_Ketik *batal* untuk membatalkan._`);
            return;
        }

        if (adminSession.step === 'add_product_new_cat_name') {
            const newCatName = userMessage.trim();
            if (!newCatName) {
                await msg.reply('⚠️ Nama kategori tidak boleh kosong.');
                return;
            }
            const newCatId = 'cat_' + Date.now();
            const newCatNode = { id: newCatId, name: newCatName, type: 'category', text: '', children: [] };
            const gCfg = groupConfigs.group_configs[adminSession.selectedGroupId];
            gCfg.menuTree = gCfg.menuTree || { id: 'root', name: 'Menu Utama', type: 'category', text: '', children: [] };
            gCfg.menuTree.children = gCfg.menuTree.children || [];
            gCfg.menuTree.children.push(newCatNode);
            saveGroupConfigs();
            io.emit('group_config_updated', { groupId: adminSession.selectedGroupId });
            adminSession.selectedCatId = newCatId;
            adminSession.step = 'add_product_name';
            await msg.reply(`✅ Kategori *${newCatName}* berhasil dibuat!\n\n✏️ *NAMA PRODUK*\n\nKetik nama produk yang ingin ditambahkan:\n\n_Ketik *batal* untuk membatalkan._`);
            return;
        }

        if (adminSession.step === 'add_product_name') {
            adminSession.newProduct = { name: userMessage.trim() };
            adminSession.step = 'add_product_desc';
            await msg.reply(`📝 *DESKRIPSI / ISI PRODUK*\n\nKetik deskripsi lengkap produk *${adminSession.newProduct.name}*:\n_(Bisa gunakan format WA: *tebal*, _miring_, ~coret~)_\n\n_Ketik *batal* untuk membatalkan._`);
            return;
        }

        if (adminSession.step === 'add_product_desc') {
            adminSession.newProduct.text = userMessage.trim();
            adminSession.step = 'add_product_status';
            await msg.reply(`📊 *STATUS KETERSEDIAAN*\n\nKetik status produk *${adminSession.newProduct.name}*:\n\n1. ✅ Tersedia\n2. ❌ Habis\n3. ⏳ Pre-order\n\n_Ketik *batal* untuk membatalkan._`);
            return;
        }

        if (adminSession.step === 'add_product_status') {
            const statusMap = { '1': 'Tersedia', '2': 'Habis', '3': 'Pre-order', 'tersedia': 'Tersedia', 'habis': 'Habis', 'pre-order': 'Pre-order', 'preorder': 'Pre-order' };
            const status = statusMap[userMessage.trim().toLowerCase()];
            if (!status) {
                await msg.reply('⚠️ Pilihan tidak valid. Ketik 1 (Tersedia), 2 (Habis), atau 3 (Pre-order).');
                return;
            }
            adminSession.newProduct.status = status;
            adminSession.step = 'add_product_promo';
            await msg.reply(`🔥 *PROMO SPESIAL?*\n\nApakah produk *${adminSession.newProduct.name}* merupakan promo spesial?\n\n1. Ya — tandai sebagai 🔥 Promo\n2. Tidak\n\n_Ketik *batal* untuk membatalkan._`);
            return;
        }

        if (adminSession.step === 'add_product_promo') {
            const isPromoMap = { '1': true, 'ya': true, 'yes': true, 'y': true, '2': false, 'tidak': false, 'no': false, 'n': false };
            const isPromo = isPromoMap[userMessage.trim().toLowerCase()];
            if (isPromo === undefined) {
                await msg.reply('⚠️ Ketik 1 (Ya) atau 2 (Tidak).');
                return;
            }
            adminSession.newProduct.isPromo = isPromo;

            const p = adminSession.newProduct;
            const promoStr = isPromo ? '🔥 Ya' : 'Tidak';
            const statusEmoji = { 'Tersedia': '✅', 'Habis': '❌', 'Pre-order': '⏳' }[p.status] || '';
            const confirmText = `📋 *KONFIRMASI PRODUK BARU*\n\n` +
                `*Nama:* ${p.name}\n` +
                `*Status:* ${statusEmoji} ${p.status}\n` +
                `*Promo:* ${promoStr}\n` +
                `*Deskripsi:*\n${p.text}\n\n` +
                `Ketik *simpan* untuk menyimpan, atau *batal* untuk membatalkan.`;
            adminSession.step = 'add_product_confirm';
            await msg.reply(confirmText);
            return;
        }

        if (adminSession.step === 'add_product_confirm') {
            if (textLower !== 'simpan') {
                await msg.reply('❌ Penambahan produk dibatalkan.');
                global.adminMenuStates.delete(senderId);
                return;
            }
            const p = adminSession.newProduct;
            const newProductNode = {
                id: 'prod_' + Date.now(),
                name: p.name,
                type: 'content',
                text: p.text,
                status: p.status,
                isPromo: p.isPromo || false,
                media: ''
            };
            const gCfg = groupConfigs.group_configs[adminSession.selectedGroupId];
            const catNode = findNodeById(gCfg.menuTree, adminSession.selectedCatId);
            if (!catNode) {
                await msg.reply('❌ Kategori tidak ditemukan. Silakan coba lagi dari awal.');
                global.adminMenuStates.delete(senderId);
                return;
            }
            catNode.children = catNode.children || [];
            catNode.children.push(newProductNode);
            saveGroupConfigs();
            io.emit('group_config_updated', { groupId: adminSession.selectedGroupId });
            global.adminMenuStates.delete(senderId);
            await msg.reply(`✅ *Produk berhasil ditambahkan!*\n\n🛍️ *${p.name}* telah masuk ke menu grup *${gCfg.groupName || adminSession.selectedGroupId}*.\n\nPelanggan bisa lihat dengan mengetik *list* di grup.`);
            return;
        }
        // ================================================================

        // =================== ALUR EDIT / HAPUS PRODUK ===================
        if (adminSession.step === 'edit_product_select_group') {
            const idx = parseInt(userMessage.trim(), 10) - 1;
            const groupIds = adminSession.groupIds || [];
            const targetGroupId = groupIds[idx];
            if (!targetGroupId) { await msg.reply(`⚠️ Pilihan tidak valid. Masukkan angka 1 sampai ${groupIds.length}.`); return; }
            adminSession.selectedGroupId = targetGroupId;
            const gCfg = groupConfigs.group_configs[targetGroupId];

            // Kumpulkan semua produk (konten)
            const allProducts = getAllContentNodes().filter(n => n.groupId === targetGroupId);
            if (allProducts.length === 0) {
                await msg.reply('⚠️ Belum ada produk di grup ini. Tambah produk dulu dengan opsi 9.');
                global.adminMenuStates.delete(senderId);
                return;
            }
            adminSession.editProducts = allProducts;

            const numMap = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
            const getN = (n) => n.toString().split('').map(d => numMap[parseInt(d,10)]||d).join('');
            const stEmoji = (s) => s==='Tersedia'?'✅':s==='Habis'?'❌':s==='Pre-order'?'⏳':'❔';

            let prodList = `✏️ *DAFTAR PRODUK — ${gCfg.groupName || targetGroupId}*\n\nKetik nomor produk yang ingin diedit:\n\n`;
            allProducts.forEach((p, i) => {
                const promo = p.isPromo ? ' 🔥' : '';
                prodList += `${getN(i+1)} *${p.name}*${promo} ${stEmoji(p.status)}\n`;
            });
            prodList += `\n_Ketik *batal* untuk membatalkan._`;
            adminSession.step = 'edit_product_pick';
            await msg.reply(prodList);
            return;
        }

        if (adminSession.step === 'edit_product_pick') {
            const idx = parseInt(userMessage.trim(), 10) - 1;
            const allProducts = adminSession.editProducts || [];
            if (!allProducts[idx]) { await msg.reply(`⚠️ Pilihan tidak valid. Masukkan angka 1 sampai ${allProducts.length}.`); return; }
            adminSession.editTargetProduct = allProducts[idx];
            const p = allProducts[idx];
            const stEmoji = (s) => s==='Tersedia'?'✅':s==='Habis'?'❌':s==='Pre-order'?'⏳':'❔';
            const detail = `✏️ *${p.name}* ${p.isPromo?'🔥':''} ${stEmoji(p.status)}\n\n_${p.text ? p.text.substring(0,120)+'...' : '(kosong)'}_\n\nPilih yang ingin diedit:\n\n1️⃣ Ubah Nama\n2️⃣ Ubah Deskripsi / Konten\n3️⃣ Ubah Status Ketersediaan\n4️⃣ Toggle Promo (${p.isPromo ? 'Promo AKTIF → Nonaktifkan' : 'Promo NONAKTIF → Aktifkan'})\n5️⃣ Hapus Produk Ini\n\n0️⃣ Kembali ke Daftar Produk\n\n_Ketik *batal* untuk keluar._`;
            adminSession.step = 'edit_product_action';
            await msg.reply(detail);
            return;
        }

        if (adminSession.step === 'edit_product_action') {
            const p = adminSession.editTargetProduct;
            const gCfg = groupConfigs.group_configs[adminSession.selectedGroupId];
            const node = findNodeById(gCfg.menuTree, p.nodeId);

            if (userMessage === '0') {
                // Kembali ke daftar
                adminSession.step = 'edit_product_select_group';
                adminSession.groupIds = [adminSession.selectedGroupId];
                const allProducts = getAllContentNodes().filter(n => n.groupId === adminSession.selectedGroupId);
                adminSession.editProducts = allProducts;
                const numMap = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
                const getN = (n) => n.toString().split('').map(d => numMap[parseInt(d,10)]||d).join('');
                const stEmoji = (s) => s==='Tersedia'?'✅':s==='Habis'?'❌':s==='Pre-order'?'⏳':'❔';
                let prodList = `✏️ *DAFTAR PRODUK*\n\nKetik nomor produk yang ingin diedit:\n\n`;
                allProducts.forEach((pr, i) => prodList += `${getN(i+1)} *${pr.name}* ${stEmoji(pr.status)}${pr.isPromo?' 🔥':''}\n`);
                prodList += `\n_Ketik *batal* untuk membatalkan._`;
                adminSession.step = 'edit_product_pick';
                await msg.reply(prodList);
                return;
            }

            if (!node) { await msg.reply('❌ Produk tidak ditemukan di pohon menu. Mungkin sudah dihapus.'); global.adminMenuStates.delete(senderId); return; }

            if (userMessage === '1') {
                adminSession.editAction = 'name';
                adminSession.step = 'edit_product_input';
                await msg.reply(`✏️ *UBAH NAMA PRODUK*\n\nNama saat ini: *${node.name}*\n\nKetik nama baru:\n\n_Ketik *batal* untuk membatalkan._`);
                return;
            } else if (userMessage === '2') {
                adminSession.editAction = 'text';
                adminSession.step = 'edit_product_input';
                await msg.reply(`📝 *UBAH DESKRIPSI PRODUK*\n\nDeskripsi saat ini:\n_${node.text || '(kosong)'}_\n\nKetik deskripsi baru (bisa pakai format WA: *tebal*, _miring_, ~coret~):\n\n_Ketik *batal* untuk membatalkan._`);
                return;
            } else if (userMessage === '3') {
                adminSession.editAction = 'status';
                adminSession.step = 'edit_product_input';
                const cur = node.status || 'Tersedia';
                await msg.reply(`📊 *UBAH STATUS PRODUK*\n\nStatus saat ini: *${cur}*\n\n1. ✅ Tersedia\n2. ❌ Habis\n3. ⏳ Pre-order\n\n_Ketik *batal* untuk membatalkan._`);
                return;
            } else if (userMessage === '4') {
                // Toggle promo langsung
                node.isPromo = !node.isPromo;
                saveGroupConfigs();
                io.emit('group_config_updated', { groupId: adminSession.selectedGroupId });
                const state = node.isPromo ? '🔥 *AKTIF*' : '❌ *NONAKTIF*';
                await msg.reply(`✅ Promo untuk *${node.name}* sekarang ${state}!`);
                // Kembali ke menu edit produk ini
                adminSession.editTargetProduct.isPromo = node.isPromo;
                adminSession.step = 'edit_product_pick';
                // reload pick
                const allProducts2 = getAllContentNodes().filter(n => n.groupId === adminSession.selectedGroupId);
                adminSession.editProducts = allProducts2;
                const numMap2 = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
                const getN2 = (n) => n.toString().split('').map(d => numMap2[parseInt(d,10)]||d).join('');
                const st2 = (s) => s==='Tersedia'?'✅':s==='Habis'?'❌':s==='Pre-order'?'⏳':'❔';
                let prodList2 = `✏️ *DAFTAR PRODUK* (diperbarui)\n\nKetik nomor produk yang ingin diedit:\n\n`;
                allProducts2.forEach((pr, i) => prodList2 += `${getN2(i+1)} *${pr.name}* ${st2(pr.status)}${pr.isPromo?' 🔥':''}\n`);
                prodList2 += `\n_Ketik *batal* untuk membatalkan._`;
                await msg.reply(prodList2);
                return;
            } else if (userMessage === '5') {
                adminSession.editAction = 'delete';
                adminSession.step = 'edit_product_input';
                await msg.reply(`🗑️ *HAPUS PRODUK*\n\nAnda yakin ingin menghapus *${node.name}*?\n\nKetik *hapus* untuk konfirmasi, atau *batal* untuk membatalkan.`);
                return;
            } else {
                await msg.reply('⚠️ Pilihan tidak valid. Ketik 1-5 atau 0 untuk kembali.');
                return;
            }
        }

        if (adminSession.step === 'edit_product_input') {
            const p = adminSession.editTargetProduct;
            const gCfg = groupConfigs.group_configs[adminSession.selectedGroupId];
            const node = findNodeById(gCfg.menuTree, p.nodeId);
            if (!node) { await msg.reply('❌ Produk tidak ditemukan.'); global.adminMenuStates.delete(senderId); return; }

            if (adminSession.editAction === 'name') {
                const oldName = node.name;
                node.name = userMessage.trim();
                saveGroupConfigs();
                io.emit('group_config_updated', { groupId: adminSession.selectedGroupId });
                global.adminMenuStates.delete(senderId);
                await msg.reply(`✅ Nama produk berhasil diubah!\n\n*${oldName}* → *${node.name}*`);
                return;
            } else if (adminSession.editAction === 'text') {
                node.text = userMessage.trim();
                saveGroupConfigs();
                io.emit('group_config_updated', { groupId: adminSession.selectedGroupId });
                global.adminMenuStates.delete(senderId);
                await msg.reply(`✅ Deskripsi produk *${node.name}* berhasil diperbarui!`);
                return;
            } else if (adminSession.editAction === 'status') {
                const statusMap = { '1': 'Tersedia', '2': 'Habis', '3': 'Pre-order', 'tersedia': 'Tersedia', 'habis': 'Habis', 'pre-order': 'Pre-order', 'preorder': 'Pre-order' };
                const newStatus = statusMap[userMessage.trim().toLowerCase()];
                if (!newStatus) { await msg.reply('⚠️ Pilihan tidak valid. Ketik 1, 2, atau 3.'); return; }
                const oldStatus = node.status;
                node.status = newStatus;
                saveGroupConfigs();
                io.emit('group_config_updated', { groupId: adminSession.selectedGroupId });
                global.adminMenuStates.delete(senderId);
                const stEmoji = (s) => s==='Tersedia'?'✅':s==='Habis'?'❌':s==='Pre-order'?'⏳':'❔';
                await msg.reply(`✅ Status *${node.name}* diubah: ${stEmoji(oldStatus)} ${oldStatus} → ${stEmoji(newStatus)} *${newStatus}*`);
                return;
            } else if (adminSession.editAction === 'delete') {
                if (textLower !== 'hapus') { await msg.reply('❌ Penghapusan dibatalkan.'); global.adminMenuStates.delete(senderId); return; }
                // Cari parent dan hapus node dari children
                const deleteNode = (tree, targetId) => {
                    if (!tree.children) return false;
                    const idx = tree.children.findIndex(c => c.id === targetId);
                    if (idx >= 0) { tree.children.splice(idx, 1); return true; }
                    return tree.children.some(c => deleteNode(c, targetId));
                };
                const deleted = deleteNode(gCfg.menuTree, p.nodeId);
                if (deleted) {
                    saveGroupConfigs();
                    io.emit('group_config_updated', { groupId: adminSession.selectedGroupId });
                    global.adminMenuStates.delete(senderId);
                    await msg.reply(`🗑️ Produk *${p.name}* berhasil dihapus dari menu.`);
                } else {
                    await msg.reply('❌ Gagal menghapus produk.');
                    global.adminMenuStates.delete(senderId);
                }
                return;
            }
        }
        // ================================================================
    }

    if (!isGroup) {
        // Chat pribadi diabaikan untuk obrolan umum (hanya memproses menu admin di atas)
        return;
    } else {
        // JIKA CHAT GRUP
        const groupId = chatId;
        const cfg = groupConfigs.group_configs[groupId];
        const senderId = msg.author || msg.from;
        const cleanBoss = config.boss_number ? (config.boss_number.replace(/\D/g, '') + '@c.us') : '';

        // Tentukan apakah pengirim adalah Host Admin
        const isSenderHostAdmin = (() => {
            if (isSenderBoss) return true;
            const sender = senderId.split('@')[0].replace(/\D/g, '') + '@c.us';
            const senderLid = senderId.split('@')[0].replace(/\D/g, '') + '@lid';
            return (shopData.host_admins || []).some(admin => {
                const cleanAdmin = admin.replace(/\D/g, '');
                return cleanAdmin === sender.split('@')[0] || cleanAdmin === senderLid.split('@')[0];
            });
        })();

        // Intersepsi perintah Host Admin (di Grup)
        if (isSenderHostAdmin && (userMessage.startsWith('!') || userMessage.startsWith('.'))) {
            const cmd = userMessage.toLowerCase().trim();
            
            // .buka atau !toko buka
            if (cmd === '.buka' || cmd === '!toko buka') {
                try {
                    const chat = await client.getChatById(groupId);
                    await chat.setMessagesAdminsOnly(false);
                    await msg.reply("🔓 *Pemberitahuan:* Toko telah dibuka kembali. Grup dibuka untuk umum!");
                } catch (err) {
                    await msg.reply("❌ Gagal membuka grup: " + err.message);
                }
                return;
            }
            
            // .tutup atau !toko tutup
            if (cmd === '.tutup' || cmd === '!toko tutup') {
                try {
                    const chat = await client.getChatById(groupId);
                    await chat.setMessagesAdminsOnly(true);
                    await msg.reply("🔒 *Pemberitahuan:* Toko telah ditutup. Hanya Admin yang dapat mengirim pesan.");
                } catch (err) {
                    await msg.reply("❌ Gagal menutup grup: " + err.message);
                }
                return;
            }
            
            // .kick
            if (cmd === '.kick') {
                if (msg.hasQuotedMsg) {
                    try {
                        const quotedMsg = await msg.getQuotedMessage();
                        const participantId = quotedMsg.author || quotedMsg.from;
                        const chat = await msg.getChat();
                        await chat.removeParticipants([participantId]);
                        await msg.reply(`✅ Berhasil mengeluarkan user @${participantId.split('@')[0]} dari grup.`, null, {
                            mentions: [participantId]
                        });
                    } catch(err) {
                        await msg.reply("❌ Gagal mengeluarkan anggota: " + err.message);
                    }
                } else {
                    await msg.reply("⚠️ Balas/quote salah satu pesan anggota yang ingin di-kick dengan mengetik *.kick*");
                }
                return;
            }
            
            // .proses & .done (Invoice)
            if (cmd === '.proses' || cmd === '.done') {
                if (msg.hasQuotedMsg) {
                    try {
                        const quotedMsg = await msg.getQuotedMessage();
                        const customerId = quotedMsg.author || quotedMsg.from;
                        const contact = await client.getContactById(customerId);
                        const customerName = contact.pushname || contact.name || `Pelanggan`;
                        
                        const statusVal = cmd === '.proses' ? '🔴 PROSES' : '🟢 DONE';
                        const invoiceId = 'INV-' + Date.now().toString().substring(6);
                        
                        const invoiceText = `📄 *INVOICE PEMBAYARAN* 📄\n\n` +
                                            `*No Invoice:* ${invoiceId}\n` +
                                            `*Nama Pelanggan:* ${customerName} (@${customerId.split('@')[0]})\n` +
                                            `*Status:* *${statusVal}*\n` +
                                            `*Tanggal:* ${new Date().toLocaleDateString('id-ID')}\n\n` +
                                            `_Pesanan Anda sedang diproses oleh admin. Harap tunggu info selanjutnya._`;
                                            
                        await quotedMsg.reply(invoiceText, null, {
                            mentions: [customerId]
                        });
                    } catch(err) {
                        await msg.reply("❌ Gagal memproses invoice: " + err.message);
                    }
                } else {
                    await msg.reply("⚠️ Balas/quote pesan bukti pembayaran dari pelanggan dengan mengetik *.proses* atau *.done*");
                }
                return;
            }
            
            // .promote & .demote
            if (cmd === '.promote' || cmd === '.demote') {
                if (msg.hasQuotedMsg) {
                    try {
                        const quotedMsg = await msg.getQuotedMessage();
                        const participantId = quotedMsg.author || quotedMsg.from;
                        const chat = await msg.getChat();
                        if (cmd === '.promote') {
                            await chat.promoteParticipants([participantId]);
                            await msg.reply(`✅ Berhasil menjadikan @${participantId.split('@')[0]} sebagai Admin.`, null, { mentions: [participantId] });
                        } else {
                            await chat.demoteParticipants([participantId]);
                            await msg.reply(`✅ Berhasil mencopot jabatan Admin dari @${participantId.split('@')[0]}.`, null, { mentions: [participantId] });
                        }
                    } catch(err) {
                        await msg.reply("❌ Gagal merubah jabatan admin: " + err.message);
                    }
                } else {
                    await msg.reply(`⚠️ Balas/quote pesan anggota dengan mengetik *${cmd}*`);
                }
                return;
            }

            if (cmd === '!bot on') {
                if (!groupConfigs.group_configs[groupId]) {
                    groupConfigs.group_configs[groupId] = {
                        groupName: groupId,
                        enabled: true,
                        useAiFallback: true,
                        triggerPrefix: '',
                        allowedKnowledgeFiles: [],
                        categoryFooter: 'Silakan pilih menu dengan mengetik angkanya:',
                        contentFooter: 'Ketik *0* untuk kembali ke menu sebelumnya, atau *#* untuk kembali ke menu utama.',
                        menuTree: { id: "root", name: "Menu Utama", type: "category", text: "Silakan pilih salah satu opsi di bawah ini:", children: [] }
                    };
                } else {
                    groupConfigs.group_configs[groupId].enabled = true;
                }
                saveGroupConfigs();
                await msg.reply("✅ *Bot Diaktifkan:* Bot WhatsApp sekarang aktif merespons di grup ini.");
                return;
            } else if (cmd === '!bot off') {
                if (groupConfigs.group_configs[groupId]) {
                    groupConfigs.group_configs[groupId].enabled = false;
                    saveGroupConfigs();
                }
                await msg.reply("⚠️ *Bot Dinonaktifkan:* Bot WhatsApp berhenti merespons di grup ini.");
                return;
            } else if (cmd === '!pelanggan') {
                let replyText = "👥 *Daftar Pelanggan Toko:*\n\n";
                if (shopData.customers && shopData.customers.length > 0) {
                    shopData.customers.forEach((c, idx) => {
                        replyText += `${idx + 1}. *${c.name}* (${c.phone})\n   Catatan: ${c.notes || '-'}\n`;
                    });
                } else {
                    replyText += "Belum ada pelanggan terdaftar.";
                }
                await msg.reply(replyText);
                return;
            }
        }
        
        // Abaikan grup jika tidak terdaftar atau dinonaktifkan
        if (!cfg || !cfg.enabled) {
            return;
        }

        // Tambahkan pengirim ke daftar pelanggan jika belum terdaftar
        const senderPhone = senderId.split('@')[0];
        const customerExists = (shopData.customers || []).some(c => c.phone.replace(/\D/g, '') === senderPhone);
        if (!customerExists && !isSenderHostAdmin && senderId !== 'status@broadcast') {
            try {
                const contact = await msg.getContact();
                const customerName = contact.pushname || contact.name || `Pelanggan ${senderPhone}`;
                shopData.customers = shopData.customers || [];
                shopData.customers.push({
                    name: customerName,
                    phone: senderPhone,
                    notes: 'Ditambahkan otomatis oleh interaksi bot',
                    orderCount: 0
                });
                saveShopData();
            } catch (err) {
                console.error('Gagal merekam data pelanggan otomatis:', err.message);
            }
        }

        // Deteksi pesan pesanan/pembelian dan beri notifikasi ke Host Admin
        const orderKeywords = /\b(beli|pesan|order|daftar|payment|transfer|cod|harga|pembayaran|list|checkout|boking|booking)\b/i;
        if (orderKeywords.test(userMessage) && !isSenderHostAdmin && senderId !== 'status@broadcast') {
            try {
                const contact = await msg.getContact();
                const customerName = contact.pushname || contact.name || `Pelanggan ${senderPhone}`;
                const notifyText = `🔔 *Notifikasi Pesanan Masuk Baru!*\n\n` +
                                   `*Pelanggan:* ${customerName} (wa.me/${senderPhone})\n` +
                                   `*Grup:* ${cfg.groupName || groupId}\n` +
                                   `*Pesan:* "${userMessage}"`;
                
                const adminTargets = new Set();
                if (cleanBoss) adminTargets.add(cleanBoss);
                (shopData.host_admins || []).forEach(admin => {
                    adminTargets.add(admin.replace(/\D/g, '') + '@c.us');
                });

                for (const adminTarget of adminTargets) {
                    try {
                        await client.sendMessage(adminTarget, notifyText);
                    } catch (err) {
                        console.error(`Gagal mengirim notifikasi pesanan ke ${adminTarget}:`, err.message);
                    }
                }
            } catch (err) {
                console.error('Gagal memproses notifikasi pesanan otomatis:', err.message);
            }
        }
        
        const sessionKey = `${groupId}_${senderId}`;
        const text = userMessage.toLowerCase().trim();
        
        // Tentukan command pemicu menu berdasarkan konfigurasi grup
        const isTrigger = cfg.triggerPrefix ? 
            (text === cfg.triggerPrefix.toLowerCase()) : 
            (['menu', 'bantuan', 'help', '/menu', '#menu', '#'].includes(text));
            
        if (isTrigger) {
            // Inisialisasi/Reset sesi menu untuk anggota ini
            customerMenuStates.set(sessionKey, {
                currentNodeId: 'root',
                parentIds: [],
                lastActive: Date.now()
            });
            
            const rootNode = cfg.menuTree || { id: "root", name: "Menu Utama", type: "category", children: [] };
            const replyMsg = renderGroupMenuMessage(rootNode, cfg);
            await msg.reply(replyMsg);
            
            io.emit('message_log', {
                chatId: groupId,
                body: `[Menu Utama dikirim ke ${senderId.split('@')[0]}]`,
                type: 'outgoing',
                timestamp: Date.now()
            });
            return;
        }

        // ---- PROMO TRIGGER: ketik "promo", "promosi", "diskon", "sale" ----
        const promoKeywords = ['promo', 'promosi', 'diskon', 'sale', 'promo spesial', 'daftar promo'];
        if (promoKeywords.includes(text)) {
            const promoNodes = getAllPromoNodes(cfg.menuTree);

            if (promoNodes.length === 0) {
                await msg.reply(
                    `🔍 *Tidak ada promo aktif saat ini.*\n\n` +
                    `_Pantau terus! Promo spesial akan segera hadir._ 🔔`
                );
                return;
            }

            // Urutkan A-Z per nama produk
            promoNodes.sort((a, b) => (a.node.name || '').localeCompare(b.node.name || '', 'id', { sensitivity: 'base' }));

            const numMap = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
            const getNumEmoji = (n) => n.toString().split('').map(d => numMap[parseInt(d,10)] || d).join('');
            const statusEmoji = (s) => s === 'Tersedia' ? '✅' : s === 'Habis' ? '❌' : s === 'Pre-order' ? '⏳' : '❔';

            let promoText = `🔥 *PROMO SPESIAL* 🔥\n`;
            promoText += `━━━━━━━━━━━━━━━━━━━━\n`;
            promoText += `✨ Penawaran terbatas — jangan sampai ketinggalan!\n`;
            promoText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

            promoNodes.forEach(({ node, categoryPath }, idx) => {
                const catLabel = categoryPath && categoryPath.length > 0
                    ? `_[${categoryPath.join(' › ')}]_\n   `
                    : '';
                promoText += `${getNumEmoji(idx + 1)} 🔥 *${node.name}* ${statusEmoji(node.status)}\n`;
                if (catLabel) promoText += `   ${catLabel}\n`;
            });

            promoText += `\n━━━━━━━━━━━━━━━━━━━━\n`;
            promoText += `📌 Ketik *nama produk* untuk detail & harga promo!\n`;
            promoText += `🛒 Hubungi admin untuk order sekarang.`;

            await msg.reply(promoText);

            io.emit('message_log', {
                chatId: groupId,
                body: `[Daftar Promo dikirim ke ${senderId.split('@')[0]}]`,
                type: 'outgoing',
                timestamp: Date.now()
            });
            return;
        }
        // ---------------------------------------------------------------
        
        // Cek pencocokan nama menu secara langsung (Direct Menu Name Trigger)
        const matchResult = findNodeByName(cfg.menuTree || { id: "root", name: "Menu Utama", type: "category", children: [] }, userMessage);
        
        if (matchResult) {
            const { node: matchedNode, parentPath } = matchResult;
            
            // Inisialisasi atau perbarui sesi menu untuk navigasi berikutnya
            customerMenuStates.set(sessionKey, {
                currentNodeId: matchedNode.type === 'category' ? matchedNode.id : parentPath[parentPath.length - 1] || 'root',
                parentIds: matchedNode.type === 'category' ? parentPath : parentPath.slice(0, -1),
                lastActive: Date.now()
            });
            
            if (matchedNode.type === 'category') {
                const replyMsg = renderGroupMenuMessage(matchedNode, cfg);
                await msg.reply(replyMsg);
            } else {
                const conEmoji = matchedNode.isPromo ? '🔥' : (cfg.contentEmoji || '📄');
                const statusSuffix = getStatusEmoji(matchedNode.status);
                const promoHeader = matchedNode.isPromo ? `⚠️ *PROMO SPESIAL HARI INI!* ⚠️\n\n` : '';
                let replyText = `${conEmoji} *${matchedNode.name}*${statusSuffix}\n\n${promoHeader}${matchedNode.text}`;
                const footerText = cfg.contentFooter || `_Ketik *0* untuk kembali ke menu sebelumnya, atau *#* untuk kembali ke menu utama._`;
                replyText += `\n\n${footerText}`;
                
                await msg.reply(replyText);
                
                if (matchedNode.media && matchedNode.media.trim() !== '') {
                    const mediaPath = path.join('./media', matchedNode.media.trim());
                    if (fs.existsSync(mediaPath)) {
                        const fileData = fs.readFileSync(mediaPath);
                        const base64Data = fileData.toString('base64');
                        const mimeType = getMimeType(mediaPath);
                        const mediaObj = new MessageMedia(mimeType, base64Data, path.basename(mediaPath));
                        await client.sendMessage(groupId, mediaObj, { quotedMessageId: msg.id._serialized });
                    }
                }
            }
            
            io.emit('message_log', {
                chatId: groupId,
                body: `[Direct Match: ${matchedNode.name}]`,
                type: 'outgoing',
                timestamp: Date.now()
            });
            return;
        }

        // Cek jika mencocokkan kata kunci tambahan (extraTriggers)
        if (cfg.extraTriggers && Array.isArray(cfg.extraTriggers)) {
            const matchedTrigger = cfg.extraTriggers.find(t => {
                if (!t.keyword) return false;
                const kw = t.keyword.toLowerCase().trim();
                return text === kw;
            });

            if (matchedTrigger) {
                await msg.reply(matchedTrigger.reply);
                
                if (matchedTrigger.media && matchedTrigger.media.trim() !== '') {
                    const mediaPath = path.join('./media', matchedTrigger.media.trim());
                    if (fs.existsSync(mediaPath)) {
                        try {
                            const fileData = fs.readFileSync(mediaPath);
                            const base64Data = fileData.toString('base64');
                            const mimeType = getMimeType(mediaPath);
                            const mediaObj = new MessageMedia(mimeType, base64Data, path.basename(mediaPath));
                            await client.sendMessage(groupId, mediaObj);
                        } catch(err) {
                            console.error('Gagal mengirim media extra trigger:', err.message);
                        }
                    }
                }
                
                io.emit('message_log', {
                    chatId: groupId,
                    body: `[Extra Trigger: ${matchedTrigger.keyword}]`,
                    type: 'outgoing',
                    timestamp: Date.now()
                });
                return;
            }
        }
        
        // Cek jika ada sesi menu aktif (berlaku 2 menit)
        const session = customerMenuStates.get(sessionKey);
        const isSessionActive = session && (Date.now() - session.lastActive < 120000);
        
        if (isSessionActive) {
            session.lastActive = Date.now();
            
            if (text === '0') {
                // Kembali ke menu sebelumnya
                if (session.parentIds.length > 0) {
                    const parentId = session.parentIds.pop();
                    session.currentNodeId = parentId;
                } else {
                    session.currentNodeId = 'root';
                }
                
                const currentNode = findNodeById(cfg.menuTree, session.currentNodeId) || cfg.menuTree;
                const replyMsg = renderGroupMenuMessage(currentNode, cfg);
                await msg.reply(replyMsg);
                return;
            }
            
            if (text === '#') {
                // Kembali ke menu utama
                session.currentNodeId = 'root';
                session.parentIds = [];
                
                const replyMsg = renderGroupMenuMessage(cfg.menuTree, cfg);
                await msg.reply(replyMsg);
                return;
            }
            
            // Coba urai angka pilihan (hanya jika navigasi angka aktif)
            if (cfg.enableNumberNavigation !== false) {
                const choiceIndex = parseInt(text, 10) - 1;
                const currentNode = findNodeById(cfg.menuTree, session.currentNodeId) || cfg.menuTree;
                
                if (currentNode && currentNode.children) {
                    // Urutkan anak menu berdasarkan abjad A-Z agar sesuai dengan tampilan list
                    const sortedChildren = [...currentNode.children].sort((a, b) => {
                        return (a.name || '').localeCompare(b.name || '', 'id', { sensitivity: 'base' });
                    });

                    if (choiceIndex >= 0 && choiceIndex < sortedChildren.length) {
                        const chosenNode = sortedChildren[choiceIndex];
                        
                        if (chosenNode.type === 'category') {
                            // Masuk sub-menu
                            session.parentIds.push(session.currentNodeId);
                            session.currentNodeId = chosenNode.id;
                            
                            const replyMsg = renderGroupMenuMessage(chosenNode, cfg);
                            await msg.reply(replyMsg);
                        } else {
                            // Leaf Node: Kirim konten teks + media
                            const conEmoji = chosenNode.isPromo ? '🔥' : (cfg.contentEmoji || '📄');
                            const statusSuffix = getStatusEmoji(chosenNode.status);
                            const promoHeader = chosenNode.isPromo ? `⚠️ *PROMO SPESIAL HARI INI!* ⚠️\n\n` : '';
                            let replyText = `${conEmoji} *${chosenNode.name}*${statusSuffix}\n\n${promoHeader}${chosenNode.text}`;
                            const footerText = cfg.contentFooter || `_Ketik *0* untuk kembali ke menu sebelumnya, atau *#* untuk kembali ke menu utama._`;
                            replyText += `\n\n${footerText}`;
                            
                            await msg.reply(replyText);
                            
                            if (chosenNode.media && chosenNode.media.trim() !== '') {
                                const mediaPath = path.join('./media', chosenNode.media.trim());
                                if (fs.existsSync(mediaPath)) {
                                    const fileData = fs.readFileSync(mediaPath);
                                    const base64Data = fileData.toString('base64');
                                    const mimeType = getMimeType(mediaPath);
                                    const mediaObj = new MessageMedia(mimeType, base64Data, path.basename(mediaPath));
                                    await client.sendMessage(groupId, mediaObj, { quotedMessageId: msg.id._serialized });
                                }
                            }
                        }
                        return;
                    } else {
                        if (/^\d+$/.test(text)) {
                            await msg.reply(`⚠️ Pilihan tidak valid. Silakan ketik angka (1-${sortedChildren.length}), ketik *0* untuk kembali, atau *#* untuk ke menu utama.`);
                            return;
                        }
                    }
                }
            }
        }
        
        // AI Fallback khusus grup dinonaktifkan agar di grup hanya merespon list menu dan kata kunci
        return;
    }

    // --- MEKANISME PROCESSING LOCK (ANTI OVERLOAD RAM) ---
    if (activeLocks.has(chatId)) {
        console.log(`[Lock Active] Mengabaikan pesan dari ${chatId} karena pesan sebelumnya sedang diproses.`);
        try {
            await msg.react('⏳');
        } catch (e) {
            // Abaikan
        }
        return;
    }

    // Emit incoming message ke dashboard
    io.emit('message_log', {
        chatId,
        body: userMessage || '[Berkas Media/Foto]',
        type: 'incoming',
        timestamp: Date.now()
    });

    // 1. PENANGANAN MEDIA (DOKUMEN & FOTO/GAMBAR)
    if (msg.hasMedia) {
        activeLocks.add(chatId);
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        
        try {
            const media = await msg.downloadMedia();
            if (!media) {
                await msg.reply('❌ Maaf Bos, gagal mengunduh berkas media.');
                activeLocks.delete(chatId);
                return;
            }
            
            // A. Penanganan Dokumen PDF
            if (media.mimetype === 'application/pdf') {
                await msg.reply('📄 Dokumen PDF diterima! Sedang mengekstrak teks dan menganalisis, mohon tunggu...');
                const buffer = Buffer.from(media.data, 'base64');
                const pdfData = await pdfParse(buffer);
                const docText = pdfData.text.trim();
                
                if (!docText) {
                    await msg.reply('❌ Maaf Bos, tidak ada teks yang terbaca di dalam dokumen PDF tersebut.');
                    activeLocks.delete(chatId);
                    return;
                }
                
                const prompt = `Bos mengirimkan berkas dokumen PDF dengan nama "${media.filename || 'Dokumen'}". Berikut adalah isi teks dokumen tersebut:\n"""\n${docText}\n"""\n\n[INSTRUKSI/PERTANYAAN BOS]: ${userMessage || 'Tolong ringkas isi dokumen di atas.'}`;
                const result = await generateUnifiedAiResponse(prompt, chatId);
                const aiReply = result.reply || result.content || 'Gagal memproses dokumen.';
                await msg.reply(aiReply);
                
                io.emit('message_log', {
                    chatId,
                    body: `[Dokumen PDF diproses] Ringkasan dikirim`,
                    type: 'outgoing',
                    timestamp: Date.now()
                });
            }
            // B. Penanganan Dokumen Teks (TXT)
            else if (media.mimetype === 'text/plain') {
                await msg.reply('📄 Berkas teks diterima! Sedang membaca berkas, mohon tunggu...');
                const docText = Buffer.from(media.data, 'base64').toString('utf-8').trim();
                
                if (!docText) {
                    await msg.reply('❌ Maaf Bos, berkas teks tersebut kosong.');
                    activeLocks.delete(chatId);
                    return;
                }
                
                const prompt = `Bos mengirimkan berkas teks dengan nama "${media.filename || 'Dokumen'}". Berikut adalah isi berkas tersebut:\n"""\n${docText}\n"""\n\n[INSTRUKSI/PERTANYAAN BOS]: ${userMessage || 'Tolong ringkas isi berkas di atas.'}`;
                const result = await generateUnifiedAiResponse(prompt, chatId);
                const aiReply = result.reply || result.content || 'Gagal memproses berkas.';
                await msg.reply(aiReply);
                
                io.emit('message_log', {
                    chatId,
                    body: `[Berkas teks diproses] Jawaban dikirim`,
                    type: 'outgoing',
                    timestamp: Date.now()
                });
            }
            // C. Penanganan Foto / Gambar
            else if (media.mimetype.startsWith('image/')) {
                await msg.reply('📸 Foto diterima! Sedang memproses dengan OCR lokal dan analisis, mohon tunggu...');
                const buffer = Buffer.from(media.data, 'base64');
                
                // Jalankan OCR
                const ocrText = await performOCR(buffer);
                console.log('--- HASIL OCR TEKS ---');
                console.log(ocrText);
                
                if (!ocrText.trim()) {
                    await msg.reply('❌ Maaf Bos, tidak terdeteksi teks tulisan di dalam foto tersebut.');
                    activeLocks.delete(chatId);
                    return;
                }
                
                // 1. Deteksi kuitansi menggunakan algoritma lokal (0 token!) [DINONAKTIFKAN jika FITUR_KEUANGAN=false]
                const isReceipt = FITUR_KEUANGAN && isReceiptText(ocrText);
                console.log('[Local Classifier]: isReceipt =', isReceipt);
                
                if (isReceipt) {
                    // Hanya gunakan AI untuk mengekstrak nominal & keterangan jika algoritma lokal mendeteksi struk
                    const extracted = await extractReceiptDetails(ocrText);
                    
                    if (extracted.nominal > 0) {
                        // Simpan ke pending state untuk konfirmasi pencatatan keuangan
                        pendingTransactions.set(chatId, {
                            intent: 'finance',
                            type: 'Pengeluaran',
                            nominal: extracted.nominal,
                            keterangan: extracted.keterangan || 'Catatan Struk'
                        });
                        
                        await msg.reply(`🤖 *Terdeteksi Struk Belanja/Transaksi*:\n- Tipe: *Pengeluaran*\n- Nominal: *Rp ${extracted.nominal.toLocaleString('id-ID')}*\n- Keterangan: *${extracted.keterangan}*\n\nApakah data ini ingin disimpan ke Google Spreadsheet?\n👉 Balas *YA* untuk menyimpan atau *TIDAK* untuk membatalkannya.`);
                        
                        io.emit('message_log', {
                            chatId,
                            body: `Struk terdeteksi - Menunggu konfirmasi: Rp ${extracted.nominal.toLocaleString('id-ID')} untuk ${extracted.keterangan}`,
                            type: 'outgoing',
                            timestamp: Date.now()
                        });
                        activeLocks.delete(chatId);
                        return;
                    }
                }
                
                // 2. Jika bukan kuitansi (atau gagal ekstrak nominal), respon sebagai foto biasa (bacakan/proses teks)
                const prompt = `Bos mengirimkan sebuah foto. Hasil pembacaan teks (OCR) pada foto tersebut:\n"""\n${ocrText}\n"""\n\n[INSTRUKSI/PERTANYAAN BOS]: ${userMessage || 'Tolong bacakan atau ringkas teks pada foto di atas.'}`;
                const result = await generateUnifiedAiResponse(prompt, chatId);
                const aiReply = result.reply || result.content || 'Gagal menganalisis foto.';
                await msg.reply(aiReply);
                
                io.emit('message_log', {
                    chatId,
                    body: `[Foto OCR diproses] Jawaban dikirim`,
                    type: 'outgoing',
                    timestamp: Date.now()
                });
            }
            // D. Media lainnya yang tidak didukung
            else {
                await msg.reply('❌ Maaf Bos, format berkas ini belum didukung. Silakan kirimkan dokumen dalam format PDF/TXT, atau gambar dalam format foto/screenshot.');
            }
        } catch (err) {
            console.error('Gagal membaca media:', err.message);
            await msg.reply(`❌ Terjadi kesalahan saat membaca berkas media: ${err.message}`);
        } finally {
            activeLocks.delete(chatId);
        }
        return;
    }

    // Interupsi Pintasan: Jika ada pending transaksi tapi user mengirim perintah baru, batalkan pendingnya
    const isCommand = 
        userMessage.startsWith('+') || 
        userMessage.startsWith('-') || 
        userMessage.toLowerCase().startsWith('masuk') || 
        userMessage.toLowerCase().startsWith('keluar') || 
        userMessage.toLowerCase().startsWith('#agenda') || 
        userMessage.toLowerCase().startsWith('#akubosmu') || 
        userMessage.toLowerCase().startsWith('#jadwallaporan') ||
        userMessage.toLowerCase().startsWith('#ingatkan') ||
        userMessage === '!reload' ||
        ['help', 'bantuan', 'menu', '#bantuan', '/help'].includes(userMessage.toLowerCase().trim());

    if (isCommand && pendingTransactions.has(chatId)) {
        console.log(`[Command Interrupt] Membatalkan pending transaksi karena mendeteksi perintah/pintasan baru.`);
        pendingTransactions.delete(chatId);
    }

    // 2. PENANGANAN KONFIRMASI TRANSAKSI PENDING (YA/TIDAK)
    if (FITUR_KEUANGAN && pendingTransactions.has(chatId)) {
        activeLocks.add(chatId);
        const pending = pendingTransactions.get(chatId);
        const replyText = userMessage.toLowerCase().trim();
        
        if (replyText === 'ya' || replyText === 'yes' || replyText === 'y') {
            try {
                if (pending.intent === 'agenda') {
                    // Simpan agenda
                    await sendToGoogleSheets({
                        action: 'add_agenda',
                        waktu: pending.waktu,
                        acara: pending.acara
                    });
                    
                    // Simpan ke log lokal dan update dashboard
                    addHistoryLog('agenda', {
                        waktu: pending.waktu,
                        acara: pending.acara
                    });
                    
                    const successMsg = `✅ Agenda berhasil dijadwalkan Bos!\n\n📅 *Detail Agenda*:\n- Waktu: ${pending.waktu}\n- Acara: ${pending.acara}`;
                    await msg.reply(successMsg);
                    
                    io.emit('message_log', {
                        chatId,
                        body: `Disimpan ke Sheets: ${pending.waktu} - ${pending.acara}`,
                        type: 'outgoing',
                        timestamp: Date.now()
                    });
                } else {
                    // Simpan keuangan
                    await sendToGoogleSheets({
                        action: 'add_finance',
                        type: pending.type,
                        nominal: pending.nominal,
                        keterangan: pending.keterangan
                    });
                    
                    // Simpan ke log lokal dan update dashboard
                    addHistoryLog('finance', {
                        tipe: pending.type,
                        nominal: pending.nominal,
                        keterangan: pending.keterangan
                    });
                    
                    // Ambil saldo kas terbaru secara real-time
                    const summary = await fetchSheetsSummary(true);
                    const saldoStr = summary ? `Rp ${summary.saldoKas.toLocaleString('id-ID')}` : 'Tidak diketahui';
                    
                    const successMsg = `✅ Data berhasil disimpan ke Google Spreadsheet Bos!\n\n📋 *Arus Kas Terdaftar*:\n- Tipe: ${pending.type}\n- Nominal: Rp ${pending.nominal.toLocaleString('id-ID')}\n- Keterangan: ${pending.keterangan}\n\n💼 *Saldo Kas Terbaru*: *${saldoStr}*`;
                    await msg.reply(successMsg);
                    
                    io.emit('message_log', {
                        chatId,
                        body: `Disimpan ke Sheets: Rp ${pending.nominal.toLocaleString('id-ID')} (${pending.keterangan})`,
                        type: 'outgoing',
                        timestamp: Date.now()
                    });
                }
                pendingTransactions.delete(chatId);
            } catch (err) {
                console.error('Gagal menyimpan data pending ke Sheets:', err.message);
                await msg.reply(`❌ Gagal menyimpan data ke Google Sheets: ${err.message}`);
            }
        } else if (replyText === 'tidak' || replyText === 'no' || replyText === 't') {
            pendingTransactions.delete(chatId);
            await msg.reply('❌ Pencatatan dibatalkan Bos.');
            
            io.emit('message_log', {
                chatId,
                body: `Pencatatan dibatalkan oleh pengguna`,
                type: 'outgoing',
                timestamp: Date.now()
            });
        } else {
            await msg.reply('⚠️ Mohon balas dengan *YA* untuk menyimpan data ini, atau *TIDAK* untuk membatalkannya.');
        }
        activeLocks.delete(chatId);
        return;
    }

    // 3. ADMIN TOOLS COMMANDS (RELOAD / RESET)
    if (userMessage === '!reload') {
        console.log(`[Admin Command] Melakukan pemindaian ulang folder knowledge...`);
        await msg.reply('✅ File basis pengetahuan berhasil dimuat ulang di server.');
        io.emit('message_log', {
            chatId,
            body: '!reload (Admin Command)',
            type: 'system-cmd',
            timestamp: Date.now()
        });
        return;
    }

    // 3.5. TRIGGER MEMORI OTOMATIS (#akubosmu)
    if (userMessage.toLowerCase().startsWith('#akubosmu')) {
        const memoryText = userMessage.substring('#akubosmu'.length).trim();
        if (!memoryText) {
            await msg.reply('❌ Memori tidak boleh kosong Bos. Contoh: #akubosmu Sandi wifi kantor adalah "admin123"');
            return;
        }
        
        activeLocks.add(chatId);
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        
        try {
            appendToMemory(memoryText);
            const replyMsg = `✅ Memori berhasil disimpan, Bos!\n\n🧠 *Memori Baru*:\n"${memoryText}"\n\nSaya akan mengingat hal ini dalam tugas-tugas saya.`;
            await msg.reply(replyMsg);
            
            io.emit('message_log', {
                chatId,
                body: `Memori disimpan: "${memoryText}"`,
                type: 'outgoing',
                timestamp: Date.now()
            });
        } catch (err) {
            console.error('Gagal menyimpan memori otomatis:', err.message);
            await msg.reply(`❌ Gagal menyimpan memori: ${err.message}`);
        } finally {
            activeLocks.delete(chatId);
        }
        return;
    }

    // 3.5.5. UBAH JADWAL LAPORAN HARIAN (#jadwallaporan)
    if (userMessage.toLowerCase().startsWith('#jadwallaporan')) {
        const timeInput = userMessage.substring('#jadwallaporan'.length).trim();
        const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
        
        if (!timeRegex.test(timeInput)) {
            await msg.reply('❌ Format waktu salah Bos. Harap gunakan format HH:MM (24 jam). Contoh: *#jadwallaporan 17:00*');
            return;
        }

        activeLocks.add(chatId);
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        
        try {
            config.report_time = timeInput;
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
            
            const replyMsg = `✅ Jadwal laporan harian berhasil diubah, Bos!\n\n🕒 *Waktu Baru*: *${timeInput} WIB*\n\nLaporan berikutnya akan dikirim otomatis setiap hari pada jam tersebut.`;
            await msg.reply(replyMsg);
            
            io.emit('message_log', {
                chatId,
                body: `Jadwal laporan diubah ke ${timeInput} WIB`,
                type: 'outgoing',
                timestamp: Date.now()
            });
        } catch (err) {
            console.error('Gagal memperbarui jadwal laporan via WA:', err.message);
            await msg.reply(`❌ Gagal memperbarui jadwal: ${err.message}`);
        } finally {
            activeLocks.delete(chatId);
        }
        return;
    }

    // 3.5.7. PENANGANAN PINTASAN PENGINGAT (#ingatkan)
    if (userMessage.toLowerCase().startsWith('#ingatkan')) {
        const content = userMessage.substring('#ingatkan'.length).trim();
        let timePart = '';
        let messagePart = '';

        const parts = content.split('|');
        if (parts.length >= 2) {
            timePart = parts[0].trim();
            messagePart = parts.slice(1).join('|').trim();
        } else {
            await msg.reply('❌ Format salah Bos. Gunakan format: *#ingatkan [waktu] | [keterangan]*\nContoh: *#ingatkan jam 15:30 | Telepon Klien*');
            return;
        }

        const targetDate = parseReminderTime(timePart);
        if (!targetDate) {
            await msg.reply('❌ Gagal membaca format waktu Bos. Contoh waktu yang didukung:\n- *15:30* (hari ini)\n- *besok 09:00*\n- *lusa 10:00*\n- *20/06 jam 14:00*');
            return;
        }

        activeLocks.add(chatId);
        const chat = await msg.getChat();
        await chat.sendStateTyping();

        try {
            const newReminder = {
                id: Date.now().toString(),
                chatId: chatId,
                time: targetDate.toISOString(),
                message: messagePart,
                sent: false
            };

            reminders.push(newReminder);
            saveReminders();

            const formattedTime = targetDate.toLocaleString('id-ID', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Jakarta'
            }) + ' WIB';

            const replyMsg = `✅ Pengingat berhasil dijadwalkan, Bos!\n\n🔔 *Detail Pengingat*:\n- *Pengingat*: ${messagePart}\n- *Waktu*: ${formattedTime}\n\nSaya akan mengirim pesan WhatsApp kepada Bos secara otomatis pada waktu tersebut.`;
            await msg.reply(replyMsg);

            io.emit('message_log', {
                chatId,
                body: `Menjadwalkan Pengingat: "${messagePart}" untuk ${formattedTime}`,
                type: 'outgoing',
                timestamp: Date.now()
            });
        } catch (err) {
            console.error('Gagal menambahkan pengingat:', err.message);
            await msg.reply(`❌ Gagal menambahkan pengingat: ${err.message}`);
        } finally {
            activeLocks.delete(chatId);
        }
        return;
    }

    // 3.6. MANUAL BANTUAN / PETUNJUK PENGGUNAAN
    const helpKeywords = ['help', 'bantuan', 'menu', '#bantuan', '/help'];
    if (helpKeywords.includes(userMessage.toLowerCase().trim())) {
        activeLocks.add(chatId);
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        
        const helpMsg = `💼 *Asisten Manager Pribadi*
Halo Bos! Saya siap membantu mencatat Keuangan & Agenda Anda ke Google Spreadsheet.

👉 *Bahasa Alami (Tanpa Template)*:
Ketik obrolan seperti biasa, AI akan mendeteksi otomatis!
- Contoh: *"kemarin bayar listrik 150rb"*
- Contoh: *"tolong jadwalkan rapat besok jam 10 pagi"*
(Setelah mengetik, cukup balas *YA* untuk mengonfirmasi)

👉 *Pintasan Catat Keuangan*:
- Pemasukan: \`+ [nominal] [keterangan]\` atau \`masuk [nominal] [keterangan]\`
- Pengeluaran: \`- [nominal] [keterangan]\` atau \`keluar [nominal] [keterangan]\`
- Contoh: \`+ 100rb Uang proyek\` atau \`- 25k Beli bensin\`
(Mendukung nominal singkatan: rb / k / jt)

👉 *Pintasan Catat Agenda*:
- Format: \`#agenda [waktu] | [nama acara]\`
- Contoh: \`#agenda Besok jam 10 pagi | Rapat Direksi\`

👉 *Membaca Foto Kuitansi*:
- Cukup kirim foto kuitansi/nota belanja ke sini. Saya akan mengekstrak total nominal dan tujuan belanjanya secara otomatis!

👉 *Trigger Memori*:
- Format: \`#akubosmu [informasi]\`
- Contoh: \`#akubosmu Sandi wifi kantor adalah "admin123"\`
(Saya akan mengingat fakta ini untuk menjawab pertanyaan Anda nantinya)

👉 *Mengatur Jadwal Laporan*:
- Format: \`#jadwallaporan [HH:MM]\`
- Contoh: \`#jadwallaporan 20:00\`
(Untuk mengatur waktu pengiriman laporan harian otomatis kapan saja)

👉 *Pintasan Buat Pengingat*:
- Format: \`#ingatkan [waktu] | [keterangan]\`
- Contoh: \`#ingatkan besok jam 09:00 | Bayar gaji karyawan\`
(Untuk membuat pengingat WhatsApp otomatis kapan saja)`;

        await msg.reply(helpMsg);
        
        io.emit('message_log', {
            chatId,
            body: helpMsg,
            type: 'outgoing',
            timestamp: Date.now()
        });
        activeLocks.delete(chatId);
        return;
    }

    // 4. PENANGANAN PENCATATAN KEUANGAN TEKS (TEMPLATE PINTASAN) [DINONAKTIFKAN jika FITUR_KEUANGAN=false]
    const shortcut = FITUR_KEUANGAN ? parseShortcutMessage(userMessage) : null;
    if (shortcut) {
        if (shortcut.nominal <= 0) {
            await msg.reply('❌ Nominal uang tidak valid. Pastikan formatnya benar (contoh: 50rb, 1.5jt, 250000).');
            return;
        }

        activeLocks.add(chatId);
        const chat = await msg.getChat();
        await chat.sendStateTyping();

        try {
            await sendToGoogleSheets({
                action: 'add_finance',
                type: shortcut.type,
                nominal: shortcut.nominal,
                keterangan: shortcut.keterangan
            });

            // Simpan ke log lokal dan update dashboard
            addHistoryLog('finance', {
                tipe: shortcut.type,
                nominal: shortcut.nominal,
                keterangan: shortcut.keterangan
            });

            // Ambil saldo kas terbaru secara real-time
            const summary = await fetchSheetsSummary(true);
            const saldoStr = summary ? `Rp ${summary.saldoKas.toLocaleString('id-ID')}` : 'Tidak diketahui';

            const successMsg = `✅ Berhasil dicatat Bos!\n\n📋 *Rincian Arus Kas*:\n- Tipe: ${shortcut.type}\n- Nominal: Rp ${shortcut.nominal.toLocaleString('id-ID')}\n- Keterangan: ${shortcut.keterangan}\n\n💼 *Saldo Kas Terbaru*: *${saldoStr}*`;
            await msg.reply(successMsg);

            io.emit('message_log', {
                chatId,
                body: `Dicatat: ${shortcut.type} Rp ${shortcut.nominal.toLocaleString('id-ID')} - ${shortcut.keterangan}`,
                type: 'outgoing',
                timestamp: Date.now()
            });
        } catch (err) {
            console.error('Gagal mencatat keuangan ke Google Sheets:', err.message);
            await msg.reply(`❌ Gagal mencatat keuangan ke Google Sheets: ${err.message}`);
        } finally {
            activeLocks.delete(chatId);
        }
        return;
    }

    // 5. PENANGANAN PENCATATAN AGENDA TEKS (TEMPLATE PINTASAN)
    if (userMessage.toLowerCase().startsWith('#agenda')) {
        const content = userMessage.substring('#agenda'.length).trim();
        let waktu = '';
        let acara = '';

        const parts = content.split(/[|-]/);
        if (parts.length >= 2) {
            waktu = parts[0].trim();
            acara = parts.slice(1).join('-').trim();
        } else {
            waktu = 'Hari ini';
            acara = content;
        }

        if (!acara) {
            await msg.reply('❌ Keterangan acara tidak boleh kosong. Format: #agenda [waktu] | [nama acara]');
            return;
        }

        activeLocks.add(chatId);
        const chat = await msg.getChat();
        await chat.sendStateTyping();

        try {
            await sendToGoogleSheets({
                action: 'add_agenda',
                waktu: waktu,
                acara: acara
            });

            // Simpan ke log lokal dan update dashboard
            addHistoryLog('agenda', {
                waktu: waktu,
                acara: acara
            });

            const successMsg = `✅ Agenda berhasil dijadwalkan Bos!\n\n📅 *Detail Agenda*:\n- Waktu: ${waktu}\n- Acara: ${acara}`;
            await msg.reply(successMsg);

            io.emit('message_log', {
                chatId,
                body: `Jadwal Baru: ${waktu} - ${acara}`,
                type: 'outgoing',
                timestamp: Date.now()
            });
        } catch (err) {
            console.error('Gagal mencatat agenda ke Google Sheets:', err.message);
            await msg.reply(`❌ Gagal mencatat agenda ke Google Sheets: ${err.message}`);
        } finally {
            activeLocks.delete(chatId);
        }
        return;
    }

    // 6. FALLBACK: COBA PARSING ALGORITMA LOKAL DULU (HEMAT TOKEN) [DINONAKTIFKAN jika FITUR_KEUANGAN=false]
    const localFinance = FITUR_KEUANGAN ? localParseFinanceMessage(userMessage) : null;
    if (localFinance) {
        console.log(`[Local Parser] Berhasil mendeteksi keuangan locally:`, JSON.stringify(localFinance));
        
        pendingTransactions.set(chatId, {
            intent: 'finance',
            type: localFinance.type,
            nominal: localFinance.nominal,
            keterangan: localFinance.keterangan
        });
        
        const replyMsg = `🤖 *Terdeteksi Catatan Keuangan*:\n- Tipe: *${localFinance.type}*\n- Nominal: *Rp ${localFinance.nominal.toLocaleString('id-ID')}*\n- Keterangan: *${localFinance.keterangan}*\n\nApakah data ini ingin disimpan ke Google Spreadsheet?\n👉 Balas *YA* untuk menyimpan atau *TIDAK* untuk membatalkannya.`;
        await msg.reply(replyMsg);
        
        io.emit('message_log', {
            chatId,
            body: `Terdeteksi keuangan (Lokal) - Menunggu konfirmasi: Rp ${localFinance.nominal.toLocaleString('id-ID')} untuk ${localFinance.keterangan}`,
            type: 'outgoing',
            timestamp: Date.now()
        });
        return;
    }

    // 6.5. FALLBACK: PROSES LAPORAN KEUANGAN SECARA LOKAL (0 TOKEN) [DINONAKTIFKAN jika FITUR_KEUANGAN=false]
    const isReportHandled = FITUR_KEUANGAN ? await handleLocalReportCommands(userMessage, msg) : false;
    if (isReportHandled) {
        return;
    }

    // Jika tidak cocok dengan pola lokal, baru panggil AI Terpadu
    activeLocks.add(chatId);
    const chat = await msg.getChat();
    await chat.sendStateTyping();
    
    try {
        console.log(`[Unified AI] Memproses pesan dari ${chatId}: "${userMessage}"`);
        const result = await generateUnifiedAiResponse(userMessage, chatId);
        console.log(`[Unified AI] Hasil analisis:`, JSON.stringify(result));
        
        if (FITUR_KEUANGAN && result.intent === 'finance' && result.data && result.data.nominal > 0) {
            const data = result.data;
            pendingTransactions.set(chatId, {
                intent: 'finance',
                type: data.type || 'Pengeluaran',
                nominal: data.nominal,
                keterangan: data.keterangan || 'Catatan Keuangan'
            });
            
            const replyMsg = `🤖 *Terdeteksi Catatan Keuangan*:\n- Tipe: *${data.type || 'Pengeluaran'}*\n- Nominal: *Rp ${data.nominal.toLocaleString('id-ID')}*\n- Keterangan: *${data.keterangan || 'Catatan Keuangan'}*\n\nApakah data ini ingin disimpan ke Google Spreadsheet?\n👉 Balas *YA* untuk menyimpan atau *TIDAK* untuk membatalkannya.`;
            await msg.reply(replyMsg);
            
            io.emit('message_log', {
                chatId,
                body: `Terdeteksi keuangan (AI) - Menunggu konfirmasi: Rp ${data.nominal.toLocaleString('id-ID')} untuk ${data.keterangan}`,
                type: 'outgoing',
                timestamp: Date.now()
            });
        } 
        else if (result.intent === 'agenda' && result.data && result.data.acara) {
            const data = result.data;
            pendingTransactions.set(chatId, {
                intent: 'agenda',
                waktu: data.waktu || 'Hari ini',
                acara: data.acara
            });
            
            const replyMsg = `🤖 *Terdeteksi Agenda Baru*:\n- Waktu: *${data.waktu || 'Hari ini'}*\n- Acara: *${data.acara}*\n\nApakah agenda ini ingin dijadwalkan ke Google Spreadsheet?\n👉 Balas *YA* untuk menyimpan atau *TIDAK* untuk membatalkannya.`;
            await msg.reply(replyMsg);
            
            io.emit('message_log', {
                chatId,
                body: `Terdeteksi agenda (AI) - Menunggu konfirmasi: ${data.waktu} - ${data.acara}`,
                type: 'outgoing',
                timestamp: Date.now()
            });
        } 
        else if (result.intent === 'reminder' && result.data && result.data.waktu && result.data.pesan) {
            const data = result.data;
            const targetDate = parseReminderTime(data.waktu);
            if (targetDate) {
                const newReminder = {
                    id: Date.now().toString(),
                    chatId: chatId,
                    time: targetDate.toISOString(),
                    message: data.pesan,
                    sent: false
                };

                reminders.push(newReminder);
                saveReminders();

                const formattedTime = targetDate.toLocaleString('id-ID', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'Asia/Jakarta'
                }) + ' WIB';

                const replyMsg = `🤖 *Pengingat Dijadwalkan Otomatis*:\n- *Pengingat*: ${data.pesan}\n- *Waktu*: ${formattedTime}\n\nSaya akan mengirimkan pesan pengingat kepada Bos pada waktu tersebut.`;
                await msg.reply(replyMsg);

                io.emit('message_log', {
                    chatId,
                    body: `Menjadwalkan Pengingat (AI): "${data.pesan}" untuk ${formattedTime}`,
                    type: 'outgoing',
                    timestamp: Date.now()
                });
            } else {
                const aiReply = result.reply || `Saya mengerti Bos ingin diingatkan tentang "${data.pesan}" pada "${data.waktu}". Namun saya gagal mengurai format waktunya. Harap gunakan format yang lebih spesifik seperti *besok jam 10:00* atau *15:30*.`;
                await msg.reply(aiReply);
                
                io.emit('message_log', {
                    chatId,
                    body: aiReply,
                    type: 'outgoing',
                    timestamp: Date.now()
                });
            }
        }
        else {
            // Jika intent adalah 'chat' (obrolan umum)
            console.log(`[AI Chat] Memproses balasan obrolan umum untuk: "${userMessage}"`);
            const aiReply = result.reply || 'Maaf Bos, saya tidak mengerti maksud pesan tersebut.';
            await msg.reply(aiReply);
            
            io.emit('message_log', {
                chatId,
                body: aiReply,
                type: 'outgoing',
                timestamp: Date.now()
            });
        }
    } catch (err) {
        console.error('Gagal menjalankan klasifikasi AI / Chat:', err.message);
        
        let providerName = 'Lokal';
        if (config.provider === 'gemini') providerName = 'Gemini';
        else if (config.provider === 'groq') providerName = 'Groq';
        else if (config.provider === 'deepseek') providerName = 'DeepSeek';
        else if (config.provider === 'qwen') providerName = 'Qwen';
        else if (config.provider === 'openrouter') providerName = 'OpenRouter';

        const errorFallbackMsg = `⚠️ Maaf Bos, server AI ${providerName} tidak merespon. Silakan gunakan pintasan berikut:\n- Catat Keuangan: \`+ 50rb Beli bensin\`\n- Catat Agenda: \`#agenda Besok jam 10 | Rapat\`\n- Atau ketik *bantuan* untuk panduan lengkap.`;
        await msg.reply(errorFallbackMsg);
        
        io.emit('message_log', {
            chatId,
            body: errorFallbackMsg,
            type: 'outgoing',
            timestamp: Date.now()
        });
    } finally {
        activeLocks.delete(chatId);
    }
}

// Proteksi Global agar aplikasi tidak crash secara tiba-tiba
process.on('uncaughtException', (err) => {
    console.error('Terjadi uncaughtException global:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise Rejection dideteksi pada:', promise, 'alasan:', reason);
});

// Mulai Inisialisasi WhatsApp Client & Express Web Server
server.listen(PORT, async () => {
    console.log(`\n======================================================`);
    console.log(`Web Dashboard CS Aktif di: http://localhost:${PORT}`);
    console.log(`======================================================\n`);
    await cleanupHeadlessChrome();
    createNewClient();
});
