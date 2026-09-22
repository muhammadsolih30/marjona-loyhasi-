const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pool.query("SELECT NOW()")
  .then(res => {
    console.log("DB ulanishi muvaffaqiyatli:", res.rows[0]);
    process.exit(0);
  })
  .catch(err => {
    console.error("DB ulanishida xatolik:", err.message);
    process.exit(1);
  });
