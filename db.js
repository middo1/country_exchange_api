// db.js
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'shortline.proxy.rlwy.net',
  port: process.env.DB_PORT || 29334,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'UFgTsXwANVoEdgrfcnVODndcaHReuYvC',
  database: process.env.DB_DATABASE || 'railway',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00'
});

export default pool;

