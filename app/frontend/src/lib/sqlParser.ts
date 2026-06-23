/**
 * SQL Parser utility for splitting statements and detecting DDL operations
 */

export interface ParsedStatement {
  sql: string;
  statementType: string;
  objectType: string;
  objectSchema: string | null;
  objectName: string | null;
  isDDL: boolean;
}

/**
 * Split SQL into individual statements, handling:
 * - String literals ('...')
 * - Dollar-quoted strings ($$...$$, $tag$...$tag$)
 * - Line comments (--)
 * - Block comments
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    
    // Check for line comment
    if (char === "-" && next === "-") {
      // Read until end of line
      current += char;
      i++;
      while (i < sql.length && sql[i] !== "\n") {
        current += sql[i];
        i++;
      }
      if (i < sql.length) {
        current += sql[i];
        i++;
      }
      continue;
    }
    
    // Check for block comment
    if (char === "/" && next === "*") {
      let depth = 1;
      current += "/*";
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          current += "/*";
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          current += "*/";
          i += 2;
        } else {
          current += sql[i];
          i++;
        }
      }
      continue;
    }
    
    // Check for dollar quote
    if (char === "$") {
      const dollarMatch = sql.slice(i).match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/);
      if (dollarMatch) {
        const tag = dollarMatch[0];
        current += tag;
        i += tag.length;
        // Find closing tag
        const closeIndex = sql.indexOf(tag, i);
        if (closeIndex !== -1) {
          current += sql.slice(i, closeIndex + tag.length);
          i = closeIndex + tag.length;
        } else {
          // No closing tag, read to end
          current += sql.slice(i);
          i = sql.length;
        }
        continue;
      }
    }
    
    // Check for string literal
    if (char === "'") {
      current += char;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            // Escaped quote
            current += "''";
            i += 2;
          } else {
            current += sql[i];
            i++;
            break;
          }
        } else {
          current += sql[i];
          i++;
        }
      }
      continue;
    }
    
    // Check for double-quoted identifier
    if (char === '"') {
      current += char;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            current += '""';
            i += 2;
          } else {
            current += sql[i];
            i++;
            break;
          }
        } else {
          current += sql[i];
          i++;
        }
      }
      continue;
    }
    
    // Check for semicolon (statement separator)
    if (char === ";") {
      const stmt = current.trim();
      if (stmt) {
        statements.push(stmt);
      }
      current = "";
      i++;
      continue;
    }
    
    current += char;
    i++;
  }
  
  // Don't forget trailing statement without semicolon
  const last = current.trim();
  if (last) {
    statements.push(last);
  }
  
  return statements;
}

