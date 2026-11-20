import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from '../src/mcp.mjs';

async function toolDescription(name) {
  const response = await handleMessage({ jsonrpc: '2.0', id: 951, method: 'tools/list' });
  const tool = response.result.tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} must be advertised to MCP clients`);
  return tool.description;
}

test('FAILS_ON_OLD 951: swarm_search advertises its text and structured result formats', async () => {
  const description = await toolDescription('swarm_search');
  assert.match(description, /\bcontent\b/, 'describe the MCP content field, not just a sourced summary');
  assert.match(description, /\bone text item\b/i);
  assert.match(description, /\bMarkdown\b/i);
  assert.match(description, /\bstructuredContent\b/);
  assert.match(description, /\bJSON report object\b/i);
  assert.match(description, /\bweb\/files\/serp\b/, 'report fields vary by search mode');
  assert.match(description, /\bisError:\s*true\b/, 'describe text tool error results too');
});

test('FAILS_ON_OLD 951: swarm_providers advertises its text rows without a structured result', async () => {
  const description = await toolDescription('swarm_providers');
  assert.match(description, /\bcontent\b/, 'describe the returned content field, not just provider discovery');
  assert.match(description, /\bone text item\b/i);
  assert.match(description, /\bone line per provider\b/i);
  assert.match(description, /✓\/✗\s+availability/i);
  assert.match(description, /\bid\b.*\blabel\b/i);
  assert.match(description, /\boptional default model\b/i);
  assert.match(description, /\bno structuredContent\b/);
});
