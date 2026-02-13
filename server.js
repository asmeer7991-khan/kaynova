// server.js
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static("public"));

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";

// === DB ===
const db = new sqlite3.Database("database.db");
db.serialize(() => {
 db.run(`
  CREATE TABLE IF NOT EXISTS users (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   username TEXT UNIQUE NOT NULL,
   password_hash TEXT NOT NULL,
   role TEXT NOT NULL DEFAULT 'user'
  )
 `);

 // Each purchase creates one row in tshirts
 db.run(`
  CREATE TABLE IF NOT EXISTS tshirts (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   name TEXT NOT NULL,
   color TEXT NOT NULL,
   size TEXT NOT NULL,
   original_qty INTEGER NOT NULL,
   quantity INTEGER NOT NULL,
   purchase_price REAL NOT NULL,
   section TEXT NOT NULL CHECK(section IN ('MOM','KAYNOVA')),
   user_id INTEGER NOT NULL,
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   FOREIGN KEY(user_id) REFERENCES users(id)
  )
 `);

 // Each sell creates one row in sales
 db.run(`
  CREATE TABLE IF NOT EXISTS sales (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   tshirt_id INTEGER NOT NULL,
   user_id INTEGER NOT NULL,
   qty INTEGER NOT NULL,
   unit_purchase REAL NOT NULL,
   unit_selling REAL NOT NULL,
   profit REAL NOT NULL,
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   FOREIGN KEY(tshirt_id) REFERENCES tshirts(id),
   FOREIGN KEY(user_id) REFERENCES users(id)
  )
 `);
});

// === Auth middleware ===
function auth(req, res, next) {
 const hdr = req.headers.authorization || "";
 const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
 if (!token) return res.status(401).send({ message: "No token" });
 try {
  req.user = jwt.verify(token, JWT_SECRET);
  next();
 } catch {
  res.status(401).send({ message: "Invalid token" });
 }
}

// === Auth routes ===
app.post("/auth/register", (req, res) => {
 const { username, password, role } = req.body || {};
 if (!username || !password) return res.status(400).send({ message: "username & password required" });
 const pass = bcrypt.hashSync(password, 10);
 const userRole = role === "admin" ? "admin" : "user";
 db.run(
  "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  [username, pass, userRole],
  function (err) {
   if (err) {
    if (/UNIQUE/i.test(err.message)) return res.status(409).send({ message: "username taken" });
    return res.status(500).send({ error: err.message });
   }
   const payload = { id: this.lastID, username, role: userRole };
   const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
   res.send({ token, user: payload });
  }
 );
});

app.post("/auth/login", (req, res) => {
 const { username, password } = req.body || {};
 if (!username || !password) return res.status(400).send({ message: "username & password required" });
 db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
  if (err) return res.status(500).send({ error: err.message });
  if (!row) return res.status(401).send({ message: "invalid credentials" });
  const ok = bcrypt.compareSync(password, row.password_hash);
  if (!ok) return res.status(401).send({ message: "invalid credentials" });
  const payload = { id: row.id, username: row.username, role: row.role };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
  res.send({ token, user: payload });
 });
});

// === PURCHASE (no selling price here) ===
app.post("/purchase", auth, (req, res) => {
 const { name, color, size, quantity, purchase_price, total_purchase_price, section } = req.body || {};
 const qty = Number(quantity);
 const pBuy = Number(purchase_price);
 const sec = (section || "").toUpperCase();

 if (!name || !color || !size || !["MOM","KAYNOVA"].includes(sec))
  return res.status(400).send({ message: "invalid input" });
 if (!Number.isInteger(qty) || qty <= 0)
  return res.status(400).send({ message: "quantity invalid" });
 if (!(pBuy > 0))
  return res.status(400).send({ message: "purchase price invalid" });

 db.run(
  `INSERT INTO tshirts (name,color,size,original_qty,quantity,purchase_price,section,user_id)
   VALUES (?,?,?,?,?,?,?,?)`,
  [name, color, size, qty, qty, pBuy, sec, req.user.id],
  function (err) {
   if (err) return res.status(500).send({ error: err.message });
   res.send({ message: "Purchase saved", id: this.lastID });
  }
 );
});

