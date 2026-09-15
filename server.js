const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'marjona202';

app.use(cors());
app.use(express.json());

// In-memory active tokens for admin session
const activeSessions = new Set();

function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.add(token);
  return token;
}

function verifyToken(token) {
  if (!token) return false;
  return activeSessions.has(token);
}

// Fallback local JSON storage directory if Neon is not yet connected
const dataDir = path.join(__dirname, 'data');
const fallbackFile = path.join(dataDir, 'leads.json');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(fallbackFile)) {
  fs.writeFileSync(fallbackFile, JSON.stringify([]));
}

// Database Connection Setup (Neon PostgreSQL)
let pool = null;
let isDbConnected = false;

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    pool.on('error', (err) => {
      console.warn('Neon connection notice:', err ? err.message : 'idle client closed');
    });

    // Test connection and initialize table
    pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(100) NOT NULL,
        business_type VARCHAR(100),
        budget VARCHAR(100),
        status VARCHAR(50) DEFAULT 'Yangi',
        notes TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `).then(() => {
      isDbConnected = true;
      console.log('✅ Neon PostgreSQL bazasiga muvaffaqiyatli ulandi va "leads" jadvali tayyor.');
    }).catch(err => {
      console.error('⚠️ Neon PostgreSQL ulanishida xatolik yuz berdi. Fallback rejimiga o\'tilmoqda:', err.message);
      isDbConnected = false;
    });
  } catch (err) {
    console.error('⚠️ Pool yaratishda xatolik:', err.message);
    isDbConnected = false;
  }
} else {
  console.log('ℹ️ DATABASE_URL topilmadi. Hozircha mahalliy zaxira (data/leads.json) rejimida ishlanmoqda.');
  console.log('ℹ️ Neon connection string ni .env fayliga kiritsangiz, avtomatik Neon PostgreSQL bazasiga ulanadi.');
}

// Helper methods for Lead operations
async function saveLead(leadData) {
  const { name, phone, biz, budget } = leadData;
  if (pool) {
    try {
      const result = await pool.query(
        `INSERT INTO leads (name, phone, business_type, budget, status, created_at)
         VALUES ($1, $2, $3, $4, 'Yangi', NOW())
         RETURNING *`,
        [name, phone, biz, budget]
      );
      isDbConnected = true;
      return result.rows[0];
    } catch (err) {
      console.error('Neon DB ga saqlashda xato:', err.message);
      isDbConnected = false;
    }
  }

  // Fallback storage
  const fileContent = fs.readFileSync(fallbackFile, 'utf8');
  const leads = JSON.parse(fileContent || '[]');
  const newLead = {
    id: leads.length ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1,
    name,
    phone,
    business_type: biz,
    budget,
    status: 'Yangi',
    notes: '',
    created_at: new Date().toISOString()
  };
  leads.unshift(newLead);
  fs.writeFileSync(fallbackFile, JSON.stringify(leads, null, 2));
  return newLead;
}

async function getAllLeads() {
  if (pool) {
    try {
      const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
      isDbConnected = true;
      return result.rows;
    } catch (err) {
      console.error('Neon DB dan olishda xato:', err.message);
      isDbConnected = false;
    }
  }

  const fileContent = fs.readFileSync(fallbackFile, 'utf8');
  return JSON.parse(fileContent || '[]');
}

async function updateLeadStatus(id, status, notes) {
  if (pool) {
    try {
      let query = 'UPDATE leads SET status = $1';
      const params = [status];
      if (notes !== undefined) {
        query += ', notes = $2 WHERE id = $3 RETURNING *';
        params.push(notes, id);
      } else {
        query += ' WHERE id = $2 RETURNING *';
        params.push(id);
      }
      const res = await pool.query(query, params);
      isDbConnected = true;
      return res.rows[0];
    } catch (err) {
      console.error('Status yangilashda xato:', err.message);
      isDbConnected = false;
    }
  }

  const fileContent = fs.readFileSync(fallbackFile, 'utf8');
  const leads = JSON.parse(fileContent || '[]');
  const lead = leads.find(l => String(l.id) === String(id));
  if (lead) {
    lead.status = status;
    if (notes !== undefined) lead.notes = notes;
    fs.writeFileSync(fallbackFile, JSON.stringify(leads, null, 2));
  }
  return lead;
}

async function deleteLead(id) {
  if (pool) {
    try {
      await pool.query('DELETE FROM leads WHERE id = $1', [id]);
      isDbConnected = true;
      return true;
    } catch (err) {
      console.error('O\'chirishda xato:', err.message);
      isDbConnected = false;
    }
  }

  const fileContent = fs.readFileSync(fallbackFile, 'utf8');
  let leads = JSON.parse(fileContent || '[]');
  leads = leads.filter(l => String(l.id) !== String(id));
  fs.writeFileSync(fallbackFile, JSON.stringify(leads, null, 2));
  return true;
}

// Authentication middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ success: false, message: 'Ruxsat berilmadi. Qaytadan kiring.' });
  }
  next();
}

// API Routes

// 1. Yangi lidni saqlash (Landing page formasi uchun)
app.post('/api/leads', async (req, res) => {
  try {
    const { name, phone, biz, budget } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Ism va telefon to\'ldirilishi shart.' });
    }

    const saved = await saveLead({ name, phone, biz, budget });
    return res.status(201).json({
      success: true,
      message: 'Murojaat qabul qilindi',
      lead: saved
    });
  } catch (err) {
    console.error('Lid saqlashda xatolik:', err);
    res.status(500).json({ success: false, message: 'Serverda xatolik' });
  }
});

// 2. Admin kirish (Login)
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Noto\'g\'ri parol!' });
  }

  const token = generateToken();
  return res.json({
    success: true,
    token,
    message: 'Admin panelga muvaffaqiyatli kirildi'
  });
});

// 3. Admin sessiyasini tekshirish
app.get('/api/admin/verify', requireAuth, (req, res) => {
  res.json({ success: true, dbConnected: isDbConnected });
});

// 4. Barcha lidlarni olish
app.get('/api/admin/leads', requireAuth, async (req, res) => {
  try {
    const leads = await getAllLeads();
    res.json({
      success: true,
      dbConnected: isDbConnected,
      count: leads.length,
      leads
    });
  } catch (err) {
    console.error('Lidlarni olishda xatolik:', err);
    res.status(500).json({ success: false, message: 'Server xatoligi' });
  }
});

// 5. Lid holatini yangilash
app.patch('/api/admin/leads/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const updated = await updateLeadStatus(id, status, notes);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Lid topilmadi' });
    }
    res.json({ success: true, lead: updated });
  } catch (err) {
    console.error('Lid yangilashda xato:', err);
    res.status(500).json({ success: false, message: 'Server xatoligi' });
  }
});

// 6. Lidni o'chirish
app.delete('/api/admin/leads/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await deleteLead(id);
    res.json({ success: true, message: 'Lid o\'chirildi' });
  } catch (err) {
    console.error('Lid o\'chirishda xato:', err);
    res.status(500).json({ success: false, message: 'Server xatoligi' });
  }
});

// 7. Statistika
app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const leads = await getAllLeads();
    const today = new Date().toISOString().split('T')[0];
    
    const todayLeads = leads.filter(l => {
      const d = new Date(l.created_at).toISOString().split('T')[0];
      return d === today;
    }).length;

    const stats = {
      total: leads.length,
      today: todayLeads,
      yangi: leads.filter(l => l.status === 'Yangi').length,
      boglanildi: leads.filter(l => l.status === 'Bog\'lanildi').length,
      jarayonda: leads.filter(l => l.status === 'Jarayonda').length,
      kelishildi: leads.filter(l => l.status === 'Kelishildi').length,
      bekor: leads.filter(l => l.status === 'Bekor').length,
      dbConnected: isDbConnected
    };

    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server xatoligi' });
  }
});

// Admin Panel sahifasi (/admin)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Statik fayllar (Landing page uchun)
app.use(express.static(__dirname));

// Har qanday boshqa so'rovlar uchun bosh sahifaga yo'naltirish
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server http://localhost:${PORT} manzilida ishlamoqda.`);
  console.log(`🔐 Yashirin Admin Panel: http://localhost:${PORT}/admin`);
});
