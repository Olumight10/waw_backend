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
// 2. HELPERS
const getCountryCode = (country) => {
  const codes = { "Nigeria": "NG", "Ghana": "GH", "United Kingdom": "UK", "USA": "US", "Canada": "CA" };
  return codes[country] || (country ? country.substring(0, 2).toUpperCase() : "XX");
};

const getCleanAbbrev = (abbrev) => {
  return abbrev.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
};

// Dynamically check and add columns for the active event
const ensureActiveProgramColumns = async (client) => {
  try {
    const activeEventRes = await client.query("SELECT abbrev FROM events WHERE status = 'Active' LIMIT 1");
    if (activeEventRes.rows.length > 0) {
      const abbrev = getCleanAbbrev(activeEventRes.rows[0].abbrev);
      const tables = ['prog_reg', 'prog_attend', 'prog_method', 'prog_diet', 'prog_prayer', 'prog_online', 'prog_reg_time', 'prog_reg_who', 'prog_att_time', 'prog_att_who'];
      const suffixes = ['reg', 'attend', 'method', 'diet', 'prayer', 'online', 'reg_time', 'reg_who', 'att_time', 'att_who'];

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

// GET User Specific Active Event Status
app.get("/api/user-event-status/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const activeEventRes = await pool.query("SELECT * FROM events WHERE status = 'Active' LIMIT 1");
    if (activeEventRes.rows.length === 0) return res.json({ isRegistered: false, activeEvent: null });
    
    const activeEvent = activeEventRes.rows[0];
    const abbrev = getCleanAbbrev(activeEvent.abbrev);
    const colName = `${abbrev}_reg`;
    const methodCol = `${abbrev}_method`;

    const query = `
      SELECT pr.${colName} AS reg_status, pm.${methodCol} AS method_status
      FROM prog_reg pr
      LEFT JOIN prog_method pm ON pr.unique_code = pm.unique_code
      WHERE pr.unique_code = $1
    `;
    const regCheck = await pool.query(query, [code]);

    let isRegistered = false;
    let method = null;

    if (regCheck.rows.length > 0) {
      const regValue = regCheck.rows[0].reg_status;
      isRegistered = regValue ? regValue.toLowerCase() === 'yes' : false;
      method = regCheck.rows[0].method_status;
    }

    res.json({ isRegistered, method, activeEvent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET Registration Logs (Time & Who)
app.get("/api/registration-log/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const activeEventRes = await pool.query("SELECT abbrev FROM events WHERE status = 'Active' LIMIT 1");
    if (activeEventRes.rows.length === 0) return res.json({ myRegistration: null, registeredByMe: [] });
    
    const abbrev = getCleanAbbrev(activeEventRes.rows[0].abbrev);

    const checkCol = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name='prog_reg_time' AND column_name=$1
    `, [`${abbrev}_reg_time`]);

    if (checkCol.rows.length === 0) {
        return res.json({ myRegistration: null, registeredByMe: [] });
    }

    // Self Healing Logic for Time/Who
    const tablesToUpdate = ['prog_reg_time', 'prog_reg_who'];
    for (const table of tablesToUpdate) {
        const check = await pool.query(`SELECT 1 FROM ${table} WHERE unique_code = $1`, [code]);
        if (check.rows.length === 0) {
            await pool.query(`INSERT INTO ${table} (unique_code) VALUES ($1)`, [code]);
        }
    }

    const regCheck = await pool.query(`SELECT ${abbrev}_reg FROM prog_reg WHERE unique_code = $1`, [code]);
    if (regCheck.rows.length > 0 && regCheck.rows[0][`${abbrev}_reg`] === 'Yes') {
        const timeCheck = await pool.query(`SELECT ${abbrev}_reg_time FROM prog_reg_time WHERE unique_code = $1`, [code]);
        if (!timeCheck.rows[0][`${abbrev}_reg_time`]) {
            await pool.query(`UPDATE prog_reg_time SET ${abbrev}_reg_time = CURRENT_TIMESTAMP WHERE unique_code = $1`, [code]);
            await pool.query(`UPDATE prog_reg_who SET ${abbrev}_reg_who = $1 WHERE unique_code = $1`, [code]);
        }
    }

    const myRegRes = await pool.query(`
      SELECT prt.${abbrev}_reg_time AS time, prw.${abbrev}_reg_who AS who
      FROM prog_reg_time prt
      LEFT JOIN prog_reg_who prw ON prt.unique_code = prw.unique_code
      WHERE prt.unique_code = $1
    `, [code]);

    const regByMeRes = await pool.query(`
      SELECT r.full_name, r.unique_code, prt.${abbrev}_reg_time AS time
      FROM prog_reg_who prw
      JOIN registrations r ON prw.unique_code = r.unique_code
      LEFT JOIN prog_reg_time prt ON prw.unique_code = prt.unique_code
      WHERE prw.${abbrev}_reg_who = $1 AND prw.unique_code != $1
    `, [code]);

    res.json({
      myRegistration: myRegRes.rows[0] || null,
      registeredByMe: regByMeRes.rows
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST Register for Program
app.post("/api/program/register", async (req, res) => {
  const { unique_code, target_code, method, diet, prayer, amount_paid, currency } = req.body;
  const codeToRegister = (target_code || unique_code).trim();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userCheck = await client.query("SELECT 1 FROM registrations WHERE unique_code = $1", [codeToRegister]);
    if (userCheck.rows.length === 0) {
      throw new Error(`This user (${codeToRegister}) cannot be found.`);
    }

    const activeEventRes = await client.query("SELECT abbrev FROM events WHERE status = 'Active' LIMIT 1");
    if (activeEventRes.rows.length === 0) throw new Error("No active event found");
    
    const abbrev = getCleanAbbrev(activeEventRes.rows[0].abbrev);

    const regCheck = await client.query(`SELECT ${abbrev}_reg FROM prog_reg WHERE unique_code = $1`, [codeToRegister]);
    if (regCheck.rows.length > 0 && regCheck.rows[0][`${abbrev}_reg`] === 'Yes') {
      throw new Error(`This user (${codeToRegister}) is already registered for this event.`);
    }

    // ADDED prog_online TO THE AUTO-UPDATE LIST
    const tablesToUpdate = ['prog_reg', 'prog_method', 'prog_diet', 'prog_prayer', 'prog_reg_time', 'prog_reg_who', 'prog_online'];
    for (const table of tablesToUpdate) {
        const check = await client.query(`SELECT 1 FROM ${table} WHERE unique_code = $1`, [codeToRegister]);
        if (check.rows.length === 0) {
            await client.query(`INSERT INTO ${table} (unique_code) VALUES ($1)`, [codeToRegister]);
        }
    }

    await client.query(`UPDATE prog_reg SET ${abbrev}_reg = 'Yes' WHERE unique_code = $1`, [codeToRegister]);
    await client.query(`UPDATE prog_method SET ${abbrev}_method = $1 WHERE unique_code = $2`, [method, codeToRegister]);
    await client.query(`UPDATE prog_diet SET ${abbrev}_diet = $1 WHERE unique_code = $2`, [diet, codeToRegister]);
    await client.query(`UPDATE prog_prayer SET ${abbrev}_prayer = $1 WHERE unique_code = $2`, [prayer, codeToRegister]);
    
    await client.query(`UPDATE prog_reg_time SET ${abbrev}_reg_time = CURRENT_TIMESTAMP WHERE unique_code = $1`, [codeToRegister]);
    await client.query(`UPDATE prog_reg_who SET ${abbrev}_reg_who = $1 WHERE unique_code = $2`, [unique_code, codeToRegister]);

    await client.query('COMMIT');
    res.json({ message: "Registration successful", registered_code: codeToRegister });

  } catch (err) {
    await client.query('ROLLBACK');
    const isCustomError = err.message.includes("cannot be found") || err.message.includes("already registered") || err.message.includes("No active event");
    res.status(isCustomError ? 400 : 500).json({ error: err.message || "Registration failed" });
  } finally {
    client.release();
  }
});

// POST Join Online
app.post("/api/program/join-online", async (req, res) => {
  const { unique_code } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const activeEventRes = await pool.query("SELECT abbrev, meeting_id, meeting_password FROM events WHERE status = 'Active' LIMIT 1");
    if (activeEventRes.rows.length === 0) return res.status(404).json({ error: "No active event" });
    
    const event = activeEventRes.rows[0];
    const abbrev = getCleanAbbrev(event.abbrev);
    const colName = `${abbrev}_online`;

    // Fetch user. If not found, SELF HEAL by generating the row!
    let sessionRes = await pool.query(`SELECT ${colName} FROM prog_online WHERE unique_code = $1`, [unique_code]);
    if (sessionRes.rows.length === 0) {
      await pool.query(`INSERT INTO prog_online (unique_code) VALUES ($1)`, [unique_code]);
      sessionRes = await pool.query(`SELECT ${colName} FROM prog_online WHERE unique_code = $1`, [unique_code]);
    }

    const currentIp = sessionRes.rows[0][colName];

    if (!currentIp || currentIp === 'No') {
      await pool.query(`UPDATE prog_online SET ${colName} = $1 WHERE unique_code = $2`, [clientIp, unique_code]);
      res.json({ success: true, meeting_id: event.meeting_id, meeting_password: event.meeting_password });
    } else if (currentIp === clientIp) {
      res.json({ success: true, meeting_id: event.meeting_id, meeting_password: event.meeting_password });
    } else {
      res.status(403).json({ error: "Access denied. You are already logged in from another device." });
    }
  } catch (err) {
    console.error("Online Join Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET user info
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

// POST Login
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

// POST Logout
app.post("/api/logout", async (req, res) => {
  const { unique_code } = req.body;
  try {
    await pool.query("UPDATE notifications SET logout = CURRENT_TIMESTAMP WHERE unique_code = $1", [unique_code]);
    res.json({ message: "Logout tracked" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST Register (New Account)
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
      INSERT INTO registrations (id, full_name, email, phone_number, country, city_state, chapter, password, unique_code) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;
    await client.query(insertUser, [newId, full_name, email, phone_number, country, city_state, chapter, defaultPassword, uniqueCode]);

    await client.query("INSERT INTO prof_pic (unique_code, picture) VALUES ($1, 'nil')", [uniqueCode]);
    await client.query("INSERT INTO status (unique_code, status, scope) VALUES ($1, 'member', 'Nil')", [uniqueCode]);
    await client.query("INSERT INTO prog_reg (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_attend (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_method (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_diet (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_prayer (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO notifications (unique_code, login) VALUES ($1, CURRENT_TIMESTAMP)", [uniqueCode]);

    // Initialize NEW Time/Who/Online Tables
    await client.query("INSERT INTO prog_reg_time (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_reg_who (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_att_time (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_att_who (unique_code) VALUES ($1)", [uniqueCode]);
    await client.query("INSERT INTO prog_online (unique_code) VALUES ($1)", [uniqueCode]); // ADDED THIS

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

// Update Password
app.post('/api/update-password', async (req, res) => {
  const { unique_code, password } = req.body;
  try {
    await pool.query("UPDATE registrations SET password = $1 WHERE unique_code = $2", [password, unique_code]);
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update password" });
  }
});

// Forgot Password
app.post('/api/forgot-password', async (req, res) => {
  const { unique_code, email, phone_number, full_name, new_password } = req.body;
  try {
    const checkUser = await pool.query(`
      SELECT id FROM registrations WHERE 
      (unique_code = $1 AND email = $2 AND phone_number = $3) OR 
      (unique_code = $1 AND email = $2 AND full_name = $4) OR 
      (unique_code = $1 AND phone_number = $3 AND full_name = $4) OR 
      (email = $2 AND phone_number = $3 AND full_name = $4)
    `, [unique_code, email, phone_number, full_name]);

    if (checkUser.rows.length === 0) return res.status(404).json({ error: "Verification failed." });

    await pool.query("UPDATE registrations SET password = $1 WHERE id = $2", [new_password, checkUser.rows[0].id]);
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Forgot Code
app.post('/api/forgot-code', async (req, res) => {
  const { full_name, email, phone_number, password } = req.body;
  try {
    const result = await pool.query(`
      SELECT unique_code FROM registrations WHERE 
      (full_name = $1 AND email = $2 AND phone_number = $3) OR 
      (full_name = $1 AND email = $2 AND password = $4) OR 
      (full_name = $1 AND phone_number = $3 AND password = $4) OR 
      (email = $2 AND phone_number = $3 AND password = $4)
    `, [full_name, email, phone_number, password]);

    if (result.rows.length === 0) return res.status(404).json({ error: "Account not found." });
    res.json({ unique_code: result.rows[0].unique_code });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// User Profile Editing
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

// Update Profile Pic
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

// GET Records
app.get('/api/records/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const regRes = await pool.query("SELECT * FROM prog_reg WHERE unique_code = $1", [code]);
    const attendRes = await pool.query("SELECT * FROM prog_attend WHERE unique_code = $1", [code]);
    const methodRes = await pool.query("SELECT * FROM prog_method WHERE unique_code = $1", [code]);
    const eventsRes = await pool.query("SELECT event_name, abbrev, event_date, status FROM events ORDER BY event_date DESC");

    res.json({
      events: eventsRes.rows,
      registered: regRes.rows[0] || {},
      attended: attendRes.rows[0] || {},
      methods: methodRes.rows[0] || {}
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));