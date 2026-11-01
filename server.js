const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./database");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Update current_categories every_month {

    function updateCurrentCategories(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
    }).formatToParts(now);
    const year = parts.find((part) => part.type === "year").value;
    const month = parts.find((part) => part.type === "month").value;
    const date = `${year}-${month}-01`;

    return db.prepare(`
        INSERT INTO current_categories (category_id, name, limit_amount, date)
        SELECT category_id, name, limit_amount, ? FROM categories WHERE 1
        ON CONFLICT (category_id, date) DO NOTHING
    `).run(date);
    }

    function scheduleMonthlyCategoryUpdate() {
    // Vietnam is UTC+7. Calculate midnight on the first day of next month.
    const vietnamNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const nextMonth = Date.UTC(
        vietnamNow.getUTCFullYear(), vietnamNow.getUTCMonth() + 1, 1
    ) - 7 * 60 * 60 * 1000;

    function waitForNextMonth() {
        const remaining = nextMonth - Date.now();
        if (remaining > 0) {
        // Keep each timeout within Node.js's supported delay range.
        setTimeout(waitForNextMonth, Math.min(remaining, 24 * 60 * 60 * 1000)).unref();
        return;
        }

        try {
        updateCurrentCategories();
        scheduleMonthlyCategoryUpdate();
        } catch (error) {
        console.error("Could not update monthly categories:", error);
        setTimeout(waitForNextMonth, 60 * 1000).unref();
        }
    }

    waitForNextMonth();
    }

    scheduleMonthlyCategoryUpdate();
    
// }
function sendPostResult(req, res, status, data, message) {
  if (req.is("application/x-www-form-urlencoded")) {
    const alertMessage = JSON.stringify(`Status ${status}: ${message}`).replace(/</g, "\\u003c");
    return res.status(status).type("html").send(`<!DOCTYPE html>
      <html lang="vi"><head><meta charset="UTF-8"><title>Kết quả</title></head>
      <body><script>window.alert(${alertMessage}); window.location.replace("/");</script>
      <a href="/">Về trang chủ</a></body></html>`);
  }
  return res.status(status).json(data);
}
app.get("/api/categories", (req, res) => {
  try {
    const categories = db.prepare("SELECT * FROM categories").all();
    return res.json(categories);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not get categories" });
  }
});

app.get("/api/current_categories", (req, res) => {
  try {
    const categories = db.prepare("SELECT * FROM current_categories").all();
    return res.json(categories);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not get current categories" });
  }
});

