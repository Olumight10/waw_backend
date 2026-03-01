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

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const countryShort = getCountryCode(country);

    // Insert user - using phone_number as plain text password
    const insertQuery = `
      INSERT INTO registrations 
      (full_name, email, phone_number, country, city_state, chapter, special_requirements, password, unique_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 
        'WWW-' || LPAD(nextval('registrations_id_seq')::text, 5, '0') || '-' || $9
      )
      RETURNING unique_code, password;
    `;

    const values = [
      full_name, 
      email, 
      phone_number, 
      country, 
      city_state, 
      chapter, 
      special_requirements, 
      phone_number, // Storing as plain text
      countryShort
    ];

    const result = await client.query(insertQuery, values);
    await client.query('COMMIT');

    res.status(201).json({
      message: "Registration Successful",
      unique_code: result.rows[0].unique_code,
      password: result.rows[0].password
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

// 5. START SERVER
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});