import {mkdtemp,copyFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {getDatabase,quoteIdentifier} from '../src/db.js';
import {migrate} from '../src/migrate.js';
import {migrationsDirectory} from '../src/storage.js';
import {executeNative} from '../src/native-service.js';
import {integration,TEST_DATABASE_URL,dropSchema,type TestSchema} from './support/database.js';
integration('native schema upgrade and data recovery',()=>{
 let target:TestSchema|undefined;
 afterEach(async()=>{await dropSchema(target);target=undefined;});
 it('upgrades the merged schema without changing existing ledger history',async()=>{
  const schema=`inv_upgrade_${process.pid}_${Date.now()}`;
  const db=await getDatabase(schema,TEST_DATABASE_URL!,schema);target={db,schema,poolKey:schema};
  const directory=await mkdtemp(path.join(os.tmpdir(),'inventory-upgrade-'));
  try{
   for(const file of await readdir(migrationsDirectory()))if(/^00(0[1-9]|1[0-3])_.*\.sql$/.test(file))await copyFile(path.join(migrationsDirectory(),file),path.join(directory,file));
   await migrate(db,directory);
   const part=await db.transaction(async c=>{
    const r=await c.query("INSERT INTO parts(vendor,vendor_part_number) VALUES('test','SYNTHETIC-OLD') RETURNING id");
    await c.query("INSERT INTO ledger_entries(part_id,entry_type,quantity_delta,on_hand_delta,reference,provenance,created_by) VALUES($1,'receipt',7,7,'SYNTHETIC-OLD','{\"source\":\"synthetic-upgrade\"}','synthetic')",[r.rows[0].id]);return r.rows[0].id;
   });
   const before=await db.query('SELECT * FROM ledger_entries');
   await migrate(db,migrationsDirectory());expect((await db.query<any>('SELECT * FROM ledger_entries')).map(({count_line_id,...row})=>row)).toEqual(before);
   expect(Number((await db.query<any>('SELECT on_hand FROM part_stock WHERE part_id=$1',[part]))[0].on_hand)).toBe(7);
   expect((await db.query<any>('SELECT count(*)::int AS n FROM schema_migrations'))[0].n).toBe(15);
   await expect(db.transaction(c=>c.query(`UPDATE ${quoteIdentifier(schema)}.ledger_entries SET quantity_delta=0`))).rejects.toThrow(/append.only/i);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 it('restores a logical data snapshot without reapplying an approved count',async()=>{
  const schema=`inv_restore_${process.pid}_${Date.now()}`;
  const db=await getDatabase(schema,TEST_DATABASE_URL!,schema);target={db,schema,poolKey:schema};await migrate(db,migrationsDirectory());
  const actor={type:'agent' as const,id:'synthetic-agent',companyId:'synthetic-company'};
  const adjustment=await executeNative(db,actor,'adjust',{partId:'test:SYNTHETIC-RESTORE',quantityDelta:5,reference:'restore-key',reason:'Synthetic recovery'});
  await executeNative(db,{...actor,type:'user',id:'reviewer'},'approve_count',{countId:adjustment.countId,reason:'Verified'});
  // Logical data backup exercises restored idempotency and provenance. Production
  // recovery additionally uses pg_dump/pg_restore as documented.
  const tables=['parts','operational_settings','physical_counts','physical_count_lines','ledger_entries'];
  const backup:Record<string,any[]>={};
  await db.transaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');for(const table of tables)backup[table]=(await c.query(`SELECT * FROM ${quoteIdentifier(table)}`)).rows;});
  await db.pool.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);await migrate(db,migrationsDirectory());
  await db.transaction(async c=>{
   await c.query('SET LOCAL session_replication_role=replica');
   for(const table of [...tables].reverse())await c.query(`DELETE FROM ${quoteIdentifier(table)}`);
   for(const table of tables)for(const row of backup[table]){
    const keys=Object.keys(row);await c.query(`INSERT INTO ${quoteIdentifier(table)}(${keys.map(quoteIdentifier).join(',')}) OVERRIDING SYSTEM VALUE VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(k=>typeof row[k]==='object'&&row[k]!==null&&!(row[k] instanceof Date)?JSON.stringify(row[k]):row[k]));
   }
   await c.query("SELECT setval(pg_get_serial_sequence('ledger_entries','id'),COALESCE((SELECT max(id) FROM ledger_entries),1))");
  });
  const retry=await executeNative(db,actor,'adjust',{partId:'test:SYNTHETIC-RESTORE',quantityDelta:5,reference:'restore-key',reason:'Synthetic recovery'});expect(retry.duplicate).toBe(true);expect(retry.status).toBe('applied');
  expect((await db.query<any>('SELECT on_hand FROM part_stock'))[0].on_hand).toBe('5.0000');
  expect(await db.query('SELECT * FROM ledger_entries')).toHaveLength(1);
 });
});
