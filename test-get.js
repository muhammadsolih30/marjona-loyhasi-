const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pool.query("SELECT * FROM leads ORDER BY id DESC LIMIT 5")
  .then(res => {
    console.log(res.rows);
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
