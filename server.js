
const multer = require("multer");
// server.js
const express = require("express");
//const Database = require('better-sqlite3');
const Database = require('better-sqlite3');
const dbFile = process.env.DB_FILE || "database.db";
const db = new Database(dbFile); // adjust file name

//const info = db.prepare("PRAGMA table_info(tshirts);").all();
//console.log(info);

const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

const storage = multer.diskStorage({
 destination: function (req, file, cb) {
  cb(null, "uploads/");
 },
 filename: function (req, file, cb) {
  cb(null, Date.now() + "-" + file.originalname);
 }
});

const upload = multer({ storage: storage });

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";

// === DB ===
//const db = new sqlite3.Database("database.db");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user'
);

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
 purchase_date TEXT,
 image TEXT,
 FOREIGN KEY(user_id) REFERENCES users(id)
 
);

CREATE TABLE IF NOT EXISTS sales (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 tshirt_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 qty INTEGER NOT NULL,
 unit_purchase REAL NOT NULL,
 unit_selling REAL NOT NULL,
 profit REAL NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 sell_date TEXT,
 FOREIGN KEY(tshirt_id) REFERENCES tshirts(id),
 FOREIGN KEY(user_id) REFERENCES users(id)
);
`);


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
 try {
  const result = db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)"
  ).run(username, pass, userRole);

  const payload = { id: result.lastInsertRowid, username, role: userRole };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
  res.send({ token, user: payload });
} catch (err) {
  if (/UNIQUE/i.test(err.message)) return res.status(409).send({ message: "username taken" });
  res.status(500).send({ error: err.message });
}
});

app.post("/auth/login", (req, res) => {
 const { username, password } = req.body || {};
 if (!username || !password) return res.status(400).send({ message: "username & password required" });
try {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

  if (!row) return res.status(401).send({ message: "invalid credentials" });
  if (!bcrypt.compareSync(password, row.password_hash))
    return res.status(401).send({ message: "invalid credentials" });

  const payload = { id: row.id, username: row.username, role: row.role };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
  res.send({ token, user: payload });
} catch (err) {
  res.status(500).send({ error: err.message });
}
});

// === PURCHASE (no selling price here) ===
app.post("/purchase", auth, upload.single("image"), (req, res) => {
 //const { name, color, size, quantity, purchase_price, total_purchase_price, section } = req.body || {};
 const {
 name,
 color,
 size,
 quantity,
 purchase_price,
 total_purchase_price,
 section,
 purchase_date
} = req.body || {};
 const qty = Number(quantity);
 const pBuy = Number(purchase_price);
 const sec = (section || "").toUpperCase();
 if (!["MOM","KAYNOVA"].includes(sec)) return res.status(400).send({ message: "invalid input" });

 if (!name || !color || !size || !["MOM","KAYNOVA"].includes(sec))
  return res.status(400).send({ message: "invalid input" });
 if (!Number.isInteger(qty) || qty <= 0)
  return res.status(400).send({ message: "quantity invalid" });
 if (!(pBuy > 0))
  return res.status(400).send({ message: "purchase price invalid" });

try {
  const image = req.file ? "/uploads/" + req.file.filename : null;

const result = db.prepare(
 `INSERT INTO tshirts 
 (name,color,size,original_qty,quantity,purchase_price,section,user_id,purchase_date,image)
 VALUES (?,?,?,?,?,?,?,?,?,?)`
).run(name, color, size, qty, qty, pBuy, sec, req.user.id, purchase_date, image);

  res.send({ message: "Purchase saved", id: result.lastInsertRowid });
} catch(err) {
  res.status(500).send({ error: err.message });
}
});

app.delete("/purchase/:id", auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send({ message: "Invalid id" });

  try {
    // only allow delete if quantity === 0
    const row = db.prepare("SELECT quantity FROM tshirts WHERE id = ? AND user_id = ?")
                  .get(id, req.user.id);
    if (!row) return res.status(404).send({ message: "Purchase not found" });
    if (row.quantity > 0) return res.status(400).send({ message: "Cannot delete, quantity > 0" });

    db.prepare("DELETE FROM tshirts WHERE id = ?").run(id);
    res.send({ message: "Purchase deleted ✅" });

  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

// get all sales (for logged in user)
app.get("/sales", auth, (req, res) => {
  const section = (req.query.section || "").toUpperCase(); // get section from query
  const userFilter = req.user.role === "admin" ? "" : "WHERE s.user_id = ?";
  const params = req.user.role === "admin" ? [] : [req.user.id];

  let sectionFilter = "";
  if (["MOM", "KAYNOVA"].includes(section)) {
    sectionFilter = userFilter ? ` AND t.section = ?` : `WHERE t.section = ?`;
    params.push(section);
  }

try {
  const rows = db.prepare(`
    SELECT s.id, s.qty, s.unit_selling, s.profit, s.sell_date, t.name as tshirt_name
    FROM sales s
    JOIN tshirts t ON t.id = s.tshirt_id
    ${userFilter}${sectionFilter}
    ORDER BY s.id DESC
  `).all(...params);
  res.send(rows);
} catch(err) {
  res.status(500).send({ error: err.message });
}
});

// === STOCK for Sell page ===
app.get("/stock", auth, (req, res) => {
 const section = (req.query.section || "").toUpperCase();
 const clauses = [];
 const params = [];
 if (req.user.role !== "admin") { clauses.push("user_id = ?"); params.push(req.user.id); }
 if (["MOM","KAYNOVA"].includes(section)) { clauses.push("section = ?"); params.push(section); }
 const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
try {
  const rows = db.prepare(`SELECT id,name,color,size,quantity,purchase_price,original_qty,purchase_date,image FROM tshirts ${where} ORDER BY id DESC`).all(...params);
  res.send(rows);
} catch(err) {
  res.status(500).send({ error: err.message });
}
});

// === SELL (accepts { qty, sell_price }) ===
app.post("/sell/:id", auth, (req, res) => {
  const id = Number(req.params.id);
  const qty = Number(req.body?.qty);
  const sellPrice = Number(req.body?.sell_price);
  const sellDate = req.body?.sell_date || new Date().toISOString();

  // validation
  if (!Number.isInteger(id) || !Number.isInteger(qty) || qty <= 0)
    return res.status(400).send({ message: "invalid id/qty" });
  if (!(sellPrice > 0))
    return res.status(400).send({ message: "sell price invalid" });

  const ownFilter = req.user.role === "admin" ? "" : " AND user_id = ?";
  const ownParam = req.user.role === "admin" ? [] : [req.user.id];

  try {
    const row = db.prepare(`SELECT id, quantity, purchase_price FROM tshirts WHERE id = ?${ownFilter}`).get(id, ...ownParam);
    if (!row) return res.status(404).send({ message: "Item not found or not yours" });
    if (row.quantity < qty) return res.status(400).send({ message: "Not enough stock" });

    const profit = qty * (sellPrice - row.purchase_price);
    const newQty = row.quantity - qty;

    db.prepare("UPDATE tshirts SET quantity = ? WHERE id = ?").run(newQty, id);
    db.prepare(`INSERT INTO sales 
      (tshirt_id,user_id,qty,unit_purchase,unit_selling,profit,sell_date)
      VALUES (?,?,?,?,?,?,?)`).run(id, req.user.id, qty, row.purchase_price, sellPrice, profit, sellDate);

    const remaining_amount = newQty * row.purchase_price;
    res.send({ message: "Sold successfully", sold_qty: qty, profit, remaining_qty: newQty, remaining_amount, sell_date: sellDate });

  } catch(err) {
    res.status(500).send({ error: err.message });
  }
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

  try {
    // get rows synchronously using better-sqlite3
    const rows = db.prepare(sql).all(...params);

    // map each row to items
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

    // calculate totals
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

  } catch(err) {
    res.status(500).send({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
``
