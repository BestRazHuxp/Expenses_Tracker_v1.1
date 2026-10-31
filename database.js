const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const db = new DatabaseSync(path.join(__dirname, "database.sqlite"));

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS categories (
    category_id INTEGER PRIMARY KEY NOT NULL,
    name TEXT,
    limit_amount REAL,
    is_deleted BOOL
  );

  CREATE TABLE IF NOT EXISTS current_categories (
    category_id INTEGER NOT NULL,
    name TEXT,
    limit_amount REAL,
    is_deleted BOOL,
    date TEXT,
    PRIMARY KEY (category_id, date)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    amount REAL NOT NULL,
    category_id INTEGER,
    coefficient INTEGER NOT NULL CHECK (coefficient IN (1, -1)),
    date TEXT,
    note TEXT,
    FOREIGN KEY (category_id) REFERENCES categories(category_id)
  );
`);

const currentCategoryColumns = db.prepare("PRAGMA table_info(current_categories)").all();
if (!currentCategoryColumns.some((column) => column.name === "date")) {
  db.exec("ALTER TABLE current_categories ADD COLUMN date TEXT");
}

if (!currentCategoryColumns.some((column) => column.name === "date" && column.pk === 2)) {
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`
      CREATE TABLE current_categories_new (
        category_id INTEGER NOT NULL,
        name TEXT,
        limit_amount REAL,
        is_deleted BOOL,
        date TEXT,
        PRIMARY KEY (category_id, date)
      );
      INSERT INTO current_categories_new (category_id, name, limit_amount, is_deleted, date)
      SELECT category_id, name, limit_amount, is_deleted, date FROM current_categories;
      DROP TABLE current_categories;
      ALTER TABLE current_categories_new RENAME TO current_categories;
      COMMIT;
    `);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = db;
