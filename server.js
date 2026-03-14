import express from 'express';
import pg from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// 1. DATABASE CONFIGURATION
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false } // Uncomment for Render/Supabase
});

// 2. CONNECTION CHECK
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Database connection error:', err.stack);
  }
  client.query('SELECT NOW()', (err, result) => {
    release();
    if (err) {
      return console.error('❌ Query error:', err.stack);
    }
    console.log('✅ Connected to Postgres at:', result.rows[0].now);
  });
});

// 2. HELPERS
const getCountryCode = (country) => {
  const codes = { "Nigeria": "NG", "Ghana": "GH", "United Kingdom": "UK", "USA": "US", "Canada": "CA" };
  return codes[country] || (country ? country.substring(0, 2).toUpperCase() : "XX");
};

// Dynamically check and add columns for the active event
const ensureActiveProgramColumns = async (client) => {
  try {
    const activeEventRes = await client.query("SELECT abbrev FROM events WHERE status = 'Active' LIMIT 1");
    if (activeEventRes.rows.length > 0) {
      const abbrev = activeEventRes.rows[0].abbrev.replace(/[^a-zA-Z0-9_]/g, ''); // Sanitize
      const tables = ['prog_reg', 'prog_atend', 'prog_method', 'prog_diet', 'prog_prayer'];
      const suffixes = ['reg', 'atend', 'method', 'diet', 'prayer'];

      for (let i = 0; i < tables.length; i++) {
        const colName = `${abbrev}_${suffixes[i]}`;
        await client.query(`ALTER TABLE ${tables[i]} ADD COLUMN IF NOT EXISTS ${colName} TEXT`);
      }
    }
  } catch (err) {
    console.error("Error ensuring active program columns:", err);
  }
};

// 3. API ROUTES

