import express from 'express';
import pg from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, // e.g., postgres://user:password@localhost:5432/church_db
});


// This tells us immediately if the database is working
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

// Helper to get Country Short Form
const getCountryCode = (country) => {
  const codes = { "Nigeria": "NG", "Ghana": "GH", "United Kingdom": "UK", "USA": "US" };
  return codes[country] || country.substring(0, 2).toUpperCase();
};

app.post('/api/register', async (req, res) => {
  const { full_name, email, phone_number, country, city_state, chapter, special_requirements } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get the country short code
    const countryShort = getCountryCode(country);

    // 2. Insert the user and generate the unique_code based on the new ID
    // We use a subquery to get the nextval of the table's ID sequence
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
      phone_number, // Default password
      countryShort  // Used for the suffix
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
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: "Email already registered." });
    }
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
  }
});


app.post('/api/update-password', async (req, res) => {
  const { unique_code, password } = req.body;
  try {
    await pool.query(
      "UPDATE registrations SET password = $1 WHERE unique_code = $2",
      [password, unique_code]
    );
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update password" });
  }
});


app.listen(5000, () => console.log('Server running on port 5000'));