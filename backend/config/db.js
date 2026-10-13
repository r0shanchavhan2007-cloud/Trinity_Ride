const mysql = require('mysql2/promise');
require('dotenv').config();

// Connection pool — reused across requests rather than opening a new
// connection per query. Matches the tables in trinity_ride_schema.sql.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // TiDB Cloud requires a secure connection. Turned on only when DB_SSL=true.
  ssl: process.env.DB_SSL === 'true'
    ? { minVersion: 'TLSv1.2', rejectUnauthorized: true }
    : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;