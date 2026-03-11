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

// 3. HELPERS
const getCountryCode = (country) => {
  const codes = { 
    "Nigeria": "NG", 
    "Ghana": "GH", 
    "United Kingdom": "UK", 
    "USA": "US",
    "Canada": "CA" 
  };
  return codes[country] || (country ? country.substring(0, 2).toUpperCase() : "XX");
};

// 4. API ROUTES

/**
 * POST /api/register
 * Saves all user details and generates sequential WWW-0000X-XX code
 */

// POST /api/login
app.post("/api/login", async (req, res) => {
  const { unique_code, password } = req.body;

  if (!unique_code || !password) {
    return res.status(400).json({
      error: "Unique code and password are required.",
    });
  }

  try {
    const userRes = await pool.query(
      "SELECT full_name, unique_code, password FROM registrations WHERE unique_code = $1",
      [unique_code]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userRes.rows[0];

    if (user.password !== password) {
      return res.status(401).json({ error: "Invalid password" });
    }

    res.json({
      message: "Login successful",
      unique_code: user.unique_code,
      full_name: user.full_name,
    });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post('/api/register', async (req, res) => {
  // These names now match your RegistrationLayout state exactly
  const { 
    full_name, 
    email, 
    phone_number, 
    country, 
    city_state, 
    chapter, 
    special_requirements 
  } = req.body;

  // ✅ REQUIRED FIELD VALIDATION (PUT IT HERE)
  if (!full_name || !email || !phone_number || !country || !city_state) {
    return res.status(400).json({
      error: "Full name, email, phone number, country and state are required."
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');


    // 2️⃣ 🔥 PUT DUPLICATE CHECK RIGHT HERE
    const existingUser = await client.query(
      `SELECT unique_code FROM registrations 
       WHERE full_name = $1 
       AND email = $2 
       AND phone_number = $3`,
      [full_name, email, phone_number]
    );

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: "Account already exists",
        existing: true,
        unique_code: existingUser.rows[0].unique_code
      });
    }


    const countryShort = getCountryCode(country);
    const defaultPassword = phone_number + "#";

    // Insert user - using phone_number as plain text password
    const insertUser = `
    INSERT INTO registrations 
    (full_name, email, phone_number, country, city_state, chapter, special_requirements, password)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id;
    `;

    const userResult = await client.query(insertUser, [
    full_name,
    email,
    phone_number,
    country,
    city_state,
    chapter,
    special_requirements,
    defaultPassword
    ]);

    const newId = userResult.rows[0].id;

    const uniqueCode = `WAW-${String(newId).padStart(5, '0')}-${countryShort}`;

    await client.query(
    "UPDATE registrations SET unique_code = $1 WHERE id = $2",
    [uniqueCode, newId]
    );
    
    await client.query('COMMIT');

    res.status(201).json({
      message: "Registration Successful",
      unique_code: uniqueCode,
      password: defaultPassword
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration Error:', err);
    
    if (err.code === '23505') {
      return res.status(400).json({ error: "This email is already registered." });
    }
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/**
 * POST /api/update-password
 * Updates the plain text password
 */
app.post('/api/update-password', async (req, res) => {
  const { unique_code, password } = req.body;

  try {
    const updateQuery = "UPDATE registrations SET password = $1 WHERE unique_code = $2";
    await pool.query(updateQuery, [password, unique_code]);

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error('Update Password Error:', err);
    res.status(500).json({ error: "Failed to update password" });
  }
});



// 5. RECOVERY ROUTES

/**
 * POST /api/forgot-password
 * Verifies 3 out of 4 fields to allow a password update
 * Fields: unique_code, email, phone_number, full_name
 */
app.post('/api/forgot-password', async (req, res) => {
    const { unique_code, email, phone_number, full_name, new_password } = req.body;
    
    try {
        // Check for record matching at least 3 identifying fields
        const checkUser = await pool.query(
            `SELECT id FROM registrations 
             WHERE (unique_code = $1 AND email = $2 AND phone_number = $3)
                OR (unique_code = $1 AND email = $2 AND full_name = $4)
                OR (unique_code = $1 AND phone_number = $3 AND full_name = $4)
                OR (email = $2 AND phone_number = $3 AND full_name = $4)`,
            [unique_code, email, phone_number, full_name]
        );

        if (checkUser.rows.length === 0) {
            return res.status(404).json({ error: "Verification failed. Details do not match our records." });
        }

        await pool.query("UPDATE registrations SET password = $1 WHERE id = $2", [new_password, checkUser.rows[0].id]);
        res.json({ message: "Password reset successfully" });
    } catch (err) {
        res.status(500).json({ error: "Server error during recovery" });
    }
});

/**
 * POST /api/forgot-code
 * Verifies 3 out of 4 fields to retrieve the unique code
 * Fields: full_name, email, phone_number, password
 */
// Add this to your server.js API ROUTES section [cite: 56]

// FORGOT PASSWORD: Verifies 3 of 4 to update password
app.post('/api/forgot-password', async (req, res) => {
    const { unique_code, email, phone_number, full_name, new_password } = req.body;
    
    try {
        const checkUser = await pool.query(
            `SELECT id FROM registrations 
             WHERE (unique_code = $1 AND email = $2 AND phone_number = $3)
                OR (unique_code = $1 AND email = $2 AND full_name = $4)
                OR (unique_code = $1 AND phone_number = $3 AND full_name = $4)
                OR (email = $2 AND phone_number = $3 AND full_name = $4)`,
            [unique_code, email, phone_number, full_name]
        );

        if (checkUser.rows.length === 0) {
            return res.status(404).json({ error: "Verification failed. Details do not match." });
        }

        await pool.query("UPDATE registrations SET password = $1 WHERE id = $2", [new_password, checkUser.rows[0].id]);
        res.json({ message: "Password updated successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// FORGOT UNIQUE CODE: Verifies 3 of 4 to return the code
app.post('/api/forgot-code', async (req, res) => {
    const { full_name, email, phone_number, password } = req.body;

    try {
        const result = await pool.query(
            `SELECT unique_code FROM registrations 
             WHERE (full_name = $1 AND email = $2 AND phone_number = $3)
                OR (full_name = $1 AND email = $2 AND password = $4)
                OR (full_name = $1 AND phone_number = $3 AND password = $4)
                OR (email = $2 AND phone_number = $3 AND password = $4)`,
            [full_name, email, phone_number, password]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Account not found." });
        }

        res.json({ unique_code: result.rows[0].unique_code });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// GET /api/user/:code
app.get('/api/user/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const userRes = await pool.query(
      "SELECT full_name, unique_code, email, phone_number FROM registrations WHERE unique_code = $1", 
      [code]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(userRes.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// 5. START SERVER
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});