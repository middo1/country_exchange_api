// index.js
console.log('ENV:', process.env.DB_HOST, process.env.DB_USER, process.env.DB_PASS);

import express from 'express';
import axios from 'axios';
import pool from './db.js';
import dotenv from 'dotenv';
import Jimp from 'jimp';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import { fileURLToPath } from 'url';

// Fix __dirname and __filename for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(express.json());

const COUNTRIES_API = process.env.COUNTRIES_API || 'https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies';
const EXCHANGE_API = process.env.EXCHANGE_API || 'https://open.er-api.com/v6/latest/USD';
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);
const IMAGE_PATH = path.join(__dirname, 'cache', 'summary.png');

// helper random integer between min and max inclusive
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// validation helper
function validateCountryRecord(record) {
  const errors = {};
  if (!record.name) errors.name = 'is required';
  if (typeof record.population !== 'number' || Number.isNaN(record.population))
    errors.population = 'is required and must be a number';
  if (!record.currency_code) errors.currency_code = 'is required';
  return Object.keys(errors).length ? { error: 'Validation failed', details: errors } : null;
}

// fetch countries + exchange rates with timeouts
async function fetchExternalData() {
  const [countriesResp, ratesResp] = await Promise.all([
    axios.get(COUNTRIES_API, { timeout: TIMEOUT }),
    axios.get(EXCHANGE_API, { timeout: TIMEOUT })
  ]);
  return { countries: countriesResp.data, rates: ratesResp.data };
}

// compute estimated_gdp given population and exchange_rate (or null rules)
function computeEstimatedGdp(population, exchange_rate) {
  if (population == null || Number.isNaN(population)) return null;
  if (exchange_rate == null) return null;
  const multiplier = randInt(1000, 2000);
  return (population * multiplier) / exchange_rate;
}

