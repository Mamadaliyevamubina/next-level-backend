import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import accountRoutes from './routes/account.js';
import teacherRoutes from './routes/teacher.js';
import teacherAssignmentRoutes from './routes/teacherAssignments.js';
import assignmentRoutes from './routes/assignments.js';
import adminRoutes from './routes/admin.js';
import practiceRoutes from './routes/practice.js';
import { pool } from './db.js';

// Only these browser origins may call the API (comma-separated in .env). Defaults to the Vite dev server.
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);

const app = express();
app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: '200kb' }));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, database: err.message });
  }
});

// Public: course list for the home page (no login needed).
app.use('/api/catalog', catalogRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/teacher/assignments', teacherAssignmentRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/admin', adminRoutes);
// Practice routes are mounted last: they need an approved account for everything under /api.
app.use('/api', practiceRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`API running on http://localhost:${port}`));