// === STOCK for Sell page ===
app.get("/stock", auth, (req, res) => {
 const section = (req.query.section || "").toUpperCase();
 const clauses = [];
 const params = [];
 if (req.user.role !== "admin") { clauses.push("user_id = ?"); params.push(req.user.id); }
 if (["MOM","KAYNOVA"].includes(section)) { clauses.push("section = ?"); params.push(section); }
 const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
 db.all(`SELECT id,name,size,quantity,purchase_price,original_qty FROM tshirts ${where} ORDER BY id DESC`, params, (err, rows) => {
  if (err) return res.status(500).send({ error: err.message });
  res.send(rows);
 });
});

// === SELL (accepts { qty, sell_price }) ===
app.post("/sell/:id", auth, (req, res) => {
 const id = Number(req.params.id);
 const qty = Number(req.body?.qty);
 const sellPrice = Number(req.body?.sell_price);

 if (!Number.isInteger(id) || !Number.isInteger(qty) || qty <= 0)
  return res.status(400).send({ message: "invalid id/qty" });
 if (!(sellPrice > 0))
  return res.status(400).send({ message: "sell price invalid" });

 const ownFilter = req.user.role === "admin" ? "" : " AND user_id = ?";
 const ownParam = req.user.role === "admin" ? [] : [req.user.id];

 db.get(
  `SELECT id, quantity, purchase_price FROM tshirts WHERE id = ?${ownFilter}`,
  [id, ...ownParam],
  (err, row) => {
   if (err) return res.status(500).send({ error: err.message });
   if (!row) return res.send({ message: "Not found or not yours" });
   if (row.quantity < qty) return res.send({ message: "Not enough stock" });

   const profit = qty * (sellPrice - row.purchase_price);
   const newQty = row.quantity - qty;

   db.run("UPDATE tshirts SET quantity = ? WHERE id = ?", [newQty, id], function (err2) {
    if (err2) return res.status(500).send({ error: err2.message });
    db.run(
     `INSERT INTO sales (tshirt_id,user_id,qty,unit_purchase,unit_selling,profit)
      VALUES (?,?,?,?,?,?)`,
     [id, req.user.id, qty, row.purchase_price, sellPrice, profit],
     () => {
      const remaining_amount = newQty * row.purchase_price;
      res.send({
       message: "Sold",
       sold_qty: qty,
       profit,
       remaining_qty: newQty,
       remaining_amount
      });
     }
    );
   });
  }
 );
});

// === PROFIT DETAILS (items + totals) ===
app.get("/profit/details", auth, (req, res) => {
 const section = (req.query.section || "").toUpperCase();
 const conds = [];
 const params = [];

 if (req.user.role !== "admin") { conds.push("t.user_id = ?"); params.push(req.user.id); }
 if (["MOM","KAYNOVA"].includes(section)) { conds.push("t.section = ?"); params.push(section); }

 const where = conds.length ? "WHERE " + conds.join(" AND ") : "";

 const sql = `
  SELECT
   t.id, t.name, t.size, t.original_qty, t.quantity, t.purchase_price,
   COALESCE(SUM(s.qty),0) AS sold_qty,
   COALESCE(SUM(s.qty * s.unit_selling),0) AS sold_revenue,
   COALESCE(SUM(s.profit),0) AS profit
  FROM tshirts t
  LEFT JOIN sales s ON s.tshirt_id = t.id
  ${where}
  GROUP BY t.id
  ORDER BY t.id DESC
 `;

 db.all(sql, params, (err, rows) => {
  if (err) return res.status(500).send({ error: err.message });

  const items = rows.map(r => ({
   name: r.name,
   size: r.size,
   purchased_qty: r.original_qty,
   purchased_cost: r.original_qty * r.purchase_price,
   sold_qty: r.sold_qty,
   sold_revenue: r.sold_revenue,
   profit: r.profit,
   remaining_qty: r.quantity,
   remaining_value: r.quantity * r.purchase_price
  }));

  const totals = items.reduce((acc, it) => {
   acc.purchased_qty += it.purchased_qty;
   acc.purchased_cost += it.purchased_cost;
   acc.sold_qty += it.sold_qty;
   acc.sold_revenue += it.sold_revenue;
   acc.profit += it.profit;
   acc.remaining_qty += it.remaining_qty;
   acc.remaining_value += it.remaining_value;
   return acc;
  }, { purchased_qty:0, purchased_cost:0, sold_qty:0, sold_revenue:0, profit:0, remaining_qty:0, remaining_value:0 });

  res.send({ items, totals });
 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
``
