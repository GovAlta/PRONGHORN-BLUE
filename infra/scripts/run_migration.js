const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const password = process.env.TF_VAR_administrator_password;
  if (!password) {
    console.error('ERROR: TF_VAR_administrator_password environment variable not set');
    process.exit(1);
  }

  const host = process.env.PGHOST || 'pronghorn-dev-pgdb.postgres.database.azure.com';
  console.log(`Using PostgreSQL host: ${host}`);

  const client = new Client({
    host: host,
    port: 5432,
    user: 'pronghornAdmin',
    password: password,
    database: process.env.PGDATABASE || 'pronghorn',
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Connecting to PostgreSQL...');
    await client.connect();
    console.log('Connected successfully!');

    const migrationPath = path.join(__dirname, '..', 'migrations', '001_full_schema.sql');
    console.log(`Reading migration file: ${migrationPath}`);
    let sql = fs.readFileSync(migrationPath, 'utf8');

    // Remove BOM if present
    if (sql.charCodeAt(0) === 0xFEFF) {
      sql = sql.slice(1);
    }

    // Remove single-line comments first
    sql = sql.replace(/--.*$/gm, '');
    
    // Split by semicolons, but handle $$ delimited blocks (functions, triggers)
    const statements = [];
    let current = '';
    let inDollarQuote = false;
    
    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      const nextChar = sql[i + 1] || '';
      
      // Check for $$ delimiter
      if (char === '$' && nextChar === '$') {
        inDollarQuote = !inDollarQuote;
        current += '$$';
        i++; // skip next $
        continue;
      }
      
      if (char === ';' && !inDollarQuote) {
        const stmt = current.trim();
        if (stmt) {
          statements.push(stmt);
        }
        current = '';
      } else {
        current += char;
      }
    }
    
    // Add any remaining statement
    const remaining = current.trim();
    if (remaining) {
      statements.push(remaining);
    }

    console.log(`Found ${statements.length} statements to execute`);

    // Execute each statement
    let completed = 0;
    let skipped = 0;
    for (const stmt of statements) {
      // Skip empty statements
      if (!stmt.trim()) continue;
      
      try {
        await client.query(stmt + ';');
        completed++;
        if (completed % 20 === 0) {
          console.log(`Progress: ${completed} statements executed, ${skipped} skipped`);
        }
      } catch (err) {
        // Log but continue on some expected errors
        if (err.message.includes('already exists') || 
            err.message.includes('duplicate key') ||
            err.message.includes('does not exist')) {
          skipped++;
          // console.log(`Skipping: ${err.message.substring(0, 60)}`);
        } else {
          console.error(`Error executing statement ${completed + 1}:`, err.message);
          console.error('Statement:', stmt.substring(0, 200));
          throw err;
        }
      }
    }

    console.log(`\nMigration completed!`);
    console.log(`  Statements executed: ${completed}`);
    console.log(`  Statements skipped: ${skipped}`);

  } catch (err) {
    console.error('Migration failed:', err.message);
    if (err.position) {
      console.error('Error position:', err.position);
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