app.get("/api/summary", (req, res) => {
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  if (
    typeof req.query.month !== "string" || typeof req.query.year !== "string" ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(year) || year < 1 || year > 9999
  ) {
    return res.status(400).json({ error: "month must be 1-12 and year must be 1-9999" });
  }

  const queriedMonth = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  res.vary("Accept");
  if (req.get("Accept")?.includes("text/html") && req.accepts(["html", "json"]) === "html") {
    return res.sendFile(path.join(__dirname, "summary.html"));
  }
  try {
    // ISO timestamps are converted to Vietnam time; date-only inputs retain their day.
    const transactions = db.prepare(`
      SELECT t.*, c.name AS category_name, date(t.date, '+7 hours') AS transaction_day
      FROM transactions t
      LEFT JOIN categories c ON c.category_id = t.category_id
      WHERE strftime('%Y-%m', t.date, '+7 hours') = ?
      ORDER BY transaction_day, t.date, t.id
    `).all(queriedMonth);
    const monthlyCategories = db.prepare(`
      SELECT * FROM current_categories WHERE substr(date, 1, 7) = ?
      ORDER BY category_id, date
    `).all(queriedMonth);

    const days = new Map();
    const categoryTotals = new Map();
    let totalIncome = 0;
    let totalExpense = 0;
    for (const transaction of transactions) {
      const income = transaction.coefficient === 1 ? transaction.amount : 0;
      const expense = transaction.coefficient === -1 ? transaction.amount : 0;
      totalIncome += income;
      totalExpense += expense;

      if (!days.has(transaction.transaction_day)) {
        days.set(transaction.transaction_day, {
          date: transaction.transaction_day, total_income: 0, total_expense: 0, transactions: [],
        });
      }
      const day = days.get(transaction.transaction_day);
      day.total_income += income;
      day.total_expense += expense;
      day.transactions.push(transaction);

      const totals = categoryTotals.get(transaction.category_id) || { total_income: 0, total_expense: 0 };
      totals.total_income += income;
      totals.total_expense += expense;
      categoryTotals.set(transaction.category_id, totals);
    }

    return res.json({
      month,
      year,
      total_income: totalIncome,
      total_expense: totalExpense,
      savings: totalIncome - totalExpense,
      savings_rate: totalIncome > 0 ? (totalIncome - totalExpense) / totalIncome * 100 : null,
      categories: monthlyCategories.map((category) => {
        const totals = categoryTotals.get(category.category_id) || { total_income: 0, total_expense: 0 };
        // monthlyCategories contains current_categories rows for queriedMonth.
        const limit_amount = category.limit_amount;
        return {
          ...category,
          ...totals,
          limit_amount,
          remaining_amount: limit_amount == null ? null : limit_amount - totals.total_expense,
          budget_usage_rate: limit_amount > 0 ? totals.total_expense / limit_amount * 100 : null,
        };
      }),
      days: Array.from(days.values()),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not get summary" });
  }
});

app.post("/api/categories", (req, res) => {
   const { name,limit_amount , change_current_categories } = req.body || {};
  try {
    db.exec("BEGIN TRANSACTION");
    const result = db.prepare(`
      INSERT INTO categories (name, limit_amount)
      VALUES (?, ?)
    `).run(name, limit_amount);
    const category_id = Number(result.lastInsertRowid);

    const dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const date = ["year", "month", "day"]
      .map((type) => dateParts.find((part) => part.type === type).value)
      .join("-");

    db.prepare(`
      INSERT INTO current_categories (category_id, name, limit_amount, date)
      VALUES (?, ?, ?, ?)
    `).run(category_id, name, limit_amount, date);
    db.exec("COMMIT");
    return sendPostResult(req, res, 201, {
      category_id,
      name,
      limit_amount,
    }, "Thêm danh mục thành công.");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    console.error(error);
    return sendPostResult(req, res, 500, { error: "Could not create category" }, "Không thể thêm danh mục.");
  }
});

app.patch("/api/categories", (req, res) => {
  const { id, limit_amount } = req.body || {};
  if (!Number.isSafeInteger(id) || typeof limit_amount !== "number" || !Number.isFinite(limit_amount)) {
    return res.status(400).json({ error: "id must be an integer and limit_amount must be a finite number" });
  }

  try {
    db.exec("BEGIN TRANSACTION");
    const result = db.prepare("UPDATE categories SET limit_amount = ? WHERE category_id = ?").run(limit_amount, id);
    if (!result.changes) {
      db.exec("ROLLBACK");
      return res.status(404).json({ error: "Category does not exist" });
    }

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit",
    }).formatToParts(new Date());
    const year = parts.find((part) => part.type === "year").value;
    const month = parts.find((part) => part.type === "month").value;
    const currentMonth = `${year}-${month}`;
    const currentResult = db.prepare(`
      UPDATE current_categories SET limit_amount = ?
      WHERE category_id = ? AND substr(date, 1, 7) = ?
    `).run(limit_amount, id, currentMonth);
    db.exec("COMMIT");
    return res.json({ id, limit_amount, updated_current_categories: currentResult.changes });
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    console.error(error);
    return res.status(500).json({ error: "Could not update category" });
  }
});

app.delete("/api/categories", (req, res) => {
  const { id } = req.body || {};
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: "id must be an integer" });
  }

  try {
    db.exec("BEGIN TRANSACTION");
    const category = db.prepare("SELECT category_id FROM categories WHERE category_id = ?").get(id);
    if (!category) {
      db.exec("ROLLBACK");
      return res.status(404).json({ error: "Category does not exist" });
    }

    const transactions = db.prepare("UPDATE transactions SET category_id = NULL WHERE category_id = ?").run(id);
    const currentCategories = db.prepare("DELETE FROM current_categories WHERE category_id = ?").run(id);
    db.prepare("DELETE FROM categories WHERE category_id = ?").run(id);
    db.exec("COMMIT");

    return res.json({
      id,
      deleted_current_categories: currentCategories.changes,
      updated_transactions: transactions.changes,
    });
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    console.error(error);
    return res.status(500).json({ error: "Could not delete category" });
  }
});