// DDL patterns for detection
const DDL_PATTERNS: { pattern: RegExp; type: string; objectPattern: RegExp }[] = [
  // CREATE statements
  { 
    pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?(TEMP(ORARY)?\s+)?TABLE\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+SEQUENCE\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+TYPE\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+TYPE\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+SCHEMA\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+EXTENSION\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bCREATE\s+POLICY\b/i,
    type: "CREATE",
    objectPattern: /\bCREATE\s+POLICY\s+"?([a-zA-Z_][a-zA-Z0-9_ ]*)"?\s+ON/i
  },
  
  // ALTER statements
  { 
    pattern: /\bALTER\s+TABLE\b/i,
    type: "ALTER",
    objectPattern: /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bALTER\s+VIEW\b/i,
    type: "ALTER",
    objectPattern: /\bALTER\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bALTER\s+FUNCTION\b/i,
    type: "ALTER",
    objectPattern: /\bALTER\s+FUNCTION\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bALTER\s+SEQUENCE\b/i,
    type: "ALTER",
    objectPattern: /\bALTER\s+SEQUENCE\s+(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bALTER\s+TYPE\b/i,
    type: "ALTER",
    objectPattern: /\bALTER\s+TYPE\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bALTER\s+SCHEMA\b/i,
    type: "ALTER",
    objectPattern: /\bALTER\s+SCHEMA\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bALTER\s+INDEX\b/i,
    type: "ALTER",
    objectPattern: /\bALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bALTER\s+POLICY\b/i,
    type: "ALTER",
    objectPattern: /\bALTER\s+POLICY\s+"?([a-zA-Z_][a-zA-Z0-9_ ]*)"?\s+ON/i
  },
  
  // DROP statements
  { 
    pattern: /\bDROP\s+TABLE\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+(MATERIALIZED\s+)?VIEW\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+FUNCTION\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+PROCEDURE\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+PROCEDURE\s+(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+TRIGGER\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+INDEX\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+SEQUENCE\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+SEQUENCE\s+(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+TYPE\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+SCHEMA\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+EXTENSION\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+EXTENSION\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bDROP\s+POLICY\b/i,
    type: "DROP",
    objectPattern: /\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_ ]*)"?\s+ON/i
  },
  
  // TRUNCATE
  { 
    pattern: /\bTRUNCATE\s+(TABLE\s+)?/i,
    type: "TRUNCATE",
    objectPattern: /\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  
  // GRANT/REVOKE
  { 
    pattern: /\bGRANT\s+/i,
    type: "GRANT",
    objectPattern: /\bGRANT\s+.+\s+ON\s+(?:ALL\s+)?(?:TABLES|SEQUENCES|FUNCTIONS|SCHEMAS)?\s*(?:IN\s+SCHEMA\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  { 
    pattern: /\bREVOKE\s+/i,
    type: "REVOKE",
    objectPattern: /\bREVOKE\s+.+\s+ON\s+(?:ALL\s+)?(?:TABLES|SEQUENCES|FUNCTIONS|SCHEMAS)?\s*(?:IN\s+SCHEMA\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
  
  // COMMENT ON
  { 
    pattern: /\bCOMMENT\s+ON\s+(TABLE|VIEW|COLUMN|FUNCTION|INDEX|SEQUENCE|TYPE|SCHEMA)\b/i,
    type: "COMMENT",
    objectPattern: /\bCOMMENT\s+ON\s+(TABLE|VIEW|COLUMN|FUNCTION|INDEX|SEQUENCE|TYPE|SCHEMA)\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i
  },
];

/**
 * Extract object type from SQL statement
 */
function getObjectType(sql: string): string {
  const upperSql = sql.toUpperCase();
  
  if (upperSql.includes("TABLE")) return "TABLE";
  if (upperSql.includes("MATERIALIZED VIEW")) return "MATERIALIZED VIEW";
  if (upperSql.includes("VIEW")) return "VIEW";
  if (upperSql.includes("FUNCTION")) return "FUNCTION";
  if (upperSql.includes("PROCEDURE")) return "PROCEDURE";
  if (upperSql.includes("TRIGGER")) return "TRIGGER";
  if (upperSql.includes("INDEX")) return "INDEX";
  if (upperSql.includes("SEQUENCE")) return "SEQUENCE";
  if (upperSql.includes("TYPE")) return "TYPE";
  if (upperSql.includes("SCHEMA")) return "SCHEMA";
  if (upperSql.includes("EXTENSION")) return "EXTENSION";
  if (upperSql.includes("POLICY")) return "POLICY";
  if (upperSql.includes("CONSTRAINT")) return "CONSTRAINT";
  
  return "UNKNOWN";
}

/**
 * Parse a SQL statement and extract DDL metadata
 */
export function parseDDLStatement(sql: string): ParsedStatement | null {
  const trimmedSql = sql.trim();
  
  for (const { pattern, type, objectPattern } of DDL_PATTERNS) {
    if (pattern.test(trimmedSql)) {
      const objectMatch = trimmedSql.match(objectPattern);
      
      let objectSchema: string | null = null;
      let objectName: string | null = null;
      
      if (objectMatch) {
        // For triggers, indexes without schema (single capture group)
        if (objectMatch.length === 2) {
          objectName = objectMatch[1];
        } else if (objectMatch.length >= 3) {
          // Schema.name pattern
          objectSchema = objectMatch[1] || null;
          objectName = objectMatch[2] || objectMatch[1];
        }
      }
      
      return {
        sql: trimmedSql,
        statementType: type,
        objectType: getObjectType(trimmedSql),
        objectSchema,
        objectName,
        isDDL: true,
      };
    }
  }
  
  return null;
}

/**
 * Parse SQL and extract all DDL statements
 */
export function extractDDLStatements(sql: string): ParsedStatement[] {
  const statements = splitSqlStatements(sql);
  const ddlStatements: ParsedStatement[] = [];
  
  for (const stmt of statements) {
    const parsed = parseDDLStatement(stmt);
    if (parsed) {
      ddlStatements.push(parsed);
    }
  }
  
  return ddlStatements;
}

/**
 * Check if SQL contains any DDL statements
 */
export function containsDDL(sql: string): boolean {
  return extractDDLStatements(sql).length > 0;
}
