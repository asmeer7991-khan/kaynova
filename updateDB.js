const Database = require('better-sqlite3');
const db = new Database('database.sqlite'); // make sure this is the correct DB file

// check if 'image' column exists
const columns = db.prepare("PRAGMA table_info(tshirts);").all();
const hasImage = columns.some(c => c.name === "image");

if (hasImage) {
  console.log("Column 'image' already exists ✅");
} else {
  // add the column
  db.prepare("ALTER TABLE tshirts ADD COLUMN image TEXT;").run();
  console.log("Column 'image' added successfully ✅");
}

db.close();
