## 🌍 Country Exchange API

A RESTful API built with **Node.js**, **Express**, and **MySQL** that fetches and stores country data, computes estimated GDP, and provides CRUD endpoints.

---

### 🚀 Features

* Fetch countries from external APIs
* Match currencies with exchange rates
* Compute and store `estimated_gdp`
* Filter and sort countries by region, currency, or GDP
* Generate a summary image of top countries
* MySQL database caching

---

### ⚙️ Setup

#### 1. Clone and install

```bash
git clone https://github.com/your-username/country-exchange-api.git
cd country-exchange-api
npm install
```

#### 2. Create `.env`

```bash
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=your_mysql_password
DB_DATABASE=countries_db
PORT=5000
```

#### 3. Set up MySQL

```sql
CREATE DATABASE countries_db;
```

---

### ▶️ Run the app

```bash
npm start
```

or for development:

```bash
npm run dev
```

App runs on:
👉 **[http://localhost:5000](http://localhost:5000)**

---

### 🧪 Endpoints

| Method   | Endpoint             | Description                           |
| -------- | -------------------- | ------------------------------------- |
| `POST`   | `/countries/refresh` | Fetch and cache all countries         |
| `GET`    | `/countries`         | Get all countries (with filters)      |
| `GET`    | `/countries/:name`   | Get country by name                   |
| `DELETE` | `/countries/:name`   | Delete a country                      |
| `GET`    | `/status`            | Get total count and last refresh time |
| `GET`    | `/countries/image`   | Get summary image                     |

**Filters:**
`?region=Africa` `?currency=USD` `?sort=gdp_desc`

---

### 🖼️ Summary Image

After `/countries/refresh`, an image is generated at:

```
cache/summary.png
```

It includes:

* Total countries
* Top 5 by GDP
* Last refresh timestamp

---

### 💾 Testing

To test endpoints, use **Postman** or **curl**, for example:

```bash
curl http://localhost:5000/countries
```

To run automatic tests:

```bash
npm run test-api
```

---

### 🧯 Troubleshooting

| Issue                    | Fix                                                   |
| ------------------------ | ----------------------------------------------------- |
| `require is not defined` | Use `"type": "module"` in `package.json`              |
| `Country not found`      | Run `/countries/refresh` first                        |
| Image not found          | Make sure `/countries/refresh` completed successfully |

---


