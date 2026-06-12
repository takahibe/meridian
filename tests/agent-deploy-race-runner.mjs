// Inner runner for agent-deploy-race.test.js — must run under
// node --experimental-test-module-mocks (mock.module is flag-gated in Node 22).
// Mocks every static import of agent.js so agentLoop runs with zero network/chain
// access, then feeds one assistant message containing TWO parallel deploy_position
// tool calls and reports how many actually executed.
import { mock } from "node:test";
import assert from "node:assert/strict";

const local = (p) => new URL(p, import.meta.url).href;

const executeToolCalls = [];

// Scripted LLM: step 1 → two deploy_position calls in one message; step 2 → final answer
const responses = [
  {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "deploy_position", arguments: JSON.stringify({ pool_address: "poolA", amount_sol: 0.5 }) } },
          { id: "call_2", type: "function", function: { name: "deploy_position", arguments: JSON.stringify({ pool_address: "poolB", amount_sol: 0.5 }) } },
        ],
      },
    }],
  },
  { choices: [{ message: { role: "assistant", content: "done" } }] },
];

mock.module("openai", {
  defaultExport: class OpenAIMock {
    constructor() {
      this.chat = { completions: { create: async () => responses.shift() } };
    }
  },
});
mock.module(local("../prompt.js"), { namedExports: { buildSystemPrompt: () => "test prompt" } });
mock.module(local("../tools/executor.js"), {
  namedExports: {
    executeTool: async (name, args) => {
      executeToolCalls.push({ name, args });
      return { success: true, position: `pos_${args.pool_address}` };
    },
  },
});
mock.module(local("../tools/definitions.js"), {
  namedExports: {
    tools: [{ type: "function", function: { name: "deploy_position", description: "d", parameters: { type: "object", properties: {} } } }],
  },
});
mock.module(local("../tools/wallet.js"), { namedExports: { getWalletBalances: async () => ({ sol: 5 }) } });
mock.module(local("../tools/dlmm.js"), { namedExports: { getMyPositions: async () => [] } });
mock.module(local("../logger.js"), { namedExports: { log: () => {} } });
mock.module(local("../config.js"), { namedExports: { config: { llm: { maxSteps: 5, temperature: 0.2, maxTokens: 2048 } } } });
mock.module(local("../state.js"), { namedExports: { getStateSummary: () => "" } });
mock.module(local("../lessons.js"), { namedExports: { getLessonsForPrompt: () => "", getPerformanceSummary: () => "" } });
mock.module(local("../decision-log.js"), { namedExports: { getDecisionSummary: () => "" } });

const { agentLoop } = await import(local("../agent.js"));

const finishes = [];
const result = await agentLoop("deploy into the best pool", 5, [], "GENERAL", null, null, {
  onToolFinish: ({ name, result: r, success }) => finishes.push({ name, success, blocked: !!r?.blocked }),
});

assert.equal(result.content, "done", "loop should reach the scripted final answer");

// Machine-readable summary for the outer test (last stdout line)
console.log(JSON.stringify({
  deployExecutions: executeToolCalls.length,
  blocked: finishes.filter((f) => f.blocked).length,
}));
