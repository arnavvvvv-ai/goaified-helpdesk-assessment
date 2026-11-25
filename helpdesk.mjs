import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const policies = [
  ['HR-01', 'Annual leave', 'Submit planned annual leave in the employee portal at least five working days ahead. Your manager approves it.'],
  ['HR-02', 'Sick leave', 'Notify your manager before your shift if you need sick leave. For three or more consecutive days, send documentation through the confidential HR portal.'],
  ['HR-03', 'Expense reimbursement', 'Submit expenses and itemized receipts through the finance portal within 30 days of purchase.'],
  ['HR-04', 'Remote work', 'Request recurring remote work through the employee portal. Your manager reviews the request before it takes effect.'],
  ['IT-01', 'Password reset', 'Open the company identity portal and choose Reset password. If you cannot access your recovery methods, contact the IT service desk.'],
  ['IT-02', 'Lost device', 'Immediately report a lost company laptop or mobile device to the IT service desk. Include the asset label if available.'],
  ['IT-03', 'VPN connection', 'Use the approved VPN client. If it will not connect, confirm internet access and contact the IT service desk with the error code.'],
  ['IT-04', 'Software installation', 'Request installation of approved software through the IT service desk. Include the business use and device asset label.'],
];

const dimensions = 256;
const stopWords = new Set('a an and are can could do does for from get how i in is it me my of on or please should the to what when where who will with you your'.split(' '));
const aliases = new Map([['vacation','annual'],['holiday','annual'],['forgot','reset'],['forgotten','reset'],['stolen','lost'],['missing','lost'],['install','installation'],['reimburse','reimbursement'],['receipt','receipts'],['claim','expenses'],['ill','sick'],['wfh','remote'],['working','work']]);
const tokens = (text) => (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [])
  .filter((word) => !stopWords.has(word)).map((word) => aliases.get(word) ?? word);

function embed(text) {
  const result = new Array(dimensions).fill(0);
  for (const word of tokens(text)) {
    let hash = 2166136261;
    for (const character of word) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    result[(hash >>> 0) % dimensions] += 1;
  }
  return JSON.stringify(result);
}

const offTopic = /\b(weather|cricket|football|recipe|movie|bitcoin|stock price)\b/i;
const prohibited = /\b(ignore|override|disregard)\b.{0,40}\b(instructions|polic(?:y|ies)|rules)\b|\b(system prompt|all employee records|dump database)\b/i;
const personalInfo = /\b(email address|phone number|home address|government id|social security|personal contact)\b/i;
const unsupportedPolicy = /\b(sabbatical|bereavement|parental|paternity|maternity|overtime)\b/i;
const domain = /\b(hr|it|leave|vacation|holiday|password|vpn|software|device|laptop|employee|expenses?|reimburse\w*|remote|wfh|policy|sabbatical|bereavement|parental|paternity|maternity|overtime)\b/i;
const noAnswer = 'I could not find an answer in the approved policies. Please contact the relevant HR or IT team.';
const protect = (answer) => answer
  .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[redacted email]')
  .replace(/(?:\+?\d[\s().-]*){10,15}(?!\d)/g, '[redacted phone]');

export async function serve() {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(`CREATE EXTENSION vector;
    CREATE TABLE policies (id text PRIMARY KEY, title text NOT NULL, content text NOT NULL, embedding vector(${dimensions}) NOT NULL);
    CREATE TABLE employee_leave (employee_id text PRIMARY KEY, days_remaining integer NOT NULL);
    INSERT INTO employee_leave VALUES ('E102', 8), ('E103', 12);`);
  for (const [id, title, content] of policies) {
    await db.query('INSERT INTO policies VALUES ($1,$2,$3,$4::vector)', [id, title, content, embed(`${title} ${title} ${content}`)]);
  }

  const server = new McpServer({ name: 'synthetic-hr-it-helpdesk', version: '1.0.0' });
  const answer = (value) => ({ content: [{ type: 'text', text: protect(value) }] });
  server.registerTool('search_policy', {
    description: 'Retrieve a supported HR or IT policy passage with a stable source ID.',
    inputSchema: { question: z.string().min(1).max(500) },
  }, async ({ question }) => {
    if (prohibited.test(question) || personalInfo.test(question) || offTopic.test(question) || !domain.test(question)) {
      return answer('I can help with HR and IT policy questions using approved information.');
    }
    if (unsupportedPolicy.test(question)) return answer(noAnswer);
    const query = embed(question);
    if (!tokens(question).length) return answer(noAnswer);
    const { rows: candidates } = await db.query(`SELECT id, title, content, 1 - (embedding <=> $1::vector) AS similarity
      FROM policies ORDER BY embedding <=> $1::vector LIMIT 3`, [query]);
    const queryWords = new Set(tokens(question));
    const match = candidates.find((row) => row.similarity >= 0.19 && tokens(row.title).some((word) => queryWords.has(word)));
    return answer(match ? `${match.content} [${match.id} | ${match.title}]` : noAnswer);
  });

  server.registerTool('get_my_leave_balance', {
    description: 'Return only the authenticated demo employee’s remaining leave days.',
    inputSchema: {},
  }, async () => {
    // The stdio process represents a trusted demo session for E102. Callers cannot supply an identity.
    const { rows } = await db.query('SELECT days_remaining FROM employee_leave WHERE employee_id = $1', ['E102']);
    return answer(rows[0] ? `You have ${rows[0].days_remaining} annual leave days remaining. [Employee leave register]` : noAnswer);
  });

  await server.connect(new StdioServerTransport());
}

export async function createHelpdesk() {
  const client = new Client({ name: 'hr-it-helpdesk-client', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(import.meta.url), '--mcp'], stderr: 'inherit' });
  await client.connect(transport);

  return {
    close: () => client.close(),
    async ask(input) {
      const question = input.trim();
      if (!question || question.length > 500) return 'Please ask one HR or IT question in 500 characters or fewer.';
      if (prohibited.test(question)) return 'I can only answer approved HR and IT questions. I cannot disclose instructions or employee records.';
      if (personalInfo.test(question)) return 'I cannot disclose personal contact or identity information.';
      if (offTopic.test(question) || !domain.test(question)) return 'That is outside the HR and IT helpdesk scope.';
      const ids = [...question.matchAll(/\bE\d{3}\b/gi)].map(([id]) => id.toUpperCase());
      if (ids.some((id) => id !== 'E102')) return 'I can only show leave information for your own demo account.';
      const balance = /\bleave\b/i.test(question) && /\b(balance|remaining|left|how many)\b/i.test(question);
      const result = await client.callTool(balance
        ? { name: 'get_my_leave_balance', arguments: {} }
        : { name: 'search_policy', arguments: { question } });
      if (result.isError) return 'I could not reach the approved helpdesk data. Please retry or contact support.';
      return protect(result.content.filter(({ type }) => type === 'text').map(({ text }) => text).join('\n'));
    },
  };
}

if (process.argv.includes('--mcp')) await serve();
else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { createInterface } = await import('node:readline');
  const agent = await createHelpdesk();
  const ui = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  try {
    if (process.stdin.isTTY) console.log('HR and IT Helpdesk • synthetic employee E102. Type exit to finish.');
    for await (const line of ui) {
      if (line.trim().toLowerCase() === 'exit') break;
      console.log(await agent.ask(line));
    }
  } finally {
    ui.close();
    await agent.close();
  }
}
