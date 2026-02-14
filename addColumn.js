const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("database.db");

db.serialize(() => {
  db.run(
    "ALTER TABLE tshirts ADD COLUMN purchase_date TEXT",
    (err) => {
      if (err) {
        if (/duplicate column/i.test(err.message)) {
          console.log("Column 'purchase_date' already exists!");
        } else {
          console.error("Error:", err.message);
        }
      } else {
        console.log("Column 'purchase_date' added successfully!");
      }
    }
  );
});

db.close();
