# POS & Inventory System — Backend API

Offline-first REST API built with Node.js + Express + SQLite + Supabase.

---

## 🚀 Setup & Run

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `JWT_SECRET` — any long random string
- `SUPABASE_URL` — from your Supabase project settings
- `SUPABASE_SERVICE_KEY` — service role key (not anon key)

### 3. Set up Supabase
Run the SQL in `src/db/supabase_schema.sql` in your **Supabase SQL Editor**.

### 4. Run migrations & seed
```bash
npm run migrate   # Creates local SQLite tables
npm run seed      # Adds sample products + users
```

### 5. Start the server
```bash
npm run dev       # Development (with auto-reload)
npm start         # Production
```

Server runs at: `http://localhost:3001`

### 6. Run tests
```bash
npm test
```

---

## 🔑 Default Credentials (after seeding)
| Role    | Email                    | Password    |
|---------|--------------------------|-------------|
| Admin   | admin@posystem.com       | password123 |
| Cashier | cashier@posystem.com     | password123 |

---

## 📡 API Endpoints

### Auth
| Method | Endpoint           | Access  |
|--------|--------------------|---------|
| POST   | /api/auth/login    | Public  |
| POST   | /api/auth/register | Admin   |
| GET    | /api/auth/me       | All     |

### Products
| Method | Endpoint                      | Access  |
|--------|-------------------------------|---------|
| GET    | /api/products                 | All     |
| GET    | /api/products/:id             | All     |
| GET    | /api/products/barcode/:code   | All     |
| POST   | /api/products                 | Admin   |
| PUT    | /api/products/:id             | Admin   |
| PATCH  | /api/products/:id/stock       | Admin   |
| DELETE | /api/products/:id             | Admin   |

### Sales
| Method | Endpoint                       | Access  |
|--------|--------------------------------|---------|
| GET    | /api/sales                     | All     |
| POST   | /api/sales                     | All     |
| GET    | /api/sales/:id                 | All     |
| GET    | /api/sales/receipt/:number     | All     |
| POST   | /api/sales/:id/void            | Admin   |
| GET    | /api/sales/summary/today       | All     |

### Sync
| Method | Endpoint           | Access  |
|--------|--------------------|---------|
| POST   | /api/sync          | All     |
| GET    | /api/sync/status   | All     |
| GET    | /api/sync/health   | All     |
| POST   | /api/sync/retry    | Admin   |

---

## 🔄 Sync Architecture

```
Local SQLite (source of truth)
       ↓ every 30s (auto) or POST /api/sync (manual)
   Sync Engine
    ├── PUSH unsynced records → Supabase
    └── PULL cloud changes → Local (last-write-wins)
```

All operations work **fully offline**. The sync engine handles retries automatically.

---

## 📁 Project Structure
```
backend/
├── src/
│   ├── controllers/     # Route handlers
│   ├── db/
│   │   ├── localDb.js       # SQLite singleton
│   │   ├── supabase.js      # Supabase client
│   │   ├── migrate.js       # SQLite schema
│   │   ├── supabase_schema.sql
│   │   └── seed.js          # Sample data
│   ├── middleware/      # Auth middleware
│   ├── routes/          # API route definitions
│   └── services/
│       └── syncEngine.js    # Offline sync logic
├── tests/
├── .env.example
└── package.json
```
# backend-pos
# backend-pos
