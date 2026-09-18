import pg from 'pg';
import { readDotEnvPostgres } from './acd-test-db.mjs';
import { routeOne } from '../../lib/acd/router.mjs';
const db=readDotEnvPostgres();
if(db.database!=='acd_core_test_routing_skills')throw Error('Isolated routing test database required');
const pool=new pg.Pool({...db,max:1});
try { console.log(JSON.stringify(await routeOne(pool,process.argv[2]))); } finally { await pool.end(); }
