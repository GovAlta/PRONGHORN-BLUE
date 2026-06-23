/**
 * Database Proxy Routes - Generic database operations
 * 
 * @swagger
 * tags:
 *   name: Database
 *   description: Generic database operations 
 */
import { Router, Request, Response } from "express";
import db from "../utils/database";
import { logger } from "../utils/logger";
import { Errors } from "../middleware/errorHandler";

const router = Router();

interface FilterValue {
  op?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is";
  value: any;
}

interface BuildWhereResult {
  clause: string;
  values: any[];
  nextIndex: number;
}

/**
 * Build WHERE clause from filters
 */
function buildWhereClause(filters: Record<string, any> | undefined, startIndex = 1): BuildWhereResult {
  if (!filters || Object.keys(filters).length === 0) {
    return { clause: "", values: [], nextIndex: startIndex };
  }

  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = startIndex;

  for (const [key, value] of Object.entries(filters)) {
    if (value === null) {
      conditions.push(`${key} IS NULL`);
    } else if (typeof value === "object" && value.op) {
      const filterVal = value as FilterValue;
      switch (filterVal.op) {
        case "eq":
          conditions.push(`${key} = $${paramIndex++}`);
          values.push(filterVal.value);
          break;
        case "neq":
          conditions.push(`${key} != $${paramIndex++}`);
          values.push(filterVal.value);
          break;
        case "gt":
          conditions.push(`${key} > $${paramIndex++}`);
          values.push(filterVal.value);
          break;
        case "gte":
          conditions.push(`${key} >= $${paramIndex++}`);
          values.push(filterVal.value);
          break;
        case "lt":
          conditions.push(`${key} < $${paramIndex++}`);
          values.push(filterVal.value);
          break;
        case "lte":
          conditions.push(`${key} <= $${paramIndex++}`);
          values.push(filterVal.value);
          break;
        case "like":
          conditions.push(`${key} LIKE $${paramIndex++}`);
          values.push(filterVal.value);
          break;
        case "ilike":
          conditions.push(`${key} ILIKE $${paramIndex++}`);
          values.push(filterVal.value);
          break;
        case "in":
          if (Array.isArray(filterVal.value) && filterVal.value.length > 0) {
            const placeholders = filterVal.value.map(() => `$${paramIndex++}`).join(", ");
            conditions.push(`${key} IN (${placeholders})`);
            values.push(...filterVal.value);
          }
          break;
        case "is":
          if (filterVal.value === null) {
            conditions.push(`${key} IS NULL`);
          } else if (filterVal.value === true) {
            conditions.push(`${key} IS TRUE`);
          } else if (filterVal.value === false) {
            conditions.push(`${key} IS FALSE`);
          }
          break;
        default:
          conditions.push(`${key} = $${paramIndex++}`);
          values.push(filterVal.value);
      }
    } else {
      conditions.push(`${key} = $${paramIndex++}`);
      values.push(value);
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
    nextIndex: paramIndex,
  };
}

/**
 * Validate table name to prevent SQL injection
 */
function validateTableName(table: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw Errors.badRequest("Invalid table name");
  }
}

/**
 * @swagger
 * /db/select:
 *   post:
 *     summary: Select data from a table
 *     tags: [Database]
 */
router.post("/select", async (req: Request, res: Response) => {
  const { table, columns = "*", filters, order, limit, offset, single } = req.body;

  if (!table) {
    throw Errors.badRequest("Table name is required");
  }

  validateTableName(table);

  const { clause: whereClause, values } = buildWhereClause(filters);

  let sql = `SELECT ${columns} FROM ${table} ${whereClause}`;

  // Add ORDER BY
  if (order) {
    const orderParts = Object.entries(order).map(([col, dir]) => {
      const direction = dir === "desc" ? "DESC" : "ASC";
      return `${col} ${direction}`;
    });
    if (orderParts.length > 0) {
      sql += ` ORDER BY ${orderParts.join(", ")}`;
    }
  }

  // Add LIMIT and OFFSET
  if (limit) {
    sql += ` LIMIT ${parseInt(limit)}`;
  }
  if (offset) {
    sql += ` OFFSET ${parseInt(offset)}`;
  }

  logger.debug(`DB Select: ${sql}`, { values });

  const result = await db.query(sql, values);

  if (single) {
    res.json({ data: result.rows[0] || null, error: null });
  } else {
    res.json({ data: result.rows, error: null });
  }
});

