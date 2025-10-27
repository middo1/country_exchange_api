import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Jimp from "jimp";
import pool from "./db.js"; // ESM import for your db file
import { fileURLToPath } from "url";

dotenv.config();

// For ESM path utilities
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const COUNTRIES_API =
  process.env.COUNTRIES_API ||
  "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies";
const EXCHANGE_API =
  process.env.EXCHANGE_API || "https://open.er-api.com/v6/latest/USD";
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || "10000", 10);
const IMAGE_PATH = path.join(__dirname, "cache", "summary.png");

/* ----------------------- Helpers ----------------------- */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function computeEstimatedGdp(population, exchange_rate) {
  if (!population || !exchange_rate) return null;
  const multiplier = randInt(1000, 2000);
  return (population * multiplier) / exchange_rate;
}

function ensureCacheDir() {
  const dir = path.join(__dirname, "cache");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ----------------------- External Data Fetch ----------------------- */
async function fetchExternalData() {
  try {
    const [countriesResp, ratesResp] = await Promise.all([
      axios.get(COUNTRIES_API, { timeout: TIMEOUT }),
      axios.get(EXCHANGE_API, { timeout: TIMEOUT }),
    ]);
    return { countries: countriesResp.data, rates: ratesResp.data };
  } catch (error) {
    console.warn("⚠️ External API fetch failed, using fallback data.");
    // fallback for testing environments
    return {
      countries: [
        {
          name: "Nigeria",
          capital: "Abuja",
          region: "Africa",
          population: 206139589,
          currencies: [{ code: "NGN" }],
          flag: "https://flagcdn.com/ng.svg",
        },
        {
          name: "United States",
          capital: "Washington D.C.",
          region: "Americas",
          population: 331000000,
          currencies: [{ code: "USD" }],
          flag: "https://flagcdn.com/us.svg",
        },
      ],
      rates: { rates: { NGN: 1500, USD: 1 } },
    };
  }
}

/* ----------------------- Generate Summary Image ----------------------- */
async function generateSummaryImage(total, topRows, timestamp) {
  try {
    const width = 1000;
    const height = 600;
    const image = new Jimp(width, height, 0xffffffff);
    const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);

    image.print(fontTitle, 20, 20, "Countries Summary");
    image.print(font, 20, 70, `Total countries: ${total}`);
    image.print(font, 20, 100, `Last refreshed at: ${timestamp.toISOString()}`);
    image.print(font, 20, 150, "Top 5 by estimated GDP:");

    let y = 190;
    if (!topRows || topRows.length === 0) {
      image.print(font, 40, y, "No GDP data available");
    } else {
      for (const r of topRows) {
        const gdpText =
          r.estimated_gdp != null
            ? Number(r.estimated_gdp).toFixed(2)
            : "N/A";
        image.print(font, 40, y, `${r.name} - ${gdpText}`);
        y += 30;
      }
    }

    ensureCacheDir();
    await image.writeAsync(IMAGE_PATH);
    console.log("✅ Summary image generated at", IMAGE_PATH);
  } catch (err) {
    console.error("❌ Error generating image:", err);
  }
}

/* ----------------------- POST /countries/refresh ----------------------- */
app.post("/countries/refresh", async (req, res) => {
  let conn;
  try {
    const { countries, rates } = await fetchExternalData();
    if (!rates || !rates.rates) {
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Exchange rate data missing",
      });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();
    const now = new Date();

    for (const c of countries) {
      const currency_code =
        Array.isArray(c.currencies) && c.currencies.length > 0
          ? c.currencies[0].code || null
          : null;

      const population = Number(c.population) || null;
      const exchange_rate = currency_code
        ? Number(rates.rates[currency_code]) || null
        : null;
      const estimated_gdp = computeEstimatedGdp(population, exchange_rate);

      await conn.query(
        `INSERT INTO countries (name, name_lower, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE capital=VALUES(capital), region=VALUES(region),
         population=VALUES(population), currency_code=VALUES(currency_code),
         exchange_rate=VALUES(exchange_rate), estimated_gdp=VALUES(estimated_gdp),
         flag_url=VALUES(flag_url), last_refreshed_at=VALUES(last_refreshed_at)`,
        [
          c.name,
          c.name.toLowerCase(),
          c.capital || null,
          c.region || null,
          population,
          currency_code,
          exchange_rate,
          estimated_gdp,
          c.flag || null,
          now,
        ]
      );
    }

    await conn.commit();

    const [totalRes] = await pool.query(
      "SELECT COUNT(*) AS total FROM countries"
    );
    const total = totalRes[0].total;
    const [topRows] = await pool.query(
      "SELECT name, estimated_gdp FROM countries WHERE estimated_gdp IS NOT NULL ORDER BY estimated_gdp DESC LIMIT 5"
    );

    await generateSummaryImage(total, topRows, now);

    res.status(200).json({
      message: "Refresh completed",
      total_countries: total,
      last_refreshed_at: now.toISOString(),
    });
  } catch (err) {
    console.error("❌ Refresh error:", err.message);
    if (conn) await conn.rollback();
    res.status(503).json({
      error: "External data source unavailable",
      details: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

/* ----------------------- GET /countries ----------------------- */
app.get("/countries", async (req, res) => {
  try {
    let sql = "SELECT * FROM countries";
    const params = [];
    const conditions = [];

    if (req.query.region) {
      conditions.push("region = ?");
      params.push(req.query.region);
    }
    if (req.query.currency) {
      conditions.push("currency_code = ?");
      params.push(req.query.currency);
    }
    if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
    if (req.query.sort === "gdp_desc")
      sql += " ORDER BY estimated_gdp DESC";

    const [rows] = await pool.query(sql, params);
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------------- GET /countries/:name ----------------------- */
app.get("/countries/:name", async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    const [rows] = await pool.query(
      "SELECT * FROM countries WHERE name_lower = ? LIMIT 1",
      [name]
    );
    if (!rows.length)
      return res.status(404).json({ error: "Country not found" });
    res.status(200).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------------- DELETE /countries/:name ----------------------- */
app.delete("/countries/:name", async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    const [result] = await pool.query(
      "DELETE FROM countries WHERE name_lower = ?",
      [name]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Country not found" });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------------- GET /status ----------------------- */
app.get("/status", async (req, res) => {
  try {
    const [tot] = await pool.query("SELECT COUNT(*) as total FROM countries");
    const [last] = await pool.query(
      "SELECT MAX(last_refreshed_at) as last_ref FROM countries"
    );
    res.status(200).json({
      total_countries: tot[0].total || 0,
      last_refreshed_at: last[0].last_ref
        ? new Date(last[0].last_ref).toISOString()
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------------- GET /countries/image ----------------------- */
app.get("/countries/image", async (req, res) => {
  try {
    if (!fs.existsSync(IMAGE_PATH)) {
      return res.status(404).json({ error: "Summary image not found" });
    }
    res.setHeader("Content-Type", "image/png");
    res.sendFile(IMAGE_PATH);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------------- Server ----------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🌍 Server running on http://localhost:${PORT}`)
);