app.get("/api/transactions", (req, res) => {
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  if (
    (req.query.page !== undefined && typeof req.query.page !== "string") ||
    !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger((page - 1) * 10)
  ) {
    return res.status(400).json({ error: "page must be a positive integer" });
  }

  try {
    const total = db.prepare("SELECT COUNT(*) AS total FROM transactions").get().total;
    const transactions = db.prepare(`
      SELECT t.*, c.name AS category_name
      FROM transactions t
      LEFT JOIN categories c ON c.category_id = t.category_id
      ORDER BY datetime(t.date) DESC, t.id DESC
      LIMIT 10 OFFSET ?
    `).all((page - 1) * 10);
    return res.json({ page, page_size: 10, total, total_pages: Math.ceil(total / 10), transactions });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not get transactions" });
  }
});

app.patch("/api/transactions", (req, res) => {
  const { id, date, category_id, amount, coefficient, note } = req.body || {};
  if (
    !Number.isSafeInteger(id) ||
    typeof date !== "string" || date.trim() === "" ||
    (category_id !== null && !Number.isSafeInteger(category_id)) ||
    typeof amount !== "number" || !Number.isFinite(amount) ||
    ![1, -1].includes(coefficient) ||
    (note != null && typeof note !== "string")
  ) {
    return res.status(400).json({ error: "Invalid transaction data" });
  }

  try {
    const transactionDay = db.prepare("SELECT date(?, '+7 hours') AS day").get(date).day;
    if (!transactionDay) {
      return res.status(400).json({ error: "Invalid transaction date" });
    }
    const transactionMonth = transactionDay.slice(0, 7);

    db.exec("BEGIN TRANSACTION");
    const transaction = db.prepare("SELECT id FROM transactions WHERE id = ?").get(id);
    if (!transaction) {
      db.exec("ROLLBACK");
      return res.status(404).json({ error: "Transaction does not exist" });
    }

    if (category_id !== null) {
      const category = db.prepare("SELECT * FROM categories WHERE category_id = ?").get(category_id);
      if (!category) {
        db.exec("ROLLBACK");
        return res.status(400).json({ error: "Category does not exist" });
      }

      const currentCategory = db.prepare(`
        SELECT category_id FROM current_categories
        WHERE category_id = ? AND substr(date, 1, 7) = ?
      `).get(category_id, transactionMonth);
      if (!currentCategory) {
        db.prepare(`
          INSERT INTO current_categories (category_id, name, limit_amount, date)
          VALUES (?, ?, ?, ?)
        `).run(category_id, category.name, category.limit_amount, transactionDay);
      }
    }

    db.prepare(`
      UPDATE transactions SET date = ?, category_id = ?, amount = ?, coefficient = ?, note = ?
      WHERE id = ?
    `).run(date, category_id, amount, coefficient, note ?? null, id);
    db.exec("COMMIT");
    return res.json({ id, date, category_id, amount, coefficient, note: note ?? null });
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    console.error(error);
    return res.status(500).json({ error: "Could not update transaction" });
  }
});

app.delete("/api/transactions", (req, res) => {
  const { id } = req.body || {};
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: "id must be an integer" });
  }

  try {
    const result = db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    if (!result.changes) {
      return res.status(404).json({ error: "Transaction does not exist" });
    }
    return res.json({ id, deleted: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not delete transaction" });
  }
});

app.post("/api/transactions", (req, res) => {
  let { amount, category_id, date, coefficient, note } = req.body || {};
  if (req.is("application/x-www-form-urlencoded")) {
    amount = Number(amount);
    category_id = category_id === "null" ? null : Number(category_id);
    coefficient = Number(coefficient);
  }

  const transactionDate = date == null || date.trim() === ""
    ? new Date().toISOString()
    : date;

  try {
    const result = db.prepare(`
      INSERT INTO transactions (amount, category_id, date, coefficient, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(amount, category_id, transactionDate, coefficient, note ?? null);

    return sendPostResult(req, res, 201, {
      id: Number(result.lastInsertRowid),
      amount,
      category_id,
      date: transactionDate,
      coefficient,
      note: note ?? null,
    }, "Thêm giao dịch thành công.");
  } catch (error) {
    console.error(error);
    return sendPostResult(req, res, 500, { error: "Could not create transaction" }, "Không thể thêm giao dịch.");
  }
});

app.get("/edit_transactions.html", (req, res) => {
  res.sendFile(path.join(__dirname, "edit_transactions.html"));
});

app.get("/edit_categories.html", (req, res) => {
  res.sendFile(path.join(__dirname, "edit_categories.html"));
});

app.get("/", (req, res) => {
  const stream = fs.createReadStream(path.join(__dirname, "index.html"));

  res.type("html");
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).send("Không thể đọc index.html");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
});

app.listen(3456, () => {
  console.log("Server đang chạy tại http://localhost:3456");
});