/**
 * @swagger
 * /db/insert:
 *   post:
 *     summary: Insert data into a table
 *     tags: [Database]
 */
router.post("/insert", async (req: Request, res: Response) => {
  const { table, data, returning = "*" } = req.body;

  if (!table || !data) {
    throw Errors.badRequest("Table and data are required");
  }

  validateTableName(table);

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) {
    throw Errors.badRequest("No data to insert");
  }

  const columns = Object.keys(rows[0]);
  const allValues: any[] = [];
  const valuePlaceholders: string[] = [];

  let paramIndex = 1;
  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      rowPlaceholders.push(`$${paramIndex++}`);
      allValues.push(row[col]);
    }
    valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
  }

  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valuePlaceholders.join(", ")} RETURNING ${returning}`;

  logger.debug(`DB Insert: ${sql.substring(0, 200)}...`);

  const result = await db.query(sql, allValues);

  res.status(201).json({ data: result.rows, error: null });
});

/**
 * @swagger
 * /db/update:
 *   post:
 *     summary: Update data in a table
 *     tags: [Database]
 */
router.post("/update", async (req: Request, res: Response) => {
  const { table, data, filters, returning = "*" } = req.body;

  if (!table || !data) {
    throw Errors.badRequest("Table and data are required");
  }

  validateTableName(table);

  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    setClauses.push(`${key} = $${paramIndex++}`);
    values.push(value);
  }

  const { clause: whereClause, values: whereValues } = buildWhereClause(filters, paramIndex);
  values.push(...whereValues);

  const sql = `UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause} RETURNING ${returning}`;

  logger.debug(`DB Update: ${sql}`);

  const result = await db.query(sql, values);

  res.json({ data: result.rows, error: null });
});

/**
 * @swagger
 * /db/delete:
 *   post:
 *     summary: Delete data from a table
 *     tags: [Database]
 */
router.post("/delete", async (req: Request, res: Response) => {
  const { table, filters, returning = "*" } = req.body;

  if (!table) {
    throw Errors.badRequest("Table name is required");
  }

  validateTableName(table);

  const { clause: whereClause, values } = buildWhereClause(filters);

  if (!whereClause) {
    throw Errors.badRequest("Filters are required for delete operations");
  }

  const sql = `DELETE FROM ${table} ${whereClause} RETURNING ${returning}`;

  logger.debug(`DB Delete: ${sql}`);

  const result = await db.query(sql, values);

  res.json({ data: result.rows, error: null });
});

/**
 * @swagger
 * /db/upsert:
 *   post:
 *     summary: Upsert data into a table
 *     tags: [Database]
 */
router.post("/upsert", async (req: Request, res: Response) => {
  const { table, data, onConflict, returning = "*" } = req.body;

  if (!table || !data) {
    throw Errors.badRequest("Table and data are required");
  }

  validateTableName(table);

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) {
    throw Errors.badRequest("No data to upsert");
  }

  const columns = Object.keys(rows[0]);
  const allValues: any[] = [];
  const valuePlaceholders: string[] = [];

  let paramIndex = 1;
  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      rowPlaceholders.push(`$${paramIndex++}`);
      allValues.push(row[col]);
    }
    valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
  }

  const conflictColumn = onConflict || "id";
  const updateSet = columns
    .filter((c) => c !== conflictColumn)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valuePlaceholders.join(", ")} 
    ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updateSet} RETURNING ${returning}`;

  logger.debug(`DB Upsert: ${sql.substring(0, 200)}...`);

  const result = await db.query(sql, allValues);

  res.json({ data: result.rows, error: null });
});

export default router;