// GET Events
app.get("/api/events", async (req, res) => {
  try {
    const eventsRes = await pool.query("SELECT * FROM events ORDER BY event_date ASC");
    res.json(eventsRes.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/login
app.post("/api/login", async (req, res) => {
  const { unique_code, password } = req.body;
  if (!unique_code || !password) return res.status(400).json({ error: "Unique code and password required." });

  try {
    const userRes = await pool.query("SELECT full_name, unique_code, password FROM registrations WHERE unique_code = $1", [unique_code]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });

    const user = userRes.rows[0];
    if (user.password !== password) return res.status(401).json({ error: "Invalid password" });

    await pool.query("UPDATE notifications SET login = CURRENT_TIMESTAMP WHERE unique_code = $1", [unique_code]);
    
    const client = await pool.connect();
    await ensureActiveProgramColumns(client);
    client.release();

    res.json({ message: "Login successful", unique_code: user.unique_code, full_name: user.full_name });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/logout
app.post("/api/logout", async (req, res) => {
  const { unique_code } = req.body;
  try {
    await pool.query("UPDATE notifications SET logout = CURRENT_TIMESTAMP WHERE unique_code = $1", [unique_code]);
    res.json({ message: "Logout tracked" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/register
app.post('/api/register', async (req, res) => {
  const { full_name, email, phone_number, country, city_state, chapter } = req.body;

  if (!full_name || !email || !phone_number || !country || !city_state) {
    return res.status(400).json({ error: "Full name, email, phone number, country and state are required." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingUser = await client.query(
      "SELECT unique_code FROM registrations WHERE full_name = $1 AND email = $2 AND phone_number = $3",
      [full_name, email, phone_number]
    );

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: "Account already exists", existing: true, unique_code: existingUser.rows[0].unique_code });
    }

    const countryShort = getCountryCode(country);
    const defaultPassword = phone_number + "#";

    const idResult = await client.query("SELECT nextval('registrations_id_seq')");
    const newId = idResult.rows[0].nextval;
    const uniqueCode = `WAW-${String(newId).padStart(5, '0')}-${countryShort}`;

    const insertUser = `
      INSERT INTO registrations 
      (id, full_name, email, phone_number, country, city_state, chapter, password, unique_code) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;
    await client.query(insertUser, [
      newId, full_name, email, phone_number, country, city_state, chapter, defaultPassword, uniqueCode
    ]);

    await client.query("INSERT INTO prof_pic (unique_code, picture) VALUES ($1, 'nil')", [uniqueCode]);
    await client.query("INSERT INTO status (unique_code, status, scope) VALUES ($1, 'member', 'Nil')", [uniqueCode]);
    await client.query("INSERT INTO prog_reg (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_atend (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_method (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_diet (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_prayer (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO notifications (unique_code, login) VALUES ($1, CURRENT_TIMESTAMP)", [uniqueCode]);

    await ensureActiveProgramColumns(client);

    await client.query('COMMIT');
    res.status(201).json({ message: "Registration Successful", unique_code: uniqueCode, password: defaultPassword });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration Error:', err);
    if (err.code === '23505') return res.status(400).json({ error: "Email already registered." });
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// POST /api/update-password
app.post('/api/update-password', async (req, res) => {
  const { unique_code, password } = req.body;
  try {
    await pool.query("UPDATE registrations SET password = $1 WHERE unique_code = $2", [password, unique_code]);
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update password" });
  }
});

// POST /api/forgot-password
app.post('/api/forgot-password', async (req, res) => {
  const { unique_code, email, phone_number, full_name, new_password } = req.body;
  try {
    const checkUser = await pool.query(
      `SELECT id FROM registrations WHERE (unique_code = $1 AND email = $2 AND phone_number = $3) OR (unique_code = $1 AND email = $2 AND full_name = $4) OR (unique_code = $1 AND phone_number = $3 AND full_name = $4) OR (email = $2 AND phone_number = $3 AND full_name = $4)`,
      [unique_code, email, phone_number, full_name]
    );
    if (checkUser.rows.length === 0) return res.status(404).json({ error: "Verification failed." });
    await pool.query("UPDATE registrations SET password = $1 WHERE id = $2", [new_password, checkUser.rows[0].id]);
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/forgot-code
app.post('/api/forgot-code', async (req, res) => {
  const { full_name, email, phone_number, password } = req.body;
  try {
    const result = await pool.query(
      `SELECT unique_code FROM registrations WHERE (full_name = $1 AND email = $2 AND phone_number = $3) OR (full_name = $1 AND email = $2 AND password = $4) OR (full_name = $1 AND phone_number = $3 AND password = $4) OR (email = $2 AND phone_number = $3 AND password = $4)`,
      [full_name, email, phone_number, password]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Account not found." });
    res.json({ unique_code: result.rows[0].unique_code });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/user/:code (MODIFIED TO INCLUDE PROF_PIC)
app.get('/api/user/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const userRes = await pool.query(`
      SELECT r.*, s.status, s.scope, p.picture 
      FROM registrations r 
      LEFT JOIN status s ON r.unique_code = s.unique_code 
      LEFT JOIN prof_pic p ON r.unique_code = p.unique_code
      WHERE r.unique_code = $1
    `, [code]);
    
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(userRes.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT /api/user/:code (FOR INLINE PROFILE EDITING)
app.put('/api/user/:code', async (req, res) => {
  const { code } = req.params;
  const { field, value } = req.body;
  
  const allowedFields = ['full_name', 'email', 'phone_number', 'country', 'city_state'];
  if (!allowedFields.includes(field)) return res.status(400).json({ error: "Invalid field" });

  try {
    await pool.query(`UPDATE registrations SET ${field} = $1 WHERE unique_code = $2`, [value, code]);
    res.json({ message: "Updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
});

// PUT /api/user/:code/profile-pic (NEW - FOR CLOUDINARY UPLOAD)
app.put('/api/user/:code/profile-pic', async (req, res) => {
  const { code } = req.params;
  const { pictureUrl } = req.body;
  
  try {
    await pool.query("UPDATE prof_pic SET picture = $1 WHERE unique_code = $2", [pictureUrl, code]);
    res.json({ message: "Profile picture updated successfully", picture: pictureUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
});

// GET /api/records/:code
app.get('/api/records/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    const regRes = await pool.query("SELECT * FROM prog_reg WHERE unique_code = $1", [code]);
    const atendRes = await pool.query("SELECT * FROM prog_atend WHERE unique_code = $1", [code]);
    const methodRes = await pool.query("SELECT * FROM prog_method WHERE unique_code = $1", [code]);
    const eventsRes = await pool.query("SELECT event_name, abbrev, event_date, status FROM events ORDER BY event_date DESC");

    res.json({
      events: eventsRes.rows,
      registered: regRes.rows[0] || {},
      attended: atendRes.rows[0] || {},
      methods: methodRes.rows[0] || {}
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));