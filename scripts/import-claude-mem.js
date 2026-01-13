#!/usr/bin/env node
/**
 * Import memories from claude-mem SQLite database into OpenMemory
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const CLAUDE_MEM_DB = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
const OPENMEMORY_URL = process.env.OPENMEMORY_URL || 'http://localhost:8080';

async function importMemories() {
  console.log('Opening claude-mem database:', CLAUDE_MEM_DB);
  const db = new Database(CLAUDE_MEM_DB, { readonly: true });

  // Get all observations
  const observations = db.prepare(`
    SELECT id, memory_session_id, project, text, type, title, created_at
    FROM observations
    WHERE text IS NOT NULL AND text != ''
    ORDER BY created_at ASC
  `).all();

  console.log(`Found ${observations.length} observations to import`);

  // Get session summaries
  const summaries = db.prepare(`
    SELECT id, memory_session_id, project, request, investigated, learned,
           completed, next_steps, notes, created_at
    FROM session_summaries
    ORDER BY created_at ASC
  `).all();

  console.log(`Found ${summaries.length} session summaries to import`);

  let imported = 0;
  let failed = 0;

  // Import observations
  for (const obs of observations) {
    const content = obs.title
      ? `[${obs.type.toUpperCase()}] ${obs.title}\n\n${obs.text}`
      : `[${obs.type.toUpperCase()}] ${obs.text}`;

    const tags = [obs.type, 'claude-mem', 'observation'];
    if (obs.project) {
      tags.push(`project:${path.basename(obs.project)}`);
    }

    try {
      const response = await fetch(`${OPENMEMORY_URL}/memory/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          user_id: 'claude-mem-import',
          tags,
          metadata: {
            source: 'claude-mem',
            original_id: obs.id,
            type: obs.type,
            project: obs.project,
            session_id: obs.memory_session_id,
            created_at: obs.created_at
          }
        })
      });

      if (response.ok) {
        imported++;
        process.stdout.write('.');
      } else {
        failed++;
        process.stdout.write('x');
      }
    } catch (err) {
      failed++;
      process.stdout.write('x');
    }
  }

  // Import session summaries as combined memories
  for (const summary of summaries) {
    const parts = [];
    if (summary.request) parts.push(`Request: ${summary.request}`);
    if (summary.investigated) parts.push(`Investigated: ${summary.investigated}`);
    if (summary.learned) parts.push(`Learned: ${summary.learned}`);
    if (summary.completed) parts.push(`Completed: ${summary.completed}`);
    if (summary.next_steps) parts.push(`Next Steps: ${summary.next_steps}`);
    if (summary.notes) parts.push(`Notes: ${summary.notes}`);

    if (parts.length === 0) continue;

    const content = `[SESSION SUMMARY]\n\n${parts.join('\n\n')}`;
    const tags = ['session-summary', 'claude-mem'];
    if (summary.project) {
      tags.push(`project:${path.basename(summary.project)}`);
    }

    try {
      const response = await fetch(`${OPENMEMORY_URL}/memory/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          user_id: 'claude-mem-import',
          tags,
          metadata: {
            source: 'claude-mem',
            type: 'session_summary',
            original_id: summary.id,
            project: summary.project,
            session_id: summary.memory_session_id,
            created_at: summary.created_at
          }
        })
      });

      if (response.ok) {
        imported++;
        process.stdout.write('S');
      } else {
        failed++;
        process.stdout.write('x');
      }
    } catch (err) {
      failed++;
      process.stdout.write('x');
    }
  }

  console.log(`\n\nImport complete: ${imported} imported, ${failed} failed`);
  db.close();
}

importMemories().catch(console.error);