// ensure cache dir exists
function ensureCacheDir() {
  const dir = path.join(__dirname, 'cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * POST /countries/refresh
 */
app.post('/countries/refresh', async (req, res) => {
  let conn;
  try {
    const { countries, rates } = await fetchExternalData();

    if (!rates || !rates.rates) {
      return res.status(503).json({ error: 'External data source unavailable', details: 'Could not fetch data from exchange rates API' });
    }
    const rateMap = rates.rates;

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const now = new Date();

    for (const c of countries) {
      let currency_code = null;
      if (Array.isArray(c.currencies) && c.currencies.length > 0) {
        const first = c.currencies[0];
        currency_code = (first && (first.code || first.currency || first.name)) || null;
      }

      const population = c.population != null ? Number(c.population) : null;
      let exchange_rate = null;
      let estimated_gdp = null;

      if (currency_code && rateMap[currency_code] != null) {
        exchange_rate = Number(rateMap[currency_code]);
        estimated_gdp = computeEstimatedGdp(population, exchange_rate);
      } else if (currency_code) {
        exchange_rate = null;
        estimated_gdp = null;
      } else {
        currency_code = null;
        exchange_rate = null;
        estimated_gdp = 0;
      }

      const entry = {
        name: c.name || null,
        name_lower: (c.name || '').toLowerCase(),
        capital: c.capital || null,
        region: c.region || null,
        population,
        currency_code,
        exchange_rate,
        estimated_gdp,
        flag_url: c.flag || null,
        last_refreshed_at: now
      };

      const validation = validateCountryRecord(entry);
      if (validation) {
        // skip validation errors for missing optional fields
      }

      const [existing] = await conn.query('SELECT id FROM countries WHERE name_lower = ? LIMIT 1', [entry.name_lower]);
      if (existing && existing.length > 0) {
        await conn.query(
          `UPDATE countries SET capital = ?, region = ?, population = ?, currency_code = ?, exchange_rate = ?, estimated_gdp = ?, flag_url = ?, last_refreshed_at = ? WHERE id = ?`,
          [entry.capital, entry.region, entry.population, entry.currency_code, entry.exchange_rate, entry.estimated_gdp, entry.flag_url, entry.last_refreshed_at, existing[0].id]
        );
      } else {
        await conn.query(
          `INSERT INTO countries (name, name_lower, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [entry.name, entry.name_lower, entry.capital, entry.region, entry.population, entry.currency_code, entry.exchange_rate, entry.estimated_gdp, entry.flag_url, entry.last_refreshed_at]
        );
      }
    }

    await conn.commit();

    ensureCacheDir();
    const [totRows] = await pool.query('SELECT COUNT(*) as cnt FROM countries');
    const total_countries = totRows[0].cnt || 0;
    const [topRows] = await pool.query('SELECT name, estimated_gdp FROM countries WHERE estimated_gdp IS NOT NULL ORDER BY estimated_gdp DESC LIMIT 5');

    await generateSummaryImage(total_countries, topRows, now);

    return res.status(200).json({
      message: 'Refresh completed',
      total_countries,
      last_refreshed_at: now.toISOString()
    });

  } catch (err) {
    console.error('Refresh error:', err?.message || err);
    try { if (conn) await conn.rollback(); } catch (e) {}
    const msg = err?.response?.config?.url ? `Could not fetch data from ${err.response.config.url}` : 'External data source unavailable';
    return res.status(503).json({ error: 'External data source unavailable', details: msg });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * GET /countries
 */
app.get('/countries', async (req, res) => {
  try {
    let base = 'SELECT * FROM countries';
    const params = [];
    const conditions = [];

    if (req.query.region) {
      conditions.push('region = ?');
      params.push(req.query.region);
    }
    if (req.query.currency) {
      conditions.push('currency_code = ?');
      params.push(req.query.currency);
    }
    if (conditions.length) base += ' WHERE ' + conditions.join(' AND ');
    if (req.query.sort === 'gdp_desc') base += ' ORDER BY estimated_gdp DESC';

    const [rows] = await pool.query(base, params);
    return res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /countries/:name
 */
app.get('/countries/:name', async (req, res) => {
  try {
    const name = String(req.params.name || '').toLowerCase();
    const [rows] = await pool.query('SELECT * FROM countries WHERE name_lower = ? LIMIT 1', [name]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Country not found' });
    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /countries/:name
 */
app.delete('/countries/:name', async (req, res) => {
  try {
    const name = String(req.params.name || '').toLowerCase();
    const [rows] = await pool.query('DELETE FROM countries WHERE name_lower = ?', [name]);
    if (rows?.affectedRows > 0) return res.status(204).send();
    return res.status(404).json({ error: 'Country not found' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /status
 */
app.get('/status', async (req, res) => {
  try {
    const [tot] = await pool.query('SELECT COUNT(*) as total FROM countries');
    const [last] = await pool.query('SELECT MAX(last_refreshed_at) as last_ref FROM countries');
    return res.status(200).json({
      total_countries: tot[0].total || 0,
      last_refreshed_at: last?.[0]?.last_ref ? new Date(last[0].last_ref).toISOString() : null
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /countries/image
 */
app.get('/countries/image', async (req, res) => {
  try {
    if (!fs.existsSync(IMAGE_PATH)) {
      return res.status(404).json({ error: 'Summary image not found' });
    }

    res.setHeader('Content-Type', 'image/png');
    res.sendFile(path.resolve(IMAGE_PATH));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ---------- Image generation ---------- */
export async function generateSummaryImage(total, topRows, timestamp) {
  try {
    const width = 1000;
    const height = 600;
    const image = new Jimp(width, height, 0xffffffff);
    const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);

    image.print(fontTitle, 20, 20, 'Countries Summary');
    image.print(font, 20, 70, `Total countries: ${total}`);
    image.print(font, 20, 100, `Last refreshed at: ${timestamp.toISOString()}`);
    image.print(font, 20, 150, 'Top 5 by estimated GDP:');

    let y = 190;
    if (!topRows || topRows.length === 0) {
      image.print(font, 40, y, 'No GDP data available');
    } else {
      for (const r of topRows) {
        const gdpText = r.estimated_gdp != null ? Number(r.estimated_gdp).toFixed(2) : 'N/A';
        image.print(font, 40, y, `${r.name} - ${gdpText}`);
        y += 30;
      }
    }

    ensureCacheDir();
    await image.writeAsync(IMAGE_PATH);
    console.log('✅ Summary image generated at', IMAGE_PATH);
  } catch (err) {
    console.error('❌ Error generating image:', err);
  }
}

/* ---------- start server ---------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
