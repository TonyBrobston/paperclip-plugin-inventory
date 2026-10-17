import type { PoolClient } from 'pg';
import { InputError } from './errors.js';
export async function authorizeAdjustment(client: PoolClient, lineId: string | undefined, partId: string, delta: number) {
  if (!lineId) throw new InputError('Adjustments must be submitted through the inventory reconciliation policy.');
  const result = await client.query(`SELECT 1 FROM physical_count_lines l JOIN physical_counts c ON c.id=l.count_id
    WHERE l.id=$1 AND l.part_id=$2 AND l.counted-l.expected=$3 AND c.status='applying'
    AND c.decided_by IS NOT NULL AND l.ledger_entry_id IS NULL`, [lineId,partId,delta]);
  if (!result.rowCount) throw new InputError('This adjustment has no authorized count submission.');
}
