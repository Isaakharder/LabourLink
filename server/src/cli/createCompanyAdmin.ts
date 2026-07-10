/**
 * Provisions a brand new company plus its first administrator.
 *
 * The HTTP setup screen (/api/setup/bootstrap-admin) only ever creates the
 * very first company+admin on a fresh system and permanently locks itself
 * once any user exists. Provisioning additional companies afterward is
 * deliberately NOT an HTTP endpoint (that would be anonymous admin-account
 * creation against a live system) — it's a CLI command run by whoever has
 * shell access to the API container:
 *
 *   Dev:  docker compose exec api npm run create-admin
 *   Prod: docker compose -f docker-compose.prod.yml exec api npm run create-admin:prod
 */
import readline from 'readline';
import { db } from '../db';
import { hashPassword, validatePasswordStrength } from '../lib/password';

const KEY_LF = String.fromCharCode(10);
const KEY_CR = String.fromCharCode(13);
const KEY_EOF = String.fromCharCode(4);
const KEY_INTERRUPT = String.fromCharCode(3);
const KEY_BACKSPACE = String.fromCharCode(127);

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.resume();
    stdin.setRawMode?.(true);
    let value = '';
    const onData = (char: Buffer) => {
      const c = char.toString('utf8');
      if (c === KEY_LF || c === KEY_CR || c === KEY_EOF) {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (c === KEY_INTERRUPT) {
        process.stdout.write('\n');
        process.exit(1);
      }
      if (c === KEY_BACKSPACE) {
        value = value.slice(0, -1);
        return;
      }
      value += c;
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  console.log('LabourLink — create a new company + administrator\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const companyName = (await ask(rl, 'Company name: ')).trim();
  const email = (await ask(rl, 'Admin email: ')).trim();
  rl.close();
  const password = await askHidden('Admin password: ');
  const confirm = await askHidden('Confirm password: ');

  if (!companyName) {
    console.error('Company name is required.');
    process.exitCode = 1;
    return;
  }
  if (!email) {
    console.error('Email is required.');
    process.exitCode = 1;
    return;
  }
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exitCode = 1;
    return;
  }
  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    console.error(passwordError);
    process.exitCode = 1;
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: dupCompany } = await client.query(
      'SELECT id FROM companies WHERE lower(name) = lower($1)',
      [companyName],
    );
    if (dupCompany.length) {
      console.error(
        `A company named "${companyName}" already exists (id ${dupCompany[0].id}). ` +
          'Use the admin panel to add users to an existing company instead.',
      );
      await client.query('ROLLBACK');
      process.exitCode = 1;
      return;
    }

    const { rows: companyRows } = await client.query(
      'INSERT INTO companies (name) VALUES ($1) RETURNING id',
      [companyName],
    );
    const companyId = companyRows[0].id;

    const { rows: roleRows } = await client.query(
      "SELECT id FROM security_roles WHERE name = 'Admin'",
    );
    const roleId = roleRows[0].id;

    const passwordHash = await hashPassword(password);
    const { rows: userRows } = await client.query(
      `INSERT INTO users (company_id, email, password_hash, role_id, is_active)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
      [companyId, email, passwordHash, roleId],
    );

    await client.query('COMMIT');
    console.log(
      `\nCreated company "${companyName}" (id ${companyId}) with admin ${email} (user id ${userRows[0].id}).`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Failed to create company/admin:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
}

main();
