import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { runCodingAgent } from '../src/ai/runtime/coding-agent.ts';
import {
  exportPlanningSession,
  importPlanningSession,
  PLANNING_CONFIG,
} from '../src/ai/runtime/planning-session.ts';
import { proxyAiGatewayRequest } from '../src/services/ai-gateway-proxy.ts';
import { createAiGatewayGrant } from '../src/integrations/security/ai-gateway-grant.ts';

const exec = promisify(execFile);

// Only the remote provider is scripted. The pinned OpenCode executable, its
// tools/session database/retries, our command/config, grant and proxy are real.
// No production account, credentials, network services or paid inference.
await test(
  'planner survives a 429 and a fresh sandbox without delegating or losing research',
  { timeout: 90_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'turbodiff-planning-'));
    const cwd = path.join(root, 'repo');
    await mkdir(cwd);
    await writeFile(
      path.join(cwd, 'evidence.txt'),
      'Evidence only available from the read tool: amber-7391',
    );
    let home = path.join(root, 'first');
    const sandbox = {
      async exec(command, options = {}) {
        const started = Date.now();
        try {
          const result = await exec('/bin/sh', ['-c', command], {
            cwd: options.cwd,
            env: {
              ...process.env,
              XDG_DATA_HOME: home,
              XDG_CONFIG_HOME: path.join(root, 'config'),
              XDG_CACHE_HOME: path.join(root, 'cache'),
              XDG_STATE_HOME: path.join(root, 'state'),
              ...options.env,
            },
            timeout: options.timeout,
            maxBuffer: 8 * 1024 * 1024,
          });
          return {
            ...result,
            success: true,
            exitCode: 0,
            command,
            duration: Date.now() - started,
            timestamp: new Date().toISOString(),
          };
        } catch (error) {
          return {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? '',
            success: false,
            exitCode: error.code ?? 1,
            command,
            duration: Date.now() - started,
            timestamp: new Date().toISOString(),
          };
        }
      },
      writeFile: (file, content) => writeFile(file, content),
      readFile: async (file) => ({ content: await readFile(file, 'utf8') }),
    };
    const model = 'openai/gpt-5.6-sol';
    const config = {
      accountId: 'isolated-test',
      gatewayId: 'isolated-test',
      apiToken: 'test-only-secret',
    };
    const requests = [];
    let stage = 'analysis';
    let retryAt;
    let failure;
    const upstream = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.equal(body.model, model);
      assert.ok(
        !body.tools.some((tool) => tool.name === 'task'),
        'delegation must not be offered to the model',
      );
      if (requests.length === 1) {
        retryAt = Date.now();
        return Response.json(
          { error: { message: 'Wholesale Rate limited', type: 'rate_limit_error' } },
          { status: 429, headers: { 'retry-after': '3' } },
        );
      }
      if (requests.length === 2)
        assert.ok(Date.now() - retryAt >= 2_900, 'Retry-After was ignored');
      const evidence = body.input.some(
        (item) =>
          item.type === 'function_call_output' && String(item.output).includes('amber-7391'),
      );
      if (stage === 'refine') {
        assert.ok(evidence, 'restored session lost the analysis tool result');
        assert.ok(
          JSON.stringify(body.input).includes('Grounded analysis complete'),
          'restored session lost the previous answer',
        );
      }
      const output =
        stage === 'analysis' && !evidence
          ? [
              {
                type: 'function_call',
                id: 'fc_evidence',
                call_id: 'call_evidence',
                name: 'read',
                arguments: JSON.stringify({ filePath: path.join(cwd, 'evidence.txt') }),
              },
            ]
          : [
              {
                type: 'message',
                id: `msg_${requests.length}`,
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text:
                      stage === 'analysis'
                        ? 'Grounded analysis complete'
                        : 'Plan uses the preserved evidence',
                    annotations: [],
                  },
                ],
              },
            ];
      const response = {
        id: `resp_${requests.length}`,
        object: 'response',
        created_at: 1,
        model: 'gpt-5.6-sol',
        status: 'completed',
        output,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: { cached_tokens: 0 },
        },
      };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      ];
      for (const [output_index, item] of output.entries()) {
        events.push({
          type: 'response.output_item.added',
          output_index,
          item: { ...item, arguments: '', content: [] },
        });
        if (item.type === 'function_call') {
          events.push({
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index,
            delta: item.arguments,
          });
          events.push({
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            output_index,
            arguments: item.arguments,
          });
        } else
          events.push({
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index,
            content_index: 0,
            delta: item.content[0].text,
          });
        events.push({
          type: 'response.output_item.done',
          output_index,
          item: { ...item, status: 'completed' },
        });
      }
      events.push({ type: 'response.completed', response });
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const server = createServer(async (req, res) => {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const response = await proxyAiGatewayRequest(
          new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers: req.headers,
            body,
          }),
          config,
          upstream,
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch (error) {
        failure = error;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: error.message, type: 'invalid_request_error' } }),
        );
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const pinned = (await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')).match(
        /opencode-ai@([\d.]+)/,
      )[1];
      const version = await sandbox.exec('opencode --version', { cwd, timeout: 15_000 });
      assert.equal(version.stdout.trim(), pinned, 'test must use the production OpenCode version');
      const auth = {
        mode: 'gateway',
        model,
        baseURL: `http://127.0.0.1:${server.address().port}/ai-proxy/v1`,
        vars: {
          TURBODIFF_AI_GATEWAY_GRANT: await createAiGatewayGrant(
            config.apiToken,
            model,
            Date.now() + 90_000,
          ),
        },
      };
      const promptFile = path.join(root, 'prompt.md');
      await writeFile(promptFile, 'Analyze the evidence file.');
      const options = { cwd, promptFile, timeout: 30_000, configExtensionJson: PLANNING_CONFIG };
      const analysis = await runCodingAgent(sandbox, auth, options);
      if (failure) throw failure;
      assert.equal(analysis.success, true, analysis.stderr || analysis.stdout);
      assert.equal(analysis.resultText, 'Grounded analysis complete');
      assert.equal(requests.length, 3, 'expected one retry, one tool read, one final response');
      const snapshot = await exportPlanningSession(sandbox, auth, cwd, analysis.codingSessionId);
      await rm(home, { recursive: true, force: true });
      home = path.join(root, 'replacement');
      await rm(path.join(cwd, 'evidence.txt')); // Resumption must retain the actual read result.
      const sessionId = await importPlanningSession(sandbox, auth, cwd, snapshot);
      stage = 'refine';
      await writeFile(promptFile, 'The user answered: proceed. Produce the plan.');
      const refined = await runCodingAgent(sandbox, auth, { ...options, sessionId });
      if (failure) throw failure;
      assert.equal(refined.success, true, refined.stderr || refined.stdout);
      assert.equal(refined.codingSessionId, analysis.codingSessionId);
      assert.equal(refined.resultText, 'Plan uses the preserved evidence');
      assert.equal(requests.length, 4, 'refinement should use the imported context in one request');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
