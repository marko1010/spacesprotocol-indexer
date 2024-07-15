// import { drizzle } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/node-postgres";
// import postgres from "postgres";
import pg from 'pg';
const { Client } = pg;

import * as schema from './schema.js';
import dotenv from 'dotenv';
dotenv.config();

// const sql = postgres(process.env.DB_URL, { max: 50 })
// const db = drizzle(sql, { schema });


// export const client = new Client({ connectionString: process.env.DB_URL });
// await client.connect();
// const db = drizzle(client, { schema });

export async function getDb() {
    const client = new Client({ connectionString: process.env.DB_URL });
    await client.connect();
    const dbDrizzle = drizzle(client, { schema });

    // Create an extended db object with the end method
    const db = Object.assign(dbDrizzle, {
      end: () => client.end()
    }) as typeof dbDrizzle & { end: () => Promise<void> };
  
    return db;
}

// export default db;
